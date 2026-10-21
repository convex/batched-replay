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
  /**
   * Needed for `fromStart` and `snapshot`, and to fill gaps when batches are
   * missed.
   */
  history?: FunctionReference<
    "query",
    "public",
    { room: string; stream?: string; after?: Cursor; limit?: number },
    { batches: (PlayerBatch<V> & { stream: string })[]; next: Cursor | null }
  >;
};

/**
 * Your own snapshot of what's been played so far, to start from instead of
 * the whole history.
 */
export type PlaybackSnapshot<S> = {
  /** Loads it: on start, and again after every reset. */
  load: () => Promise<S>;
  /**
   * Draws it, and returns the last batch (`seq`) it covers for each stream.
   * Not called if the room was reset while it loaded.
   */
  apply: (snapshot: S) => { stream: string; seq: number }[];
};

export type PlaybackOptions<V, S = unknown> = {
  room: string;
  /** Your own stream key: you draw your own input locally, with no delay. */
  self?: string;
  /**
   * Replay the room's whole history through onSample first, instantly and in
   * order, then carry on live with no gap and nothing twice.
   */
  fromStart?: boolean;
  /**
   * Start from your own snapshot instead (say, a table `onAppend` keeps).
   * Each stream carries on from the batch after the one the snapshot covers,
   * with nothing twice and no gap; a stream it doesn't list plays from its
   * first batch.
   */
  snapshot?: PlaybackSnapshot<S>;
  /** How many of the room's most recently active streams to watch (100). */
  maxStreams?: number;
  delayMs?: number;
  maxDelayMs?: number;
  interpolate?: Interpolate<V>;
  onSample?: (stream: string, value: V, time: number) => void;
  /**
   * Called when the room is cleared. Everything buffered is dropped, and with
   * fromStart the (now empty) history is replayed again, or with snapshot
   * the snapshot is loaded again.
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
 * Subscribes to a room's active streams and plays them back slightly behind
 * live. Re-renders every frame while something is playing.
 */
export function usePlayback<V, S = unknown>(
  api: PlaybackApi<V>,
  options: PlaybackOptions<V, S>,
): { values: Map<string, V>; stats: PlayerStats } {
  const { room, self, maxStreams, delayMs, maxDelayMs, interpolate } = options;
  const fromStart = options.fromStart ?? false;
  const fromSnapshot = options.snapshot !== undefined;
  const convex = useConvex();
  const onSampleRef = useRef(options.onSample);
  const onResetRef = useRef(options.onReset);
  const snapshotRef = useRef(options.snapshot);
  useEffect(() => {
    onSampleRef.current = options.onSample;
    onResetRef.current = options.onReset;
    snapshotRef.current = options.snapshot;
  });
  // `api.x.y` is a new object on every render, so hooks below key on the
  // function's name and read the latest reference from here.
  const apiRef = useRef(api);
  apiRef.current = api;
  const historyName = api.history && getFunctionName(api.history);
  if ((fromStart || fromSnapshot) && !historyName) {
    throw new Error(
      "usePlayback: fromStart and snapshot need `history` in the api",
    );
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
        // Every batch after the history or snapshot matters.
        fromStart: fromStart || fromSnapshot,
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
    [convex, room, fromStart, fromSnapshot, historyName],
  );
  player.configure({ delayMs, maxDelayMs, interpolate });

  const list = useQuery(
    api.streams,
    maxStreams === undefined ? { room } : { room, limit: maxStreams },
  );
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

  // With fromStart, replay the stored history before going live; with
  // snapshot, apply the snapshot.
  const [startDone, setStartDone] = useState<{
    player: Player<V>;
    epoch: number;
  }>();
  useEffect(() => {
    if (!(fromStart || fromSnapshot) || epoch === undefined) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const start = async () => {
      if (!fromSnapshot) {
        return player.loadHistory((after: Cursor | undefined) =>
          convex.query(apiRef.current.history!, { room, after, limit: 200 }),
        );
      }
      const { load, apply } = snapshotRef.current!;
      const snapshot = await load();
      if (stopped) return false;
      player.startAfter(apply(snapshot));
      return true;
    };
    const run = () =>
      start().then(
        (done) => {
          if (done && !stopped) setStartDone({ player, epoch });
        },
        () => {
          if (!stopped) retry = setTimeout(run, RETRY_HISTORY_MS);
        },
      );
    void run();
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [fromStart, fromSnapshot, player, epoch, convex, room]);
  const live =
    !(fromStart || fromSnapshot) ||
    (startDone?.player === player && startDone.epoch === epoch);

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

  // useQueries needs a stable object or it resubscribes every render.
  const latestName = getFunctionName(api.latest);
  const queries = useMemo(
    () =>
      Object.fromEntries(
        activeKey
          .split("\n")
          .filter(Boolean)
          .map((stream) => [
            stream,
            { query: apiRef.current.latest, args: { room, stream } },
          ]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKey, latestName, room],
  );
  const results = useQueries(queries);

  useEffect(() => {
    if (!live) return;
    for (const [stream, result] of Object.entries(results)) {
      if (Array.isArray(result)) player.ingest(stream, result);
    }
    render();
  }, [results, player, live, epoch]);

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
