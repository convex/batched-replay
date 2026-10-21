import { useEffect, useRef, useState } from "react";
import { usePlayback } from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { TILT_ROOM } from "./Tilt";
import MarbleBoard from "./MarbleBoard";
import type { MarbleView } from "./MarbleBoard";

// The maze: # is a wall, O a hole, S the start and G the goal. Each cell is
// half the marble's width, so the paths are two cells wide. Three of the
// holes sit just past a corner, where it's easy to overshoot.
const MAZE = [
  "###############################",
  "#S...........................O#",
  "#.............................#",
  "##########..#############..####",
  "#.................#...........#",
  "#.................#...........#",
  "###################..#######..#",
  "#O...................#........#",
  "#....................#........#",
  "####..#..###################..#",
  "#.....#.................#.....#",
  "#.....#.................#.....#",
  "#..#..#############..#######..#",
  "#..#.............O#........#..#",
  "#..#..............#........#..#",
  "#..##########..################",
  "#...........#................G#",
  "#...........#.........O.......#",
  "###############################",
];
const CELL = 32;

// Simple physics, in px and seconds: tilt is acceleration, walls bounce it
// back a little, and friction slows it down.
const RADIUS = 16;
const HOLE_RADIUS = 22;
const GRAVITY = 1000; // at 90 degrees of tilt
const FRICTION = 1.5;
const BOUNCE = 0.4;
const DEGREES = Math.PI / 180;

type Tilt = { beta: number; gamma: number; flushMs: number };
type Ball = { x: number; y: number; vx: number; vy: number };

function cells(kind: string) {
  return MAZE.flatMap((row, r) =>
    [...row].flatMap((cell, c) =>
      cell === kind ? [{ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL }] : [],
    ),
  );
}
const START = cells("S")[0];
const GOAL = cells("G")[0];
const HOLES = cells("O");
const isWall = (c: number, r: number) => (MAZE[r]?.[c] ?? "#") === "#";
const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

function roll(ball: Ball, tilt: Tilt, dt: number): Ball {
  let { x, y, vx, vy } = ball;
  vx += GRAVITY * Math.sin(tilt.gamma * DEGREES) * dt;
  vy += GRAVITY * Math.sin(tilt.beta * DEGREES) * dt;
  vx *= Math.exp(-FRICTION * dt);
  vy *= Math.exp(-FRICTION * dt);
  // Move in small steps, so a fast marble can't pass through a wall.
  const steps = Math.max(1, Math.ceil((Math.hypot(vx, vy) * dt) / 4));
  for (let i = 0; i < steps; i++) {
    x += (vx * dt) / steps;
    y += (vy * dt) / steps;
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (!isWall(c, r)) continue;
        // The nearest point of this wall: if it's inside the marble, push
        // the marble out and bounce it off.
        const nearX = clamp(x, c * CELL, (c + 1) * CELL);
        const nearY = clamp(y, r * CELL, (r + 1) * CELL);
        const distance = Math.hypot(x - nearX, y - nearY);
        if (distance >= RADIUS || distance === 0) continue;
        const nx = (x - nearX) / distance;
        const ny = (y - nearY) / distance;
        x = nearX + nx * RADIUS;
        y = nearY + ny * RADIUS;
        const into = vx * nx + vy * ny;
        if (into < 0) {
          vx -= (1 + BOUNCE) * into * nx;
          vy -= (1 + BOUNCE) * into * ny;
        }
      }
    }
  }
  return { x, y, vx, vy };
}

const near = (ball: Ball, point: { x: number; y: number }, within: number) =>
  Math.hypot(ball.x - point.x, ball.y - point.y) < within;

const atStart = (): Ball => ({ ...START, vx: 0, vy: 0 });
const LEVEL = { beta: 0, gamma: 0, flushMs: 0 };
// How long dropping into a hole takes, before the marble starts again.
const FALL_MS = 750;
const LAYOUT = {
  maze: MAZE,
  cell: CELL,
  start: START,
  goal: GOAL,
  holes: HOLES,
  radius: RADIUS,
  holeRadius: HOLE_RADIUS,
};

export default function Marble() {
  // Follow whichever phone sent the newest sample.
  const [leader] = useState({ stream: "", time: 0 });
  const { values, stats } = usePlayback(api.tilt, {
    room: TILT_ROOM,
    interpolate: true,
    onSample: (stream, _tilt, time) => {
      if (time < leader.time) return;
      leader.stream = stream;
      leader.time = time;
    },
  });
  const tilt = values.get(leader.stream);

  // The marble rolls locally, every frame, from the replayed tilt.
  const tiltRef = useRef<Tilt | undefined>(undefined);
  useEffect(() => {
    tiltRef.current = tilt;
  });
  // What the 3D board draws each frame.
  const view = useRef<MarbleView>({
    ball: START,
    tilt: LEVEL,
    fall: null,
    fallMs: FALL_MS,
    spawnedAt: 0,
    finishedAt: -Infinity,
  });
  const [run, setRun] = useState({
    ms: 0,
    best: null as number | null,
    falls: 0,
  });
  useEffect(() => {
    let ball = atStart();
    let fall: MarbleView["fall"] = null;
    let startedAt = performance.now();
    let last = startedAt;
    let frame = requestAnimationFrame(function loop(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const shown = view.current;
      shown.tilt = tiltRef.current ?? LEVEL;
      if (fall) {
        // Dropping into a hole: once it's gone, start again.
        if (now - fall.at > FALL_MS) {
          ball = atStart();
          fall = null;
          startedAt = now;
          shown.spawnedAt = now;
        }
      } else {
        ball = roll(ball, tiltRef.current ?? LEVEL, dt);
        const hole = HOLES.find((hole) => near(ball, hole, HOLE_RADIUS));
        if (hole) {
          fall = { ...hole, at: now };
          setRun((r) => ({ ...r, falls: r.falls + 1 }));
        } else if (near(ball, GOAL, HOLE_RADIUS)) {
          const ms = now - startedAt;
          ball = atStart();
          startedAt = now;
          shown.spawnedAt = shown.finishedAt = now;
          setRun((r) => ({ ...r, best: Math.min(ms, r.best ?? Infinity) }));
        }
      }
      shown.ball = ball;
      shown.fall = fall;
      setRun((r) => ({ ...r, ms: now - startedAt }));
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const phoneUrl = `${location.origin}${location.pathname}#tilt`;
  return (
    <>
      <MarbleBoard layout={LAYOUT} view={view} />
      <div className="hud marble-hud">
        <h1>Batched replay: tilt marble</h1>
        <div className="marble-phone">
          On your phone, open <strong>{phoneUrl}</strong>
        </div>
        {location.protocol !== "https:" && (
          <div className="marble-note">
            The phone's tilt sensor needs HTTPS: see example/README.md
          </div>
        )}
        <div className="marble-tilt">
          {tilt
            ? `Tilt ${tilt.beta.toFixed(0)}° forward, ${tilt.gamma.toFixed(0)}° sideways`
            : "Waiting for a phone"}
        </div>
        <div className="marble-flush">
          Phone flushes every {tilt ? `${Math.round(tilt.flushMs)} ms` : "-"}
        </div>
        <div className="marble-delay">
          Playing {Math.round(stats.delayMs)} ms behind
        </div>
        <div className="marble-run">
          Time {(run.ms / 1000).toFixed(1)} s, best{" "}
          {run.best === null ? "-" : `${(run.best / 1000).toFixed(1)} s`},{" "}
          {run.falls} {run.falls === 1 ? "fall" : "falls"}
        </div>
      </div>
    </>
  );
}
