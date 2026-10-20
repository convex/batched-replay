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
    const before = Date.now();
    if (args.stream === undefined) await markCleared(ctx, args.room, before);
    await ctx.runMutation(internal.streams.clearChunk, { ...args, before });
    return null;
  },
});

export const clearChunk = internalMutation({
  args: {
    room: v.string(),
    stream: v.optional(v.string()),
    // When the clear was asked for. Anything written after that is new
    // drawing, made while a big room was still being cleared: keep it.
    before: v.number(),
    // Where the stream docs pass got to, so kept streams aren't re-read.
    afterStream: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { room, stream, before, afterStream }) => {
    const batches = ctx.db.query("batches").withIndex("by_stream", (q) => {
      const r = q.eq("room", room);
      return stream === undefined ? r : r.eq("stream", stream);
    });
    let deleted = 0;
    for await (const batch of batches) {
      if (batch._creationTime <= before) {
        await ctx.db.delete("batches", batch._id);
        deleted++;
      }
      if (deleted === CHUNK || (await nearReadLimit(ctx))) {
        if (deleted > 0) {
          await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
            room,
            stream,
            before,
          });
          return null;
        }
        break; // nothing left in reach but new batches: leave them be
      }
    }
    // Stream docs are small, so a plain row count is enough here. A stream
    // that drew during the clear still has batches, so its doc stays.
    const streamDocs = await ctx.db
      .query("streams")
      .withIndex("by_room", (q) => {
        const r = q.eq("room", room);
        if (stream !== undefined) return r.eq("stream", stream);
        return afterStream === undefined ? r : r.gt("stream", afterStream);
      })
      .take(CHUNK);
    for (const doc of streamDocs) {
      const left = await ctx.db
        .query("batches")
        .withIndex("by_stream", (q) =>
          q.eq("room", room).eq("stream", doc.stream),
        )
        .first();
      if (!left) await ctx.db.delete("streams", doc._id);
    }
    if (streamDocs.length === CHUNK) {
      await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
        room,
        stream,
        before,
        afterStream: streamDocs[streamDocs.length - 1].stream,
      });
      return null;
    }
    // The feed's frames hold copies of the batches, so they go too.
    if (!(await deleteFrames(ctx, room))) {
      await ctx.scheduler.runAfter(0, internal.streams.clearChunk, {
        room,
        stream,
        before,
        afterStream: streamDocs.at(-1)?.stream ?? afterStream,
      });
      return null;
    }
    await bumpEpoch(ctx, room);
    return null;
  },
});

// Deletes a chunk of the room's feed frames. True once they're all gone.
async function deleteFrames(ctx: MutationCtx, room: string) {
  const frames = ctx.db
    .query("frames")
    .withIndex("by_room", (q) => q.eq("room", room));
  let deleted = 0;
  for await (const frame of frames) {
    if (deleted === CHUNK || (await nearReadLimit(ctx))) return false;
    await ctx.db.delete("frames", frame._id);
    deleted++;
  }
  return true;
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
