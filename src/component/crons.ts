import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { CHUNK, FRAME_MAX_AGE_MS, nearReadLimit } from "./shared.js";

const streamKey = v.object({ room: v.string(), stream: v.string() });

export const deleteExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    // Batches with no expiresAt have it undefined, which sorts first in the
    // index, so start just above that.
    const expired = ctx.db
      .query("batches")
      .withIndex("by_expiresAt", (q) =>
        q.gt("expiresAt", 0).lt("expiresAt", now),
      );
    const touched = new Map<string, { room: string; stream: string }>();
    let deleted = 0;
    let more = false;
    for await (const batch of expired) {
      await ctx.db.delete("batches", batch._id);
      deleted++;
      touched.set(`${batch.room}\0${batch.stream}`, {
        room: batch.room,
        stream: batch.stream,
      });
      if (deleted === CHUNK || (await nearReadLimit(ctx))) {
        more = true;
        break;
      }
    }
    if (touched.size > 0) {
      await ctx.scheduler.runAfter(0, internal.crons.deleteEmptyStreams, {
        streams: [...touched.values()],
      });
    }
    if (more) {
      await ctx.scheduler.runAfter(0, internal.crons.deleteExpired, {});
    }
    return null;
  },
});

// Drops the stream doc of any stream whose batches have all expired. Its own
// mutation, since checking a stream reads one of its batches (up to 1 MiB).
export const deleteEmptyStreams = internalMutation({
  args: { streams: v.array(streamKey) },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const [i, { room, stream }] of args.streams.entries()) {
      if (await nearReadLimit(ctx)) {
        await ctx.scheduler.runAfter(0, internal.crons.deleteEmptyStreams, {
          streams: args.streams.slice(i),
        });
        return null;
      }
      const remaining = await ctx.db
        .query("batches")
        .withIndex("by_stream", (q) => q.eq("room", room).eq("stream", stream))
        .first();
      if (remaining) continue;
      const doc = await ctx.db
        .query("streams")
        .withIndex("by_room", (q) => q.eq("room", room).eq("stream", stream))
        .unique();
      if (doc) await ctx.db.delete("streams", doc._id);
    }
    return null;
  },
});

// The feed trims its own frames as it goes, but a room that went quiet keeps
// its last few. Those hold copies of batches, so they go after a minute.
export const deleteOldFrames = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = ctx.db
      .query("frames")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - FRAME_MAX_AGE_MS),
      );
    let deleted = 0;
    for await (const frame of old) {
      if (deleted === CHUNK || (await nearReadLimit(ctx))) {
        await ctx.scheduler.runAfter(0, internal.crons.deleteOldFrames, {});
        return null;
      }
      await ctx.db.delete("frames", frame._id);
      deleted++;
    }
    return null;
  },
});

const crons = cronJobs();
crons.interval(
  "delete expired batches",
  { minutes: 1 },
  internal.crons.deleteExpired,
  {},
);
crons.interval(
  "delete old feed frames",
  { minutes: 1 },
  internal.crons.deleteOldFrames,
  {},
);
export default crons;
