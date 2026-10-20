import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const sampleValidator = v.object({ t: v.number(), v: v.any() });

// A batch as copied into a feed frame. Field names can't start with "_" inside
// a document, so `_id` and `_creationTime` are stored as `id` and `creationTime`.
export const frameBatchValidator = v.object({
  id: v.id("batches"),
  creationTime: v.number(),
  stream: v.string(),
  seq: v.number(),
  start: v.number(),
  end: v.number(),
  samples: v.array(sampleValidator),
});

export default defineSchema({
  // One stream's samples for one flush window.
  batches: defineTable({
    room: v.string(),
    stream: v.string(),
    seq: v.number(), // per stream: 0, 1, 2...
    start: v.number(), // server ms, timeline start of this batch
    end: v.number(), // server ms, start + duration
    samples: v.array(sampleValidator),
    expiresAt: v.optional(v.number()), // undefined = keep forever
    // When the append committed, in commit order (unlike _creationTime). The
    // room feed reads "everything since" with it. Optional so batches written
    // before it existed still validate.
    committed: v.optional(v.commitTs()),
  })
    .index("by_stream", ["room", "stream", "seq"])
    .index("by_room_start", ["room", "start"])
    .index("by_room_committed", ["room", "committed"])
    .index("by_expiresAt", ["expiresAt"]),

  // Kept apart from batches so the stream list doesn't change on every append.
  streams: defineTable({
    room: v.string(),
    stream: v.string(),
    firstStart: v.number(),
    lastEnd: v.number(), // touched at most every TOUCH_MS
  })
    .index("by_room", ["room", "stream"])
    .index("by_room_lastEnd", ["room", "lastEnd"]),

  // Bumped each time a room is cleared, so every viewer finds out.
  rooms: defineTable({
    room: v.string(),
    epoch: v.number(),
    // When the whole room was last cleared. Samples captured before this that
    // arrive late (still in a sender's buffer at the time) are dropped.
    clearedAt: v.optional(v.number()),
  }).index("by_room", ["room"]),

  // The room feed: one doc per room per worker tick, holding copies of the
  // batches that tick picked up, so a viewer subscribes once per room instead
  // of once per stream. Only the newest few are kept.
  frames: defineTable({
    room: v.string(),
    seq: v.number(), // per room: 0, 1, 2...
    batches: v.array(frameBatchValidator), // in commit order
  }).index("by_room", ["room", "seq"]),
});
