import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { sampleValidator } from "./schema.js";
import {
  MAX_CLAMP_MS,
  MAX_DURATION_MS,
  MAX_SAMPLES,
  TOUCH_MS,
  batchValidator,
  clampCount,
  cursorValidator,
  historyPageValidator,
  nearReadLimit,
} from "./shared.js";

export const append = mutation({
  args: {
    room: v.string(),
    stream: v.string(),
    samples: v.array(sampleValidator),
    duration: v.number(),
    retentionMs: v.optional(v.number()),
  },
  // Null when every sample was captured before the room was last cleared.
  // `dropped` is how many leading samples were left out for that reason.
  returns: v.union(
    v.null(),
    v.object({
      seq: v.number(),
      start: v.number(),
      end: v.number(),
      dropped: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    validate(args.samples, args.duration, args.retentionMs);
    const now = Date.now();
    const prev = await ctx.db
      .query("batches")
      .withIndex("by_stream", (q) =>
        q.eq("room", args.room).eq("stream", args.stream),
      )
      .order("desc")
      .first();

    // A stream's timeline never overlaps or goes backwards, which absorbs
    // network jitter. A one-off latency spike re-anchors instead of pushing
    // the stream into the future for good.
    const idealStart = now - args.duration;
    let start = idealStart;
    if (prev && start < prev.end) {
      start = prev.end;
      if (start > idealStart + MAX_CLAMP_MS) start = idealStart;
    }
    const end = start + args.duration;

    // Someone cleared the room while these were still in the sender's buffer:
    // keep only what was captured after the clear. Times never go down, so
    // the ones to drop are always at the start.
    const roomDoc = await ctx.db
      .query("rooms")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique();
    const clearedAt = roomDoc?.clearedAt ?? -Infinity;
    const dropped = args.samples.findIndex((s) => start + s.t >= clearedAt);
    if (dropped === -1) return null;
    const samples = args.samples.slice(dropped);

    const seq = prev ? prev.seq + 1 : 0;
    const expiresAt =
      args.retentionMs === undefined ? undefined : end + args.retentionMs;

    await ctx.db.insert("batches", {
      room: args.room,
      stream: args.stream,
      seq,
      start,
      end,
      samples,
      expiresAt,
    });

    const streamDoc = await ctx.db
      .query("streams")
      .withIndex("by_room", (q) =>
        q.eq("room", args.room).eq("stream", args.stream),
      )
      .unique();
    if (!streamDoc) {
      await ctx.db.insert("streams", {
        room: args.room,
        stream: args.stream,
        firstStart: start,
        lastEnd: end,
      });
    } else if (end - streamDoc.lastEnd > TOUCH_MS) {
      await ctx.db.patch("streams", streamDoc._id, { lastEnd: end });
    }
    return { seq, start, end, dropped };
  },
});

export const latest = query({
  args: { room: v.string(), stream: v.string(), count: v.optional(v.number()) },
  returns: v.array(batchValidator),
  handler: async (ctx, args) => {
    const count = clampCount(args.count, 1, 20);
    const rows = ctx.db
      .query("batches")
      .withIndex("by_stream", (q) =>
        q.eq("room", args.room).eq("stream", args.stream),
      )
      .order("desc");
    // Twenty big batches could pass the read limit, so stop early if need be.
    const newestFirst = [];
    for await (const batch of rows) {
      newestFirst.push(batch);
      if (newestFirst.length === count || (await nearReadLimit(ctx))) break;
    }
    return newestFirst.reverse();
  },
});

export const history = query({
  args: {
    room: v.string(),
    stream: v.optional(v.string()),
    after: v.optional(cursorValidator),
    limit: v.optional(v.number()),
  },
  returns: historyPageValidator,
  handler: async (ctx, args) => {
    const limit = clampCount(args.limit, 100, 500);
    const rows =
      args.stream !== undefined
        ? streamRows(ctx, args.room, args.stream, args.after?.seq)
        : roomRows(ctx, args.room, args.after);
    const batches = [];
    let more = false;
    for await (const batch of rows) {
      // We've read one row past a full page, so another page exists.
      if (batches.length === limit) {
        more = true;
        break;
      }
      batches.push(batch);
      // Big batches can fill the read limit before the page is full. A short
      // page is fine: the cursor carries on from its last row.
      if (await nearReadLimit(ctx)) {
        more = true;
        break;
      }
    }
    const last = batches[batches.length - 1];
    return {
      batches,
      next:
        more && last
          ? {
              start: last.start,
              creationTime: last._creationTime,
              seq: last.seq,
            }
          : null,
    };
  },
});

// One stream: seq order is timeline order, so seq is a complete cursor.
function streamRows(
  ctx: QueryCtx,
  room: string,
  stream: string,
  afterSeq: number | undefined,
) {
  return ctx.db.query("batches").withIndex("by_stream", (q) => {
    const s = q.eq("room", room).eq("stream", stream);
    return afterSeq === undefined ? s : s.gt("seq", afterSeq);
  });
}

// Whole room: many batches can share a start, and the index breaks ties by
// _creationTime. So resume with the rest of the cursor's start, then
// everything after it.
async function* roomRows(
  ctx: QueryCtx,
  room: string,
  after: { start: number; creationTime: number } | undefined,
) {
  const batches = ctx.db.query("batches");
  if (!after) {
    yield* batches.withIndex("by_room_start", (q) => q.eq("room", room));
    return;
  }
  yield* batches.withIndex("by_room_start", (q) =>
    q
      .eq("room", room)
      .eq("start", after.start)
      .gt("_creationTime", after.creationTime),
  );
  yield* batches.withIndex("by_room_start", (q) =>
    q.eq("room", room).gt("start", after.start),
  );
}

// ConvexErrors reach the app's client with their message, even in
// production, where other errors only say "Server Error".
function validate(
  samples: { t: number }[],
  duration: number,
  retentionMs: number | undefined,
) {
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > MAX_DURATION_MS
  ) {
    throw new ConvexError(
      `duration must be between 0 and ${MAX_DURATION_MS} ms`,
    );
  }
  if (samples.length < 1 || samples.length > MAX_SAMPLES) {
    throw new ConvexError(`a batch needs 1 to ${MAX_SAMPLES} samples`);
  }
  let previous = 0;
  for (const { t } of samples) {
    if (!Number.isFinite(t) || t < previous || t > duration) {
      throw new ConvexError(
        "sample times must be non-decreasing and within [0, duration]",
      );
    }
    previous = t;
  }
  if (
    retentionMs !== undefined &&
    (!Number.isFinite(retentionMs) || retentionMs < 0)
  ) {
    throw new ConvexError("retentionMs must be a finite number, 0 or more");
  }
}
