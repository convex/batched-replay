import { lerp } from "./lerp.js";

/** A batch as returned by the component's `latest` query. */
export type PlayerBatch<V> = {
  _id: string;
  _creationTime: number;
  start: number;
  end: number;
  samples: { t: number; v: V }[];
};

export type Interpolate<V> = boolean | ((a: V, b: V, alpha: number) => V);

export type PlayerOptions<V> = {
  /**
   * How far behind the server's clock to play. By default it's automatic:
   * just far enough behind to cover how late batches have been arriving.
   */
  delayMs?: number;
  /** true lerps numeric fields and steps the rest; or pass your own blend. */
  interpolate?: Interpolate<V>;
  /** Fired once per sample as the playhead passes it, in time order. */
  onSample?: (stream: string, value: V, time: number) => void;
  now?: () => number;
};

export type PlayerStats = {
  delayMs: number;
  bufferedMs: Record<string, number>;
  samplesPerSecond: number;
  batchesPerSecond: number;
};

// Before any live batch has been measured, guess one flush window plus this.
const GUESS_MARGIN_MS = 150;
export const DEFAULT_DELAY_MS = 250 + GUESS_MARGIN_MS;
// Headroom on top of the latest a batch has arrived lately.
const SAFETY_MS = 50;
// How fast an automatic delay may change, in ms of delay per ms of time.
// Growing is quicker, since running out of samples shows as a stutter.
const DELAY_GROW = 0.2;
const DELAY_SHRINK = 0.05;
// Samples that show up already this far behind the playhead aren't emitted.
const MAX_LATE_MS = 3_000;
// How long clock-offset measurements and rate counters look back.
const OFFSET_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 5_000;
const KEEP_BEHIND_MS = 10_000;

type Entry<V> = { time: number; v: V; emitted: boolean };
type Arrival = {
  at: number; // local time it arrived
  created: number; // server time it was written
  start: number; // server time its first sample plays
  samples: number;
  duration: number;
  // False for the batches a new subscription delivers in one go: they were
  // written before we were listening, so their lateness means nothing.
  live: boolean;
};
type StreamState<V> = {
  entries: Entry<V>[]; // sorted by time
  seen: Map<string, number>; // batch _id -> end, for dedupe
  lastTime: number;
};

/**
 * Replays batches with their original timing, a little behind the server.
 * Feed it with `ingest`, call `tick` every frame, read `value`.
 */
export class Player<V> {
  private fixedDelayMs: number | undefined;
  private delayMs: number;
  private lastEaseAt: number | undefined;
  private delaySettled = false;
  private interpolate: Interpolate<V>;
  private readonly onSample?: PlayerOptions<V>["onSample"];
  private readonly now: () => number;

  private streamStates = new Map<string, StreamState<V>>();
  private offsets: { arrivedAt: number; offset: number }[] = [];
  private arrivals: Arrival[] = [];

  constructor(options: PlayerOptions<V> = {}) {
    this.fixedDelayMs = options.delayMs;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.interpolate = options.interpolate ?? false;
    this.onSample = options.onSample;
    this.now = options.now ?? Date.now;
  }

  configure(options: Pick<PlayerOptions<V>, "delayMs" | "interpolate">) {
    this.fixedDelayMs = options.delayMs;
    if (options.delayMs !== undefined) this.delayMs = options.delayMs;
    this.interpolate = options.interpolate ?? false;
  }

  /** Feed the result of `latest`; batches already seen are ignored. */
  ingest(stream: string, batches: PlayerBatch<V>[]) {
    const arrivedAt = this.now();
    const live = this.streamStates.has(stream);
    const state = this.stateFor(stream);
    for (const batch of batches) {
      if (state.seen.has(batch._id)) continue;
      state.seen.set(batch._id, batch.end);
      this.noteArrival(arrivedAt, batch, live);
      for (const sample of batch.samples) {
        insertSorted(state.entries, {
          time: batch.start + sample.t,
          v: sample.v,
          emitted: false,
        });
      }
      state.lastTime = Math.max(state.lastTime, batch.end);
    }
  }

  /** Estimated server clock minus the local clock, once a batch has arrived. */
  clockOffset(): number | undefined {
    return this.offset();
  }

  /** Server time the player is showing, or undefined before any batch. */
  playhead(): number | undefined {
    const offset = this.offset();
    return offset === undefined
      ? undefined
      : this.now() + offset - this.delayMs;
  }

  /** Advance to the current playhead. Call from requestAnimationFrame. */
  tick() {
    this.easeDelay();
    const playhead = this.playhead();
    if (playhead === undefined) return;
    for (const [stream, state] of this.streamStates) {
      for (const entry of state.entries) {
        if (entry.time > playhead) break;
        if (entry.emitted) continue;
        entry.emitted = true;
        if (playhead - entry.time <= MAX_LATE_MS) {
          this.onSample?.(stream, entry.v, entry.time);
        }
      }
      this.prune(state, playhead);
    }
  }

  /** The stream's value at the playhead; undefined until it has data. */
  value(stream: string): V | undefined {
    const state = this.streamStates.get(stream);
    const playhead = this.playhead();
    if (!state || playhead === undefined || state.entries.length === 0) {
      return undefined;
    }
    const { entries } = state;
    const next = entries.findIndex((e) => e.time > playhead);
    // Not started yet: show the first known value right away.
    if (next === 0) return entries[0].v;
    // Out of buffer: hold the last value.
    if (next === -1) return entries[entries.length - 1].v;
    const a = entries[next - 1];
    const b = entries[next];
    if (!this.interpolate) return a.v;
    const alpha = (playhead - a.time) / (b.time - a.time);
    const blend = this.interpolate === true ? lerp : this.interpolate;
    return blend(a.v as never, b.v as never, alpha) as V;
  }

  /** Streams with any data. */
  streams(): string[] {
    return [...this.streamStates]
      .filter(([, s]) => s.entries.length > 0)
      .map(([stream]) => stream);
  }

  /** True while some stream still has samples ahead of the playhead. */
  isPlaying(): boolean {
    const playhead = this.playhead();
    if (playhead === undefined) return false;
    return [...this.streamStates.values()].some((s) => s.lastTime > playhead);
  }

  stats(): PlayerStats {
    const playhead = this.playhead();
    const bufferedMs: Record<string, number> = {};
    for (const [stream, state] of this.streamStates) {
      bufferedMs[stream] =
        playhead === undefined ? 0 : Math.max(0, state.lastTime - playhead);
    }
    const recent = this.recentArrivals();
    const seconds = RATE_WINDOW_MS / 1000;
    return {
      delayMs: this.delayMs,
      bufferedMs,
      samplesPerSecond: recent.reduce((n, a) => n + a.samples, 0) / seconds,
      batchesPerSecond: recent.length / seconds,
    };
  }

  private stateFor(stream: string) {
    let state = this.streamStates.get(stream);
    if (!state) {
      state = { entries: [], seen: new Map(), lastTime: -Infinity };
      this.streamStates.set(stream, state);
    }
    return state;
  }

  // _creationTime is when the server inserted the batch, so it is a real
  // server-clock reading. The largest (server - local) difference is the one
  // with the least network delay in it.
  private noteArrival(arrivedAt: number, batch: PlayerBatch<V>, live: boolean) {
    this.offsets.push({ arrivedAt, offset: batch._creationTime - arrivedAt });
    const cutoff = arrivedAt - OFFSET_WINDOW_MS;
    this.offsets = this.offsets.filter((o) => o.arrivedAt >= cutoff);
    this.arrivals.push({
      at: arrivedAt,
      created: batch._creationTime,
      start: batch.start,
      samples: batch.samples.length,
      duration: batch.end - batch.start,
      live,
    });
    this.arrivals = this.arrivals.filter(
      (a) => a.at >= arrivedAt - RATE_WINDOW_MS,
    );
  }

  // With no fixed delay, play just far enough behind that every batch lately
  // arrived before the playhead needed it. That covers the flush window,
  // network time and jitter without having to know any of them. The delay
  // eases towards its target so nothing visibly jumps.
  private easeDelay() {
    const now = this.now();
    const elapsed = now - (this.lastEaseAt ?? now);
    this.lastEaseAt = now;
    if (this.fixedDelayMs !== undefined) {
      this.delayMs = this.fixedDelayMs;
      return;
    }
    const target = this.targetDelay();
    if (target === undefined) return; // nothing live: keep the delay we have
    if (!this.delaySettled) {
      // First data: start at the right delay rather than easing into it.
      this.delayMs = target;
      this.delaySettled = true;
      return;
    }
    const diff = target - this.delayMs;
    const step = elapsed * (diff > 0 ? DELAY_GROW : DELAY_SHRINK);
    this.delayMs += Math.max(-step, Math.min(step, diff));
  }

  private targetDelay(): number | undefined {
    const recent = this.recentArrivals();
    const offset = this.offset();
    const live = recent.filter((a) => a.live);
    if (live.length > 0 && offset !== undefined) {
      // How long after its first sample each batch was in our hands, in
      // server time. The playhead has to be at least that far behind.
      const lateness = live.map((a) => a.at + offset - a.start);
      return Math.max(...lateness) + SAFETY_MS;
    }
    if (recent.length > 0) {
      return Math.max(...recent.map((a) => a.duration)) + GUESS_MARGIN_MS;
    }
    return undefined;
  }

  // Batches that arrived lately and were written lately. A new subscription
  // also delivers a stream's last few batches, which may be minutes old, and
  // those mustn't count towards the delay or the rates.
  private recentArrivals() {
    const since = this.now() - RATE_WINDOW_MS;
    const newest = Math.max(...this.arrivals.map((a) => a.created));
    return this.arrivals.filter(
      (a) => a.at >= since && a.created >= newest - RATE_WINDOW_MS,
    );
  }

  private offset(): number | undefined {
    if (this.offsets.length === 0) return undefined;
    return Math.max(...this.offsets.map((o) => o.offset));
  }

  // Drop played samples, keeping the one just before the playhead for lerp.
  private prune(state: StreamState<V>, playhead: number) {
    const { entries } = state;
    while (
      entries.length > 2 &&
      entries[0].emitted &&
      entries[1].time < playhead - KEEP_BEHIND_MS
    ) {
      entries.shift();
    }
    for (const [id, end] of state.seen) {
      if (end < playhead - 3 * KEEP_BEHIND_MS) state.seen.delete(id);
    }
  }
}

function insertSorted<V>(entries: Entry<V>[], entry: Entry<V>) {
  let i = entries.length;
  while (i > 0 && entries[i - 1].time > entry.time) i--;
  entries.splice(i, 0, entry);
}
