/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommitTsPlaceholder } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { splitIntoFrames } from "./feed.js";
import { initConvexTest } from "./setup.test.js";
import { FEED_TICK_MS, FRAME_BYTES, KEEP_FRAMES } from "./shared.js";

const T0 = 1_000_000;

async function append(
  t: ReturnType<typeof initConvexTest>,
  stream: string,
  feed = true,
) {
  vi.advanceTimersByTime(250);
  await t.mutation(api.batches.append, {
    room: "r",
    stream,
    samples: [{ t: 0, v: stream }],
    duration: 250,
    feed,
  });
}

// Lets the worker run on the fake clock a tick at a time. (vi.runAllTimers
// would jump straight to the worker's 60 s liveness monitor.)
function runWorker(t: ReturnType<typeof initConvexTest>) {
  return t.finishAllScheduledFunctions(
    () => vi.advanceTimersByTime(FEED_TICK_MS),
    1_000,
  );
}

type Cursor = { committed: bigint | CommitTsPlaceholder; frame: number };

// Runs the worker's work query by hand, as Batch Worker would.
async function nextTick(t: ReturnType<typeof initConvexTest>, cursor?: Cursor) {
  const result = await t.query(internal.feed.nextTick, { name: "r", cursor });
  if (!("batch" in result) || !result.batch) throw new Error("expected work");
  return result.batch;
}

// Every batch id across the room's frames, oldest frame first.
async function framedIds(t: ReturnType<typeof initConvexTest>) {
  const frames = await t.run((ctx) =>
    ctx.db
      .query("frames")
      .withIndex("by_room", (q) => q.eq("room", "r"))
      .collect(),
  );
  return frames.flatMap((frame) => frame.batches.map((b) => b.id));
}

async function batchIds(t: ReturnType<typeof initConvexTest>) {
  const batches = await t.run((ctx) =>
    ctx.db
      .query("batches")
      .withIndex("by_room_committed", (q) => q.eq("room", "r"))
      .collect(),
  );
  return batches.map((b) => b._id);
}

describe("the room feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("copies every batch into frames once, in commit order", async () => {
    const t = initConvexTest();
    await append(t, "a");
    await append(t, "b");
    await append(t, "a");
    await runWorker(t);
    // A second burst, after the worker went idle: picked up from its cursor.
    await append(t, "b");
    await append(t, "c");
    await runWorker(t);

    const ids = await batchIds(t);
    expect(ids).toHaveLength(5);
    expect(await framedIds(t)).toEqual(ids);

    const [newest] = await t.query(api.feed.latest, { room: "r" });
    expect(newest.batches.map((b) => b.stream)).toEqual(["b", "c"]);
    expect(newest.batches[0]).toMatchObject({ _id: ids[3], seq: 1 });
    expect(typeof newest.batches[0]._creationTime).toBe("number");
  });

  test("appends landing between ticks are neither lost nor doubled", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 12; i++) {
      await append(t, ["a", "b", "c"][i % 3]);
      // Let a tick or two run before the next append.
      for (let tick = 0; tick < 2; tick++) {
        vi.advanceTimersByTime(FEED_TICK_MS);
        await t.finishInProgressScheduledFunctions();
      }
    }
    await runWorker(t);
    const ids = await batchIds(t);
    expect(ids).toHaveLength(12);
    expect(await framedIds(t)).toEqual(ids);
    const frames = await t.query(api.feed.latest, { room: "r", count: 10 });
    expect(frames.length).toBeGreaterThan(5); // it really did take many ticks
  });

  test("with the feed off, nothing is written to it", async () => {
    const t = initConvexTest();
    await append(t, "a", false);
    await runWorker(t);
    expect(await framedIds(t)).toEqual([]);
    expect(await t.query(api.feed.latest, { room: "r" })).toEqual([]);
    // And latest still returns batches exactly as before.
    const [batch] = await t.query(api.batches.latest, {
      room: "r",
      stream: "a",
    });
    expect(batch).not.toHaveProperty("committed");
  });

  test("ticks run from the cursor and trim old frames", async () => {
    const t = initConvexTest();
    // Drive the work query and worker mutation by hand, as Batch Worker would.
    let cursor: Cursor | undefined;
    for (let i = 0; i < KEEP_FRAMES + 5; i++) {
      await append(t, "a", false);
      const tick = await nextTick(t, cursor);
      expect(tick.batches).toHaveLength(1);
      const done = await t.mutation(internal.feed.writeFrames, tick);
      cursor = done!.cursor;
    }
    expect(cursor!.frame).toBe(KEEP_FRAMES + 4);
    // Nothing new: the work query goes idle.
    const idle = await t.query(internal.feed.nextTick, { name: "r", cursor });
    expect(idle).toMatchObject({ kind: "idle" });

    const frames = await t.run((ctx) => ctx.db.query("frames").collect());
    expect(frames.length).toBeLessThanOrEqual(KEEP_FRAMES);
    expect(frames.at(-1)!.seq).toBe(KEEP_FRAMES + 4);
  });

  test("a tick read before a clear is read again", async () => {
    const t = initConvexTest();
    await append(t, "a", false);
    const tick = await nextTick(t);
    await t.mutation(api.streams.clear, { room: "r" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await t.mutation(internal.feed.writeFrames, tick);
    expect(done!.cursor).toEqual(tick.cursor);
    expect(await framedIds(t)).toEqual([]);
  });

  test("clear deletes the room's frames", async () => {
    const t = initConvexTest();
    await append(t, "a");
    await runWorker(t);
    expect(await framedIds(t)).toHaveLength(1);
    await t.mutation(api.streams.clear, { room: "r" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await framedIds(t)).toEqual([]);
  });

  test("the cron deletes frames in rooms that went quiet", async () => {
    const t = initConvexTest();
    await append(t, "a");
    await runWorker(t);
    expect(await framedIds(t)).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    await t.mutation(internal.crons.deleteOldFrames, {});
    expect(await framedIds(t)).toEqual([]);
  });
});

describe("splitIntoFrames", () => {
  const batch = (seq: number, bytes: number) => ({
    id: `id${seq}` as never,
    creationTime: 0,
    stream: "a",
    seq,
    start: 0,
    end: 0,
    samples: [{ t: 0, v: "x".repeat(bytes) }],
  });

  test("keeps each frame under the document limit, in order", () => {
    const third = Math.floor(FRAME_BYTES / 3);
    const frames = splitIntoFrames([0, 1, 2, 3, 4].map((s) => batch(s, third)));
    expect(frames.map((f) => f.map((b) => b.seq))).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });

  test("leaves out a batch too big to copy", () => {
    const frames = splitIntoFrames([batch(0, 10), batch(1, FRAME_BYTES)]);
    expect(frames.map((f) => f.map((b) => b.seq))).toEqual([[0]]);
  });
});
