import { v } from "convex/values";
import { exposeApi } from "@convex-dev/batched-replay";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { limitAppends, limitSamples } from "./limits.js";

const ROOM = "racer-demo";

// Each lap is its own stream, "<player>:<lap>", so one lap can be replayed on
// its own: that's how the ghost works.
const LAP_STREAM = /^([\w-]+):(\d+)$/;

const lap = v.object({ stream: v.string(), lapMs: v.number() });

// The demo is public, so laps don't pile up forever. A lap's batches are
// kept for a day, and its entry in the laps table goes well before that, so
// a ghost never points at history that has gone.
const RETENTION_MS = 24 * 60 * 60_000;
const LAP_KEEP_MS = 20 * 60 * 60_000;
// Each player keeps their newest laps, and their best.
const MAX_LAPS_PER_PLAYER = 20;
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Where a car is and which way it points, on the 1600x900 track. The
    // sample that crosses the finish line also carries the lap time, and a
    // car painted from the URL carries its colour.
    value: v.object({
      x: v.number(),
      y: v.number(),
      angle: v.number(),
      lapMs: v.optional(v.number()),
      color: v.optional(v.string()),
    }),
    retentionMs: RETENTION_MS,
    // Same anonymous pattern as cursors.ts: the demo has no sign-in.
    authorizeRead: async () => {},
    authorizeWrite: async (ctx: MutationCtx, { stream }) => {
      if (!stream || !LAP_STREAM.test(stream)) {
        throw new Error('The stream key must be "<player>:<lap>"');
      }
      // The same public limits as cursors.ts.
      await limitAppends(ctx, "racer", stream);
      return stream;
    },
    // Keep each finished lap, with its time, in the app's own laps table.
    onAppend: async (ctx: MutationCtx, { room, stream, samples }) => {
      limitSamples(samples);
      const finished = samples.filter((s) => s.v.lapMs !== undefined);
      if (finished.length === 0) return;
      const player = LAP_STREAM.exec(stream)![1];
      for (const { v: sample } of finished) {
        await ctx.db.insert("laps", {
          room,
          player,
          stream,
          lapMs: sample.lapMs!,
        });
        await dropOldestLap(ctx, room, player);
      }
    },
  },
);

// Past MAX_LAPS_PER_PLAYER, deletes the player's oldest lap, unless that's
// their best, in which case the next oldest goes instead.
async function dropOldestLap(ctx: MutationCtx, room: string, player: string) {
  const oldestFirst = await ctx.db
    .query("laps")
    .withIndex("by_room_and_player", (q) =>
      q.eq("room", room).eq("player", player),
    )
    .take(MAX_LAPS_PER_PLAYER + 1);
  if (oldestFirst.length <= MAX_LAPS_PER_PLAYER) return;
  const best = await ctx.db
    .query("laps")
    .withIndex("by_room_and_player_and_lapMs", (q) =>
      q.eq("room", room).eq("player", player),
    )
    .first();
  const oldest = oldestFirst.find((lap) => lap._id !== best?._id)!;
  await ctx.db.delete("laps", oldest._id);
}

// Runs every hour from crons.ts. Deletes laps older than LAP_KEEP_MS, 100 at
// a time.
export const deleteOldLaps = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const old = await ctx.db
      .query("laps")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - LAP_KEEP_MS),
      )
      .take(100);
    for (const lap of old) await ctx.db.delete("laps", lap._id);
    if (old.length === 100) {
      await ctx.scheduler.runAfter(0, internal.racer.deleteOldLaps, {});
    }
    return null;
  },
});

// A player's best lap (for the ghost) and their last few.
export const laps = query({
  args: { player: v.string() },
  returns: v.object({ best: v.union(lap, v.null()), recent: v.array(lap) }),
  handler: async (ctx, { player }) => {
    const best = await ctx.db
      .query("laps")
      .withIndex("by_room_and_player_and_lapMs", (q) =>
        q.eq("room", ROOM).eq("player", player),
      )
      .first();
    const recent = await ctx.db
      .query("laps")
      .withIndex("by_room_and_player", (q) =>
        q.eq("room", ROOM).eq("player", player),
      )
      .order("desc")
      .take(5);
    const pick = ({ stream, lapMs }: { stream: string; lapMs: number }) => ({
      stream,
      lapMs,
    });
    return { best: best && pick(best), recent: recent.map(pick) };
  },
});
