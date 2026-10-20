import { getConvexSize, v, type Infer } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { frameBatchValidator } from "./schema.js";
import {
  FEED_COOLDOWN_MS,
  FEED_LOOKBACK_NS,
  FEED_TICK_BATCHES,
  FEED_TICK_BYTES,
  FEED_TICK_MS,
  FRAME_BYTES,
  KEEP_FRAMES,
  frameValidator,
} from "./shared.js";

// The room feed. When it's on, each append pings a Batch Worker loop named
// after its room. Every tick, the loop's work query reads the room's batches
// committed since the last tick, and its worker mutation copies them into a
// frame. Viewers subscribe to the newest frame: one subscription per room
// instead of one per person in it.

type FrameBatch = Infer<typeof frameBatchValidator>;

// How far the feed has got: the last commit it copied and the last frame it
// wrote. Batch Worker stores it for us and hands it back to the next tick.
const feedCursor = v.object({ committed: v.commitTs(), frame: v.number() });

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: {
      room: v.string(),
      epoch: v.number(), // the room's epoch when this tick read it
      cursor: feedCursor, // where this tick started
      upTo: v.commitTs(), // the last commit this tick picked up
      batches: v.array(frameBatchValidator),
    },
    cursor: feedCursor,
  });

/** Called by append when the feed is on: makes sure the room's loop runs. */
export async function pingFeed(ctx: MutationCtx, room: string) {
  await ping(ctx, components.batchWorker, {
    name: room,
    workQuery: internal.feed.nextTick,
    workerMutation: internal.feed.writeFrames,
    // Wait a tick before the first one, so a burst lands in one frame.
    config: { debounceMs: FEED_TICK_MS },
  });
}

// The work query. Batch Worker runs it as a snapshot read with no read
// dependencies, so the appends landing while it reads never conflict with it.
export const nextTick = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { name: room, cursor }) => {
    // A room's first tick starts a little way back rather than at the
    // beginning of its history.
    const from = cursor ?? {
      committed: ctx.meta.getSnapshotTs() - FEED_LOOKBACK_NS,
      frame: -1,
    };
    const rows = ctx.db
      .query("batches")
      .withIndex("by_room_committed", (q) =>
        q.eq("room", room).gt("committed", from.committed),
      );
    const batches: FrameBatch[] = [];
    let bytes = 0;
    let upTo = from.committed;
    for await (const batch of rows) {
      const committed = batch.committed as bigint;
      // Stop between commits, never inside one: the cursor is a commit
      // timestamp, so a commit split in two would lose its second half.
      const full =
        bytes >= FEED_TICK_BYTES || batches.length >= FEED_TICK_BATCHES;
      if (full && committed !== upTo) break;
      const copy = {
        id: batch._id,
        creationTime: batch._creationTime,
        stream: batch.stream,
        seq: batch.seq,
        start: batch.start,
        end: batch.end,
        samples: batch.samples,
      };
      batches.push(copy);
      bytes += getConvexSize(copy);
      upTo = committed;
    }
    if (batches.length === 0) {
      // Keep polling for a while before going idle, so appends after a short
      // pause find the loop still running and their ping is a plain read.
      return {
        kind: "idle" as const,
        cooldownMs: FEED_COOLDOWN_MS,
        pollIntervalMs: FEED_TICK_MS,
      };
    }
    const epoch = await roomEpoch(ctx, room);
    return { batch: { room, epoch, cursor: from, upTo, batches } };
  },
});

// The worker mutation: writes the tick's batches as one or more frames, and
// trims the old ones. Only this loop writes frames, so nothing conflicts.
export const writeFrames = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { room, epoch, cursor, upTo, batches }) => {
    // The room was cleared after the snapshot this tick read, so some of
    // these batches may be gone. Read again from the same place.
    if ((await roomEpoch(ctx, room)) !== epoch) {
      return { cursor, debounceMs: FEED_TICK_MS };
    }
    let frame = cursor.frame;
    for (const group of splitIntoFrames(batches)) {
      frame++;
      await ctx.db.insert("frames", { room, seq: frame, batches: group });
    }
    // Viewers only need the newest frame. Delete as many old ones as were
    // just written (plus one), so the room keeps about KEEP_FRAMES.
    const old = await ctx.db
      .query("frames")
      .withIndex("by_room", (q) =>
        q.eq("room", room).lte("seq", frame - KEEP_FRAMES),
      )
      .take(frame - cursor.frame + 1);
    for (const doc of old) await ctx.db.delete("frames", doc._id);
    return { cursor: { committed: upTo, frame }, debounceMs: FEED_TICK_MS };
  },
});

/**
 * The room's newest frames, newest first (default 1, max 10). This is the
 * live subscription in feed mode. A viewer that misses a frame sees a gap in
 * a stream's seq and fills it from `history`, as with `latest`.
 */
export const latest = query({
  args: { room: v.string(), count: v.optional(v.number()) },
  returns: v.array(frameValidator),
  handler: async (ctx, args) => {
    const count = Math.min(Math.max(args.count ?? 1, 1), 10);
    const frames = await ctx.db
      .query("frames")
      .withIndex("by_room", (q) => q.eq("room", args.room))
      .order("desc")
      .take(count);
    return frames.map((frame) => ({
      seq: frame.seq,
      batches: frame.batches.map(({ id, creationTime, ...batch }) => ({
        _id: id,
        _creationTime: creationTime,
        ...batch,
      })),
    }));
  },
});

// Greedily packs batches into frames that fit in a document. A batch too big
// to copy on its own is left out: viewers fetch it from history when they
// see the gap in its stream.
export function splitIntoFrames(batches: FrameBatch[]): FrameBatch[][] {
  const frames: FrameBatch[][] = [];
  let current: FrameBatch[] = [];
  let bytes = 0;
  for (const batch of batches) {
    const size = getConvexSize(batch);
    if (size > FRAME_BYTES) continue;
    if (bytes + size > FRAME_BYTES) {
      frames.push(current);
      current = [];
      bytes = 0;
    }
    current.push(batch);
    bytes += size;
  }
  if (current.length > 0) frames.push(current);
  return frames;
}

async function roomEpoch(ctx: QueryCtx, room: string) {
  const doc = await ctx.db
    .query("rooms")
    .withIndex("by_room", (q) => q.eq("room", room))
    .unique();
  return doc?.epoch ?? 0;
}
