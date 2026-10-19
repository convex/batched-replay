import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { sampleValidator } from "./schema.js";
import {
  MAX_CLAMP_MS,
  MAX_DURATION_MS,
  MAX_SAMPLES,
  TOUCH_MS,
  batchValidator,
  cursorValidator,
  historyPageValidator,
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
  returns: v.union(
    v.null(),
    v.object({ seq: v.number(), start: v.number(), end: v.number() }),
  ),
  handler: async (ctx, args) => {
    validate(args.samples, args.duration);
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
    // keep only what was captured after the clear.
    const roomDoc = await ctx.db
      .query("rooms")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique();
    const clearedAt = roomDoc?.clearedAt ?? -Infinity;
    const samples = args.samples.filter((s) => start + s.t >= clearedAt);
    if (samples.length === 0) return null;

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
    return { seq, start, end };
  },
});

export const latest = query({
  args: { room: v.string(), stream: v.string(), count: v.optional(v.number()) },
  returns: v.array(batchValidator),
  handler: async (ctx, args) => {
    const count = Math.min(Math.max(args.count ?? 2, 1), 20);
    const newestFirst = await ctx.db
      .query("batches")
      .withIndex("by_stream", (q) =>
        q.eq("room", args.room).eq("stream", args.stream),
      )
      .order("desc")
      .take(count);
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
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const rows =
      args.stream !== undefined
        ? streamRows(ctx, args.room, args.stream, args.after?.seq)
        : roomRows(ctx, args.room, args.after);
    // Read one extra row to learn whether another page exists.
    const batches = [];
    for await (const batch of rows) {
      batches.push(batch);
      if (batches.length > limit) break;
    }
    const page = batches.slice(0, limit);
    const last = page[page.length - 1];
    return {
      batches: page,
      next:
        batches.length > limit && last
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

// Whole room: many batches can share a start, so resume from `start` and skip
// the ones already returned (the index breaks ties by _creationTime).
function roomRows(
  ctx: QueryCtx,
  room: string,
  after: { start: number; creationTime: number } | undefined,
) {
  const rows = ctx.db.query("batches").withIndex("by_room_start", (q) => {
    const r = q.eq("room", room);
    return after ? r.gte("start", after.start) : r;
  });
  if (!after) return rows;
  // Only skips rows that share `start` with the cursor, so it stays cheap.
  // eslint-disable-next-line @convex-dev/no-filter-in-query
  return rows.filter((q) =>
    q.or(
      q.gt(q.field("start"), after.start),
      q.gt(q.field("_creationTime"), after.creationTime),
    ),
  );
}

function validate(samples: { t: number }[], duration: number) {
  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > MAX_DURATION_MS
  ) {
    throw new Error(`duration must be between 0 and ${MAX_DURATION_MS} ms`);
  }
  if (samples.length < 1 || samples.length > MAX_SAMPLES) {
    throw new Error(`a batch needs 1 to ${MAX_SAMPLES} samples`);
  }
  let previous = 0;
  for (const { t } of samples) {
    if (!Number.isFinite(t) || t < previous || t > duration) {
      throw new Error(
        "sample times must be non-decreasing and within [0, duration]",
      );
    }
    previous = t;
  }
}
