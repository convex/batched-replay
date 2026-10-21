import { afterEach, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, internal } from "./_generated/api";

afterEach(() => {
  vi.useRealTimers();
});

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

test("a player keeps their newest 20 laps, and always their best", async () => {
  const t = initConvexTest();
  // The first lap is the best; the rest are slower.
  await drive(t, "me:1", [car(3, 5_000)]);
  for (let lap = 2; lap <= 25; lap++) {
    await drive(t, `me:${lap}`, [car(3, 9_000 + lap)]);
  }
  const laps = await t.run((ctx) => ctx.db.query("laps").collect());
  expect(laps.map((l) => l.stream)).toEqual([
    "me:1",
    ...Array.from({ length: 19 }, (_, i) => `me:${i + 7}`),
  ]);
  const { best } = await t.query(api.racer.laps, { player: "me" });
  expect(best).toEqual({ stream: "me:1", lapMs: 5_000 });
});

test("old laps are deleted while their history is still there", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  await drive(t, "me:1", [car(3, 8_000)]);
  vi.advanceTimersByTime(21 * 60 * 60_000);
  await drive(t, "me:2", [car(3, 9_000)]);

  await t.mutation(internal.racer.deleteOldLaps, {});
  const { best, recent } = await t.query(api.racer.laps, { player: "me" });
  expect(best).toEqual({ stream: "me:2", lapMs: 9_000 });
  expect(recent.map((lap) => lap.stream)).toEqual(["me:2"]);
  // The lap went before its batches, which are kept for a day.
  const page = await t.query(api.racer.history, {
    room: "racer-demo",
    stream: "me:1",
  });
  expect(page.batches).toHaveLength(1);
  expect(page.batches[0].expiresAt).toBe(page.batches[0].end + 86_400_000);
});
