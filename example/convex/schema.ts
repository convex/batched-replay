import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const point = v.object({ x: v.number(), y: v.number() });

// The app's own copy of the drawing, kept by onAppend in drawing.ts. A new
// window draws the board from it instead of replaying every batch, and the
// Strokes sidebar lists it.
export default defineSchema({
  // Which board a room is on. "Clear board" moves it to the next one.
  boards: defineTable({
    room: v.string(),
    board: v.number(),
  }).index("by_room", ["room"]),

  // Each stream's pen, one document per stream: the last batch it has
  // applied (seq), and the stroke it's in the middle of, if any.
  pens: defineTable({
    room: v.string(),
    stream: v.string(),
    board: v.number(),
    seq: v.number(),
    stroke: v.union(
      v.null(),
      v.object({ startSeq: v.number(), points: v.array(point) }),
    ),
  })
    .index("by_stream", ["room", "stream"])
    .index("by_board", ["room", "board"]),

  // Finished strokes. The board shows the ones on the current board; the
  // Strokes sidebar shows them all, so they outlive "Clear board".
  strokes: defineTable({
    room: v.string(),
    stream: v.string(),
    board: v.number(),
    points: v.array(point),
    startSeq: v.number(),
    endSeq: v.number(),
    endedAt: v.number(), // server time of the pen-up
  }).index("by_board", ["room", "board"]),

  // Finished racer laps, kept by onAppend in racer.ts. Each lap is its own
  // stream in the component, so `stream` is all the ghost needs to replay it.
  laps: defineTable({
    room: v.string(),
    player: v.string(),
    stream: v.string(),
    lapMs: v.number(),
  })
    // Newest first, for the lap list; the other index finds the best lap.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index("by_room_and_player", ["room", "player"])
    .index("by_room_and_player_and_lapMs", ["room", "player", "lapMs"]),
});
