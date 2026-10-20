import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { exposeApi } from "@convex-dev/batched-replay";

// The cursors demo for big rooms (open it with ?feed): every append also goes
// into the room feed, and viewers subscribe to that once instead of to each
// person. Otherwise the same as cursors.ts.
export const { append, latest, history, streams, feed } = exposeApi(
  components.batchedReplay,
  {
    value: v.object({ x: v.number(), y: v.number() }),
    retentionMs: 10 * 60_000,
    feed: true,
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream) throw new Error("A stream key is required");
      return stream;
    },
  },
);
