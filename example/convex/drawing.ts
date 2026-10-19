import { v } from "convex/values";
import { BatchedReplay, exposeApi } from "@convex-dev/batched-replay";
import { components } from "./_generated/api.js";
import { mutation } from "./_generated/server.js";

const ROOM = "drawing-demo";

// Drawings are kept forever (no retentionMs), so any session can be replayed.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Pen down, move or up, at a point on the 1600x900 board.
    value: v.object({
      k: v.union(v.literal("down"), v.literal("move"), v.literal("up")),
      x: v.number(),
      y: v.number(),
    }),
    // Same anonymous pattern as cursors.ts: the demo has no sign-in.
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream) throw new Error("A stream key is required");
      return stream;
    },
  },
);

// Deleting is destructive, so it isn't part of exposeApi: use the class.
// Every viewer's onReset fires once it's done.
export const clear = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await new BatchedReplay(components.batchedReplay).clear(ctx, {
      room: ROOM,
    });
    return null;
  },
});
