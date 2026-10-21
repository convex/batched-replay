import { expect, test } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

test("a phone's tilt is stored under its stream, with its flush interval", async () => {
  const t = initConvexTest();
  await t.mutation(api.tilt.append, {
    room: "tilt-demo",
    stream: "phone",
    samples: [{ t: 0, v: { beta: 10, gamma: -5, flushMs: 50 } }],
    duration: 50,
  });
  const [batch] = await t.query(api.tilt.latest, {
    room: "tilt-demo",
    stream: "phone",
  });
  expect(batch.samples[0].v).toEqual({ beta: 10, gamma: -5, flushMs: 50 });
});

test("tilt needs a stream key", async () => {
  const t = initConvexTest();
  await expect(
    t.mutation(api.tilt.append, {
      room: "tilt-demo",
      samples: [{ t: 0, v: { beta: 0, gamma: 0, flushMs: 250 } }],
      duration: 50,
    }),
  ).rejects.toThrow(/stream key/);
});

test("a sample without the flush interval is rejected", async () => {
  const t = initConvexTest();
  await expect(
    t.mutation(api.tilt.append, {
      room: "tilt-demo",
      stream: "phone",
      // @ts-expect-error the value validator wants { beta, gamma, flushMs }
      samples: [{ t: 0, v: { beta: 0, gamma: 0 } }],
      duration: 50,
    }),
  ).rejects.toThrow(/Validator/);
});
