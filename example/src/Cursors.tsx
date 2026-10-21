import { useEffect, useRef, useState } from "react";
import { usePlayback, useSender } from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { useAnonymousId } from "./anonymous";
import { useWritesPerSecond } from "./useWritesPerSecond";
import UsageStats from "./UsageStats";
import CursorsScene from "./CursorsScene";

const ROOM = "cursors-demo";
// A position on a shared 1440x900 surface, so every window agrees.
type Point = { x: number; y: number };

// Three ways to show everyone else's cursor, from the same batches.
const MODES = {
  jump: "Jump",
  smooth: "Smooth",
  replay: "Replay batches",
};
type Mode = keyof typeof MODES;

export default function Cursors() {
  const me = useAnonymousId();
  const [flushMs, setFlushMs] = useState(250);
  const [mode, setMode] = useState<Mode>("replay");
  const [trails, setTrails] = useState(true);
  const [mouse, setMouse] = useState<Point>({ x: -100, y: -100 });

  const { writesPerSecond, countWrite } = useWritesPerSecond();
  const send = useSender(api.cursors.append, {
    room: ROOM,
    stream: me,
    flushMs,
    onSend: countWrite,
  });
  const { values, stats } = usePlayback(api.cursors, {
    room: ROOM,
    self: me,
    // Room for a crowd: see `npm run crowd`.
    maxStreams: 200,
    // No delayMs when replaying: it follows the senders' flush rate on its
    // own. Otherwise a delay of 0 with no smoothing gives the newest point
    // each cursor has sent.
    ...(mode === "replay"
      ? { interpolate: true }
      : { delayMs: 0, interpolate: false }),
  });
  const glided = useGlide(values, mode === "smooth", flushMs);
  const cursors = mode === "smooth" ? glided : values;

  // The scene turns the mouse into a point on the surface.
  const onMove = (point: Point) => {
    setMouse(point); // your own cursor is drawn locally, with no delay
    send(point);
  };

  return (
    <>
      <div className="hud">
        <h1>Batched replay: cursors</h1>
        <div>Open this page in a second tab and move the mouse.</div>
        <div>
          You send {writesPerSecond} writes/s (
          {(writesPerSecond * 60).toLocaleString()} a minute)
        </div>
        <div>You receive {stats.batchesPerSecond.toFixed(1)} batches/s</div>
        <UsageStats />
        <div>
          {(Object.keys(MODES) as Mode[]).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {MODES[m]}
            </button>
          ))}
        </div>
        <div>
          {mode === "jump" && "Jumping to the newest point"}
          {mode === "smooth" &&
            `Gliding to the newest point over ${flushMs} ms`}
          {mode === "replay" &&
            `Replaying ${Math.round(stats.delayMs)} ms behind`}
        </div>
        <label>
          Flush every {flushMs} ms
          <br />
          <input
            type="range"
            min={16}
            max={1000}
            value={flushMs}
            onChange={(e) => setFlushMs(Number(e.target.value))}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={trails}
            onChange={(e) => setTrails(e.target.checked)}
          />
          Trails
        </label>
      </div>
      <CursorsScene
        me={me}
        mine={mouse}
        cursors={cursors}
        trails={trails}
        onMove={onMove}
      />
    </>
  );
}

type Glide = { from: Point; to: Point; startedAt: number };

// Smooth mode: what you'd try without replaying batches. Each cursor glides
// in a straight line from where it's drawn to the newest point it sent,
// over one flush interval.
function useGlide(targets: Map<string, Point>, on: boolean, ms: number) {
  const [shown, setShown] = useState(() => new Map<string, Point>());
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  });
  useEffect(() => {
    if (!on) return;
    const glides = new Map<string, Glide>();
    const at = (glide: Glide, now: number): Point => {
      const alpha = Math.min(1, (now - glide.startedAt) / ms);
      return {
        x: glide.from.x + (glide.to.x - glide.from.x) * alpha,
        y: glide.from.y + (glide.to.y - glide.from.y) * alpha,
      };
    };
    let frame = requestAnimationFrame(function loop(now) {
      const next = new Map<string, Point>();
      for (const [stream, to] of targetsRef.current) {
        const glide = glides.get(stream);
        if (!glide) {
          glides.set(stream, { from: to, to, startedAt: now });
        } else if (to.x !== glide.to.x || to.y !== glide.to.y) {
          glides.set(stream, { from: at(glide, now), to, startedAt: now });
        }
        next.set(stream, at(glides.get(stream)!, now));
      }
      setShown(next);
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [on, ms]);
  return shown;
}
