// A crowd of bot cursors for the cursors demo. Each bot is its own Convex
// client with its own stream key, sending through the component's Sender
// just like a browser tab, and moves the way a person moves a mouse: a
// curved sweep to somewhere else on a 1440x900 screen, easing in and out,
// with the odd pause.
//
//   npm run crowd -- --bots 100 --flush 250 --seconds 60 --url https://...
//
// Stops after --seconds (0 runs until Ctrl-C), or on Ctrl-C. The URL
// defaults to VITE_CONVEX_URL in .env.local.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConvexClient } from "convex/browser";
import { Sender } from "@convex-dev/batched-replay";
import { api } from "../convex/_generated/api.js";

const ROOM = "cursors-demo";
const WIDTH = 1440;
const HEIGHT = 900;
const MARGIN = 40;

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "100" },
    flush: { type: "string", default: "250" },
    seconds: { type: "string", default: "60" },
    url: { type: "string" },
  },
});
const bots = Number(args.bots);
const flushMs = Number(args.flush);
const seconds = Number(args.seconds);
const url = args.url ?? envUrl();
if (!url) throw new Error("No --url, and no VITE_CONVEX_URL in .env.local");

function envUrl() {
  try {
    const env = readFileSync(new URL("../../.env.local", import.meta.url));
    return /^VITE_CONVEX_URL=(.*)$/m.exec(env.toString())?.[1].trim();
  } catch {
    return undefined;
  }
}

type Point = { x: number; y: number };
// One sweep: from a point to the next, bending through a control point.
type Move = { from: Point; bend: Point; to: Point; start: number; ms: number };

const random = (min: number, max: number) => min + Math.random() * (max - min);
const anywhere = (): Point => ({
  x: random(MARGIN, WIDTH - MARGIN),
  y: random(MARGIN, HEIGHT - MARGIN),
});
const clamp = (n: number, max: number) =>
  Math.min(max - MARGIN, Math.max(MARGIN, n));

// The next sweep starts after an occasional pause, bends to one side by up
// to a third of its length, and moves at a speed of its own.
function nextMove(from: Point, now: number): Move {
  const to = anywhere();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = random(-0.35, 0.35);
  const bend = {
    x: clamp((from.x + to.x) / 2 - dy * side, WIDTH),
    y: clamp((from.y + to.y) / 2 + dx * side, HEIGHT),
  };
  const pause = Math.random() < 0.3 ? random(200, 1200) : 0;
  const speed = random(300, 1100); // px per second
  const ms = (Math.hypot(dx, dy) / speed) * 1000 + 150;
  return { from, bend, to, start: now + pause, ms };
}

// Where a sweep is at `now`: eased in and out along a quadratic curve.
function positionOf(move: Move, now: number): Point {
  const linear = Math.min(1, Math.max(0, (now - move.start) / move.ms));
  const t = linear < 0.5 ? 4 * linear ** 3 : 1 - (-2 * linear + 2) ** 3 / 2;
  const { from, bend, to } = move;
  const curve = (a: number, b: number, c: number) =>
    (1 - t) ** 2 * a + 2 * (1 - t) * t * b + t ** 2 * c;
  return {
    x: Math.round(curve(from.x, bend.x, to.x)),
    y: Math.round(curve(from.y, bend.y, to.y)),
  };
}

const started = performance.now();
const crowd = Array.from({ length: bots }, (_, i) => {
  const client = new ConvexClient(url);
  const stream = `bot-${String(i + 1).padStart(3, "0")}`;
  const sender = new Sender<Point>({
    send: (batch) =>
      client.mutation(api.cursors.append, { room: ROOM, stream, ...batch }),
    onError: (error) => console.warn(stream, String(error)),
    flushMs,
  });
  // Bots start at different moments, so they don't all flush in step.
  const move = nextMove(anywhere(), started + random(0, 2 * flushMs));
  return { client, sender, move };
});
console.log(`${bots} bots in ${ROOM} on ${url}, flushing every ${flushMs} ms`);

// One timer moves every bot at 60 Hz, like a mouse.
const mover = setInterval(() => {
  const now = performance.now();
  for (const bot of crowd) {
    if (now < bot.move.start) continue;
    bot.sender.push(positionOf(bot.move, now));
    if (now >= bot.move.start + bot.move.ms) {
      bot.move = nextMove(bot.move.to, now);
    }
  }
}, 1000 / 60);

let stopping = false;
async function stop() {
  if (stopping) process.exit(1); // a second Ctrl-C doesn't wait
  stopping = true;
  clearInterval(mover);
  clearTimeout(timer);
  console.log("Stopping...");
  // Send what's left, but don't wait more than 2 s for it.
  const flushed = Promise.all(crowd.map((bot) => bot.sender.flush()));
  await Promise.race([flushed, new Promise((r) => setTimeout(r, 2_000))]);
  for (const bot of crowd) bot.sender.dispose();
  await Promise.all(crowd.map((bot) => bot.client.close()));
  process.exit(0);
}
const timer =
  seconds > 0 ? setTimeout(() => void stop(), seconds * 1000) : undefined;
process.on("SIGINT", () => void stop());
