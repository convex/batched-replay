import { useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { useConvex, useMutation, useQuery } from "convex/react";
import {
  useHistory,
  usePlayback,
  useSender,
} from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { colorFor, useAnonymousId } from "./anonymous";
import { useWritesPerSecond } from "./useWritesPerSecond";
import DrawingScene from "./DrawingScene";

const ROOM = "drawing-demo";
const FLUSH_MS = 250;
const SPEEDS = [1, 10, 50];

// The board is a fixed 1600x900 world, drawn on a 2D canvas. The 3D scene
// shows that canvas as the ink on a sheet of paper, so a resize never needs
// a redraw.
const WIDTH = 1600;
const HEIGHT = 900;
const PEN_WIDTH = 10;
const dpr = window.devicePixelRatio || 1;

type Point = { x: number; y: number };
type Sample = { k: "down" | "move" | "up"; x: number; y: number };
// Where each stream's pen last was. No entry means the pen is up.
type Pens = Map<string, Point>;
// The app's own copy of the board: see snapshot in convex/drawing.ts.
type Snapshot = FunctionReturnType<typeof api.drawing.snapshot>;

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
  // A soft edge in the same colour, like marker ink bleeding into paper.
  ctx.shadowColor = color;
  ctx.shadowBlur = 2.5 * dpr;
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

function drawStroke(
  canvas: HTMLCanvasElement | null,
  stream: string,
  points: Point[],
) {
  points.forEach((point, i) =>
    drawSegment(canvas, colorFor(stream), points[i - 1] ?? point, point),
  );
}

// Draws the board from the app's snapshot. A pen that's mid-stroke is left
// where it got to, so its next live samples carry on from there.
function drawSnapshot(
  canvas: HTMLCanvasElement | null,
  pens: Pens,
  snapshot: Snapshot,
) {
  for (const stroke of snapshot.strokes) {
    drawStroke(canvas, stroke.stream, stroke.points);
  }
  for (const pen of snapshot.pens) {
    drawStroke(canvas, pen.stream, pen.points);
    const last = pen.points.at(-1);
    if (last) pens.set(pen.stream, last);
  }
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
  const convex = useConvex();
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

  const { writesPerSecond, countWrite } = useWritesPerSecond();
  const send = useSender(api.drawing.append, {
    room: ROOM,
    stream: me,
    flushMs: FLUSH_MS,
    onSend: countWrite,
  });

  // The board: drawn from the app's snapshot rather than by replaying every
  // batch, then everyone else's strokes a little behind live, carrying on
  // from the last batch the snapshot covers. When someone clears the room,
  // start again.
  const { stats } = usePlayback(api.drawing, {
    room: ROOM,
    self: me,
    snapshot: {
      load: () => convex.query(api.drawing.snapshot, {}),
      apply: (snapshot) => {
        drawSnapshot(boardRef.current, pens.board, snapshot);
        return snapshot.pens;
      },
    },
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

  // Your own strokes are drawn locally, with no delay, and sent as well.
  // The scene gives each pointer event as a point on the board.
  const pen = (k: Sample["k"], point: Point) => {
    const sample = { k, ...point };
    applySample(boardRef.current, pens.mine, me, sample);
    send(sample, k === "move" ? undefined : { keep: true });
  };

  return (
    <>
      <div className="hud">
        <h1>Batched replay: drawing</h1>
        <div>Open this page in a second tab and draw.</div>
        <div>You send {writesPerSecond} writes/s</div>
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
                  strokeWidth={4}
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
      <DrawingScene
        me={me}
        board={boardRef}
        timelapse={timelapseRef}
        showTimelapse={timelapse.playing}
        pens={{
          mine: pens.mine,
          others: timelapse.playing ? pens.timelapse : pens.board,
        }}
        onPenDown={(point) => pen("down", point)}
        onPenMove={(point) => {
          if (pens.mine.has(me)) pen("move", point);
        }}
        onPenUp={(point) => {
          if (pens.mine.has(me)) pen("up", point);
        }}
      />
      {/* The boards the scene shows, off screen. */}
      <div className="drawing3d-source">
        <canvas
          ref={boardRef}
          className="board"
          width={WIDTH * dpr}
          height={HEIGHT * dpr}
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
