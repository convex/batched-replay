import { v, type Validator } from "convex/values";
import type { QueryCtx } from "./_generated/server.js";

export const MAX_SAMPLES = 2_000;
export const MAX_DURATION_MS = 60_000;
// A clamped start may sit at most this far after `now - duration`.
export const MAX_CLAMP_MS = 1_000;
// How often a stream's `lastEnd` is rewritten.
export const TOUCH_MS = 5_000;
// The most rows clear and the expiry cron delete in one mutation.
export const CHUNK = 100;
// A batch can be as big as a document (1 MiB), and a transaction may read
// 16 MiB, so a row count alone can't keep big batches under the limit. Clear
// and the expiry cron also stop once less than this is left to read: room for
// one more full-size batch, with some to spare.
export const READ_RESERVE_BYTES = 2 * 1024 * 1024;

// True once the transaction is close to its read limit.
export async function nearReadLimit(ctx: QueryCtx) {
  const { bytesRead } = await ctx.meta.getTransactionMetrics();
  return bytesRead.remaining < READ_RESERVE_BYTES;
}

// A stored batch, with `value` as the validator for each sample's `v`.
export function batchValidatorFor<
  Value extends Validator<any, "required", any>,
>(value: Value) {
  return v.object({
    _id: v.string(),
    _creationTime: v.number(),
    room: v.string(),
    stream: v.string(),
    seq: v.number(),
    start: v.number(),
    end: v.number(),
    samples: v.array(v.object({ t: v.number(), v: value })),
    expiresAt: v.optional(v.number()),
  });
}

export const batchValidator = batchValidatorFor(v.any());

// Where a history page stopped. `seq` resumes one stream, `start` and
// `creationTime` resume a whole room.
export const cursorValidator = v.object({
  start: v.number(),
  creationTime: v.number(),
  seq: v.number(),
});

export function historyPageValidatorFor<
  Value extends Validator<any, "required", any>,
>(value: Value) {
  return v.object({
    batches: v.array(batchValidatorFor(value)),
    // Pass back as `after` for the next page. Null when there are no more.
    next: v.union(cursorValidator, v.null()),
  });
}

export const historyPageValidator = historyPageValidatorFor(v.any());

// The room feed. The worker picks up a room's new batches this often...
export const FEED_TICK_MS = 100;
// ...and keeps ticking (polling) this long after the room goes quiet, so a
// pause doesn't send it idle and every append after it doesn't have to wake it.
export const FEED_COOLDOWN_MS = 10_000;
// One tick reads at most about this much, to stay well inside a
// transaction's limits. The rest waits for the next tick.
export const FEED_TICK_BYTES = 4 * 1024 * 1024;
export const FEED_TICK_BATCHES = 1_000;
// A frame is a document, so it must stay under the 1 MiB limit. A tick with
// more than this is split across several frames.
export const FRAME_BYTES = 768 * 1024;
// Viewers only need the newest frame; a few seconds' worth are kept.
export const KEEP_FRAMES = 50;
// The cron deletes frames older than this, in rooms that went quiet.
export const FRAME_MAX_AGE_MS = 60_000;
// A room's first tick starts this far back (commit timestamps are in ns).
export const FEED_LOOKBACK_NS = 2_000_000_000n;

// One frame of the room feed, with its batches shaped like `latest`'s.
export function frameValidatorFor<
  Value extends Validator<any, "required", any>,
>(value: Value) {
  return v.object({
    seq: v.number(),
    batches: v.array(
      v.object({
        _id: v.string(),
        _creationTime: v.number(),
        stream: v.string(),
        seq: v.number(),
        start: v.number(),
        end: v.number(),
        samples: v.array(v.object({ t: v.number(), v: value })),
      }),
    ),
  });
}

export const frameValidator = frameValidatorFor(v.any());

export const streamListValidator = v.object({
  // Goes up by one each time the room is cleared.
  epoch: v.number(),
  // The most recently active streams, newest first.
  streams: v.array(
    v.object({
      stream: v.string(),
      firstStart: v.number(),
      lastEnd: v.number(),
    }),
  ),
});
