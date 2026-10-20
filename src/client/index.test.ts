import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { defineTestApp } from "convex-test";
import { exposeApi } from "./index.js";
import {
  defineSchema,
  defineTable,
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";
import componentTest from "../test.js";
import type { ComponentApi } from "../component/_generated/component.js";

// A small host app for the client, without generated app files or a module glob.
const schema = defineSchema({
  members: defineTable({ room: v.string(), user: v.string() }).index(
    "by_room_user",
    ["room", "user"],
  ),
});
// What an app's own `QueryCtx` from _generated/server is.
type QueryCtx = GenericQueryCtx<DataModelFromSchemaDefinition<typeof schema>>;
const app = defineTestApp({
  schema,
  components: { batchedReplay: componentTest },
});
const { api, createTest } = app.defineModules({
  cursors: exposeApi(app.components.batchedReplay, {
    value: v.object({ x: v.number() }),
    // Only members of a room may watch it. The ctx is a full query ctx.
    authorizeRead: async (ctx: QueryCtx, { room }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      const member = await ctx.db
        .query("members")
        .withIndex("by_room_user", (q) =>
          q.eq("room", room).eq("user", identity.subject),
        )
        .unique();
      if (!member) throw new Error("Not a member");
    },
    // The stream key is the signed-in user, whatever the client asked for.
    authorizeWrite: async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      return identity.subject;
    },
  }),
  untyped: exposeApi(app.components.batchedReplay, {
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => stream ?? "anon",
  }),
  big: exposeApi(app.components.batchedReplay, {
    value: v.object({ x: v.number() }),
    feed: true,
    authorizeRead: async () => {},
    authorizeWrite: async (_ctx, { stream }) => stream ?? "anon",
  }),
});

const samples = [{ t: 0, v: { x: 1 } }];

describe("exposeApi", () => {
  test("writes go to the stream authorizeWrite picks", async () => {
    expectTypeOf(app.components.batchedReplay).toEqualTypeOf<
      ComponentApi<"batchedReplay">
    >();
    const t = createTest().withIdentity({ subject: "user1" });
    await t.run((ctx) =>
      ctx.db.insert("members", { room: "r", user: "user1" }),
    );
    // The client asks for someone else's stream; authorizeWrite overrides it.
    await t.mutation(api.cursors.append, {
      room: "r",
      stream: "user2",
      samples,
      duration: 100,
    });
    const { streams } = await t.query(api.cursors.streams, { room: "r" });
    expect(streams.map((s) => s.stream)).toEqual(["user1"]);
    const batches = await t.query(api.cursors.latest, {
      room: "r",
      stream: "user1",
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].samples).toEqual(samples);
    const page = await t.query(api.cursors.history, { room: "r" });
    expect(page.batches).toHaveLength(1);
  });

  test("authorizeRead can check the app's own tables", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    await expect(t.query(api.cursors.streams, { room: "r" })).rejects.toThrow(
      "Not a member",
    );
    await t.run((ctx) =>
      ctx.db.insert("members", { room: "r", user: "user1" }),
    );
    expect(await t.query(api.cursors.streams, { room: "r" })).toEqual({
      epoch: 0,
      streams: [],
    });
  });

  test("rejects unauthenticated calls before touching the component", async () => {
    const t = createTest();
    await expect(
      t.mutation(api.cursors.append, { room: "r", samples, duration: 100 }),
    ).rejects.toThrow("Unauthorized");
    await expect(t.query(api.cursors.streams, { room: "r" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  test("the value validator checks every sample", async () => {
    const t = createTest().withIdentity({ subject: "user1" });
    await expect(
      t.mutation(api.cursors.append, {
        room: "r",
        // @ts-expect-error x must be a number
        samples: [{ t: 0, v: { x: "1" } }],
        duration: 100,
      }),
    ).rejects.toThrow(/Validator/);
    // Without one, anything goes.
    await t.mutation(api.untyped.append, {
      room: "r",
      samples: [{ t: 0, v: "anything" }],
      duration: 100,
    });
  });

  test("the sample type flows through to the function types", () => {
    type Append = typeof api.cursors.append;
    expectTypeOf<Append["_args"]["samples"]>().toEqualTypeOf<
      { t: number; v: { x: number } }[]
    >();
    type Latest = typeof api.cursors.latest;
    expectTypeOf<
      Latest["_returnType"][number]["samples"][number]["v"]
    >().toEqualTypeOf<{ x: number }>();
    type History = typeof api.cursors.history;
    expectTypeOf<
      History["_returnType"]["batches"][number]["samples"][number]["v"]
    >().toEqualTypeOf<{ x: number }>();
  });

  test("feed: true adds the room feed, and append writes to it", async () => {
    vi.useFakeTimers();
    try {
      const t = createTest();
      await t.mutation(api.big.append, {
        room: "r",
        stream: "a",
        samples,
        duration: 100,
      });
      // Run the room's worker a tick at a time until it goes idle.
      await t.finishAllScheduledFunctions(
        () => vi.advanceTimersByTime(100),
        1_000,
      );
      const [frame] = await t.query(api.big.feed, { room: "r" });
      expect(frame.batches.map((b) => [b.stream, b.samples])).toEqual([
        ["a", samples],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("without feed: true there's no feed query", () => {
    expectTypeOf(api.untyped).not.toHaveProperty("feed");
    expect(api.untyped).not.toHaveProperty("feed");
    type Feed = typeof api.big.feed;
    expectTypeOf<
      Feed["_returnType"][number]["batches"][number]["samples"][number]["v"]
    >().toEqualTypeOf<{ x: number }>();
  });
});
