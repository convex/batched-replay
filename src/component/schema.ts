import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const sampleValidator = v.object({ t: v.number(), v: v.any() });

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
  })
    .index("by_stream", ["room", "stream", "seq"])
    .index("by_room_start", ["room", "start"])
    .index("by_expiresAt", ["expiresAt"]),

  // Kept apart from batches so the stream list doesn't change on every append.
  streams: defineTable({
    room: v.string(),
    stream: v.string(),
    firstStart: v.number(),
    lastEnd: v.number(), // touched at most every TOUCH_MS
  }).index("by_room", ["room", "stream"]),
});
