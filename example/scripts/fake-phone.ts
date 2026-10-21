// A fake phone for the tilt demo: streams a continuously changing tilt, like a
// real phone's sensor, through the component's Sender. Used to debug #marble.
// Usage: node example/scripts/fake-phone.ts <deployment url> [seconds]
import { ConvexClient } from "convex/browser";
import { Sender } from "@convex-dev/batched-replay";
import { api } from "../convex/_generated/api.js";

const url = process.argv[2];
const seconds = Number(process.argv[3] ?? 20);
const client = new ConvexClient(url);
const stream = Math.random().toString(16).slice(2, 10);
type Tilt = { beta: number; gamma: number; flushMs: number };
const sender = new Sender<Tilt>({
  send: (batch) =>
    client.mutation(api.tilt.append, { room: "tilt-demo", stream, ...batch }),
  onError: (error) => console.warn("send failed:", String(error)),
  flushMs: 250,
});
console.log("fake phone", stream);
const t0 = Date.now();
const timer = setInterval(() => {
  const s = (Date.now() - t0) / 1000;
  sender.push({
    beta: 25 * Math.sin(s * 1.3),
    gamma: 25 * Math.cos(s * 0.9),
    flushMs: 250,
  });
  if (s > seconds) {
    clearInterval(timer);
    void sender.flush();
    setTimeout(() => {
      void client.close();
      process.exit(0);
    }, 1500);
  }
}, 22);
