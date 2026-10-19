import { describe, expect, test } from "vitest";
import { HistoryPlayer, type HistoryPage } from "./history.js";

type Cursor = number;

function setup(pages: HistoryPage<number, Cursor>["batches"][], speed = 1) {
  let clock = 0;
  const played: [string, number, number][] = [];
  const loads: (Cursor | undefined)[] = [];
  const player = new HistoryPlayer<number, Cursor>({
    speed,
    now: () => clock,
    load: async (after) => {
      loads.push(after);
      const i = after ?? 0;
      return { batches: pages[i], next: i + 1 < pages.length ? i + 1 : null };
    },
    onSample: (stream, v, time) => played.push([stream, v, time]),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    player,
    played,
    loads,
    flush,
    advance: (ms: number) => (clock += ms),
  };
}

const page1 = [
  {
    stream: "a",
    start: 1_000,
    samples: [
      { t: 0, v: 1 },
      { t: 500, v: 2 },
    ],
  },
  { stream: "b", start: 1_200, samples: [{ t: 0, v: 10 }] },
];
const page2 = [{ stream: "a", start: 2_000, samples: [{ t: 0, v: 3 }] }];

describe("HistoryPlayer", () => {
  test("plays on a local clock from the first batch", async () => {
    const { player, played, flush, advance } = setup([page1, page2]);
    player.play();
    await flush();
    player.tick();
    expect(played).toEqual([["a", 1, 1_000]]);
    advance(250); // 200 is where b starts
    player.tick();
    expect(played.map((p) => p[1])).toEqual([1, 10]);
    advance(2_000);
    player.tick();
    expect(played.map((p) => p[1])).toEqual([1, 10, 2, 3]); // merged by time
    expect(player.isFinished()).toBe(true);
    expect(player.isPlaying()).toBe(false);
  });

  test("pause holds the position; setSpeed changes the rate", async () => {
    const { player, played, flush, advance } = setup([page1, page2]);
    player.play();
    await flush();
    advance(100);
    player.pause();
    expect(player.position()).toBe(100);
    advance(5_000);
    player.tick();
    expect(player.position()).toBe(100);
    player.play();
    player.setSpeed(10);
    advance(100);
    player.tick();
    expect(player.position()).toBe(1_100);
    expect(played.map((p) => p[1])).toEqual([1, 10, 2, 3]);
  });

  test("loads further pages as playback nears the end of what's loaded", async () => {
    const { player, loads, flush } = setup([page1, page2]);
    player.play();
    await flush();
    // Both pages are within the 10 s prefetch horizon.
    expect(loads).toEqual([undefined, 1]);
  });

  test("instant speed emits everything as it loads", async () => {
    const { player, played, flush } = setup([page1, page2], Infinity);
    player.play();
    await flush();
    player.tick();
    await flush();
    player.tick();
    expect(played.map((p) => p[1])).toEqual([1, 10, 2, 3]);
  });

  test("seek skips to a time without emitting what it skipped", async () => {
    const { player, played, flush, advance } = setup([page1, page2]);
    await player.seek(100); // after the first sample, before b's
    player.play();
    advance(10);
    player.tick();
    expect(player.position()).toBe(110);
    expect(played).toEqual([]);
    advance(1_000);
    player.tick();
    await flush(); // the next page arrives
    player.tick();
    expect(played.map((p) => p[1])).toEqual([10, 2, 3]);
  });

  test("an empty history finishes immediately", async () => {
    const { player, flush } = setup([[]]);
    player.play();
    await flush();
    player.tick();
    expect(player.isFinished()).toBe(true);
  });
});
