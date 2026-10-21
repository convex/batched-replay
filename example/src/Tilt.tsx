// The phone half of the marble demo: open #marble on a laptop and scan its QR
// code, which opens #tilt on the phone. The phone sends its tilt, exactly the
// way the cursors demo sends the mouse. However the phone is held when the
// sensor starts counts as level, and "Set level" takes the current tilt as
// level again. The tilt sensor needs HTTPS, so see example/README.md for running
// this with a real phone. Without a sensor, arrow keys or dragging the pad
// set the tilt instead.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import { useSender } from "@convex-dev/batched-replay/react";
import { api } from "../convex/_generated/api";
import { colorFor, useAnonymousId } from "./anonymous";
import { useWritesPerSecond } from "./useWritesPerSecond";
import TiltPreview from "./TiltPreview";

export const TILT_ROOM = "tilt-demo";
// Tilt past this many degrees counts as this many.
export const MAX_TILT = 30;
const KEY_TILT = 20;
const FLUSH_CHOICES = [250, 50];

type Tilt = { beta: number; gamma: number };
// iOS only lets a page read the sensor after asking, from a tap.
type OrientationWithPermission = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const clampTilt = (degrees: number) =>
  Math.round(Math.min(Math.max(degrees, -MAX_TILT), MAX_TILT) * 10) / 10;
// Beta goes from -180 to 180, so take the short way round.
const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;
// A laptop or desktop, which has no tilt sensor: it has a mouse, not a finger.
const looksLikeLaptop = () =>
  typeof DeviceOrientationEvent === "undefined" ||
  !matchMedia("(pointer: coarse)").matches;

export default function TiltController() {
  const me = useAnonymousId();
  const [flushMs, setFlushMs] = useState(250);
  const [tilt, setTilt] = useState<Tilt>({ beta: 0, gamma: 0 });
  const [sensor, setSensor] = useState<"off" | "on" | "denied" | "missing">(
    "off",
  );
  const [laptop] = useState(looksLikeLaptop);

  const { writesPerSecond, countWrite } = useWritesPerSecond();
  const send = useSender(api.tilt.append, {
    room: TILT_ROOM,
    stream: me,
    flushMs,
    onSend: countWrite,
  });
  const update = (next: Tilt) => {
    const sample = { beta: clampTilt(next.beta), gamma: clampTilt(next.gamma) };
    setTilt(sample);
    send({ ...sample, flushMs });
  };

  // The phone's last reading, and the reading that counts as level: null
  // until the first reading, which then becomes level.
  const raw = useRef<Tilt | null>(null);
  const level = useRef<Tilt | null>(null);
  const setLevel = () => {
    level.current = raw.current;
    update({ beta: 0, gamma: 0 });
  };

  const startSensor = async () => {
    if (typeof DeviceOrientationEvent === "undefined") {
      setSensor("missing");
      return;
    }
    const orientation = DeviceOrientationEvent as OrientationWithPermission;
    if (orientation.requestPermission) {
      const answer = await orientation.requestPermission();
      if (answer !== "granted") {
        setSensor("denied");
        return;
      }
    }
    raw.current = level.current = null;
    setSensor("on");
  };

  // Phone: beta tilts front to back, gamma left to right, relative to level.
  useEffect(() => {
    if (sensor !== "on") return;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return; // no sensor here
      raw.current = { beta: e.beta, gamma: e.gamma };
      level.current ??= raw.current;
      update({
        beta: wrap(e.beta - level.current.beta),
        gamma: e.gamma - level.current.gamma,
      });
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  });
  // No reading in a second (a laptop sends none, or only nulls): there's no
  // sensor here.
  useEffect(() => {
    if (sensor !== "on") return;
    const timeout = setTimeout(() => {
      if (raw.current === null) setSensor("missing");
    }, 1000);
    return () => clearTimeout(timeout);
  }, [sensor]);

  // Desktop: arrow keys tilt it KEY_TILT degrees while they're held.
  const heldKeys = useRef(new Set<string>());
  useEffect(() => {
    const held = heldKeys.current;
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith("Arrow")) return;
      e.preventDefault();
      if (e.type === "keydown") held.add(e.key);
      else held.delete(e.key);
      const axis = (minus: string, plus: string) =>
        ((held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0)) * KEY_TILT;
      update({
        beta: axis("ArrowUp", "ArrowDown"),
        gamma: axis("ArrowLeft", "ArrowRight"),
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  });

  // Desktop: drag on the pad, and the further from the middle the more tilt.
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const across = (e.clientX - rect.left) / rect.width; // 0 to 1
    const down = (e.clientY - rect.top) / rect.height;
    update({
      beta: (down * 2 - 1) * MAX_TILT,
      gamma: (across * 2 - 1) * MAX_TILT,
    });
  };

  return (
    <div className="phone-tilt">
      <header className="phone-tilt-header">
        <div>
          <div className="phone-tilt-eyebrow">Batched replay</div>
          <h1>Tilt controller</h1>
        </div>
        <div className="phone-tilt-you">
          <i style={{ background: colorFor(me) }} />
          {me}
        </div>
      </header>
      <div
        className="phone-tilt-pad"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(e);
        }}
        onPointerMove={drag}
        onPointerUp={() => update({ beta: 0, gamma: 0 })}
        onPointerCancel={() => update({ beta: 0, gamma: 0 })}
      >
        <TiltPreview tilt={tilt} maxTilt={MAX_TILT} />
        <p className="phone-tilt-reading">
          Tilt {tilt.beta.toFixed(0)}° forward, {tilt.gamma.toFixed(0)}°
          sideways
        </p>
      </div>
      {sensor === "on" ? (
        <>
          <p className="phone-tilt-status">
            Tilt the phone to roll the marble.
          </p>
          <button className="phone-tilt-level" onClick={setLevel}>
            Set level
          </button>
        </>
      ) : (
        <button className="phone-tilt-start" onClick={() => void startSensor()}>
          Use the tilt sensor
        </button>
      )}
      {sensor === "denied" && (
        <p className="phone-tilt-status">Motion access was refused.</p>
      )}
      {(laptop || sensor === "missing") && (
        <p className="phone-tilt-status phone-tilt-laptop">
          This is the phone half of the marble demo. Open the{" "}
          <a href="#marble">Marble page</a> and scan its QR code with your
          phone. No tilt sensor here, so the arrow keys and dragging the pad
          tilt it instead.
        </p>
      )}
      <div className={`phone-tilt-flush${flushMs === 50 ? " fast" : ""}`}>
        {FLUSH_CHOICES.map((ms) => (
          <button
            key={ms}
            aria-pressed={flushMs === ms}
            onClick={() => setFlushMs(ms)}
          >
            {ms} ms
          </button>
        ))}
      </div>
      <div className="phone-tilt-rate">
        <strong>You send {writesPerSecond} writes/s</strong>
        <span>
          Flushing every {flushMs} ms: up to {1000 / flushMs} writes a second
          while tilting
        </span>
      </div>
    </div>
  );
}
