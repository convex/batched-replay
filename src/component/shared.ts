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
// A whole number between 1 and `max`, or `fallback` when it's missing, NaN
// or infinite.
export function clampCount(
  value: number | undefined,
  fallback: number,
  max: number,
) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), max);
}

// A batch can be as big as a document (1 MiB), and a transaction may read
// 16 MiB, so a row count alone can't keep big batches under the limit. Reads
// (history, latest), clear and the expiry cron also stop once less than this
// is left to read: room for one more full-size batch, with some to spare.
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
