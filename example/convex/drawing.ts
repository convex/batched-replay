import { v } from "convex/values";
import { BatchedReplay, exposeApi } from "@convex-dev/batched-replay";
import { components } from "./_generated/api.js";
import { mutation } from "./_generated/server.js";

const ROOM = "drawing-demo";

// Drawings are kept forever (no retentionMs), so any session can be replayed.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Same anonymous-id pattern as cursors.ts: the demo has no sign-in.
    auth: async (_ctx, operation) => {
      if (operation.type === "write") {
        if (!operation.stream) throw new Error("A stream key is required");
        return operation.stream;
      }
    },
  },
);

// Deleting is destructive, so it isn't part of exposeApi: use the class.
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
