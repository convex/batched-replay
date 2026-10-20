import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import {
  CHUNK,
  clampCount,
  nearReadLimit,
  streamListValidator,
} from "./shared.js";

// The room's most recently active streams, newest first, and its epoch.
export const list = query({
  args: { room: v.string(), limit: v.optional(v.number()) },
  returns: streamListValidator,
  handler: async (ctx, args) => {
    const limit = clampCount(args.limit, 100, 1_000);
    const docs = await ctx.db
      .query("streams")
      .withIndex("by_room_lastEnd", (q) => q.eq("room", args.room))
      .order("desc")
      .take(limit);
    const room = await ctx.db
      .query("rooms")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .unique();
    return {
      epoch: room?.epoch ?? 0,
      streams: docs.map(({ stream, firstStart, lastEnd }) => ({
        stream,
        firstStart,
        lastEnd,
      })),
    };
  },
});

// Deletes a stream's (or a whole room's) data a chunk at a time, then bumps
// the room's epoch so every viewer knows to start again.
export const clear = mutation({
  args: { room: v.string(), stream: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const before = Date.now();
    if (args.stream === undefined) await markCleared(ctx, args.room, before);
    await deleteBatches(ctx, { ...args, before });
    return null;
  },
});

// The scheduler's way back into deleteBatches, where the last chunk stopped.
export const clearChunk = internalMutation({
  args: {
    room: v.string(),
    stream: v.optional(v.string()),
    // When the clear was asked for. Anything written after that is new
    // drawing, made while a big room was still being cleared: keep it.
    before: v.number(),
    // The last batch the previous chunk read.
    after: v.optional(v.object({ stream: v.string(), seq: v.number() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteBatches(ctx, args);
    return null;
  },
});

// The same for deleteStreamDocs.
export const clearStreamDocs = internalMutation({
  args: {
    room: v.string(),
    stream: v.optional(v.string()),
    afterStream: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await deleteStreamDocs(ctx, args);
    return null;
  },
});

// Deletes the batches written before the clear, in index order (stream, then
// seq). Each chunk carries on from the last row the previous one read, so the
// batches it keeps are read once and never stop it short.
async function deleteBatches(
  ctx: MutationCtx,
  args: {
    room: string;
    stream?: string;
    before: number;
    after?: { stream: string; seq: number };
  },
) {
  const { room, stream, before, after } = args;
  let deleted = 0;
  for await (const batch of batchesAfter(ctx, room, stream, after)) {
    if (batch._creationTime <= before) {
      await ctx.db.delete("batches", batch._id);
      deleted++;
    }
    if (deleted === CHUNK || (await nearReadLimit(ctx))) {
      await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
        room,
        stream,
        before,
        after: { stream: batch.stream, seq: batch.seq },
      });
      return;
    }
  }
  await deleteStreamDocs(ctx, { room, stream });
}

// A room's (or one stream's) batches in index order, after `after` if given.
async function* batchesAfter(
  ctx: MutationCtx,
  room: string,
  stream: string | undefined,
  after: { stream: string; seq: number } | undefined,
) {
  const batches = ctx.db.query("batches");
  if (!after) {
    yield* batches.withIndex("by_stream", (q) => {
      const r = q.eq("room", room);
      return stream === undefined ? r : r.eq("stream", stream);
    });
    return;
  }
  // The rest of the stream we stopped in...
  yield* batches.withIndex("by_stream", (q) =>
    q.eq("room", room).eq("stream", after.stream).gt("seq", after.seq),
  );
  // ...then, for a whole room, the streams after it.
  if (stream === undefined) {
    yield* batches.withIndex("by_stream", (q) =>
      q.eq("room", room).gt("stream", after.stream),
    );
  }
}

// Deletes the stream docs of streams with no batches left, then bumps the
// epoch. A stream that drew during the clear still has batches, so its doc
// stays.
async function deleteStreamDocs(
  ctx: MutationCtx,
  args: { room: string; stream?: string; afterStream?: string },
) {
  const { room, stream, afterStream } = args;
  const streamDocs = ctx.db.query("streams").withIndex("by_room", (q) => {
    const r = q.eq("room", room);
    if (stream !== undefined) return r.eq("stream", stream);
    return afterStream === undefined ? r : r.gt("stream", afterStream);
  });
  let checked = 0;
  let last: string | undefined;
  for await (const doc of streamDocs) {
    // Checking a stream reads one of its batches, which can be big.
    if (checked === CHUNK || (await nearReadLimit(ctx))) {
      await ctx.scheduler.runAfter(0, internal.streams.clearStreamDocs, {
        room,
        stream,
        afterStream: last ?? afterStream,
      });
      return;
    }
    const left = await ctx.db
      .query("batches")
      .withIndex("by_stream", (q) =>
        q.eq("room", room).eq("stream", doc.stream),
      )
      .first();
    if (!left) await ctx.db.delete("streams", doc._id);
    checked++;
    last = doc.stream;
  }
  await bumpEpoch(ctx, room);
}

async function markCleared(ctx: MutationCtx, room: string, clearedAt: number) {
  const doc = await ctx.db
    .query("rooms")
    .withIndex("by_room", (q) => q.eq("room", room))
    .unique();
  if (doc) await ctx.db.patch("rooms", doc._id, { clearedAt });
  else await ctx.db.insert("rooms", { room, epoch: 0, clearedAt });
}

async function bumpEpoch(ctx: MutationCtx, room: string) {
  const doc = await ctx.db
    .query("rooms")
    .withIndex("by_room", (q) => q.eq("room", room))
    .unique();
  if (doc) await ctx.db.patch("rooms", doc._id, { epoch: doc.epoch + 1 });
  else await ctx.db.insert("rooms", { room, epoch: 1 });
}
