/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { CHUNK } from "./shared.js";
import { initConvexTest, modules } from "./setup.test.js";

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

  test("a limit that isn't a finite number falls back to 100", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 3; i++) await append(t, `s${i}`);
    const page = await t.query(api.batches.history, { room: "r", limit: NaN });
    expect(page.batches).toHaveLength(3);
    expect(page.next).toBeNull();
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

describe("streams.list", () => {
  test("returns the most recently active streams first, 100 by default", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("streams", {
          room: "r",
          stream: `s${i}`,
          firstStart: T0,
          lastEnd: T0 + i,
        });
      }
    });
    const { streams } = await t.query(api.streams.list, { room: "r" });
    expect(streams).toHaveLength(100);
    // The newest visitor is never cut off, however many came before.
    expect(streams[0].stream).toBe("s149");
    expect(streams[99].stream).toBe("s50");
    const few = await t.query(api.streams.list, { room: "r", limit: 2 });
    expect(few.streams.map((s) => s.stream)).toEqual(["s149", "s148"]);
  });

  test("the epoch starts at 0 and goes up once per clear", async () => {
    const t = initConvexTest();
    await append(t, "a");
    expect((await t.query(api.streams.list, { room: "r" })).epoch).toBe(0);
    await t.mutation(api.streams.clear, { room: "r" });
    expect((await t.query(api.streams.list, { room: "r" })).epoch).toBe(1);
    await t.mutation(api.streams.clear, { room: "r", stream: "a" });
    expect((await t.query(api.streams.list, { room: "r" })).epoch).toBe(2);
    expect((await t.query(api.streams.list, { room: "x" })).epoch).toBe(0);
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

  const count = (t: ReturnType<typeof initConvexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("batches").collect()).length);

  test("the cron deletes expired batches and idle stream docs", async () => {
    const t = initConvexTest();
    await append(t, "short", 1_000);
    await append(t, "forever");
    vi.setSystemTime(T0 + 2_000);
    await t.mutation(internal.crons.deleteExpired, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run((ctx) => ctx.db.query("batches").collect());
    expect(left.map((b) => b.stream)).toEqual(["forever"]);
    const { streams } = await t.query(api.streams.list, { room: "r" });
    expect(streams.map((s) => s.stream)).toEqual(["forever"]);
  });

  test("the cron works through large backlogs in chunks", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
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
    expect(await count(t)).toBe(250 - CHUNK);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await count(t)).toBe(0);
  });

  test("clear removes one stream, or a whole room, in chunks", async () => {
    const t = initConvexTest();
    await append(t, "a");
    await append(t, "b");
    await t.mutation(api.streams.clear, { room: "r", stream: "a" });
    const { streams } = await t.query(api.streams.list, { room: "r" });
    expect(streams.map((s) => s.stream)).toEqual(["b"]);

    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
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
    vi.setSystemTime(Date.now() + 1_000); // a clear comes after what it clears
    await t.mutation(api.streams.clear, { room: "r" });
    expect(await count(t)).toBe(251 - CHUNK);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await count(t)).toBe(0);
    expect(await t.query(api.streams.list, { room: "r" })).toEqual({
      epoch: 2,
      streams: [],
    });
  });

  test("a clear keeps what was drawn while it ran", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("batches", {
          room: "r",
          stream: "old",
          seq: i,
          start: T0,
          end: T0,
          samples: [],
        });
      }
    });
    vi.setSystemTime(T0 + 1_000);
    await t.mutation(api.streams.clear, { room: "r" }); // first chunk only
    vi.setSystemTime(T0 + 1_500);
    await append(t, "new"); // someone draws before the clear has finished
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await count(t)).toBe(1);
    const { streams } = await t.query(api.streams.list, { room: "r" });
    expect(streams.map((s) => s.stream)).toEqual(["new"]);
  });

  describe("with batches near the 1 MiB document limit", () => {
    // Enforces Convex's real limits, including 16 MiB read per transaction.
    const initStrict = () =>
      convexTest({ schema, modules, transactionLimits: true });
    const big = "x".repeat(900_000);

    async function insertBig(
      t: ReturnType<typeof initStrict>,
      expiresAt?: number,
    ) {
      // 30 batches, about 27 MB, written a few at a time.
      for (let i = 0; i < 30; i += 5) {
        await t.run(async (ctx) => {
          for (let j = i; j < i + 5; j++) {
            await ctx.db.insert("batches", {
              room: "r",
              stream: `s${j % 3}`,
              seq: j,
              start: T0,
              end: T0,
              samples: [{ t: 0, v: big }],
              expiresAt,
            });
          }
        });
      }
    }

    test("clear stays under the read limit", async () => {
      const t = initStrict();
      await insertBig(t);
      vi.setSystemTime(Date.now() + 1_000); // a clear comes after what it clears
      await t.mutation(api.streams.clear, { room: "r" });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        await t.run(
          async (ctx) => (await ctx.db.query("batches").take(1)).length,
        ),
      ).toBe(0);
    });

    test("history returns short pages instead of passing the read limit", async () => {
      const t = initStrict();
      await insertBig(t);
      for (const stream of [undefined, "s0"]) {
        const sizes: number[] = [];
        let after: Cursor | undefined;
        for (;;) {
          const page = await t.query(api.batches.history, {
            room: "r",
            stream,
            after,
          });
          sizes.push(page.batches.length);
          if (!page.next) break;
          after = page.next;
        }
        // About 14 batches fit in one read, so the room takes a few pages.
        expect(sizes.reduce((a, b) => a + b)).toBe(stream ? 10 : 30);
        if (!stream) expect(sizes[0]).toBeLessThan(30);
      }
    });

    test("a room clear carries on past big batches it keeps", async () => {
      const t = initStrict();
      const insert = (stream: string, seq: number, v: string) =>
        t.run(async (ctx) => {
          await ctx.db.insert("batches", {
            room: "r",
            stream,
            seq,
            start: T0,
            end: T0,
            samples: [{ t: 0, v }],
          });
        });
      // Old batches in "b" (more than one chunk's worth) and "d".
      for (let i = 0; i < 150; i++) await insert("b", i, "old");
      for (let i = 0; i < 10; i++) await insert("d", i, "old");
      vi.setSystemTime(Date.now() + 1_000);
      await t.mutation(api.streams.clear, { room: "r" }); // first chunk only
      // Before the next chunk runs, someone draws big batches into "a" and
      // "c", more than one transaction can read. The clear keeps those, and
      // must neither start again from "a" nor stop at "c".
      vi.setSystemTime(Date.now() + 500);
      for (let i = 0; i < 20; i++) {
        await insert("a", i, big);
        await insert("c", i, big);
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const has = (stream: string) =>
        t.run(
          async (ctx) =>
            (await ctx.db
              .query("batches")
              .withIndex("by_stream", (q) =>
                q.eq("room", "r").eq("stream", stream),
              )
              .first()) !== null,
        );
      expect(await has("b")).toBe(false);
      expect(await has("d")).toBe(false);
      expect(await has("a")).toBe(true);
      expect(await has("c")).toBe(true);
    });

    test("the expiry cron stays under the read limit", async () => {
      const t = initStrict();
      await insertBig(t, T0 + 1);
      vi.setSystemTime(T0 + 10);
      await t.mutation(internal.crons.deleteExpired, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        await t.run(
          async (ctx) => (await ctx.db.query("batches").take(1)).length,
        ),
      ).toBe(0);
    });
  });
});
