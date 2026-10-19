import "./App.css";
import { useEffect, useState } from "react";
import { usePlayback, useSender } from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";

const ROOM = "cursors-demo";
type Point = { x: number; y: number };

// Anonymous id, kept in sessionStorage: each tab is its own "user" (so two
// tabs in one browser see each other) and a reload stays the same user.
function useAnonymousId() {
  const [id] = useState(() => {
    const saved = sessionStorage.getItem("cursor-id");
    if (saved) return saved;
    const fresh = crypto.randomUUID().slice(0, 8);
    sessionStorage.setItem("cursor-id", fresh);
    return fresh;
  });
  return id;
}

function colorFor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 80% 60%)`;
}

export default function App() {
  const me = useAnonymousId();
  const [flushMs, setFlushMs] = useState(250);
  const [mouse, setMouse] = useState<Point>({ x: -100, y: -100 });

  const send = useSender<Point>(api.cursors.append, {
    room: ROOM,
    stream: me,
    flushMs,
  });
  const { values, stats } = usePlayback<Point>(api.cursors, {
    room: ROOM,
    exclude: me,
    // No delayMs: it follows the senders' flush rate on its own.
    interpolate: true,
  });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const point = { x: e.clientX, y: e.clientY };
      setMouse(point); // your own cursor is drawn locally, with no delay
      send(point);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  });

  return (
    <>
      <div className="hud">
        <h1>Batched replay: cursors</h1>
        <div>Open this page in a second tab and move the mouse.</div>
        <div>
          You send up to {(1000 / flushMs).toFixed(1)} writes/s while moving
        </div>
        <div>You receive {stats.batchesPerSecond.toFixed(1)} batches/s</div>
        <div>Playing {Math.round(stats.delayMs)} ms behind</div>
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
      </div>
      <div
        className="cursor me"
        style={{ transform: `translate(${mouse.x}px, ${mouse.y}px)` }}
      />
      {[...values].map(([stream, point]) => (
        <div
          key={stream}
          data-stream={stream}
          className="cursor"
          style={{
            background: colorFor(stream),
            transform: `translate(${point.x}px, ${point.y}px)`,
          }}
        />
      ))}
    </>
  );
}
