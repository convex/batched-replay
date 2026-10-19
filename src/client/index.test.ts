import { describe, expect, expectTypeOf, test } from "vitest";
import { defineTestApp } from "convex-test";
import { exposeApi } from "./index.js";
import { defineSchema } from "convex/server";
import componentTest from "../test.js";
import type { ComponentApi } from "../component/_generated/component.js";

// A small host app for the client, without generated app files or a module glob.
const app = defineTestApp({
  schema: defineSchema({}),
  components: { batchedReplay: componentTest },
});
const { api, createTest } = app.defineModules({
  cursors: exposeApi(app.components.batchedReplay, {
    // The stream key is the signed-in user; reads need a user too.
    auth: async (ctx, operation) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      if (operation.type === "write") return identity.subject;
    },
  }),
});

const samples = [{ t: 0, v: { x: 1 } }];

describe("exposeApi", () => {
  test("writes go to the stream the auth callback picks", async () => {
    expectTypeOf(app.components.batchedReplay).toEqualTypeOf<
      ComponentApi<"batchedReplay">
    >();
    const t = createTest().withIdentity({ subject: "user1" });
    // The client asks for someone else's stream; auth overrides it.
    await t.mutation(api.cursors.append, {
      room: "r",
      stream: "user2",
      samples,
      duration: 100,
    });
    const streams = await t.query(api.cursors.streams, { room: "r" });
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

  test("rejects unauthenticated calls before touching the component", async () => {
    const t = createTest();
    await expect(
      t.mutation(api.cursors.append, { room: "r", samples, duration: 100 }),
    ).rejects.toThrow("Unauthorized");
    await expect(t.query(api.cursors.streams, { room: "r" })).rejects.toThrow(
      "Unauthorized",
    );
    expect(
      await t
        .withIdentity({ subject: "user1" })
        .query(api.cursors.streams, { room: "r" }),
    ).toEqual([]);
  });
});
