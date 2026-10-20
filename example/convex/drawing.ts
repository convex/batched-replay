import { v } from "convex/values";
import { BatchedReplay, exposeApi } from "@convex-dev/batched-replay";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";

const ROOM = "drawing-demo";
// A long stroke is thinned out rather than allowed to grow without limit, so
// it stays well under Convex's 8,192 array items and 1 MiB per document.
const MAX_POINTS = 2_000;

type Point = { x: number; y: number };

// Drawings are kept forever (no retentionMs), so any session can be replayed.
export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // Pen down, move or up, at a point on the 1600x900 board.
    value: v.object({
      k: v.union(v.literal("down"), v.literal("move"), v.literal("up")),
      x: v.number(),
      y: v.number(),
    }),
    // Same anonymous pattern as cursors.ts: the demo has no sign-in.
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => {
      if (!stream) throw new Error("A stream key is required");
      return stream;
    },
    // Runs inside every append, after the batch is stored. A stroke spans
    // many batches, so each stream's points are collected in its own
    // openStrokes document until the pen goes up.
    onAppend: async (
      ctx: MutationCtx,
      { room, stream, seq, start, samples, dropped },
    ) => {
      const open = await ctx.db
        .query("openStrokes")
        .withIndex("by_stream", (q) => q.eq("room", room).eq("stream", stream))
        .unique();
      // If a clear dropped the start of this batch, the open stroke was cut:
      // start afresh rather than joining across the gap.
      let stroke =
        open && dropped === 0
          ? { startSeq: open.startSeq, points: open.points }
          : null;

      for (const { t, v: sample } of samples) {
        const point = { x: sample.x, y: sample.y };
        // A "down" starts a new stroke, dropping one that never got its "up".
        // A move with no stroke open lost its "down" (to a clear, say), so
        // it starts one too.
        if (sample.k === "down" || !stroke) {
          stroke = { startSeq: seq, points: [] };
        }
        stroke.points = addPoint(stroke.points, point);
        if (sample.k === "up") {
          await ctx.db.insert("strokes", {
            room,
            stream,
            points: stroke.points,
            startSeq: stroke.startSeq,
            endSeq: seq,
            endedAt: start + t,
          });
          stroke = null;
        }
      }

      // Keep where this stream's stroke got to, for its next batch.
      if (!stroke) {
        if (open) await ctx.db.delete("openStrokes", open._id);
      } else if (open) {
        await ctx.db.patch("openStrokes", open._id, stroke);
      } else {
        await ctx.db.insert("openStrokes", { room, stream, ...stroke });
      }
    },
  },
);

// Adds a point, halving the stroke's detail whenever it reaches MAX_POINTS.
function addPoint(points: Point[], point: Point) {
  const kept =
    points.length < MAX_POINTS ? points : points.filter((_, i) => i % 2 === 0);
  return [...kept, point];
}

// The newest finished strokes, for the gallery. Each is thinned to at most
// about 100 points, which is plenty for a thumbnail.
export const recentStrokes = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("strokes"),
      stream: v.string(),
      pointCount: v.number(),
      points: v.array(v.object({ x: v.number(), y: v.number() })),
    }),
  ),
  handler: async (ctx) => {
    const strokes = await ctx.db
      .query("strokes")
      .withIndex("by_room", (q) => q.eq("room", ROOM))
      .order("desc")
      .take(24);
    return strokes.map((stroke) => {
      const step = Math.ceil(stroke.points.length / 100);
      return {
        _id: stroke._id,
        stream: stroke.stream,
        pointCount: stroke.points.length,
        points: stroke.points.filter((_, i) => i % step === 0),
      };
    });
  },
});

// Deleting is destructive, so it isn't part of exposeApi: use the class.
// Every viewer's onReset fires once it's done. The strokes gallery is the
// app's own data, so it stays.
export const clear = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await new BatchedReplay(components.batchedReplay).clear(ctx, {
      room: ROOM,
    });
    return null;
  },
});

// Deletes the gallery, 100 strokes per mutation.
export const clearStrokes = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await deleteSomeStrokes(ctx);
    return null;
  },
});

export const clearMoreStrokes = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await deleteSomeStrokes(ctx);
    return null;
  },
});

async function deleteSomeStrokes(ctx: MutationCtx) {
  const strokes = await ctx.db
    .query("strokes")
    .withIndex("by_room", (q) => q.eq("room", ROOM))
    .take(100);
  for (const stroke of strokes) await ctx.db.delete("strokes", stroke._id);
  if (strokes.length === 100) {
    await ctx.scheduler.runAfter(0, internal.drawing.clearMoreStrokes, {});
  }
}
