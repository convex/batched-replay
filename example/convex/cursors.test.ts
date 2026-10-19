import { expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

test("a cursor batch is stored under the sender's stream", async () => {
  const t = initConvexTest();
  await t.mutation(api.cursors.append, {
    room: "cursors-demo",
    stream: "me",
    samples: [{ t: 0, v: { x: 1, y: 2 } }],
    duration: 100,
  });
  const streams = await t.query(api.cursors.streams, { room: "cursors-demo" });
  expect(streams.map((s) => s.stream)).toEqual(["me"]);
});
