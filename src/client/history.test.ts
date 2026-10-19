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

  test("reset goes back to the start and picks up batches written since", async () => {
    const pages = [page1, page2];
    const { player, played, loads, flush, advance } = setup(pages);
    player.play();
    await flush();
    advance(5_000);
    player.tick();
    expect(player.isFinished()).toBe(true);
    expect(played.map((p) => p[1])).toEqual([1, 10, 2, 3]);

    // Someone draws more after everything was loaded.
    pages[1] = [
      ...page2,
      { stream: "b", start: 3_000, samples: [{ t: 0, v: 4 }] },
    ];
    player.reset();
    expect(player.position()).toBe(0);
    expect(player.isPlaying()).toBe(false);
    expect(player.isFinished()).toBe(false);
    expect(player.values().size).toBe(0);
    played.length = 0;
    loads.length = 0;

    player.play();
    await flush();
    advance(5_000);
    player.tick();
    expect(loads).toEqual([undefined, 1]); // from the first page again
    expect(played.map((p) => p[1])).toEqual([1, 10, 2, 3, 4]);
    expect(player.isFinished()).toBe(true);
  });

  test("reset keeps the speed", async () => {
    const { player, flush, advance } = setup([page1, page2]);
    player.setSpeed(10);
    player.reset();
    player.play();
    await flush();
    advance(100);
    player.tick();
    expect(player.position()).toBe(1_000);
  });

  test("a page that arrives after reset is dropped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const played: number[] = [];
    const player = new HistoryPlayer<number, Cursor>({
      speed: Infinity,
      load: async () => {
        if (first) {
          first = false;
          await gate; // the old load is slow
          return { batches: page1, next: null };
        }
        return { batches: page2, next: null };
      },
      onSample: (_s, v) => played.push(v),
    });
    player.play();
    player.reset();
    player.play();
    release();
    await new Promise((r) => setTimeout(r, 0));
    player.tick();
    expect(played).toEqual([3]); // only the page loaded after reset
  });

  test("a failed load backs off, 1 s doubling to 10 s, and reports the error", async () => {
    let clock = 0;
    let failing = true;
    const attempts: number[] = [];
    const player = new HistoryPlayer<number, Cursor>({
      now: () => clock,
      load: async () => {
        attempts.push(clock);
        if (failing) throw new Error("offline");
        return { batches: page1, next: null };
      },
    });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    player.play();
    // Tick every frame (16 ms) for 40 s.
    for (; clock < 40_000; clock += 16) {
      player.tick();
      await flush();
    }
    expect(attempts.length).toBeLessThan(10);
    const waits = attempts.slice(1).map((at, i) => at - attempts[i]);
    expect(waits.slice(0, 5).map((w) => Math.round(w / 1000))).toEqual([
      1, 2, 4, 8, 10,
    ]);
    expect(player.error()).toEqual(new Error("offline"));

    failing = false;
    for (const end = clock + 11_000; clock < end; clock += 16) {
      player.tick();
      await flush();
    }
    expect(player.error()).toBeUndefined();
    expect(player.isFinished()).toBe(true);
  });

  test("idle stretches longer than maxGapMs are cut short", async () => {
    const pages = [
      [
        { stream: "a", start: 0, samples: [{ t: 0, v: 1 }] },
        { stream: "a", start: 500, samples: [{ t: 0, v: 2 }] },
        // An hour of nothing, then more drawing.
        { stream: "a", start: 3_600_000, samples: [{ t: 0, v: 3 }] },
        { stream: "a", start: 3_600_300, samples: [{ t: 0, v: 4 }] },
      ],
    ];
    const { player, played, flush, advance } = setup(pages);
    player.play();
    await flush();
    advance(500);
    player.tick();
    expect(played.map((p) => p[1])).toEqual([1, 2]);
    advance(2_000); // the hour plays as the default 2 s
    player.tick();
    expect(played.map((p) => p[1])).toEqual([1, 2, 3]);
    advance(300);
    player.tick();
    // onSample still gets each sample's real time.
    expect(played.map((p) => p[2])).toEqual([0, 500, 3_600_000, 3_600_300]);
    expect(player.isFinished()).toBe(true);
  });
});
