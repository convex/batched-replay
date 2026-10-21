import { afterEach, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

afterEach(() => {
  vi.useRealTimers();
});

const pen = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    t: 0,
    v: { k: "move" as const, x: i, y: 0 },
  }));

test("each stream's appends are rate limited, and it can carry on a second later", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const send = (stream: string) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream,
      samples: pen(1),
      duration: 100,
    });
  // Drawing allows 10 appends a second per stream.
  for (let i = 0; i < 10; i++) await send("me");
  await expect(send("me")).rejects.toThrow(/RateLimited/);
  // Another stream has its own limit.
  await send("you");

  vi.advanceTimersByTime(1_000);
  await send("me");
});

test("the cursors limit leaves room for the fastest flush slider setting", async () => {
  vi.useFakeTimers();
  const t = initConvexTest();
  const send = () =>
    t.mutation(api.cursors.append, {
      room: "cursors-demo",
      stream: "me",
      samples: [{ t: 0, v: { x: 1, y: 2 } }],
      duration: 16,
    });
  // A 16 ms flush is about 60 appends a second.
  for (let i = 0; i < 60; i++) {
    await send();
    vi.advanceTimersByTime(16);
  }
});

test("a batch with too many samples is refused, and nothing is stored", async () => {
  const t = initConvexTest();
  const send = (samples: ReturnType<typeof pen>) =>
    t.mutation(api.drawing.append, {
      room: "drawing-demo",
      stream: "me",
      samples,
      duration: 100,
    });
  await expect(send(pen(501))).rejects.toThrow(/at most 500 samples/);
  expect(
    await t.query(api.drawing.streams, { room: "drawing-demo" }),
  ).toMatchObject({ streams: [] });
  await send(pen(500));
});
