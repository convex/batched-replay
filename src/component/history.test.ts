/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const T0 = 1_000_000;
type Cursor = { start: number; creationTime: number; seq: number };

async function append(
  t: ReturnType<typeof initConvexTest>,
  stream: string,
  retentionMs?: number,
) {
  return t.mutation(api.batches.append, {
    room: "r",
    stream,
    samples: [{ t: 0, v: stream }],
    duration: 100,
    retentionMs,
  });
}

describe("batches.history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns a room's batches in timeline order", async () => {
    const t = initConvexTest();
    await append(t, "a");
    vi.setSystemTime(T0 + 50);
    await append(t, "b");
    vi.setSystemTime(T0 + 200);
    await append(t, "a");
    const page = await t.query(api.batches.history, { room: "r" });
    expect(page.batches.map((b) => [b.stream, b.start])).toEqual([
      ["a", T0 - 100],
      ["b", T0 - 50],
      ["a", T0 + 100],
    ]);
    expect(page.next).toBeNull();
  });

  test("pages through batches that share a start without skipping any", async () => {
    const t = initConvexTest();
    // Seven streams all start at exactly the same server time.
    for (let i = 0; i < 7; i++) await append(t, `s${i}`);
    const seen: string[] = [];
    let after: Cursor | undefined;
    for (;;) {
      const page = await t.query(api.batches.history, {
        room: "r",
        after,
        limit: 2,
      });
      seen.push(...page.batches.map((b) => b.stream));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  test("filters to one stream and pages by seq", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T0 + i * 100);
      await append(t, "a");
      await append(t, "b");
    }
    const first = await t.query(api.batches.history, {
      room: "r",
      stream: "a",
      limit: 3,
    });
    expect(first.batches.map((b) => b.seq)).toEqual([0, 1, 2]);
    const second = await t.query(api.batches.history, {
      room: "r",
      stream: "a",
      limit: 3,
      after: first.next!,
    });
    expect(second.batches.map((b) => b.seq)).toEqual([3, 4]);
    expect(second.next).toBeNull();
  });
});

describe("cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("the cron deletes expired batches and idle stream docs", async () => {
    const t = initConvexTest();
    await append(t, "short", 1_000);
    await append(t, "forever");
    vi.setSystemTime(T0 + 2_000);
    await t.mutation(internal.crons.deleteExpired, {});
    const left = await t.run((ctx) => ctx.db.query("batches").collect());
    expect(left.map((b) => b.stream)).toEqual(["forever"]);
    const streams = await t.query(api.streams.list, { room: "r" });
    expect(streams.map((s) => s.stream)).toEqual(["forever"]);
  });

  test("the cron works through large backlogs in chunks", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("batches", {
          room: "r",
          stream: "x",
          seq: i,
          start: T0,
          end: T0,
          samples: [],
          expiresAt: T0 + 1,
        });
      }
    });
    vi.setSystemTime(T0 + 10);
    await t.mutation(internal.crons.deleteExpired, {});
    expect(
      await t.run((ctx) => ctx.db.query("batches").collect()),
    ).toHaveLength(250);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) => ctx.db.query("batches").collect()),
    ).toHaveLength(0);
  });

  test("clear removes one stream, or a whole room, in chunks", async () => {
    const t = initConvexTest();
    await append(t, "a");
    await append(t, "b");
    await t.mutation(api.streams.clear, { room: "r", stream: "a" });
    expect(
      (await t.query(api.streams.list, { room: "r" })).map((s) => s.stream),
    ).toEqual(["b"]);

    await t.run(async (ctx) => {
      for (let i = 0; i < 450; i++) {
        await ctx.db.insert("batches", {
          room: "r",
          stream: "b",
          seq: 100 + i,
          start: T0,
          end: T0,
          samples: [],
        });
      }
    });
    await t.mutation(api.streams.clear, { room: "r" });
    expect(
      await t.run((ctx) => ctx.db.query("batches").collect()),
    ).toHaveLength(251);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await t.run((ctx) => ctx.db.query("batches").collect()),
    ).toHaveLength(0);
    expect(await t.query(api.streams.list, { room: "r" })).toEqual([]);
  });
});
