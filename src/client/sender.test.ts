import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Sender } from "./sender.js";

type Batch = { samples: { t: number; v: number }[]; duration: number };

function setup(options: { flushMs?: number; sampleMs?: number } = {}) {
  const batches: Batch[] = [];
  let release: (() => void) | undefined;
  let fail = false;
  let hold = false;
  const flush = vi.fn((batch: Batch) => {
    if (fail) return Promise.reject(new Error("offline"));
    batches.push(batch);
    if (!hold) return Promise.resolve();
    return new Promise<void>((resolve) => (release = resolve));
  });
  const sender = new Sender<number>({ flush, ...options });
  return {
    sender,
    batches,
    flush,
    setFail: (f: boolean) => (fail = f),
    holdFlushes: () => (hold = true),
    finishFlush: () => release?.(),
  };
}

describe("Sender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("sends nothing while idle", async () => {
    const { flush } = setup();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(flush).not.toHaveBeenCalled();
  });

  test("a window starts at the first push and flushes flushMs later", async () => {
    const { sender, batches } = setup();
    sender.push(1);
    await vi.advanceTimersByTimeAsync(100);
    sender.push(2);
    await vi.advanceTimersByTimeAsync(149);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toEqual([
      {
        samples: [
          { t: 0, v: 1 },
          { t: 100, v: 2 },
        ],
        duration: 250,
      },
    ]);
  });

  test("the next window starts at the next push, not at the flush", async () => {
    const { sender, batches } = setup();
    sender.push(1);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(1_000);
    sender.push(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual({ samples: [{ t: 0, v: 2 }], duration: 250 });
  });

  test("keeps collecting while a flush is in flight, then sends at once", async () => {
    const { sender, batches, flush, holdFlushes, finishFlush } = setup();
    holdFlushes();
    sender.push(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(flush).toHaveBeenCalledTimes(1);
    sender.push(2);
    await vi.advanceTimersByTimeAsync(1_000); // way past flushMs, still in flight
    expect(flush).toHaveBeenCalledTimes(1);
    sender.push(3);
    finishFlush();
    await vi.advanceTimersByTimeAsync(0);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(batches[1].samples.map((s) => s.v)).toEqual([2, 3]);
  });

  test("waits for the window after a fast flush rather than flushing early", async () => {
    const { sender, flush, holdFlushes, finishFlush } = setup();
    holdFlushes();
    sender.push(1);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(10);
    sender.push(2); // window starts at t=260
    finishFlush();
    await vi.advanceTimersByTimeAsync(100);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  test("a failed flush keeps its samples for the next window", async () => {
    const { sender, batches, setFail } = setup();
    setFail(true);
    sender.push(1);
    await vi.advanceTimersByTimeAsync(250);
    setFail(false);
    sender.push(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(batches).toHaveLength(1);
    expect(batches[0].samples.map((s) => s.v)).toEqual([1, 2]);
    // t stays relative to the original window start.
    expect(batches[0].samples[0].t).toBe(0);
    expect(batches[0].samples[1].t).toBe(250);
  });

  test("the retry buffer is capped", async () => {
    const { sender, batches, setFail } = setup({ flushMs: 1_000_000 });
    setFail(true);
    for (let i = 0; i < 2_500; i++) sender.push(i);
    setFail(false);
    await sender.flush();
    expect(batches[0].samples).toHaveLength(2_000);
    expect(batches[0].samples[0].v).toBe(500);
  });

  test("flush() sends right now", async () => {
    const { sender, batches } = setup();
    sender.push(1);
    await vi.advanceTimersByTimeAsync(40);
    await sender.flush();
    expect(batches).toEqual([{ samples: [{ t: 0, v: 1 }], duration: 40 }]);
  });

  test("dispose stops everything", async () => {
    const { sender, flush } = setup();
    sender.push(1);
    sender.dispose();
    sender.push(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flush).not.toHaveBeenCalled();
  });

  describe("sampleMs", () => {
    test("keeps at most one sample per sampleMs, plus the trailing one", async () => {
      const { sender, batches } = setup({ sampleMs: 100 });
      for (let i = 0; i < 25; i++) {
        sender.push(i);
        await vi.advanceTimersByTimeAsync(10);
      }
      await vi.advanceTimersByTimeAsync(250);
      const values = batches.flatMap((b) => b.samples.map((s) => s.v));
      expect(values.slice(0, 3)).toEqual([0, 10, 20]);
      expect(values.at(-1)).toBe(24);
    });

    test("never drops discrete events", async () => {
      const { sender, batches } = setup({ sampleMs: 1_000 });
      sender.push(1);
      sender.push(2, { keep: true });
      sender.push(3);
      sender.push(4, { keep: true });
      await sender.flush();
      expect(batches[0].samples.map((s) => s.v)).toEqual([1, 2, 4]);
    });
  });
});
