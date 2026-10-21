import { expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

type Car = { x: number; y: number; angle: number; lapMs?: number };
const car = (x: number, lapMs?: number): Car => ({ x, y: 0, angle: 0, lapMs });

function drive(
  t: ReturnType<typeof initConvexTest>,
  stream: string,
  samples: Car[],
) {
  return t.mutation(api.racer.append, {
    room: "racer-demo",
    stream,
    samples: samples.map((v, i) => ({ t: i * 50, v })),
    duration: 100,
  });
}

test("a finished lap is kept with its time, and the fastest is the best", async () => {
  const t = initConvexTest();
  // A lap with no finish (the out lap) keeps nothing.
  await drive(t, "me:0", [car(1)]);
  expect(await t.query(api.racer.laps, { player: "me" })).toEqual({
    best: null,
    recent: [],
  });

  await drive(t, "me:1", [car(1), car(3, 9_000)]);
  await drive(t, "me:2", [car(3, 8_000)]);
  await drive(t, "me:3", [car(3, 8_500)]);
  // Someone else's laps don't count towards yours.
  await drive(t, "you:1", [car(3, 1_000)]);

  const { best, recent } = await t.query(api.racer.laps, { player: "me" });
  expect(best).toEqual({ stream: "me:2", lapMs: 8_000 });
  expect(recent.map((lap) => lap.stream)).toEqual(["me:3", "me:2", "me:1"]);
});

test("the best lap can be replayed on its own, from its stream", async () => {
  const t = initConvexTest();
  await drive(t, "me:1", [car(1)]);
  await drive(t, "me:2", [car(2), car(3, 7_000)]);
  const { best } = await t.query(api.racer.laps, { player: "me" });
  const page = await t.query(api.racer.history, {
    room: "racer-demo",
    stream: best!.stream,
  });
  const xs = page.batches.flatMap((b) => b.samples.map((s) => s.v.x));
  expect(xs).toEqual([2, 3]);
});

test('a stream key that isn\'t "<player>:<lap>" is refused', async () => {
  const t = initConvexTest();
  await expect(drive(t, "me", [car(1)])).rejects.toThrow(/<player>:<lap>/);
  await expect(
    t.mutation(api.racer.append, {
      room: "racer-demo",
      samples: [{ t: 0, v: car(1) }],
      duration: 100,
    }),
  ).rejects.toThrow(/<player>:<lap>/);
});

test("a sample that isn't a car is rejected", async () => {
  const t = initConvexTest();
  await expect(
    t.mutation(api.racer.append, {
      room: "racer-demo",
      stream: "me:1",
      // @ts-expect-error the value validator wants { x, y, angle }
      samples: [{ t: 0, v: { x: 1, y: 2 } }],
      duration: 100,
    }),
  ).rejects.toThrow(/Validator/);
});
