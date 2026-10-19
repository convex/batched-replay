import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { CHUNK } from "./shared.js";

export const deleteExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    // Batches with no expiresAt have it undefined, which sorts first in the
    // index, so start just above that.
    const expired = await ctx.db
      .query("batches")
      .withIndex("by_expiresAt", (q) =>
        q.gt("expiresAt", 0).lt("expiresAt", now),
      )
      .take(CHUNK);
    for (const batch of expired) await ctx.db.delete("batches", batch._id);

    // Drop the stream doc of any stream whose last batch just expired.
    const touched = new Set(expired.map((b) => `${b.room}\0${b.stream}`));
    for (const key of touched) {
      const [room, stream] = key.split("\0");
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

    if (expired.length === CHUNK) {
      await ctx.scheduler.runAfter(0, internal.crons.deleteExpired, {});
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
export default crons;
