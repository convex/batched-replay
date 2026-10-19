import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  useHistory,
  usePlayback,
  useSender,
} from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { colorFor, useAnonymousId } from "./anonymous";

const ROOM = "drawing-demo";
const FLUSH_MS = 250;
const SPEEDS = [1, 10, 50];

// The board is a fixed 1600x900 world. CSS scales the canvas to fit the
// window, so a resize never needs a redraw.
const WIDTH = 1600;
const HEIGHT = 900;
const PEN_WIDTH = 6;
const dpr = window.devicePixelRatio || 1;

type Point = { x: number; y: number };
type Sample = { k: "down" | "move" | "up"; x: number; y: number };
// Where each stream's pen last was. No entry means the pen is up.
type Pens = Map<string, Point>;

function drawSegment(
  canvas: HTMLCanvasElement | null,
  color: string,
  from: Point,
  to: Point,
) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = PEN_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function clearBoard(canvas: HTMLCanvasElement | null) {
  const ctx = canvas?.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx?.clearRect(0, 0, WIDTH, HEIGHT);
}

// Draws one sample as a segment from the stream's last point. A "move" with
// no pen state (history started mid-stroke, or the pen was lifted) just
// starts a new path instead of joining an old one.
function applySample(
  canvas: HTMLCanvasElement | null,
  pens: Pens,
  stream: string,
  sample: Sample,
) {
  const point = { x: sample.x, y: sample.y };
  const last = pens.get(stream);
  if (sample.k === "down") {
    drawSegment(canvas, colorFor(stream), point, point); // a dot
  } else if (last) {
    drawSegment(canvas, colorFor(stream), last, point);
  }
  if (sample.k === "up") pens.delete(stream);
  else pens.set(stream, point);
}

export default function Drawing() {
  const me = useAnonymousId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Pen state is kept apart for each source, so strokes never join across
  // history, the live player and the timelapse.
  const [pens] = useState(() => ({
    mine: new Map() as Pens,
    live: new Map() as Pens,
    rebuild: new Map() as Pens,
    timelapse: new Map() as Pens,
  }));
  const clearRoom = useMutation(api.drawing.clear);

  const send = useSender<Sample>(api.drawing.append, {
    room: ROOM,
    stream: me,
    flushMs: FLUSH_MS,
  });

  // Rebuilds the board from everything stored, as fast as it loads.
  const rebuild = useHistory<Sample>(api.drawing, {
    room: ROOM,
    speed: Infinity,
    onSample: (stream, sample) =>
      applySample(canvasRef.current, pens.rebuild, stream, sample),
  });
  // Replays the whole room, at a speed you pick.
  const timelapse = useHistory<Sample>(api.drawing, {
    room: ROOM,
    speed: 10,
    onSample: (stream, sample) =>
      applySample(canvasRef.current, pens.timelapse, stream, sample),
  });

  // Everyone else's strokes, a little behind live. Ignored until the board is
  // rebuilt, and while the timelapse owns the canvas.
  const { stats } = usePlayback<Sample>(api.drawing, {
    room: ROOM,
    exclude: me,
    onSample: (stream, sample) => {
      if (!rebuild.finished || timelapse.playing) return;
      applySample(canvasRef.current, pens.live, stream, sample);
    },
  });

  const restartRebuild = rebuild.restart;
  const rebuildBoard = useCallback(() => {
    clearBoard(canvasRef.current);
    pens.rebuild.clear();
    pens.live.clear();
    restartRebuild();
  }, [pens, restartRebuild]);

  // On load, draw what's already there.
  useEffect(rebuildBoard, [rebuildBoard]);

  // When the timelapse ends, rebuild so nothing drawn meanwhile is missing.
  useEffect(() => {
    if (timelapse.finished) rebuildBoard();
  }, [timelapse.finished, rebuildBoard]);

  // Clear board deletes the room's streams. Nothing else tells a viewer that,
  // so rebuild (from empty history) when the stream list goes to empty.
  const streamCount = useQuery(api.drawing.streams, { room: ROOM })?.length;
  const lastStreamCount = useRef<number>(undefined);
  useEffect(() => {
    if (lastStreamCount.current && streamCount === 0 && !timelapse.playing) {
      rebuildBoard();
    }
    lastStreamCount.current = streamCount;
  }, [streamCount, timelapse.playing, rebuildBoard]);

  const startTimelapse = () => {
    clearBoard(canvasRef.current);
    pens.timelapse.clear();
    timelapse.restart();
  };
  const stopTimelapse = () => {
    timelapse.pause();
    rebuildBoard();
  };

  const toBoard = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) * WIDTH) / rect.width),
      y: Math.round(((e.clientY - rect.top) * HEIGHT) / rect.height),
    };
  };
  // Your own strokes are drawn locally, with no delay, and sent as well.
  const pen = (k: Sample["k"], e: PointerEvent<HTMLCanvasElement>) => {
    const sample = { k, ...toBoard(e) };
    applySample(canvasRef.current, pens.mine, me, sample);
    send(sample, k === "move" ? undefined : { keep: true });
  };
  const penUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (pens.mine.has(me)) pen("up", e);
  };

  return (
    <>
      <div className="hud">
        <h1>Batched replay: drawing</h1>
        <div>Open this page in a second tab and draw.</div>
        <div>
          You send up to {(1000 / FLUSH_MS).toFixed(1)} writes/s while drawing
        </div>
        <div>You receive {stats.batchesPerSecond.toFixed(1)} batches/s</div>
        <div>Playing {Math.round(stats.delayMs)} ms behind</div>
        <div>
          <button
            disabled={!rebuild.finished && !timelapse.playing}
            onClick={timelapse.playing ? stopTimelapse : startTimelapse}
          >
            {timelapse.playing ? "Stop timelapse" : "Timelapse"}
          </button>
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              aria-pressed={timelapse.speed === speed}
              onClick={() => timelapse.setSpeed(speed)}
            >
              {speed}x
            </button>
          ))}
          {timelapse.playing && (
            <span> {(timelapse.position / 1000).toFixed(0)} s</span>
          )}
        </div>
        <div>
          <button onClick={() => void clearRoom({})}>Clear board</button>
        </div>
      </div>
      <div className="board-wrap">
        <canvas
          ref={canvasRef}
          className="board"
          width={WIDTH * dpr}
          height={HEIGHT * dpr}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            pen("down", e);
          }}
          onPointerMove={(e) => {
            if (pens.mine.has(me)) pen("move", e);
          }}
          onPointerUp={penUp}
          onPointerCancel={penUp}
        />
      </div>
    </>
  );
}
