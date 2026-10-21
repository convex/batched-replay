import { afterEach, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, internal } from "./_generated/api";

type Pen = { k: "down" | "move" | "up"; x: number; y: number };

afterEach(() => {
  vi.useRealTimers();
});

test("clear empties the drawing room and leaves other rooms alone", async () => {
  const t = initConvexTest();
  const samples = [{ t: 0, v: { k: "down" as const, x: 1, y: 2 } }];
  await t.mutation(api.drawing.append, {
    room: "drawing-demo",
    stream: "me",
    samples,
    duration: 100,
  });
  await t.mutation(api.drawing.append, {
    room: "other",
    stream: "me",
    samples,
    duration: 100,
  });
  await t.mutation(api.drawing.clear, {});
  const drawing = await t.query(api.drawing.streams, { room: "drawing-demo" });
  const other = await t.query(api.drawing.streams, { room: "other" });
  // The epoch going up is what tells every viewer to start again.
  expect(drawing).toEqual({ epoch: 1, streams: [] });
  expect(other.epoch).toBe(0);
  expect(other.streams.map((s) => s.stream)).toEqual(["me"]);
});

test("finished strokes are kept in the app's own table, past a clear", async () => {
  const t = initConvexTest();
  const send = (samples: { t: number; v: Pen }[]) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream: "me",
      samples,
      duration: 100,
    });
  // One stroke over two batches, then the start of another.
  await send([
    { t: 0, v: { k: "down", x: 0, y: 0 } },
    { t: 50, v: { k: "move", x: 10, y: 0 } },
  ]);
  await send([
    { t: 0, v: { k: "move", x: 20, y: 0 } },
    { t: 50, v: { k: "up", x: 30, y: 0 } },
    { t: 100, v: { k: "down", x: 5, y: 5 } },
  ]);
  const strokes = await t.query(api.drawing.recentStrokes, {});
  expect(strokes).toHaveLength(1);
  expect(strokes[0].points.map((p) => p.x)).toEqual([0, 10, 20, 30]);
  const pens = await t.run((ctx) => ctx.db.query("pens").collect());
  expect(pens.map((p) => p.stroke?.points)).toEqual([[{ x: 5, y: 5 }]]);

  // Clearing the board leaves the gallery; clearing strokes empties it.
  await t.mutation(api.drawing.clear, {});
  expect(await t.query(api.drawing.recentStrokes, {})).toHaveLength(1);
  await t.mutation(api.drawing.clearStrokes, {});
  expect(await t.query(api.drawing.recentStrokes, {})).toEqual([]);
});

test("the snapshot is the board so far, up to each pen's last batch", async () => {
  const t = initConvexTest();
  const send = (stream: string, samples: { t: number; v: Pen }[]) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream,
      samples,
      duration: 100,
    });
  // a finishes a stroke and starts another; b is halfway through one.
  await send("a", [
    { t: 0, v: { k: "down", x: 0, y: 0 } },
    { t: 50, v: { k: "up", x: 10, y: 0 } },
  ]);
  await send("a", [{ t: 0, v: { k: "down", x: 1, y: 1 } }]);
  await send("b", [
    { t: 0, v: { k: "down", x: 5, y: 5 } },
    { t: 50, v: { k: "move", x: 6, y: 6 } },
  ]);
  const snapshot = await t.query(api.drawing.snapshot, {});
  expect(snapshot.strokes).toEqual([
    {
      stream: "a",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    },
  ]);
  expect(snapshot.pens).toEqual([
    { stream: "a", seq: 1, points: [{ x: 1, y: 1 }] },
    {
      stream: "b",
      seq: 0,
      points: [
        { x: 5, y: 5 },
        { x: 6, y: 6 },
      ],
    },
  ]);

  // Live playback carries on after each pen's seq: what history has after
  // it is exactly what the snapshot doesn't show yet.
  await send("b", [{ t: 0, v: { k: "up", x: 7, y: 7 } }]);
  const after = await t.query(api.drawing.history, {
    room: "drawing-demo",
    stream: "b",
    after: { seq: snapshot.pens[1].seq, start: 0, creationTime: 0 },
  });
  expect(after.batches.map((b) => b.samples.map((s) => s.v.k))).toEqual([
    ["up"],
  ]);
});

test("after Clear board the snapshot is empty, and a stroke cut by the clear starts afresh", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const send = (samples: { t: number; v: Pen }[]) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream: "me",
      samples,
      duration: 100,
    });
  await send([
    { t: 0, v: { k: "down", x: 0, y: 0 } },
    { t: 50, v: { k: "up", x: 10, y: 0 } },
  ]);
  await send([{ t: 0, v: { k: "down", x: 1, y: 1 } }]);
  await t.mutation(api.drawing.clear, {});
  expect(await t.query(api.drawing.snapshot, {})).toEqual({
    strokes: [],
    pens: [],
  });

  // The open stroke carries on after the clear, but only the part drawn
  // since then is on the new board. The gallery still has the old stroke.
  vi.advanceTimersByTime(1_000);
  await send([
    { t: 0, v: { k: "move", x: 2, y: 2 } },
    { t: 50, v: { k: "up", x: 3, y: 3 } },
  ]);
  const snapshot = await t.query(api.drawing.snapshot, {});
  expect(snapshot.strokes).toEqual([
    {
      stream: "me",
      points: [
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    },
  ]);
  const [last] = await t.query(api.drawing.latest, {
    room: "drawing-demo",
    stream: "me",
  });
  expect(snapshot.pens).toEqual([{ stream: "me", seq: last.seq, points: [] }]);
  expect(await t.query(api.drawing.recentStrokes, {})).toHaveLength(2);
});

test("a very long stroke is thinned out instead of growing forever", async () => {
  const t = initConvexTest();
  // 5,000 points, in batches as big as the demo allows.
  const moves = Array.from({ length: 500 }, (_, i) => ({
    t: 0,
    v: { k: "move" as const, x: i, y: 0 },
  }));
  for (let i = 0; i < 10; i++) {
    await t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream: "me",
      samples: moves,
      duration: 100,
    });
  }
  const [pen] = await t.run((ctx) => ctx.db.query("pens").collect());
  expect(pen.stroke!.points.length).toBeLessThanOrEqual(2_000);
});

test("tidy clears the board once it's been idle for ten minutes, like Clear board", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const send = (stream: string, samples: { t: number; v: Pen }[]) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream,
      samples,
      duration: 100,
    });
  await send("a", [
    { t: 0, v: { k: "down", x: 0, y: 0 } },
    { t: 50, v: { k: "up", x: 10, y: 0 } },
  ]);
  await send("b", [{ t: 0, v: { k: "down", x: 5, y: 5 } }]);

  // Nine minutes on, the board is left alone.
  vi.advanceTimersByTime(9 * 60_000);
  await t.mutation(internal.drawing.tidy, {});
  expect((await t.query(api.drawing.snapshot, {})).strokes).toHaveLength(1);

  // Past ten, it's cleared: snapshot, batches and pens, and every viewer
  // starts again. The finished stroke stays in the gallery.
  vi.advanceTimersByTime(2 * 60_000);
  await t.mutation(internal.drawing.tidy, {});
  expect(await t.query(api.drawing.snapshot, {})).toEqual({
    strokes: [],
    pens: [],
  });
  expect(await t.query(api.drawing.streams, { room: "drawing-demo" })).toEqual({
    epoch: 1,
    streams: [],
  });
  expect(await t.run((ctx) => ctx.db.query("pens").collect())).toEqual([]);
  expect(await t.query(api.drawing.recentStrokes, {})).toHaveLength(1);

  // An empty board isn't cleared again, so viewers aren't reset each minute.
  vi.advanceTimersByTime(60 * 60_000);
  await t.mutation(internal.drawing.tidy, {});
  expect(
    (await t.query(api.drawing.streams, { room: "drawing-demo" })).epoch,
  ).toBe(1);

  // Drawing carries on from the new board, and the snapshot and the
  // history agree on it.
  await send("b", [
    { t: 0, v: { k: "move", x: 6, y: 6 } },
    { t: 50, v: { k: "up", x: 7, y: 7 } },
  ]);
  const snapshot = await t.query(api.drawing.snapshot, {});
  expect(snapshot.strokes.map((s) => s.points)).toEqual([
    [
      { x: 6, y: 6 },
      { x: 7, y: 7 },
    ],
  ]);
  const [last] = await t.query(api.drawing.latest, {
    room: "drawing-demo",
    stream: "b",
  });
  expect(snapshot.pens).toEqual([{ stream: "b", seq: last.seq, points: [] }]);
});

test("tidy keeps the current board and the newest 100 strokes before it", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const send = (samples: { t: number; v: Pen }[]) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream: "me",
      samples,
      duration: 100,
    });
  // 120 strokes, numbered by x, then a clear and one more on the new board.
  const strokes = Array.from({ length: 120 }, (_, x) => [
    { t: 0, v: { k: "down" as const, x, y: 0 } },
    { t: 0, v: { k: "up" as const, x, y: 1 } },
  ]).flat();
  await send(strokes);
  await t.mutation(api.drawing.clear, {});
  vi.advanceTimersByTime(1_000);
  await send([
    { t: 0, v: { k: "down", x: 999, y: 0 } },
    { t: 0, v: { k: "up", x: 999, y: 1 } },
  ]);

  await t.mutation(internal.drawing.tidy, {});
  const kept = await t.run((ctx) => ctx.db.query("strokes").collect());
  const xs = kept.map((s) => s.points[0].x).sort((a, b) => a - b);
  // The oldest 20 went; the current board's stroke is still drawn.
  expect(xs).toEqual([...Array.from({ length: 100 }, (_, i) => i + 20), 999]);
  expect((await t.query(api.drawing.snapshot, {})).strokes).toHaveLength(1);
});
