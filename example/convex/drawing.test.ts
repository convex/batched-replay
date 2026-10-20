import { expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

type Pen = { k: "down" | "move" | "up"; x: number; y: number };

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
  const open = await t.run((ctx) => ctx.db.query("openStrokes").collect());
  expect(open.map((s) => s.points)).toEqual([[{ x: 5, y: 5 }]]);

  // Clearing the board leaves the gallery; clearing strokes empties it.
  await t.mutation(api.drawing.clear, {});
  expect(await t.query(api.drawing.recentStrokes, {})).toHaveLength(1);
  await t.mutation(api.drawing.clearStrokes, {});
  expect(await t.query(api.drawing.recentStrokes, {})).toEqual([]);
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
  const [open] = await t.run((ctx) => ctx.db.query("openStrokes").collect());
  expect(open.points.length).toBeLessThanOrEqual(2_000);
});
