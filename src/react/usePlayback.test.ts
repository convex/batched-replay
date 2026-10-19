import { describe, expect, test } from "vitest";
import { activeStreams } from "./usePlayback.js";

const now = 1_000_000;
const streams = [
  { stream: "me", lastEnd: now + 120_000 },
  { stream: "a", lastEnd: now + 119_000 },
  { stream: "b", lastEnd: now + 30_000 },
];

describe("activeStreams", () => {
  test("uses the server clock once it's known", () => {
    // The server is two minutes ahead of this machine.
    expect(
      activeStreams(streams, { self: "me", now, clockOffset: 120_000 }),
    ).toEqual(["a"]);
  });

  test("before that, goes by the newest stream, not the local clock", () => {
    // By the local clock nothing has written in the last minute (they're all
    // "in the future"), but a viewer must still subscribe to someone.
    expect(
      activeStreams(streams, { self: "me", now, clockOffset: undefined }),
    ).toEqual(["a"]);
    // A local clock that's well ahead would otherwise see nobody, ever.
    expect(
      activeStreams(streams, {
        now: now + 10 * 60_000,
        clockOffset: undefined,
      }),
    ).toEqual(["me", "a"]);
  });

  test("an empty room has nobody active", () => {
    expect(activeStreams([], { now, clockOffset: undefined })).toEqual([]);
  });
});
