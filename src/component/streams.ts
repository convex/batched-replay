import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { CHUNK } from "./shared.js";

export const list = query({
  args: { room: v.string() },
  returns: v.array(
    v.object({
      stream: v.string(),
      firstStart: v.number(),
      lastEnd: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("streams")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .take(1_000);
    return docs.map(({ stream, firstStart, lastEnd }) => ({
      stream,
      firstStart,
      lastEnd,
    }));
  },
});

// Deletes a stream's (or a whole room's) data a chunk at a time.
export const clear = mutation({
  args: { room: v.string(), stream: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.streams.clearChunk, args);
    return null;
  },
});

export const clearChunk = internalMutation({
  args: { room: v.string(), stream: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { room, stream }) => {
    const batches = await ctx.db
      .query("batches")
      .withIndex("by_stream", (q) => {
        const r = q.eq("room", room);
        return stream === undefined ? r : r.eq("stream", stream);
      })
      .take(CHUNK);
    for (const batch of batches) await ctx.db.delete("batches", batch._id);
    if (batches.length === CHUNK) {
      await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
        room,
        stream,
      });
      return null;
    }
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
    }
    return null;
  },
});
