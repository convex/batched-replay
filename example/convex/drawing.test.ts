import { afterEach, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

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
  const moves = Array.from({ length: 1_000 }, (_, i) => ({
    t: 0,
    v: { k: "move" as const, x: i, y: 0 },
  }));
  for (let i = 0; i < 5; i++) {
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
