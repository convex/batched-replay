/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const T0 = 1_000_000;
const sample = (t: number) => ({ t, v: { x: t } });

async function append(
  t: ReturnType<typeof initConvexTest>,
  opts: { stream?: string; duration?: number; retentionMs?: number } = {},
) {
  const duration = opts.duration ?? 250;
  const result = await t.mutation(api.batches.append, {
    room: "r",
    stream: opts.stream ?? "a",
    samples: [sample(0), sample(duration)],
    duration,
    retentionMs: opts.retentionMs,
  });
  if (!result) throw new Error("the batch was dropped");
  return result;
}

describe("batches.append", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drops samples captured before the room was cleared", async () => {
    const t = initConvexTest();
    await append(t);
    // Clear at T0 + 1000, then a batch covering T0 + 900..1100 arrives.
    vi.setSystemTime(T0 + 1_000);
    await t.mutation(api.streams.clear, { room: "r" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime(T0 + 1_100);
    const kept = await t.mutation(api.batches.append, {
      room: "r",
      stream: "a",
      samples: [sample(0), sample(50), sample(150), sample(200)],
      duration: 200,
    });
    // Kept samples start 900 ms in, so the first two were dropped.
    expect(kept).toEqual({
      seq: 0,
      start: T0 + 900,
      end: T0 + 1_100,
      dropped: 2,
    });
    const [batch] = await t.query(api.batches.latest, {
      room: "r",
      stream: "a",
    });
    expect(batch.samples.map((s) => s.t)).toEqual([150, 200]);

    // A batch captured entirely before the clear is dropped altogether.
    vi.setSystemTime(T0 + 1_050);
    expect(
      await t.mutation(api.batches.append, {
        room: "r",
        stream: "b",
        samples: [sample(0), sample(40)],
        duration: 100,
      }),
    ).toBeNull();
  });

  test("seq increments per stream", async () => {
    const t = initConvexTest();
    expect((await append(t)).seq).toBe(0);
    vi.setSystemTime(T0 + 250);
    expect((await append(t)).seq).toBe(1);
    expect((await append(t, { stream: "b" })).seq).toBe(0);
  });

  test("start is now minus duration", async () => {
    const t = initConvexTest();
    expect(await append(t)).toEqual({
      seq: 0,
      start: T0 - 250,
      end: T0,
      dropped: 0,
    });
  });

  test("clamps start so a stream never overlaps itself", async () => {
    const t = initConvexTest();
    await append(t); // timeline ends at T0
    vi.setSystemTime(T0 + 100); // arrives early: ideal start T0 - 150
    const second = await append(t);
    expect(second.start).toBe(T0);
    expect(second.end).toBe(T0 + 250);
  });

  test("re-anchors when clamping would push start more than 1s ahead", async () => {
    const t = initConvexTest();
    // Five batches at the same instant each get clamped 250 ms further ahead.
    const starts = [];
    for (let i = 0; i < 6; i++) starts.push((await append(t)).start);
    expect(starts).toEqual([
      T0 - 250,
      T0,
      T0 + 250,
      T0 + 500,
      T0 + 750,
      // Clamping would make this T0 + 1000, which is 1250 ms ahead of
      // now - duration, so it re-anchors instead.
      T0 - 250,
    ]);
  });

  test("rejects bad input", async () => {
    const t = initConvexTest();
    const base = { room: "r", stream: "a", duration: 100 };
    // ConvexErrors, so the app's client sees the message in production too.
    await expect(
      t.mutation(api.batches.append, { ...base, samples: [] }),
    ).rejects.toThrow(ConvexError);
    await expect(
      t.mutation(api.batches.append, { ...base, samples: [] }),
    ).rejects.toThrow(/1 to 2000 samples/);
    await expect(
      t.mutation(api.batches.append, { ...base, samples: [sample(101)] }),
    ).rejects.toThrow(/within \[0, duration\]/);
    await expect(
      t.mutation(api.batches.append, {
        ...base,
        samples: [sample(50), sample(40)],
      }),
    ).rejects.toThrow(/non-decreasing/);
    await expect(
      t.mutation(api.batches.append, {
        ...base,
        duration: 60_001,
        samples: [sample(0)],
      }),
    ).rejects.toThrow(/duration/);
    await expect(
      t.mutation(api.batches.append, {
        ...base,
        samples: Array.from({ length: 2_001 }, () => sample(0)),
      }),
    ).rejects.toThrow(/1 to 2000 samples/);
  });

  test("rejects times that aren't finite numbers", async () => {
    const t = initConvexTest();
    const base = { room: "r", stream: "a", duration: 100 };
    await expect(
      t.mutation(api.batches.append, { ...base, samples: [sample(NaN)] }),
    ).rejects.toThrow(/sample times/);
    await expect(
      t.mutation(api.batches.append, {
        ...base,
        samples: [sample(0), sample(Infinity)],
      }),
    ).rejects.toThrow(/sample times/);
    for (const duration of [NaN, Infinity, -1]) {
      await expect(
        t.mutation(api.batches.append, {
          ...base,
          duration,
          samples: [sample(0)],
        }),
      ).rejects.toThrow(/duration/);
    }
  });

  test("rejects a negative or non-finite retentionMs", async () => {
    const t = initConvexTest();
    for (const retentionMs of [-1, NaN, Infinity]) {
      await expect(
        t.mutation(api.batches.append, {
          room: "r",
          stream: "a",
          duration: 100,
          samples: [sample(0)],
          retentionMs,
        }),
      ).rejects.toThrow(/retentionMs/);
    }
  });

  test("sets expiresAt from retentionMs", async () => {
    const t = initConvexTest();
    await append(t, { retentionMs: 5_000 });
    await append(t, { stream: "keep" });
    const [expiring, kept] = await t.run(async (ctx) => [
      await ctx.db.query("batches").first(),
      await ctx.db.query("batches").order("desc").first(),
    ]);
    expect(expiring?.expiresAt).toBe(T0 + 5_000);
    expect(kept?.expiresAt).toBeUndefined();
  });

  test("touches the stream doc at most every 5s", async () => {
    const t = initConvexTest();
    const lastEnd = async () =>
      (await t.query(api.streams.list, { room: "r" })).streams[0].lastEnd;
    await append(t);
    expect(await lastEnd()).toBe(T0);
    vi.setSystemTime(T0 + 4_000);
    await append(t);
    expect(await lastEnd()).toBe(T0);
    vi.setSystemTime(T0 + 6_000);
    await append(t);
    expect(await lastEnd()).toBe(T0 + 6_000);
  });
});

describe("batches.latest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns the newest batches oldest first, default 1", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T0 + i * 250);
      await append(t);
    }
    const batches = await t.query(api.batches.latest, {
      room: "r",
      stream: "a",
    });
    expect(batches.map((b) => b.seq)).toEqual([4]);
    const three = await t.query(api.batches.latest, {
      room: "r",
      stream: "a",
      count: 3,
    });
    expect(three.map((b) => b.seq)).toEqual([2, 3, 4]);
  });

  test("a count that isn't a finite number falls back to 1", async () => {
    const t = initConvexTest();
    await append(t);
    vi.setSystemTime(T0 + 250);
    await append(t);
    for (const count of [NaN, Infinity]) {
      const batches = await t.query(api.batches.latest, {
        room: "r",
        stream: "a",
        count,
      });
      expect(batches.map((b) => b.seq)).toEqual([1]);
    }
  });

  test("only returns the asked stream", async () => {
    const t = initConvexTest();
    await append(t, { stream: "a" });
    await append(t, { stream: "b" });
    const batches = await t.query(api.batches.latest, {
      room: "r",
      stream: "b",
    });
    expect(batches.map((b) => b.stream)).toEqual(["b"]);
  });
});
