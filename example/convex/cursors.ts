import { components } from "./_generated/api.js";
import { exposeApi } from "@convex-dev/batched-replay";

// Re-export the component's API so the React hooks can call it.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Cursor batches are only interesting live, so keep them for ten minutes.
    retentionMs: 10 * 60_000,
    // The demo has no sign-in, so each browser picks its own anonymous id.
    // A real app returns a key from ctx.auth (e.g. the user's tokenIdentifier)
    // so nobody can write into someone else's stream.
    auth: async (_ctx, operation) => {
      if (operation.type === "write") {
        if (!operation.stream) throw new Error("A stream key is required");
        return operation.stream;
      }
    },
  },
);
