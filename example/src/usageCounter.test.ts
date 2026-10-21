import { describe, expect, test } from "vitest";
import { createUsageCounter } from "./usageCounter.js";

const mutation = JSON.stringify({
  type: "Mutation",
  requestId: 0,
  udfPath: "cursors:append",
  args: [{ samples: [{ t: 0, v: { x: 1, y: 2 } }] }],
});
const transition = (types: string[]) =>
  JSON.stringify({
    type: "Transition",
    startVersion: {},
    endVersion: {},
    modifications: types.map((type, queryId) => ({ type, queryId, value: 1 })),
  });

describe("usage counter", () => {
  test("counts mutations as writes and pushed query results as updates", () => {
    const counter = createUsageCounter(0);
    counter.sent(mutation, 100);
    counter.sent(mutation, 200);
    counter.sent(JSON.stringify({ type: "ModifyQuerySet" }), 200);
    counter.received(transition(["QueryUpdated", "QueryUpdated"]), 300);
    counter.received(transition(["QueryRemoved", "QueryFailed"]), 400);
    counter.received(JSON.stringify({ type: "Ping" }), 400);
    counter.received(
      JSON.stringify({ type: "MutationResponse", success: true }),
      400,
    );
    const usage = counter.snapshot(1000);
    expect(usage).toMatchObject({ writes: 2, updates: 3, calls: 5 });
    expect(usage.bytesSent).toBe(mutation.length * 2);
    expect(usage.bytesReceived).toBe(
      transition(["QueryUpdated", "QueryUpdated"]).length +
        transition(["QueryRemoved", "QueryFailed"]).length,
    );
  });

  test("joins transition chunks before counting", () => {
    const counter = createUsageCounter(0);
    const whole = transition(["QueryUpdated", "QueryUpdated", "QueryUpdated"]);
    const half = Math.floor(whole.length / 2);
    const chunk = (partNumber: number, text: string) =>
      JSON.stringify({
        type: "TransitionChunk",
        transitionId: "t1",
        partNumber,
        totalParts: 2,
        chunk: text,
      });
    counter.received(chunk(1, whole.slice(half)), 10);
    expect(counter.snapshot(20).updates).toBe(0);
    counter.received(chunk(0, whole.slice(0, half)), 30);
    expect(counter.snapshot(40).updates).toBe(3);
  });

  test("rate covers the last minute, scaled up while the page is young", () => {
    const counter = createUsageCounter(0);
    for (let i = 0; i < 10; i++) counter.sent(mutation, i * 100);
    // 10 calls in the first 2 s is 300 a minute.
    expect(counter.snapshot(2000).callsPerMinute).toBe(300);
    // A minute and a bit later they've aged out, but the total stays.
    const later = counter.snapshot(61_000);
    expect(later.callsPerMinute).toBe(0);
    expect(later.calls).toBe(10);
  });
});
