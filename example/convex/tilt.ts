import { v } from "convex/values";
import { exposeApi } from "@convex-dev/batched-replay";
import { components } from "./_generated/api.js";

// A phone's tilt, played back on the laptop to roll a marble.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Degrees from DeviceOrientationEvent: beta tilts front to back, gamma
    // left to right. flushMs is the phone's setting, so the laptop can show it.
    value: v.object({
      beta: v.number(),
      gamma: v.number(),
      flushMs: v.number(),
    }),
    // Tilt is only interesting live, so keep it for ten minutes.
    retentionMs: 10 * 60_000,
    // Same anonymous pattern as cursors.ts: the demo has no sign-in.
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream) throw new Error("A stream key is required");
      return stream;
    },
  },
);
