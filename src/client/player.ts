import { lerp } from "./lerp.js";

/** A batch as returned by the component's `latest` and `history` queries. */
export type PlayerBatch<V> = {
  _id: string;
  _creationTime: number;
  seq: number;
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
  /**
   * The most the automatic delay grows to. Batches later than this don't
   * raise it; their samples just play late. Default 2,000.
   */
  maxDelayMs?: number;
  /** true lerps numeric fields and steps the rest; or pass your own blend. */
  interpolate?: Interpolate<V>;
  /** Fired once per sample as the playhead passes it, in time order. */
  onSample?: (stream: string, value: V, time: number) => void;
  /**
   * Loads a stream's batches after `seq`, to fill a gap when some were
   * missed. Usually calls the `history` query for that stream.
   */
  fetchAfter?: (stream: string, seq: number) => Promise<PlayerBatch<V>[]>;
  /**
   * Every batch matters, as for a drawing: feed the stored batches with
   * `ingestHistory` first, and nothing after them is skipped for being old.
   */
  fromStart?: boolean;
  now?: () => number;
};

export type PlayerStats = {
  delayMs: number;
  bufferedMs: Record<string, number>;
  samplesPerSecond: number;
  batchesPerSecond: number;
};

// Until a live batch has been measured.
export const DEFAULT_DELAY_MS = 400;
export const DEFAULT_MAX_DELAY_MS = 2_000;
// Headroom on top of the latest a batch has arrived lately.
const SAFETY_MS = 50;
// How fast an automatic delay may change, in ms of delay per ms of time.
// Growing is quicker, since running out of samples shows as a stutter.
const DELAY_GROW = 0.2;
const DELAY_SHRINK = 0.05;
// A new subscription's first batches are history, not live. Their samples
// are skipped if they're already this far behind the playhead.
const MAX_SNAPSHOT_LATE_MS = 3_000;
// How long a stream waits for missing batches before playing on without them.
const GAP_WAIT_MS = 2_000;
// How long clock-offset measurements and rate counters look back.
const OFFSET_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 5_000;
const KEEP_BEHIND_MS = 10_000;

type Entry<V> = { time: number; v: V; emitted: boolean };
// "snapshot": a stream's first `ingest`, written before we were listening.
// "fill": fetched to fill a gap. Only "live" batches teach us the clock.
type Kind = "live" | "snapshot" | "fill";
type Arrival = {
  at: number; // local time it arrived
  start: number; // server time its first sample plays
  samples: number;
};
type StreamState<V> = {
  entries: Entry<V>[]; // sorted by time
  subscribed: boolean; // has had its first `ingest`
  seq: number | undefined; // the last batch taken in order
  created: number; // that batch's _creationTime
  end: number; // where the stream's timeline has got to
  held: PlayerBatch<V>[]; // arrived after a gap, waiting for the missing ones
  gapSince: number | undefined;
  fetching: boolean;
};

/**
 * Replays batches with their original timing, a little behind the server.
 * Feed it with `ingest`, call `tick` every frame, read `value`.
 */
export class Player<V> {
  private fixedDelayMs: number | undefined;
  private maxDelayMs: number;
  private delayMs: number;
  private lastEaseAt: number | undefined;
  private delaySettled = false;
  private interpolate: Interpolate<V>;
  private readonly onSample?: PlayerOptions<V>["onSample"];
  private readonly fetchAfter?: PlayerOptions<V>["fetchAfter"];
  private readonly fromStart: boolean;
  private readonly now: () => number;

  private streamStates = new Map<string, StreamState<V>>();
  private generation = 0; // bumped by reset, so loads started before it stop
  private offsets: { arrivedAt: number; offset: number }[] = [];
  private offset: number | undefined; // the best of `offsets`
  private arrivals: Arrival[] = [];
  private targetDelayMs: number | undefined;

  constructor(options: PlayerOptions<V> = {}) {
    this.fixedDelayMs = options.delayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.interpolate = options.interpolate ?? false;
    this.onSample = options.onSample;
    this.fetchAfter = options.fetchAfter;
    this.fromStart = options.fromStart ?? false;
    this.now = options.now ?? Date.now;
  }

  configure(
    options: Pick<PlayerOptions<V>, "delayMs" | "maxDelayMs" | "interpolate">,
  ) {
    this.fixedDelayMs = options.delayMs;
    if (options.delayMs !== undefined) this.delayMs = options.delayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.interpolate = options.interpolate ?? false;
  }

  /**
   * Feed each result of a stream's `latest` subscription. The first one is
   * treated as history; batches already taken are ignored.
   */
  ingest(stream: string, batches: PlayerBatch<V>[]) {
    const state = this.stateFor(stream);
    const kind = state.subscribed ? "live" : "snapshot";
    state.subscribed = true;
    this.take(stream, state, batches, kind);
  }

  /**
   * Emits stored batches straight away, in order (pages of the `history`
   * query, for "history, then live"). Each stream then carries on from the
   * last batch here, so live batches skip what's been played and fill gaps.
   */
  ingestHistory(batches: (PlayerBatch<V> & { stream: string })[]) {
    for (const batch of batches) {
      const state = this.stateFor(batch.stream);
      if (state.seq !== undefined && batch.seq <= state.seq) continue;
      for (const sample of batch.samples) {
        this.onSample?.(batch.stream, sample.v, batch.start + sample.t);
      }
      const last = batch.samples[batch.samples.length - 1];
      if (last) {
        state.entries = [
          { time: batch.start + last.t, v: last.v, emitted: true },
        ];
      }
      state.seq = batch.seq;
      state.created = batch._creationTime;
      state.end = batch.end;
    }
  }

  /**
   * "History, then live": loads every stored batch, a page at a time with
   * `load` (the room's `history` query), and plays it straight away through
   * `ingestHistory`. Resolves true once it's all played, then `ingest` live
   * results as usual. Resolves false if `reset` was called meanwhile. If it
   * fails it can just be called again: nothing is played twice.
   */
  async loadHistory<Cursor>(
    load: (after: Cursor | undefined) => Promise<{
      batches: (PlayerBatch<V> & { stream: string })[];
      next: Cursor | null;
    }>,
  ): Promise<boolean> {
    const generation = this.generation;
    let after: Cursor | undefined;
    for (;;) {
      const page = await load(after);
      if (generation !== this.generation) return false;
      this.ingestHistory(page.batches);
      if (page.next === null) return true;
      after = page.next;
    }
  }

  /** Forget every stream's data (after a room is cleared). Keeps the clock. */
  reset() {
    this.generation++;
    this.streamStates = new Map();
  }

  /** Estimated server clock minus the local clock, once a live batch has arrived. */
  clockOffset(): number | undefined {
    return this.offset;
  }

  /** Server time the player is showing, or undefined before any live batch. */
  playhead(): number | undefined {
    if (this.offset === undefined) return undefined;
    return this.now() + this.offset - this.delayMs;
  }

  /** Advance to the current playhead. Call from requestAnimationFrame. */
  tick() {
    this.easeDelay();
    for (const state of this.streamStates.values()) {
      if (
        state.gapSince !== undefined &&
        this.now() - state.gapSince > GAP_WAIT_MS
      ) {
        this.skipGap(state);
      }
    }
    // Before the clock is known, a "from start" player plays what it has
    // straight away, like history.
    const playhead = this.playhead() ?? (this.fromStart ? Infinity : undefined);
    if (playhead === undefined) return;
    for (const [stream, state] of this.streamStates) {
      for (const entry of state.entries) {
        if (entry.time > playhead) break;
        if (entry.emitted) continue;
        entry.emitted = true;
        this.onSample?.(stream, entry.v, entry.time);
      }
      this.prune(state, playhead);
    }
  }

  /**
   * The stream's value at the playhead; undefined until it has data. Before
   * any live batch, it's the stream's last known value.
   */
  value(stream: string): V | undefined {
    const state = this.streamStates.get(stream);
    if (!state || state.entries.length === 0) return undefined;
    const { entries } = state;
    const playhead = this.playhead();
    if (playhead === undefined) return entries[entries.length - 1].v;
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
    return [...this.streamStates.values()].some((s) => s.end > playhead);
  }

  stats(): PlayerStats {
    const playhead = this.playhead();
    const bufferedMs: Record<string, number> = {};
    for (const [stream, state] of this.streamStates) {
      bufferedMs[stream] =
        playhead === undefined ? 0 : Math.max(0, state.end - playhead);
    }
    const since = this.now() - RATE_WINDOW_MS;
    const recent = this.arrivals.filter((a) => a.at >= since);
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
      state = {
        entries: [],
        subscribed: false,
        // From the start, a stream we have no history for begins at seq 0.
        seq: this.fromStart ? -1 : undefined,
        created: -Infinity,
        end: -Infinity,
        held: [],
        gapSince: undefined,
        fetching: false,
      };
      this.streamStates.set(stream, state);
    }
    return state;
  }

  // Takes batches in seq order. One that comes after a gap waits until the
  // missing ones are fetched, so a stream's samples are always emitted in order.
  private take(
    stream: string,
    state: StreamState<V>,
    batches: PlayerBatch<V>[],
    kind: Kind,
  ) {
    const arrivedAt = this.now();
    const seqBefore = state.seq;
    for (const batch of [...batches].sort((a, b) => a.seq - b.seq)) {
      if (state.seq !== undefined && batch.seq <= state.seq) {
        // Already taken, unless the stream was cleared and began again.
        if (batch._creationTime <= state.created) continue;
        this.restart(state);
      }
      if (state.held.some((h) => h.seq === batch.seq)) continue;
      if (kind === "live") this.noteArrival(arrivedAt, batch);
      if (state.seq === undefined || batch.seq === state.seq + 1) {
        this.play(state, batch, kind);
      } else {
        state.held.push(batch);
        state.gapSince ??= arrivedAt;
      }
    }
    // Anything held that now follows on can play.
    state.held.sort((a, b) => a.seq - b.seq);
    while (state.held.length > 0 && state.held[0].seq <= state.seq! + 1) {
      const batch = state.held.shift()!;
      if (batch.seq === state.seq! + 1) this.play(state, batch, "live");
    }
    // A fill that moved things on earns another full wait for the rest.
    if (kind === "fill" && state.seq !== seqBefore && state.held.length > 0) {
      state.gapSince = arrivedAt;
    }
    if (state.held.length === 0) {
      state.gapSince = undefined;
    } else if (!this.fetchAfter) {
      this.skipGap(state);
    } else if (kind !== "fill" || state.seq !== seqBefore) {
      this.fetchMissing(stream, state);
    }
  }

  private play(state: StreamState<V>, batch: PlayerBatch<V>, kind: Kind) {
    const playhead = this.playhead();
    for (const sample of batch.samples) {
      const time = batch.start + sample.t;
      // Live and fetched samples always play, however late. A snapshot's
      // only play if they're new enough (or every batch matters).
      const skip =
        kind === "snapshot" &&
        !this.fromStart &&
        (playhead === undefined || time < playhead - MAX_SNAPSHOT_LATE_MS);
      insertSorted(state.entries, { time, v: sample.v, emitted: skip });
    }
    state.seq = batch.seq;
    state.created = batch._creationTime;
    state.end = Math.max(state.end, batch.end);
  }

  // Gave up waiting for the missing batches: play on without them.
  private skipGap(state: StreamState<V>) {
    for (const batch of state.held.sort((a, b) => a.seq - b.seq)) {
      this.play(state, batch, "live");
    }
    state.held = [];
    state.gapSince = undefined;
  }

  private fetchMissing(stream: string, state: StreamState<V>) {
    if (state.fetching || state.seq === undefined || !this.fetchAfter) return;
    state.fetching = true;
    this.fetchAfter(stream, state.seq).then(
      (batches) => {
        state.fetching = false;
        // Ignore it if the stream was reset meanwhile.
        if (this.streamStates.get(stream) === state) {
          this.take(stream, state, batches, "fill");
        }
      },
      () => {
        state.fetching = false; // the gap times out instead
      },
    );
  }

  // A cleared stream starts again at seq 0.
  private restart(state: StreamState<V>) {
    state.entries = [];
    state.seq = this.fromStart ? -1 : undefined;
    state.created = -Infinity;
    state.end = -Infinity;
    state.held = [];
    state.gapSince = undefined;
  }

  // _creationTime is when the server inserted the batch, so it is a real
  // server-clock reading. The largest (server - local) difference is the one
  // with the least network delay in it.
  private noteArrival(arrivedAt: number, batch: PlayerBatch<V>) {
    this.offsets.push({ arrivedAt, offset: batch._creationTime - arrivedAt });
    const cutoff = arrivedAt - OFFSET_WINDOW_MS;
    this.offsets = this.offsets.filter((o) => o.arrivedAt >= cutoff);
    this.offset = Math.max(...this.offsets.map((o) => o.offset));

    this.arrivals.push({
      at: arrivedAt,
      start: batch.start,
      samples: batch.samples.length,
    });
    this.arrivals = this.arrivals.filter(
      (a) => a.at >= arrivedAt - RATE_WINDOW_MS,
    );
    this.targetDelayMs = this.targetDelay(this.offset);
  }

  // Just far enough behind that every batch lately arrived before the
  // playhead needed it. That covers the flush window, network time and
  // jitter without having to know any of them. Batches too late to cover
  // within maxDelayMs are left out, and play late instead.
  private targetDelay(offset: number): number | undefined {
    const lateness = this.arrivals
      .map((a) => a.at + offset - a.start + SAFETY_MS)
      .filter((delay) => delay <= this.maxDelayMs);
    if (lateness.length === 0) return this.targetDelayMs;
    return Math.max(...lateness);
  }

  // The delay eases towards its target so nothing visibly jumps.
  private easeDelay() {
    const now = this.now();
    const elapsed = now - (this.lastEaseAt ?? now);
    this.lastEaseAt = now;
    if (this.fixedDelayMs !== undefined) {
      this.delayMs = this.fixedDelayMs;
      return;
    }
    const target = this.targetDelayMs;
    if (target === undefined) return; // nothing live yet
    if (!this.delaySettled) {
      // First live data: start at the right delay rather than easing into it.
      this.delayMs = target;
      this.delaySettled = true;
      return;
    }
    const diff = target - this.delayMs;
    const step = elapsed * (diff > 0 ? DELAY_GROW : DELAY_SHRINK);
    this.delayMs += Math.max(-step, Math.min(step, diff));
  }

  // Drop played samples, keeping the one just before the playhead for lerp.
  private prune(state: StreamState<V>, playhead: number) {
    const { entries } = state;
    while (
      entries.length > 2 &&
      entries[0].emitted &&
      entries[1].emitted &&
      entries[1].time < playhead - KEEP_BEHIND_MS
    ) {
      entries.shift();
    }
  }
}

function insertSorted<V>(entries: Entry<V>[], entry: Entry<V>) {
  let i = entries.length;
  while (i > 0 && entries[i - 1].time > entry.time) i--;
  entries.splice(i, 0, entry);
}
