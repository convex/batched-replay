// Counts this tab's function calls and message sizes from the raw
// WebSocket messages. Kept free of the browser so it can be unit tested.

export type Usage = {
  writes: number;
  updates: number;
  calls: number;
  callsPerMinute: number;
  bytesSent: number;
  bytesReceived: number;
};

const WINDOW_MS = 60_000;

export function createUsageCounter(startedAt: number) {
  let writes = 0;
  let updates = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  let callTimes: number[] = [];
  // Big transitions arrive split into chunks; join them to count the queries.
  const chunks = new Map<string, string[]>();

  const countCalls = (n: number, at: number) => {
    for (let i = 0; i < n; i++) callTimes.push(at);
  };

  const countTransition = (
    transition: { modifications?: unknown },
    at: number,
  ) => {
    const modifications = Array.isArray(transition.modifications)
      ? (transition.modifications as { type?: string }[])
      : [];
    const n = modifications.filter(
      (m) => m.type === "QueryUpdated" || m.type === "QueryFailed",
    ).length;
    updates += n;
    countCalls(n, at);
  };

  return {
    /** A message this tab sent to Convex. */
    sent(data: string, at: number) {
      const message = parse(data);
      if (message?.type !== "Mutation" && message?.type !== "Action") return;
      writes++;
      bytesSent += data.length;
      countCalls(1, at);
    },
    /** A message Convex sent to this tab. */
    received(data: string, at: number) {
      const message = parse(data);
      if (message?.type === "Transition") {
        bytesReceived += data.length;
        countTransition(message, at);
      } else if (message?.type === "TransitionChunk") {
        bytesReceived += data.length;
        const { transitionId, chunk, partNumber, totalParts } = message as {
          transitionId: string;
          chunk: string;
          partNumber: number;
          totalParts: number;
        };
        const parts = chunks.get(transitionId) ?? [];
        parts[partNumber] = chunk;
        chunks.set(transitionId, parts);
        if (parts.filter((p) => p !== undefined).length === totalParts) {
          chunks.delete(transitionId);
          const whole = parse(parts.join(""));
          if (whole) countTransition(whole, at);
        }
      }
    },
    snapshot(now: number): Usage {
      callTimes = callTimes.filter((at) => at > now - WINDOW_MS);
      // Early on, scale what we've seen so far up to a minute.
      const windowMs = Math.min(WINDOW_MS, Math.max(now - startedAt, 1000));
      return {
        writes,
        updates,
        calls: writes + updates,
        callsPerMinute: Math.round((callTimes.length * WINDOW_MS) / windowMs),
        bytesSent,
        bytesReceived,
      };
    },
  };
}

function parse(
  data: string,
): { type?: string; modifications?: unknown; [key: string]: unknown } | null {
  try {
    return JSON.parse(data) as { type?: string };
  } catch {
    return null;
  }
}
