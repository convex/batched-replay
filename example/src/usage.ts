import { useEffect, useState } from "react";
import { createUsageCounter, type Usage } from "./usageCounter";

// What this tab has cost since the page loaded, for the HUDs. It counts
// what goes over this tab's WebSocket, so it can't see the server-side
// database bandwidth: in a shared room one query run serves every viewer.
//
// Function calls: every mutation (or action) this tab sends, and every query
// result Convex pushes to it, the first one included. Convex counts each
// subscription update as a function call.
//
// Bytes are the size of the messages: mutation arguments going out (about
// the documents written) and query results coming in. Estimates, not the
// billed figure.

export type { Usage };

const counter = createUsageCounter(performance.now());

/**
 * A WebSocket that tells the counter about every message. Pass it to the
 * client as `webSocketConstructor`, a public option, so the counting needs
 * nothing internal from the Convex client.
 */
export class CountingWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") {
        counter.received(event.data, performance.now());
      }
    });
  }
  send(data: Parameters<WebSocket["send"]>[0]) {
    if (typeof data === "string") counter.sent(data, performance.now());
    super.send(data);
  }
}

/** This tab's usage, refreshed once a second. */
export function useUsage(): Usage {
  const [usage, setUsage] = useState(() => counter.snapshot(performance.now()));
  useEffect(() => {
    const id = setInterval(() => {
      const next = counter.snapshot(performance.now());
      setUsage((prev) => (sameUsage(prev, next) ? prev : next));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return usage;
}

function sameUsage(a: Usage, b: Usage) {
  return (Object.keys(a) as (keyof Usage)[]).every((k) => a[k] === b[k]);
}

export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
