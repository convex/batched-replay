import { v } from "convex/values";
import { exposeApi } from "@convex-dev/batched-replay";
import { components } from "./_generated/api.js";
import { query, type MutationCtx } from "./_generated/server.js";

const ROOM = "racer-demo";

// Each lap is its own stream, "<player>:<lap>", so one lap can be replayed on
// its own: that's how the ghost works.
const LAP_STREAM = /^([\w-]+):(\d+)$/;

const lap = v.object({ stream: v.string(), lapMs: v.number() });

// Laps are kept forever (no retentionMs), so your best lap can always be raced.
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
    // Same anonymous pattern as cursors.ts: the demo has no sign-in.
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream || !LAP_STREAM.test(stream)) {
        throw new Error('The stream key must be "<player>:<lap>"');
      }
      return stream;
    },
    // Keep each finished lap, with its time, in the app's own laps table.
    onAppend: async (ctx: MutationCtx, { room, stream, samples }) => {
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
      }
    },
  },
);

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
