import { ConvexError, v } from "convex/values";
import { HOUR, RateLimiter, SECOND } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";

// The hosted demo is public and has no sign-in, so these stop one stream
// from flooding it. Each allows a few times what the demo really sends.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  // The flush slider goes down to 16 ms: about 60 appends a second.
  cursors: { kind: "token bucket", rate: 100, period: SECOND },
  // The phone flushes every 50 ms at its fastest: 20 appends a second.
  tilt: { kind: "token bucket", rate: 40, period: SECOND },
  // Drawing and racing flush every 250 ms: 4 appends a second.
  drawing: { kind: "token bucket", rate: 10, period: SECOND },
  racer: { kind: "token bucket", rate: 10, period: SECOND },
});

// A batch is one flush window, which is a few dozen samples. This leaves
// room for the catch-up batch after a short network outage, too.
export const MAX_SAMPLES_PER_APPEND = 500;

// Call from authorizeWrite. Too many appends throws, and the sender retries
// the samples a little later.
export async function limitAppends(
  ctx: MutationCtx,
  demo: "cursors" | "tilt" | "drawing" | "racer",
  stream: string,
) {
  await rateLimiter.limit(ctx, demo, { key: stream, throws: true });
}

// Call from onAppend. It runs in the same transaction as the append, so
// throwing here means the batch isn't stored.
export function limitSamples(samples: unknown[]) {
  if (samples.length > MAX_SAMPLES_PER_APPEND) {
    throw new ConvexError(
      `A batch can have at most ${MAX_SAMPLES_PER_APPEND} samples`,
    );
  }
}

// Every stream key gets its own rate limit document, and anonymous tabs
// make new keys all the time. An hourly cron drops the ones more than an
// hour old: a stream still sending just starts again with a full bucket.
export const deleteOldRateLimits = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(components.rateLimiter.lib.clearAll, {
      before: Date.now() - HOUR,
    });
    return null;
  },
});
