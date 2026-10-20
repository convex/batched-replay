import { describe, expect, test } from "vitest";
import { Player } from "../client/player.js";
import { activeStreams, ingestFeed } from "./usePlayback.js";

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

describe("ingestFeed", () => {
  const batch = (stream: string, seq: number, x: number) => ({
    _id: `${stream}${seq}`,
    _creationTime: now + seq * 250,
    stream,
    seq,
    start: now + seq * 250 - 250,
    end: now + seq * 250,
    samples: [{ t: 0, v: x }],
  });

  test("plays frames oldest first and leaves out your own stream", () => {
    let local = now;
    const played: [string, number][] = [];
    const player = new Player<number>({
      delayMs: 0,
      now: () => local,
      onSample: (stream, value) => played.push([stream, value]),
    });
    ingestFeed(player, [], { self: "me", snapshot: true });
    // Newest frame first, as the feed query returns them.
    ingestFeed(
      player,
      [
        { seq: 1, batches: [batch("a", 1, 2), batch("me", 1, 99)] },
        { seq: 0, batches: [batch("a", 0, 1), batch("b", 0, 10)] },
      ],
      { self: "me", snapshot: false },
    );
    local += 5_000;
    player.tick();
    expect(played).toEqual([
      ["a", 1],
      ["a", 2],
      ["b", 10],
    ]);
    expect(player.streams()).toEqual(["a", "b"]);
  });
});
