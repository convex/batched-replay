import { expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

test("clear empties the drawing room and leaves other rooms alone", async () => {
  const t = initConvexTest();
  const samples = [{ t: 0, v: { k: "down", x: 1, y: 2 } }];
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
  expect(drawing).toEqual([]);
  expect(other.map((s) => s.stream)).toEqual(["me"]);
});
