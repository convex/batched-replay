import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { exposeApi } from "@convex-dev/batched-replay";

// Re-export the component's API so the React hooks can call it.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // What one sample is. Checked on every append, and it types the hooks.
    value: v.object({ x: v.number(), y: v.number() }),
    // Cursor batches are only interesting live, so keep them for ten minutes.
    retentionMs: 10 * 60_000,
    // The demo has no sign-in: anyone can watch, and each tab picks its own
    // anonymous stream key. See the README for the signed-in version.
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream) throw new Error("A stream key is required");
      return stream;
    },
  },
);
