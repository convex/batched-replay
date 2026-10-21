import { describe, expect, test, vi } from "vitest";
import { Player, type PlayerBatch } from "./player.js";

type P = { x: number; y: number };

// The server clock is `local + OFFSET`; batches are created at server time.
const OFFSET = 5_000;

function setup(options: ConstructorParameters<typeof Player<P>>[0] = {}) {
  let local = 100_000;
  const played: [string, P, number][] = [];
  const player = new Player<P>({
    delayMs: 400,
    now: () => local,
    onSample: (stream, value, time) => played.push([stream, value, time]),
    ...options,
  });
  return {
    player,
    played,
    xs: () => played.map((p) => p[1].x),
    advance: (ms: number) => (local += ms),
    local: () => local,
    server: () => local + OFFSET,
    // A subscription's first result is history; an empty one makes what
    // follows live.
    subscribe: (stream = "a") => player.ingest(stream, []),
  };
}

const seqs = new Map<string, number>();
let nextId = 0;
// A batch whose server-side creation time is `createdAt` (its end). Each
// stream's batches get the next seq unless one is given.
function batch(
  createdAt: number,
  samples: { t: number; v: P }[],
  options: { duration?: number; seq?: number; stream?: string } = {},
): PlayerBatch<P> {
  const duration = options.duration ?? 250;
  const stream = options.stream ?? "a";
  const seq = options.seq ?? (seqs.get(stream) ?? -1) + 1;
  seqs.set(stream, seq);
  return {
    _id: `b${nextId++}`,
    _creationTime: createdAt,
    seq,
    start: createdAt - duration,
    end: createdAt,
    samples,
  };
}
const at = (x: number) => ({ x, y: 0 });
const one = (x: number) => [{ t: 0, v: at(x) }];

describe("Player", () => {
  test("has no playhead until a live batch arrives", () => {
    const { player, server } = setup();
    expect(player.playhead()).toBeUndefined();
    expect(player.value("a")).toBeUndefined();
    player.tick();
    // A subscription's first batches were written before we listened, so
    // they don't teach us the clock.
    player.ingest("a", [batch(server() - 30_000, one(1))]);
    expect(player.playhead()).toBeUndefined();
    expect(player.clockOffset()).toBeUndefined();
  });

  test("places samples in server time and plays them as the playhead passes", () => {
    const { player, played, advance, server, subscribe } = setup();
    subscribe();
    const b = batch(server(), [
      { t: 0, v: at(1) },
      { t: 100, v: at(2) },
      { t: 250, v: at(3) },
    ]);
    player.ingest("a", [b]);
    // playhead = server - 400 = b.end - 400 = b.start - 150
    expect(player.playhead()).toBe(b.start - 150);
    player.tick();
    expect(played).toEqual([]);
    advance(150 + 100); // reaches start + 100
    player.tick();
    expect(played).toEqual([
      ["a", at(1), b.start],
      ["a", at(2), b.start + 100],
    ]);
    advance(200);
    player.tick();
    expect(played.map((p) => p[1].x)).toEqual([1, 2, 3]);
  });

  test("emits in order across batches, once each", () => {
    const { player, xs, advance, server, subscribe } = setup();
    subscribe();
    const first = batch(server(), one(1));
    const second = batch(server() + 250, one(2));
    player.ingest("a", [first]);
    player.ingest("a", [first, second]); // `latest` re-sends batch 1
    advance(2_000);
    player.tick();
    player.tick();
    expect(xs()).toEqual([1, 2]);
  });

  test("ignores a batch it has already seen", () => {
    const { player, server, subscribe } = setup();
    subscribe();
    const b = batch(server(), one(1));
    player.ingest("a", [b]);
    player.ingest("a", [b]);
    expect(player.stats().batchesPerSecond).toBeCloseTo(1 / 5);
  });

  test("a late batch still ahead of the playhead plays normally", () => {
    const { player, xs, advance, server, subscribe } = setup();
    subscribe();
    player.ingest("a", [batch(server(), [{ t: 250, v: at(1) }])]);
    advance(250);
    // The next batch is created now but only arrives 100 ms later.
    const created = server();
    advance(100);
    player.ingest("a", [batch(created, [{ t: 250, v: at(2) }])]);
    advance(1_000);
    player.tick();
    expect(xs()).toEqual([1, 2]);
  });

  test("live samples are emitted however late they are", () => {
    const { player, xs, advance, server, subscribe } = setup();
    subscribe();
    player.ingest("a", [batch(server(), one(0))]);
    advance(2_000);
    player.tick();
    // Arrives 10 s after it was written: behind the playhead, still emitted.
    player.ingest("a", [batch(server() - 10_000, one(1))]);
    player.tick();
    expect(xs()).toEqual([0, 1]);
  });

  test("a hidden tab that stops ticking misses nothing", () => {
    const { player, xs, advance, server, subscribe } = setup();
    subscribe();
    // Batches keep arriving for 20 s, but nobody calls tick.
    for (let i = 0; i < 80; i++) {
      player.ingest("a", [
        batch(server(), [
          { t: 0, v: at(2 * i) },
          { t: 125, v: at(2 * i + 1) },
        ]),
      ]);
      advance(250);
    }
    player.tick(); // the tab is visible again
    // All but the very last sample, which is still ahead of the playhead.
    expect(xs()).toEqual(Array.from({ length: 159 }, (_, i) => i));
    advance(1_000);
    player.tick();
    expect(xs()).toHaveLength(160);
  });

  describe("a subscription's first batches", () => {
    test("before any live batch, show the last known value and play nothing", () => {
      const { player, played, server } = setup();
      player.ingest("a", [
        batch(server() - 30_000, one(1)),
        batch(server() - 29_750, one(2)),
      ]);
      player.tick();
      expect(player.value("a")).toEqual(at(2)); // held, not replayed
      expect(played).toEqual([]);
    });

    test("once the clock is known, old ones are skipped and new ones play", () => {
      const { player, xs, advance, server, subscribe } = setup();
      subscribe("a");
      player.ingest("a", [batch(server(), one(1))]); // the clock is known
      // b went quiet 30 s ago; c started a moment ago.
      player.ingest("b", [batch(server() - 30_000, one(100), { stream: "b" })]);
      player.ingest("c", [batch(server() - 200, one(200), { stream: "c" })]);
      advance(1_000);
      player.tick();
      expect(xs().sort()).toEqual([1, 200]);
      expect(player.value("b")).toEqual(at(100));
    });

    test("don't move the clock or the automatic delay", () => {
      const { player, advance, server, subscribe } = setup({
        delayMs: undefined,
      });
      subscribe("a");
      player.ingest("a", [batch(server(), one(1))]);
      player.tick();
      const offset = player.clockOffset();
      const delay = player.stats().delayMs;
      advance(100);
      player.ingest("b", [batch(server() - 60_000, one(2), { stream: "b" })]);
      player.tick();
      expect(player.clockOffset()).toBe(offset);
      expect(player.stats().delayMs).toBe(delay);
    });
  });

  test("a new stream shows its first value right away, then holds the last", () => {
    const { player, advance, server, subscribe } = setup();
    subscribe();
    player.ingest("a", [
      batch(server(), [
        { t: 0, v: at(1) },
        { t: 250, v: at(9) },
      ]),
    ]);
    expect(player.value("a")).toEqual(at(1));
    advance(10_000);
    expect(player.value("a")).toEqual(at(9)); // out of buffer
  });

  test("steps between samples unless interpolating", () => {
    const { player, advance, server, subscribe } = setup();
    subscribe();
    player.ingest("a", [
      batch(server(), [
        { t: 0, v: at(0) },
        { t: 200, v: at(100) },
      ]),
    ]);
    advance(150 + 100); // halfway between the two samples
    expect(player.value("a")).toEqual(at(0));
  });

  test("interpolates numeric fields", () => {
    const t = setup({ interpolate: true });
    t.subscribe();
    t.player.ingest("a", [
      batch(t.server(), [
        { t: 0, v: { x: 0, y: 10 } },
        { t: 200, v: { x: 100, y: 20 } },
      ]),
    ]);
    t.advance(150 + 100);
    expect(t.player.value("a")).toEqual({ x: 50, y: 15 });
  });

  test("accepts a custom interpolation function", () => {
    const blend = vi.fn((a: P, _b: P, _alpha: number) => ({ ...a, x: -1 }));
    const t = setup({ interpolate: blend });
    t.subscribe();
    t.player.ingest("a", [
      batch(t.server(), [
        { t: 0, v: at(0) },
        { t: 200, v: at(100) },
      ]),
    ]);
    t.advance(250);
    expect(t.player.value("a")).toEqual({ x: -1, y: 0 });
    expect(blend.mock.calls[0][2]).toBeCloseTo(0.5);
  });

  test("estimates the server clock from the batch with the least delay", () => {
    const { player, advance, local, subscribe } = setup({ delayMs: 0 });
    subscribe();
    // Arrives 300 ms after creation, then one 20 ms after.
    player.ingest("a", [batch(local() + OFFSET - 300, one(1))]);
    advance(500);
    player.ingest("a", [batch(local() + OFFSET - 20, one(2))]);
    // The estimate follows the 20 ms one: server = local + OFFSET - 20.
    expect(player.playhead()).toBe(local() + OFFSET - 20);
  });

  test("forgets old clock readings", () => {
    const { player, advance, local, subscribe } = setup({ delayMs: 0 });
    subscribe();
    player.ingest("a", [batch(local() + OFFSET, one(1))]);
    advance(20_000);
    // The clock drifted 100 ms; the old reading is out of the 10 s window.
    player.ingest("a", [batch(local() + OFFSET + 100, one(2))]);
    expect(player.playhead()).toBe(local() + OFFSET + 100);
  });

  test("reports stats", () => {
    const { player, server, subscribe } = setup();
    subscribe();
    player.ingest("a", [
      batch(server(), [
        { t: 0, v: at(1) },
        { t: 250, v: at(2) },
      ]),
    ]);
    const stats = player.stats();
    expect(stats.delayMs).toBe(400);
    expect(stats.samplesPerSecond).toBeCloseTo(2 / 5);
    expect(stats.bufferedMs.a).toBe(400); // ends at server(), playhead 400 behind
    expect(player.streams()).toEqual(["a"]);
  });

  describe("automatic delay", () => {
    // Ticks every 50 ms for `ms`.
    function run(t: ReturnType<typeof setup>, ms: number) {
      for (let i = 0; i < ms / 50; i++) {
        t.advance(50);
        t.player.tick();
      }
    }

    test("settles on how late live batches arrive", () => {
      const t = setup({ delayMs: undefined });
      // A new subscription's first result: written before we listened.
      t.player.ingest("a", [batch(t.server() - 1_000, one(1))]);
      t.player.tick();
      expect(t.player.stats().delayMs).toBe(400); // untouched by history

      // Live batches that each turn up 250 ms after their first sample.
      for (let i = 0; i < 12; i++) {
        t.advance(250);
        t.player.ingest("a", [batch(t.server(), one(i))]);
        run(t, 200);
      }
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 50, 0);
    });

    test("grows quickly when batches start arriving later", () => {
      const t = setup({ delayMs: undefined });
      t.subscribe();
      for (let i = 0; i < 4; i++) {
        t.player.ingest("a", [batch(t.server(), one(i))]);
        run(t, 250);
      }
      // Now each batch shows up 400 ms after it was written.
      const late = (i: number) =>
        t.player.ingest("a", [batch(t.server() - 400, one(i))]);
      late(10);
      run(t, 500);
      expect(t.player.stats().delayMs).toBeGreaterThan(300 + 90);
      for (let i = 11; i < 20; i++) {
        late(i);
        run(t, 250);
      }
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 400 + 50, 0);
    });

    test("one very late batch doesn't drag the delay up; it just plays late", () => {
      const t = setup({ delayMs: undefined });
      t.subscribe();
      for (let i = 0; i < 4; i++) {
        t.player.ingest("a", [batch(t.server(), one(i))]);
        run(t, 250);
      }
      // A 60 s batch, sent in one go after a blip.
      t.player.ingest("a", [batch(t.server(), one(99), { duration: 60_000 })]);
      run(t, 1_000);
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 50, 0);
      expect(t.xs()).toContain(99);
    });

    test("never goes past maxDelayMs", () => {
      const t = setup({ delayMs: undefined, maxDelayMs: 1_000 });
      t.subscribe();
      for (let i = 0; i < 4; i++) {
        t.player.ingest("a", [batch(t.server(), one(i))]);
        run(t, 250);
      }
      for (let i = 0; i < 8; i++) {
        t.player.ingest("a", [batch(t.server() - 900, one(i))]);
        run(t, 250);
      }
      // 900 ms late + a 250 ms window is more than 1,000: left out.
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 50, 0);
      for (let i = 0; i < 12; i++) {
        t.player.ingest("a", [batch(t.server() - 600, one(i))]);
        run(t, 250);
      }
      expect(t.player.stats().delayMs).toBeLessThanOrEqual(1_000);
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 600 + 50, 0);
    });

    test("leaves a fixed delay alone", () => {
      const t = setup({ delayMs: 400 });
      t.subscribe();
      t.player.ingest("a", [batch(t.server(), one(1))]);
      t.advance(250);
      t.player.ingest("a", [batch(t.server() - 900, one(2))]);
      run(t, 2_000);
      expect(t.player.stats().delayMs).toBe(400);
    });
  });

  describe("gaps", () => {
    test("a fill that makes progress earns more time for the rest", async () => {
      const releases: ((batches: PlayerBatch<P>[]) => void)[] = [];
      const fetchAfter = vi.fn(
        () => new Promise<PlayerBatch<P>[]>((r) => releases.push(r)),
      );
      const t = setup({ fetchAfter });
      t.subscribe();
      const base = t.server();
      const b = (seq: number) => batch(base + seq * 250, one(seq), { seq });
      t.player.ingest("a", [b(0)]);
      t.player.ingest("a", [b(5)]); // 1 to 4 are missing
      t.advance(1_500);
      releases[0]([b(1), b(2)]); // first page: progress
      await Promise.resolve();
      t.advance(1_500); // 3 s since the gap opened, 1.5 s since progress
      t.player.tick();
      expect(t.xs()).toEqual([0, 1, 2]); // still waiting for 3 and 4
      releases[1]([b(3), b(4)]);
      await Promise.resolve();
      t.player.tick();
      expect(t.xs()).toEqual([0, 1, 2, 3, 4, 5]);
    });

    test("missing batches are fetched, and everything plays in order", async () => {
      let release: (batches: PlayerBatch<P>[]) => void = () => {};
      const fetchAfter = vi.fn(
        () => new Promise<PlayerBatch<P>[]>((r) => (release = r)),
      );
      const t = setup({ fetchAfter });
      t.subscribe();
      const b0 = batch(t.server(), one(0), { seq: 0 });
      const b1 = batch(t.server() + 250, one(1), { seq: 1 });
      const b2 = batch(t.server() + 500, one(2), { seq: 2 });
      const b3 = batch(t.server() + 750, one(3), { seq: 3 });
      t.player.ingest("a", [b0]);
      // The subscription skipped ahead: 1 and 2 were never delivered.
      t.advance(750);
      t.player.ingest("a", [b3]);
      expect(fetchAfter).toHaveBeenCalledWith("a", 0);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([0]); // 3 waits for the missing ones
      release([b1, b2, b3]);
      await Promise.resolve();
      t.player.tick();
      expect(t.xs()).toEqual([0, 1, 2, 3]);
    });

    test("plays on without them if they don't come", () => {
      const fetchAfter = vi.fn(() => new Promise<PlayerBatch<P>[]>(() => {}));
      const t = setup({ fetchAfter });
      t.subscribe();
      t.player.ingest("a", [batch(t.server(), one(0), { seq: 0 })]);
      t.player.ingest("a", [batch(t.server(), one(5), { seq: 5 })]);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([0]);
      t.advance(2_000);
      t.player.tick();
      expect(t.xs()).toEqual([0, 5]);
    });

    test("without fetchAfter, plays on straight away", () => {
      const t = setup();
      t.subscribe();
      t.player.ingest("a", [batch(t.server(), one(0), { seq: 0 })]);
      t.player.ingest("a", [batch(t.server() + 250, one(5), { seq: 5 })]);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([0, 5]);
    });

    test("a seq that goes backwards means the stream was cleared", () => {
      const t = setup();
      t.subscribe();
      t.player.ingest("a", [batch(t.server(), one(1), { seq: 7 })]);
      t.advance(1_000);
      t.player.tick();
      // An old batch re-delivered is ignored...
      t.player.ingest("a", [batch(t.server() - 5_000, one(2), { seq: 6 })]);
      // ...but a newer one at seq 0 starts the stream again.
      t.player.ingest("a", [batch(t.server(), one(3), { seq: 0 })]);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([1, 3]);
      expect(t.player.value("a")).toEqual(at(3));
    });
  });

  describe("from the start", () => {
    function historyBatch(stream: string, b: PlayerBatch<P>) {
      return { ...b, stream };
    }

    test("history plays at once, then live carries on with no gap and nothing twice", async () => {
      const fetchAfter = vi.fn(async (stream: string, seq: number) =>
        stored.filter((b) => b.stream === stream && b.seq > seq),
      );
      const t = setup({ fromStart: true, fetchAfter });
      const stored = [
        historyBatch("a", batch(t.server() - 9_000, one(1), { seq: 0 })),
        historyBatch("b", batch(t.server() - 8_000, one(10), { seq: 0 })),
        historyBatch("a", batch(t.server() - 7_000, one(2), { seq: 1 })),
      ];
      const pages = [stored.slice(0, 2), stored.slice(2)];
      const done = await t.player.loadHistory(async (after?: number) => {
        const i = after ?? 0;
        return { batches: pages[i], next: i + 1 < pages.length ? i + 1 : null };
      });
      expect(done).toBe(true);
      expect(t.xs()).toEqual([1, 10, 2]);

      // Meanwhile a drew batch 2, and c (a new stream) drew 0 to 2. The
      // subscriptions' first results overlap the history and skip c's 0.
      const a2 = historyBatch("a", batch(t.server() - 100, one(3), { seq: 2 }));
      const c = [0, 1, 2].map((seq) =>
        historyBatch(
          "c",
          batch(t.server() - 300 + 100 * seq, one(20 + seq), { seq }),
        ),
      );
      stored.push(a2, ...c);
      t.player.ingest("a", [stored[2], a2]);
      t.player.ingest("c", [c[1], c[2]]);
      await Promise.resolve();
      expect(fetchAfter).toHaveBeenCalledWith("c", -1);
      // No live batch yet, so no clock: what's new plays straight away.
      t.player.tick();
      expect(t.xs()).toEqual([1, 10, 2, 3, 20, 21, 22]);

      // Live from here.
      t.player.ingest("a", [a2, batch(t.server(), one(4), { seq: 3 })]);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([1, 10, 2, 3, 20, 21, 22, 4]);
    });

    test("after a snapshot, live carries on from the next batch", async () => {
      const fetchAfter = vi.fn(async (stream: string, seq: number) =>
        stored.filter((b) => b.stream === stream && b.seq > seq),
      );
      const t = setup({ fromStart: true, fetchAfter });
      const stored = [0, 1, 2, 3].map((seq) =>
        historyBatch(
          "a",
          batch(t.server() - 1_000 + 100 * seq, one(seq), { seq }),
        ),
      );
      // The app's snapshot already shows a up to batch 1, and nothing of b.
      t.player.startAfter([{ stream: "a", seq: 1 }]);
      // a's subscription starts at 3, so 2 is fetched; 1 is never played.
      t.player.ingest("a", [stored[1], stored[3]]);
      await Promise.resolve();
      expect(fetchAfter).toHaveBeenCalledWith("a", 1);
      // b isn't in the snapshot, so its old first batch still plays.
      t.player.ingest("b", [
        batch(t.server() - 5_000, one(10), { seq: 0, stream: "b" }),
      ]);
      t.player.tick();
      expect(t.xs()).toEqual([2, 3, 10]);
      // The covered batch delivered again (a newer subscription result) is
      // still skipped, and live carries on.
      t.player.ingest("a", [stored[3], batch(t.server(), one(4), { seq: 4 })]);
      t.advance(1_000);
      t.player.tick();
      expect(t.xs()).toEqual([2, 3, 10, 4]);
    });

    test("a history load cut short by reset reports it", async () => {
      const t = setup({ fromStart: true });
      let release: () => void = () => {};
      const loading = t.player.loadHistory(async () => {
        await new Promise<void>((r) => (release = r));
        return {
          batches: [{ ...batch(t.server(), one(1)), stream: "a" }],
          next: null,
        };
      });
      t.player.reset();
      release();
      expect(await loading).toBe(false);
      expect(t.played).toEqual([]);
    });
  });

  test("reset drops everything buffered and keeps the clock", () => {
    const t = setup();
    t.subscribe();
    t.player.ingest("a", [batch(t.server(), one(1))]);
    const playhead = t.player.playhead();
    t.player.reset();
    t.advance(1_000);
    t.player.tick();
    expect(t.played).toEqual([]);
    expect(t.player.streams()).toEqual([]);
    expect(t.player.playhead()).toBe(playhead! + 1_000);
  });
});
