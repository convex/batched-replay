import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useConvex, useQueries, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  Player,
  type Interpolate,
  type PlayerBatch,
  type PlayerStats,
} from "../client/player.js";

type Cursor = { start: number; creationTime: number; seq: number };
type StreamBatch<V> = PlayerBatch<V> & { stream: string };

type PlaybackApi<V> = {
  latest: FunctionReference<
    "query",
    "public",
    { room: string; stream: string; count?: number },
    PlayerBatch<V>[]
  >;
  streams: FunctionReference<
    "query",
    "public",
    { room: string; limit?: number },
    {
      epoch: number;
      streams: { stream: string; firstStart: number; lastEnd: number }[];
    }
  >;
  /** Needed for `fromStart`, and to fill gaps when batches are missed. */
  history?: FunctionReference<
    "query",
    "public",
    { room: string; stream?: string; after?: Cursor; limit?: number },
    { batches: StreamBatch<V>[]; next: Cursor | null }
  >;
  /** The room feed, from `exposeApi(..., { feed: true })`. Needed for `feed`. */
  feed?: FunctionReference<
    "query",
    "public",
    { room: string; count?: number },
    { seq: number; batches: StreamBatch<V>[] }[]
  >;
};

export type PlaybackOptions<V> = {
  room: string;
  /** Your own stream key: you draw your own input locally, with no delay. */
  self?: string;
  /**
   * Replay the room's whole history through onSample first, instantly and in
   * order, then carry on live with no gap and nothing twice.
   */
  fromStart?: boolean;
  /**
   * Subscribe to the room's feed once, instead of to each stream: for big
   * rooms. Needs `feed: true` in `exposeApi` too.
   */
  feed?: boolean;
  delayMs?: number;
  maxDelayMs?: number;
  interpolate?: Interpolate<V>;
  onSample?: (stream: string, value: V, time: number) => void;
  /**
   * Called when the room is cleared. Everything buffered is dropped, and with
   * fromStart the (now empty) history is replayed again.
   */
  onReset?: () => void;
};

// A stream counts as active if it wrote this recently.
const ACTIVE_MS = 60_000;
const ACTIVE_RECHECK_MS = 5_000;
const RETRY_HISTORY_MS = 2_000;

/**
 * The streams that wrote in the last minute, apart from your own. lastEnd is
 * server time, so it's compared with the server's clock once we know it, and
 * until then with the newest stream's lastEnd, never the local clock (which
 * may be off by minutes).
 */
export function activeStreams(
  streams: { stream: string; lastEnd: number }[],
  options: { self?: string; now: number; clockOffset: number | undefined },
): string[] {
  const { self, now, clockOffset } = options;
  const serverNow =
    clockOffset !== undefined
      ? now + clockOffset
      : Math.max(...streams.map((s) => s.lastEnd));
  return streams
    .filter((s) => s.stream !== self && s.lastEnd > serverNow - ACTIVE_MS)
    .map((s) => s.stream);
}

/**
 * Feeds one result of the room's `feed` query (newest frame first) to the
 * player, oldest first, leaving out your own stream, which you draw locally.
 */
export function ingestFeed<V>(
  player: Player<V>,
  frames: { seq: number; batches: StreamBatch<V>[] }[],
  options: { self?: string; snapshot: boolean },
) {
  for (const frame of [...frames].reverse()) {
    const batches = frame.batches.filter((b) => b.stream !== options.self);
    player.ingestFrame(batches, { snapshot: options.snapshot });
  }
}

/**
 * Subscribes to a room's active streams and plays them back slightly behind
 * live. Re-renders every frame while something is playing.
 */
export function usePlayback<V>(
  api: PlaybackApi<V>,
  options: PlaybackOptions<V>,
): { values: Map<string, V>; stats: PlayerStats } {
  const { room, self, delayMs, maxDelayMs, interpolate } = options;
  const fromStart = options.fromStart ?? false;
  const feed = options.feed ?? false;
  const convex = useConvex();
  const onSampleRef = useRef(options.onSample);
  const onResetRef = useRef(options.onReset);
  useEffect(() => {
    onSampleRef.current = options.onSample;
    onResetRef.current = options.onReset;
  });
  // `api.x.y` is a new object on every render, so hooks below key on the
  // function's name and read the latest reference from here.
  const apiRef = useRef(api);
  apiRef.current = api;
  const historyName = api.history && getFunctionName(api.history);
  if (fromStart && !historyName) {
    throw new Error("usePlayback: fromStart needs `history` in the api");
  }
  if (feed && !api.feed) {
    throw new Error("usePlayback: feed needs `feed` in the api");
  }
  useEffect(() => {
    if (!historyName) {
      console.warn(
        "usePlayback: without `history` in the api, missed batches can't be filled in",
      );
    }
  }, [historyName]);

  const player = useMemo(
    () =>
      new Player<V>({
        fromStart,
        onSample: (stream, value, time) =>
          onSampleRef.current?.(stream, value, time),
        // Fills gaps from the stream's history when batches were missed.
        fetchAfter: historyName
          ? async (stream, seq) => {
              const page = await convex.query(apiRef.current.history!, {
                room,
                stream,
                // One stream pages by seq alone.
                after: { seq, start: 0, creationTime: 0 },
                limit: 50,
              });
              return page.batches;
            }
          : undefined,
      }),
    // A new room gets a fresh player, so `room` is a dependency on purpose.
    [convex, room, fromStart, historyName],
  );
  player.configure({ delayMs, maxDelayMs, interpolate });

  const list = useQuery(api.streams, { room });
  const epoch = list?.epoch;

  // A new epoch means the room was cleared: drop everything and start again.
  const lastEpoch = useRef<{ player: Player<V>; epoch: number }>(undefined);
  useEffect(() => {
    if (epoch === undefined) return;
    const last = lastEpoch.current;
    if (last?.player === player && last.epoch !== epoch) {
      player.reset();
      onResetRef.current?.();
    }
    lastEpoch.current = { player, epoch };
  }, [player, epoch]);

  // With fromStart, replay the stored history before going live.
  const [historyDone, setHistoryDone] = useState<{
    player: Player<V>;
    epoch: number;
  }>();
  useEffect(() => {
    if (!fromStart || epoch === undefined) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      player
        .loadHistory((after: Cursor | undefined) =>
          convex.query(apiRef.current.history!, { room, after, limit: 200 }),
        )
        .then(
          (done) => {
            if (done && !stopped) setHistoryDone({ player, epoch });
          },
          () => {
            if (!stopped) retry = setTimeout(load, RETRY_HISTORY_MS);
          },
        );
    void load();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [fromStart, player, epoch, convex, room]);
  const live =
    !fromStart ||
    (historyDone?.player === player && historyDone.epoch === epoch);

  const [, render] = useReducer((n: number) => n + 1, 0);
  // The stream list only changes every few seconds, so re-check which
  // streams have gone quiet on a timer.
  const [now, refreshNow] = useReducer(() => Date.now(), Date.now());
  useEffect(() => {
    const id = setInterval(refreshNow, ACTIVE_RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  const active = activeStreams(list?.streams ?? [], {
    self,
    now,
    clockOffset: player.clockOffset(),
  });
  const activeKey = active.join("\n");

  // One `latest` subscription per active stream, or with `feed`, one
  // subscription to the room's feed. useQueries needs a stable object or it
  // resubscribes every render.
  const latestName = getFunctionName(api.latest);
  // The feed doesn't depend on who's active, so don't resubscribe it when that changes.
  const subscribedKey = feed ? "" : activeKey;
  const queries = useMemo(
    () =>
      feed
        ? { feed: { query: apiRef.current.feed!, args: { room } } }
        : Object.fromEntries(
            subscribedKey
              .split("\n")
              .filter(Boolean)
              .map((stream) => [
                stream,
                { query: apiRef.current.latest, args: { room, stream } },
              ]),
          ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feed, subscribedKey, latestName, room],
  );
  const results = useQueries(queries);

  // The feed's first result was written before we were listening.
  const feedStarted = useRef<{ player: Player<V>; epoch: number }>(undefined);
  useEffect(() => {
    if (!live) return;
    if (feed) {
      const frames = results.feed as
        { seq: number; batches: StreamBatch<V>[] }[] | undefined;
      if (Array.isArray(frames) && epoch !== undefined) {
        const started = feedStarted.current;
        const snapshot = started?.player !== player || started.epoch !== epoch;
        feedStarted.current = { player, epoch };
        ingestFeed(player, frames, { self, snapshot });
      }
    } else {
      for (const [stream, result] of Object.entries(results)) {
        if (Array.isArray(result)) player.ingest(stream, result);
      }
    }
    render();
  }, [results, player, live, epoch, feed, self]);

  // The feed only carries streams that moved in its latest tick. Fetch every
  // other active stream's last batch once (not a subscription), so people
  // who are standing still show up too. fromStart has them from history.
  const fetchedOnce = useRef<{
    player: Player<V>;
    epoch: number | undefined;
    streams: Set<string>;
  }>(undefined);
  useEffect(() => {
    if (!feed || fromStart || !live) return;
    let fetched = fetchedOnce.current;
    if (fetched?.player !== player || fetched.epoch !== epoch) {
      fetched = { player, epoch, streams: new Set() };
      fetchedOnce.current = fetched;
    }
    const current = fetched;
    for (const stream of activeKey.split("\n").filter(Boolean)) {
      if (current.streams.has(stream)) continue;
      current.streams.add(stream);
      convex.query(apiRef.current.latest, { room, stream }).then(
        (batches) => {
          // Skip it if the room was cleared meanwhile.
          if (fetchedOnce.current !== current) return;
          const withStream = batches.map((batch) => ({ ...batch, stream }));
          player.ingestFrame(withStream, { snapshot: true });
          render();
        },
        () => {}, // they show up when they next move
      );
    }
  }, [feed, fromStart, live, activeKey, player, epoch, convex, room]);

  // Tick every frame; only re-render while something is moving, plus one
  // last frame when it stops so the final value shows.
  useEffect(() => {
    let frame = requestAnimationFrame(function loop() {
      const wasPlaying = player.isPlaying();
      player.tick();
      if (wasPlaying || player.isPlaying()) render();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [player]);

  const values = new Map<string, V>();
  for (const stream of active) {
    const value = player.value(stream);
    if (value !== undefined) values.set(stream, value);
  }
  return { values, stats: player.stats() };
}
