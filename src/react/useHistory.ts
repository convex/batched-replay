import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useConvex } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import { HistoryPlayer, type HistoryPage } from "../client/history.js";

type Cursor = { start: number; creationTime: number; seq: number };

type HistoryApi<V> = {
  history: FunctionReference<
    "query",
    "public",
    { room: string; stream?: string; after?: Cursor; limit?: number },
    HistoryPage<V, Cursor>
  >;
};

/**
 * Replays a room's (or one stream's) stored batches. `onSample` fires as the
 * playhead passes each sample; the rest is play controls and progress.
 */
export function useHistory<V>(
  api: HistoryApi<V>,
  options: {
    room: string;
    stream?: string;
    speed?: number;
    onSample?: (stream: string, value: V, time: number) => void;
  },
) {
  const convex = useConvex();
  const { room, stream } = options;
  const onSampleRef = useRef(options.onSample);
  useEffect(() => {
    onSampleRef.current = options.onSample;
  });
  const [speed, setSpeedState] = useState(options.speed ?? 1);
  const [, render] = useReducer((n: number) => n + 1, 0);

  // `api.x.history` is a new object on every render, so key the player on its
  // name, or it would be rebuilt (and reset) every render.
  const historyRef = useRef(api.history);
  historyRef.current = api.history;
  const historyName = getFunctionName(api.history);
  const player = useMemo(
    () =>
      new HistoryPlayer<V, Cursor>({
        speed: options.speed,
        load: (after) =>
          convex.query(historyRef.current, { room, stream, after, limit: 200 }),
        onSample: (s, value, time) => onSampleRef.current?.(s, value, time),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [convex, historyName, room, stream],
  );

  useEffect(() => {
    let frame = requestAnimationFrame(function loop() {
      const wasPlaying = player.isPlaying();
      player.tick();
      if (wasPlaying) render();
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [player]);

  return {
    position: player.position(),
    playing: player.isPlaying(),
    finished: player.isFinished(),
    speed,
    values: player.values(),
    play: useCallback(() => {
      player.play();
      render();
    }, [player]),
    /** Reload everything from the start (picking up new batches) and play. */
    restart: useCallback(() => {
      player.reset();
      player.play();
      render();
    }, [player]),
    pause: useCallback(() => {
      player.pause();
      render();
    }, [player]),
    seek: useCallback(
      async (time: number) => {
        await player.seek(time);
        render();
      },
      [player],
    ),
    setSpeed: useCallback(
      (next: number) => {
        player.setSpeed(next);
        setSpeedState(next);
      },
      [player],
    ),
  };
}
