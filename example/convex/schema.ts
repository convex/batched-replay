import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const point = v.object({ x: v.number(), y: v.number() });

// The app's own copy of the drawing, kept by onAppend in drawing.ts. It
// survives "Clear board", which only clears the component's batches.
export default defineSchema({
  // The stroke each stream is drawing right now, one document per stream.
  openStrokes: defineTable({
    room: v.string(),
    stream: v.string(),
    points: v.array(point),
    startSeq: v.number(),
  }).index("by_stream", ["room", "stream"]),

  // Finished strokes, for the gallery.
  strokes: defineTable({
    room: v.string(),
    stream: v.string(),
    points: v.array(point),
    startSeq: v.number(),
    endSeq: v.number(),
    endedAt: v.number(), // server time of the pen-up
  }).index("by_room", ["room"]),
});
