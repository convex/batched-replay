import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { defineTestApp } from "convex-test";
import { BatchedReplay, exposeApi, type Sample } from "./index.js";
import {
  defineSchema,
  defineTable,
  mutationGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
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
  // What the onAppend test mirrors each stored batch into.
  mirrored: defineTable({
    stream: v.string(),
    seq: v.number(),
    times: v.array(v.number()),
    dropped: v.number(),
  }),
});
// What an app's own `QueryCtx` and `MutationCtx` from _generated/server are.
type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;
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
  hooked: {
    ...exposeApi(app.components.batchedReplay, {
      value: v.object({ k: v.string() }),
      authorizeRead: async () => {},
      authorizeWrite: async (_ctx, { stream }) => stream ?? "anon",
      onAppend: async (ctx: MutationCtx, batch) => {
        expectTypeOf(batch.samples).toEqualTypeOf<Sample<{ k: string }>[]>();
        if (batch.samples.some((s) => s.v.k === "boom")) {
          throw new Error("boom");
        }
        await ctx.db.insert("mirrored", {
          stream: batch.stream,
          seq: batch.seq,
          times: batch.samples.map((s) => batch.start + s.t),
          dropped: batch.dropped,
        });
      },
    }),
    clear: mutationGeneric({
      args: { room: v.string() },
      handler: async (ctx, { room }) => {
        await new BatchedReplay(app.components.batchedReplay).clear(ctx, {
          room,
        });
      },
    }),
  },
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
});

describe("onAppend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const T0 = 1_000_000;
  const mirrored = (t: ReturnType<typeof createTest>) =>
    t.run((ctx) => ctx.db.query("mirrored").collect());

  test("gets exactly the samples that were stored", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = createTest();
    const result = await t.mutation(api.hooked.append, {
      room: "r",
      stream: "a",
      samples: [
        { t: 0, v: { k: "down" } },
        { t: 100, v: { k: "up" } },
      ],
      duration: 100,
    });
    expect(result).toEqual({ seq: 0, start: T0 - 100, end: T0, dropped: 0 });
    expect(await mirrored(t)).toMatchObject([
      { stream: "a", seq: 0, times: [T0 - 100, T0], dropped: 0 },
    ]);
  });

  test("leaves out samples captured before a clear", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = createTest();
    await t.mutation(api.hooked.clear, { room: "r" });
    // Covers T0 - 200 to T0 + 100: the first two were before the clear.
    vi.setSystemTime(T0 + 100);
    await t.mutation(api.hooked.append, {
      room: "r",
      stream: "a",
      samples: [0, 100, 200, 300].map((t) => ({ t, v: { k: "move" } })),
      duration: 300,
    });
    expect(await mirrored(t)).toMatchObject([
      { times: [T0, T0 + 100], dropped: 2 },
    ]);
  });

  test("isn't called when nothing was stored", async () => {
    vi.useFakeTimers({ now: T0 });
    const t = createTest();
    await t.mutation(api.hooked.clear, { room: "r" });
    const result = await t.mutation(api.hooked.append, {
      room: "r",
      stream: "a",
      samples: [{ t: 0, v: { k: "move" } }],
      duration: 100,
    });
    expect(result).toBeNull();
    expect(await mirrored(t)).toEqual([]);
  });

  test("a throw rolls the append back", async () => {
    const t = createTest();
    await expect(
      t.mutation(api.hooked.append, {
        room: "r",
        stream: "a",
        samples: [{ t: 0, v: { k: "boom" } }],
        duration: 100,
      }),
    ).rejects.toThrow("boom");
    expect(
      await t.query(api.hooked.latest, { room: "r", stream: "a" }),
    ).toEqual([]);
    expect((await t.query(api.hooked.streams, { room: "r" })).streams).toEqual(
      [],
    );
    expect(await mirrored(t)).toEqual([]);
  });
});
