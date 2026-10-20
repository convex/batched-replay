import { useRef, useState } from "react";
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

function clearCanvas(canvas: HTMLCanvasElement | null) {
  const ctx = canvas?.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx?.clearRect(0, 0, WIDTH, HEIGHT);
}

// Draws one sample as a segment from the stream's last point. A "move" with
// no pen state (the pen was lifted) just starts a new path.
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

// A thumbnail's view box: the stroke's own bounds plus a margin, so a small
// stroke fills its thumbnail instead of being a dot on a full-size board.
function fitBox(points: Point[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const pad = 40;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + 2 * pad;
  const h = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  return `${minX} ${minY} ${w} ${h}`;
}

export default function Drawing() {
  const me = useAnonymousId();
  const boardRef = useRef<HTMLCanvasElement>(null);
  const timelapseRef = useRef<HTMLCanvasElement>(null);
  // Pen state is kept apart for each source, so strokes never join across
  // your own pen, everyone else's and the timelapse.
  const [pens] = useState(() => ({
    mine: new Map() as Pens,
    board: new Map() as Pens,
    timelapse: new Map() as Pens,
  }));
  const clearRoom = useMutation(api.drawing.clear);
  const clearStrokes = useMutation(api.drawing.clearStrokes);
  // Finished strokes, mirrored into the app's own table by onAppend.
  const strokes = useQuery(api.drawing.recentStrokes);

  const send = useSender(api.drawing.append, {
    room: ROOM,
    stream: me,
    flushMs: FLUSH_MS,
  });

  // The board: everything drawn so far, then everyone else's strokes a
  // little behind live. When someone clears the room, start again.
  const { stats } = usePlayback(api.drawing, {
    room: ROOM,
    self: me,
    fromStart: true,
    onSample: (stream, sample) =>
      applySample(boardRef.current, pens.board, stream, sample),
    onReset: () => {
      clearCanvas(boardRef.current);
      pens.board.clear();
    },
  });

  // The timelapse plays on its own canvas over the board, so the board
  // keeps up with live strokes underneath.
  const timelapse = useHistory(api.drawing, {
    room: ROOM,
    speed: 10,
    onSample: (stream, sample) =>
      applySample(timelapseRef.current, pens.timelapse, stream, sample),
  });
  const startTimelapse = () => {
    clearCanvas(timelapseRef.current);
    pens.timelapse.clear();
    timelapse.restart();
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
    applySample(boardRef.current, pens.mine, me, sample);
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
            onClick={timelapse.playing ? timelapse.pause : startTimelapse}
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
      <aside className="strokes">
        <h2>Strokes</h2>
        <p>Kept in the app's own table, so they outlive Clear board.</p>
        <div className="stroke-grid">
          {strokes?.map((stroke) => (
            <figure key={stroke._id}>
              <svg viewBox={fitBox(stroke.points)}>
                <polyline
                  points={stroke.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={colorFor(stroke.stream)}
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <figcaption>{stroke.pointCount} points</figcaption>
            </figure>
          ))}
        </div>
        <button
          disabled={!strokes?.length}
          onClick={() => void clearStrokes({})}
        >
          Clear strokes
        </button>
      </aside>
      <div className="board-wrap">
        <canvas
          ref={boardRef}
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
        <canvas
          ref={timelapseRef}
          className="board timelapse"
          hidden={!timelapse.playing}
          width={WIDTH * dpr}
          height={HEIGHT * dpr}
        />
      </div>
    </>
  );
}
