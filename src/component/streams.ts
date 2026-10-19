import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { CHUNK, nearReadLimit, streamListValidator } from "./shared.js";

// The room's most recently active streams, newest first, and its epoch.
export const list = query({
  args: { room: v.string(), limit: v.optional(v.number()) },
  returns: streamListValidator,
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 1_000);
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
    if (args.stream === undefined) await markCleared(ctx, args.room);
    await ctx.runMutation(internal.streams.clearChunk, args);
    return null;
  },
});

export const clearChunk = internalMutation({
  args: { room: v.string(), stream: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { room, stream }) => {
    const batches = ctx.db.query("batches").withIndex("by_stream", (q) => {
      const r = q.eq("room", room);
      return stream === undefined ? r : r.eq("stream", stream);
    });
    let deleted = 0;
    for await (const batch of batches) {
      await ctx.db.delete("batches", batch._id);
      deleted++;
      if (deleted === CHUNK || (await nearReadLimit(ctx))) {
        await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
          room,
          stream,
        });
        return null;
      }
    }
    // Stream docs are small, so a plain row count is enough here.
    const streamDocs = await ctx.db
      .query("streams")
      .withIndex("by_room", (q) => {
        const r = q.eq("room", room);
        return stream === undefined ? r : r.eq("stream", stream);
      })
      .take(CHUNK);
    for (const doc of streamDocs) await ctx.db.delete("streams", doc._id);
    if (streamDocs.length === CHUNK) {
      await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
        room,
        stream,
      });
      return null;
    }
    await bumpEpoch(ctx, room);
    return null;
  },
});

async function markCleared(ctx: MutationCtx, room: string) {
  const doc = await ctx.db
    .query("rooms")
    .withIndex("by_room", (q) => q.eq("room", room))
    .unique();
  const clearedAt = Date.now();
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
