import { useEffect, useMemo, useReducer, useRef } from "react";
import { useQueries, useQuery } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import {
  Player,
  type Interpolate,
  type PlayerBatch,
  type PlayerStats,
} from "../client/player.js";

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
    { room: string },
    { stream: string; firstStart: number; lastEnd: number }[]
  >;
};

export type PlaybackOptions<V> = {
  room: string;
  /** Your own stream key: you draw your own input locally, with no delay. */
  exclude?: string;
  delayMs?: number;
  interpolate?: Interpolate<V>;
  onSample?: (stream: string, value: V, time: number) => void;
};

// A stream counts as active if it wrote this recently.
const ACTIVE_MS = 60_000;
const ACTIVE_RECHECK_MS = 5_000;

/**
 * Subscribes to a room's active streams and plays them back slightly behind
 * live. Re-renders every frame while something is playing.
 */
export function usePlayback<V>(
  api: PlaybackApi<V>,
  options: PlaybackOptions<V>,
): { values: Map<string, V>; stats: PlayerStats } {
  const { room, exclude, delayMs, interpolate } = options;
  const onSampleRef = useRef(options.onSample);
  useEffect(() => {
    onSampleRef.current = options.onSample;
  });

  const player = useMemo(
    () =>
      new Player<V>({
        onSample: (stream, value, time) =>
          onSampleRef.current?.(stream, value, time),
      }),
    // A new room gets a fresh player, so `room` is a dependency on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room],
  );
  player.configure({ delayMs, interpolate });

  const [, render] = useReducer((n: number) => n + 1, 0);
  // The stream list only changes every few seconds, so re-check which
  // streams have gone quiet on a timer.
  const [now, refreshNow] = useReducer(() => Date.now(), Date.now());
  useEffect(() => {
    const id = setInterval(refreshNow, ACTIVE_RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  const list = useQuery(api.streams, { room });
  const active = useMemo(
    () =>
      (list ?? [])
        // lastEnd is server time, so compare it with the server's clock.
        .filter(
          (s) =>
            s.stream !== exclude &&
            s.lastEnd > now + (player.clockOffset() ?? 0) - ACTIVE_MS,
        )
        .map((s) => s.stream),
    [list, exclude, now, player],
  );
  // `api.x.latest` is a new object on every render, so key the memo on its
  // name. useQueries needs a stable object or it resubscribes every render.
  const latestRef = useRef(api.latest);
  latestRef.current = api.latest;
  const latestName = getFunctionName(api.latest);
  const queries = useMemo(
    () =>
      Object.fromEntries(
        active.map((stream) => [
          stream,
          { query: latestRef.current, args: { room, stream } },
        ]),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, latestName, room],
  );
  const results = useQueries(queries);

  useEffect(() => {
    for (const [stream, result] of Object.entries(results)) {
      if (Array.isArray(result)) player.ingest(stream, result);
    }
    render();
  }, [results, player]);

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
  for (const stream of player.streams()) {
    if (stream === exclude) continue;
    const value = player.value(stream);
    if (value !== undefined) values.set(stream, value);
  }
  return { values, stats: player.stats() };
}
