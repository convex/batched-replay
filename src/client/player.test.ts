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
    advance: (ms: number) => (local += ms),
    local: () => local,
    server: () => local + OFFSET,
  };
}

let nextId = 0;
// A batch whose server-side creation time is `createdAt` (its end).
function batch(
  createdAt: number,
  samples: { t: number; v: P }[],
  duration = 250,
): PlayerBatch<P> {
  return {
    _id: `b${nextId++}`,
    _creationTime: createdAt,
    start: createdAt - duration,
    end: createdAt,
    samples,
  };
}
const at = (x: number) => ({ x, y: 0 });

describe("Player", () => {
  test("has no playhead until a batch arrives", () => {
    const { player } = setup();
    expect(player.playhead()).toBeUndefined();
    expect(player.value("a")).toBeUndefined();
    player.tick();
  });

  test("places samples in server time and plays them as the playhead passes", () => {
    const { player, played, advance, server } = setup();
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
    const { player, played, advance, server } = setup();
    const first = batch(server(), [{ t: 0, v: at(1) }]);
    const second = batch(server() + 250, [{ t: 0, v: at(2) }]);
    player.ingest("a", [first]);
    player.ingest("a", [first, second]); // `latest` re-sends batch 1
    advance(2_000);
    player.tick();
    player.tick();
    expect(played.map((p) => p[1].x)).toEqual([1, 2]);
  });

  test("ignores a batch it has already seen", () => {
    const { player } = setup();
    const b = batch(100_000 + OFFSET, [{ t: 0, v: at(1) }]);
    player.ingest("a", [b]);
    player.ingest("a", [b]);
    expect(player.stats().batchesPerSecond).toBeCloseTo(1 / 5);
  });

  test("a late batch still ahead of the playhead plays normally", () => {
    const { player, played, advance, server } = setup();
    player.ingest("a", [batch(server(), [{ t: 250, v: at(1) }])]);
    advance(250);
    // The next batch is created now but only arrives 100 ms later.
    const created = server();
    advance(100);
    player.ingest("a", [batch(created, [{ t: 250, v: at(2) }])]);
    advance(1_000);
    player.tick();
    expect(played.map((p) => p[1].x)).toEqual([1, 2]);
  });

  test("samples already behind the playhead are emitted immediately unless old", () => {
    const { player, played, advance, server } = setup();
    player.ingest("a", [batch(server(), [{ t: 0, v: at(0) }])]);
    advance(2_000);
    // Arrives 2 s late: behind the playhead, but fresh enough.
    player.ingest("a", [batch(server() - 1_000, [{ t: 250, v: at(1) }])]);
    // Arrives 10 s late: too old to replay.
    player.ingest("a", [batch(server() - 10_000, [{ t: 250, v: at(2) }])]);
    player.tick();
    expect(played.map((p) => p[1].x)).toEqual([0, 1]);
  });

  test("a new stream shows its first value right away, then holds the last", () => {
    const { player, advance, server } = setup();
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
    const { player, advance, server } = setup();
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
    const { player, advance, server } = setup({ interpolate: true });
    player.ingest("a", [
      batch(server(), [
        { t: 0, v: { x: 0, y: 10 } },
        { t: 200, v: { x: 100, y: 20 } },
      ]),
    ]);
    advance(150 + 100);
    expect(player.value("a")).toEqual({ x: 50, y: 15 });
  });

  test("accepts a custom interpolation function", () => {
    const blend = vi.fn((a: P, _b: P, _alpha: number) => ({ ...a, x: -1 }));
    const { player, advance, server } = setup({ interpolate: blend });
    player.ingest("a", [
      batch(server(), [
        { t: 0, v: at(0) },
        { t: 200, v: at(100) },
      ]),
    ]);
    advance(250);
    expect(player.value("a")).toEqual({ x: -1, y: 0 });
    expect(blend.mock.calls[0][2]).toBeCloseTo(0.5);
  });

  test("estimates the server clock from the batch with the least delay", () => {
    const { player, advance, local } = setup({ delayMs: 0 });
    // Arrives 300 ms after creation, then one 20 ms after.
    player.ingest("a", [batch(local() + OFFSET - 300, [{ t: 0, v: at(1) }])]);
    advance(500);
    player.ingest("a", [batch(local() + OFFSET - 20, [{ t: 0, v: at(2) }])]);
    // The estimate follows the 20 ms one: server = local + OFFSET - 20.
    expect(player.playhead()).toBe(local() + OFFSET - 20);
  });

  test("forgets old clock readings", () => {
    const { player, advance, local } = setup({ delayMs: 0 });
    player.ingest("a", [batch(local() + OFFSET, [{ t: 0, v: at(1) }])]);
    advance(20_000);
    // The clock drifted 100 ms; the old reading is out of the 10 s window.
    player.ingest("a", [batch(local() + OFFSET + 100, [{ t: 0, v: at(2) }])]);
    expect(player.playhead()).toBe(local() + OFFSET + 100);
  });

  test("reports stats", () => {
    const { player, server } = setup();
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

    test("starts from a guess, then settles on how late live batches arrive", () => {
      const t = setup({ delayMs: undefined });
      // A new subscription's first result: written before we listened.
      t.player.ingest("a", [batch(t.server() - 1_000, [{ t: 0, v: at(1) }])]);
      t.player.tick();
      expect(t.player.stats().delayMs).toBe(250 + 150); // one window + a guess

      // Live batches that each turn up 250 ms after their first sample.
      for (let i = 0; i < 12; i++) {
        t.advance(250);
        t.player.ingest("a", [batch(t.server(), [{ t: 0, v: at(i) }])]);
        run(t, 200);
      }
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 50, 0);
    });

    test("grows quickly when batches start arriving later", () => {
      const t = setup({ delayMs: undefined });
      for (let i = 0; i < 4; i++) {
        t.player.ingest("a", [batch(t.server(), [{ t: 0, v: at(i) }])]);
        run(t, 250);
      }
      // Now each batch shows up 400 ms after it was written.
      const late = (i: number) =>
        t.player.ingest("a", [batch(t.server() - 400, [{ t: 0, v: at(i) }])]);
      late(10);
      run(t, 500);
      expect(t.player.stats().delayMs).toBeGreaterThan(300 + 90);
      for (let i = 11; i < 20; i++) {
        late(i);
        run(t, 250);
      }
      expect(t.player.stats().delayMs).toBeCloseTo(250 + 400 + 50, 0);
    });

    test("leaves a fixed delay alone", () => {
      const t = setup({ delayMs: 400 });
      t.player.ingest("a", [batch(t.server(), [{ t: 0, v: at(1) }])]);
      t.advance(250);
      t.player.ingest("a", [batch(t.server() - 900, [{ t: 0, v: at(2) }])]);
      run(t, 2_000);
      expect(t.player.stats().delayMs).toBe(400);
    });
  });
});
