import { v } from "convex/values";
import { sampleValidator } from "./schema.js";

export const MAX_SAMPLES = 2_000;
export const MAX_DURATION_MS = 60_000;
// A clamped start may sit at most this far after `now - duration`.
export const MAX_CLAMP_MS = 1_000;
// How often a stream's `lastEnd` is rewritten.
export const TOUCH_MS = 5_000;
// Rows deleted per mutation by clear and the expiry cron.
export const CHUNK = 200;

export const batchValidator = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  room: v.string(),
  stream: v.string(),
  seq: v.number(),
  start: v.number(),
  end: v.number(),
  samples: v.array(sampleValidator),
  expiresAt: v.optional(v.number()),
});

// Where a history page stopped. `seq` resumes one stream, `start` and
// `creationTime` resume a whole room.
export const cursorValidator = v.object({
  start: v.number(),
  creationTime: v.number(),
  seq: v.number(),
});

export const historyPageValidator = v.object({
  batches: v.array(batchValidator),
  // Pass back as `after` for the next page. Null when there are no more.
  next: v.union(cursorValidator, v.null()),
});
