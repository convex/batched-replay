import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import {
  useHistory,
  usePlayback,
  useSender,
} from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { colorFor, useAnonymousId } from "./anonymous";
import {
  HEIGHT,
  LAP_LENGTH,
  LEFT,
  LINE_X,
  MID_Y,
  RADIUS,
  RIGHT,
  TOP_Y,
  TRACK_WIDTH,
  WIDTH,
  trackPoint,
} from "./racerTrack";
import { CAMERAS, type CameraName } from "./racer3d";
import RacerScene from "./RacerScene";
import UsageStats from "./UsageStats";
import "./Racer.css";

const ROOM = "racer-demo";
const FLUSH_MS = 250;

// Arcade handling, in px and seconds. Top speed is ACCEL / DRAG.
const ACCEL = 700;
const BRAKE = 900;
const DRAG = 1.2;
const GRASS_DRAG = 4;
const TURN = 3.2;

// Autodrive goes round in exactly this long (unless the URL says otherwise),
// in a lane either side of the middle: -1 is the outside, 1 the inside.
const AUTO_LAP_MS = 7_000;
const LANE_WIDTH = 35;

type Car = { x: number; y: number; angle: number; speed: number };
// color is only there when the URL sets one, so other windows draw your car
// in it too.
type Sample = {
  x: number;
  y: number;
  angle: number;
  lapMs?: number;
  color?: string;
};
type Race = {
  car: Car;
  lapStartedAt: number | null; // null on the out lap, before the first line
  halfway: boolean; // been round the far side since the last line
};

const START: Car = { x: LINE_X - 200, y: TOP_Y, angle: 0, speed: 0 };

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), max);

function onTrack(x: number, y: number) {
  const fromMiddle = Math.hypot(x - clamp(x, LEFT, RIGHT), y - MID_Y);
  return Math.abs(fromMiddle - RADIUS) < TRACK_WIDTH / 2;
}

function drive(car: Car, keys: Set<string>, dt: number): Car {
  const held = (...names: string[]) => names.some((name) => keys.has(name));
  const throttle = held("ArrowUp", "w")
    ? ACCEL
    : held("ArrowDown", "s")
      ? -BRAKE
      : 0;
  const steer =
    (held("ArrowRight", "d") ? 1 : 0) - (held("ArrowLeft", "a") ? 1 : 0);
  const drag = onTrack(car.x, car.y) ? DRAG : GRASS_DRAG;
  const speed = clamp(
    car.speed + (throttle - car.speed * drag) * dt,
    -150,
    1000,
  );
  // Steering only bites once you're moving.
  const angle = car.angle + steer * TURN * clamp(speed / 250, -1, 1) * dt;
  return {
    x: clamp(car.x + Math.cos(angle) * speed * dt, 0, WIDTH),
    y: clamp(car.y + Math.sin(angle) * speed * dt, 0, HEIGHT),
    angle,
    speed,
  };
}

// Autodrive puts the car where the wall clock says it should be, so two
// windows on one computer go round in step without talking to each other.
function autodrive(
  clock: number,
  lane: number,
  lapMs: number,
  previous: Car,
): Car {
  const lapFraction = (clock % lapMs) / lapMs;
  const { x, y, angle } = trackPoint(lapFraction * LAP_LENGTH);
  const side = lane * LANE_WIDTH;
  // Keep the angle continuous, so playback never spins the car the long way.
  const turn = angle - previous.angle;
  return {
    x: x - Math.sin(angle) * side,
    y: y + Math.cos(angle) * side,
    angle: previous.angle + Math.atan2(Math.sin(turn), Math.cos(turn)),
    speed: (LAP_LENGTH / lapMs) * 1000,
  };
}

const toSample = (car: Car, color: string | null): Sample => ({
  x: Math.round(car.x),
  y: Math.round(car.y),
  angle: Math.round(car.angle * 100) / 100,
  ...(color && { color }),
});

const lapIdOf = (stream: string) => Number(stream.split(":")[1]);
const playerOf = (stream: string) => stream.split(":")[0];

const seconds = (ms: number | null | undefined) =>
  ms == null ? "-" : `${(ms / 1000).toFixed(2)} s`;

export default function Racer() {
  const me = useAnonymousId();
  // #racer?autodrive=1&lane=1&offset=60: drive by itself, in the inside
  // lane, 60 ms ahead of the clock. Add &lapMs=7500 for slower laps, so the
  // ghost of a faster one pulls ahead. See example/README.md.
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const autodriving = params.get("autodrive") === "1";
  const lane = Number(params.get("lane") ?? 0);
  const offset = Number(params.get("offset") ?? 0);
  const autoLapMs = Number(params.get("lapMs") ?? AUTO_LAP_MS);
  // &camera=tv|chase|finish picks where the 3D view looks from.
  const [camera, setCamera] = useState<CameraName>(() => {
    const name = params.get("camera");
    return name && Object.hasOwn(CAMERAS, name) ? (name as CameraName) : "tv";
  });
  // &ghost=0 hides your ghost: with autodrive it sits right on your car.
  // &color=%233b82f6 paints your car blue, here and in other windows.
  const showGhost = params.get("ghost") !== "0";
  const paint = params.get("color");
  const color = paint && CSS.supports("color", paint) ? paint : null;
  const myColor = color ?? colorFor(me);

  const race = useRef<Race>({ car: START, lapStartedAt: null, halfway: true });
  const [view, setView] = useState({
    car: START,
    lapMs: null as number | null,
  });
  // When this lap started. It names the lap's stream.
  const [lapId, setLapId] = useState(() => Date.now());

  // Each lap is its own stream, so it can be replayed on its own later.
  const stream = `${me}:${lapId}`;
  const send = useSender(api.racer.append, {
    room: ROOM,
    stream,
    flushMs: FLUSH_MS,
  });

  // Everyone else, a little behind. Each player sends a new stream every
  // lap: show the newest one that has started playing.
  const [showing] = useState(() => new Map<string, string>());
  const { values, stats } = usePlayback(api.racer, {
    room: ROOM,
    self: stream,
    interpolate: true,
    onSample: (lapStream) => {
      const player = playerOf(lapStream);
      if (player === me) return; // your own earlier laps
      const current = showing.get(player);
      if (!current || lapIdOf(lapStream) > lapIdOf(current)) {
        showing.set(player, lapStream);
      }
    },
  });

  // Your laps, kept by onAppend, and a ghost that replays your best one.
  const laps = useQuery(api.racer.laps, { player: me });
  const bestStream = laps?.best?.stream;
  const {
    restart: restartGhost,
    seek: seekGhost,
    playing: ghostPlaying,
    values: ghostValues,
  } = useHistory(api.racer, { room: ROOM, stream: bestStream });

  // The ghost sets off as you cross the line. When the lap you just finished
  // is the new best, it arrives a moment later, so skip ahead to catch up.
  useEffect(() => {
    const lapStartedAt = race.current.lapStartedAt;
    if (!bestStream || lapStartedAt === null) return;
    restartGhost();
    const late = performance.now() - lapStartedAt;
    if (late > 100) void seekGhost(late);
  }, [lapId, bestStream, restartGhost, seekGhost]);

  // Drive every frame: your own car is moved and drawn locally, with no
  // delay, and sent as well.
  useEffect(() => {
    const keys = new Set<string>();
    const key = (e: KeyboardEvent) =>
      e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const onKeyDown = (e: KeyboardEvent) => {
      keys.add(key(e));
      if (e.key.startsWith("Arrow")) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(key(e));
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Autodrive starts wherever the clock says, not from the grid.
    const state = race.current;
    if (autodriving)
      state.car = autodrive(Date.now() + offset, lane, autoLapMs, state.car);

    let last = performance.now();
    let frame = requestAnimationFrame(function loop(now) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const previous = state.car;
      const car = autodriving
        ? autodrive(Date.now() + offset, lane, autoLapMs, previous)
        : drive(previous, keys, dt);
      state.car = car;
      if (car.y > MID_Y) state.halfway = true;

      const crossed =
        previous.x < LINE_X &&
        car.x >= LINE_X &&
        Math.abs(car.y - TOP_Y) < TRACK_WIDTH / 2;
      if (crossed && state.halfway) {
        // The sample on the line ends the lap and carries its time.
        const sample = toSample(car, color);
        if (state.lapStartedAt !== null) {
          sample.lapMs = Math.round(now - state.lapStartedAt);
        }
        send(sample, { keep: true });
        state.lapStartedAt = now;
        state.halfway = false;
        setLapId(Date.now()); // the next lap gets its own stream
      } else {
        send(toSample(car, color));
      }

      const lapMs =
        state.lapStartedAt === null ? null : now - state.lapStartedAt;
      setView({ car, lapMs });
      frame = requestAnimationFrame(loop);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [autodriving, lane, offset, autoLapMs, color, send]);

  const ghost = bestStream && ghostPlaying ? ghostValues.get(bestStream) : null;
  const others = [...showing]
    .map(([player, lapStream]) => ({ player, car: values.get(lapStream) }))
    .filter((other) => other.car !== undefined);

  return (
    <>
      <RacerScene
        me={{ car: view.car, color: myColor }}
        ghost={ghost && showGhost ? { car: ghost, color: myColor } : null}
        others={others.map(({ player, car }) => ({
          id: player,
          car: car!,
          color: car!.color ?? colorFor(player),
        }))}
        camera={camera}
      />
      <div className="hud racer-hud">
        <h1>Batched replay: ghost racer</h1>
        <div>
          {autodriving
            ? "Autodrive is on"
            : "Arrow keys or WASD to drive. Open a second window to race."}
        </div>
        <div className="lap-time">Lap {seconds(view.lapMs)}</div>
        <div>Best lap {seconds(laps?.best?.lapMs)}</div>
        <div>
          Last laps{" "}
          {laps?.recent.length
            ? laps.recent.map((lap) => seconds(lap.lapMs)).join(", ")
            : "-"}
        </div>
        <div>{ghost ? "Racing your best lap's ghost" : "No ghost yet"}</div>
        <div>Playing {Math.round(stats.delayMs)} ms behind</div>
        <UsageStats />
        <div className="racer-cameras" role="group" aria-label="Camera">
          {Object.entries(CAMERAS).map(([name, label]) => (
            <button
              key={name}
              aria-pressed={camera === name}
              onClick={() => setCamera(name as CameraName)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
