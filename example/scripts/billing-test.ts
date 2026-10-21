// Measures how cached query updates are billed: one sender appends about 4
// times a second while N viewers each subscribe to the same `latest` query.
// Prints what the clients saw; compare with the deployment's metered function
// calls before and after (`npx convex deployment usage --json`).
// Usage: node example/scripts/billing-test.ts <deployment url> [viewers] [seconds]
import { ConvexClient } from "convex/browser";
import { Sender } from "@convex-dev/batched-replay";
import { api } from "../convex/_generated/api.js";

const [url, viewersArg = "20", secondsArg = "60"] = process.argv.slice(2);
const viewers = Number(viewersArg);
const seconds = Number(secondsArg);
const room = "billing-test";
const stream = `sender-${Math.random().toString(16).slice(2, 8)}`;

let appends = 0;
let updates = 0;
const sendClient = new ConvexClient(url);
const sender = new Sender<{ x: number; y: number }>({
  send: (batch) => {
    appends++;
    return sendClient.mutation(api.cursors.append, { room, stream, ...batch });
  },
  flushMs: 250,
});
const clients = Array.from({ length: viewers }, () => {
  const client = new ConvexClient(url);
  client.onUpdate(api.cursors.latest, { room, stream }, () => updates++);
  return client;
});

await new Promise((r) => setTimeout(r, 3000));
const updatesBefore = updates;
const t0 = Date.now();
await new Promise<void>((resolve) => {
  const timer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    sender.push({ x: 700 + 300 * Math.cos(s), y: 450 + 200 * Math.sin(s) });
    if (s > seconds) {
      clearInterval(timer);
      resolve();
    }
  }, 16);
});
await sender.flush();
await new Promise((r) => setTimeout(r, 3000));
console.log(
  JSON.stringify({
    viewers,
    seconds,
    appends,
    initialResults: updatesBefore,
    updatesDuringRun: updates - updatesBefore,
  }),
);
await Promise.all([sendClient, ...clients].map((c) => c.close()));
process.exit(0);
