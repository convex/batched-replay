/** One page of the component's `history` query. */
export type HistoryPage<V, Cursor> = {
  batches: {
    stream: string;
    start: number;
    samples: { t: number; v: V }[];
  }[];
  next: Cursor | null;
};

export type HistoryPlayerOptions<V, Cursor> = {
  /** Loads one page; `after` is the previous page's `next` (undefined first). */
  load: (after: Cursor | undefined) => Promise<HistoryPage<V, Cursor>>;
  /** 1 = real time. Infinity plays everything as fast as it loads. */
  speed?: number;
  /** Idle stretches longer than this are cut down to it. Default 2,000 ms. */
  maxGapMs?: number;
  /** Fired once per sample as the position passes it, in time order. */
  onSample?: (stream: string, value: V, time: number) => void;
  now?: () => number;
};

// Start loading the next page when less than this much is left to play.
const PREFETCH_MS = 10_000;
// After a failed load, wait this long before trying again, doubling each time.
const RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;

// `serverTime` is when it happened; `time` is where it plays, in ms from the
// first sample, with long idle gaps cut short.
type Item<V> = { stream: string; serverTime: number; time: number; v: V };

/**
 * Plays stored batches on a local clock, from the first batch, at any speed.
 * Like Player, it has no timers: call `tick` every frame.
 */
export class HistoryPlayer<V, Cursor = unknown> {
  private readonly load: HistoryPlayerOptions<V, Cursor>["load"];
  private readonly onSample?: HistoryPlayerOptions<V, Cursor>["onSample"];
  private readonly maxGapMs: number;
  private readonly now: () => number;

  private items: Item<V>[] = [];
  private nextItem = 0; // index of the first sample not yet emitted
  private cursor: Cursor | undefined;
  private loadedAll = false;
  private loading: Promise<void> | null = null;
  private loadTarget = 0;
  private generation = 0; // bumped by reset, so in-flight loads are dropped
  private lastError: unknown = undefined;
  private failures = 0; // in a row
  private retryAt = 0;

  private speed: number;
  private running = false;
  private positionMs = 0;
  private lastTickAt = 0;
  private lastValues = new Map<string, V>();

  constructor(options: HistoryPlayerOptions<V, Cursor>) {
    this.load = options.load;
    this.onSample = options.onSample;
    this.speed = options.speed ?? 1;
    this.maxGapMs = options.maxGapMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  play() {
    this.running = true;
    this.lastTickAt = this.now();
    void this.ensureLoaded(this.positionMs + PREFETCH_MS);
  }

  pause() {
    this.tick();
    this.running = false;
  }

  /**
   * Forget everything loaded and go back to position 0, paused. The speed is
   * kept. Call `play` to replay, loading again from the start, so batches
   * written since the last load are included.
   */
  reset() {
    this.generation++;
    this.items = [];
    this.nextItem = 0;
    this.cursor = undefined;
    this.loadedAll = false;
    this.loading = null;
    this.loadTarget = 0;
    this.lastError = undefined;
    this.failures = 0;
    this.retryAt = 0;
    this.running = false;
    this.positionMs = 0;
    this.lastValues = new Map();
  }

  setSpeed(speed: number) {
    this.tick();
    this.speed = speed;
  }

  /** Jump to `time` ms from the first batch. Skipped samples aren't emitted. */
  async seek(time: number) {
    await this.ensureLoaded(time);
    this.positionMs = Math.max(0, time);
    this.lastTickAt = this.now();
    this.nextItem = this.items.findIndex((i) => i.time > this.positionMs);
    if (this.nextItem === -1) this.nextItem = this.items.length;
  }

  /** Advance the clock and emit the samples it passed. */
  tick() {
    const now = this.now();
    if (!this.running) {
      this.lastTickAt = now;
      return;
    }
    if (this.speed === Infinity) {
      this.positionMs = this.loadedMs();
    } else {
      this.positionMs += (now - this.lastTickAt) * this.speed;
    }
    this.lastTickAt = now;
    while (
      this.nextItem < this.items.length &&
      this.items[this.nextItem].time <= this.positionMs
    ) {
      const { stream, v, serverTime } = this.items[this.nextItem++];
      this.lastValues.set(stream, v);
      this.onSample?.(stream, v, serverTime);
    }
    if (this.positionMs + PREFETCH_MS >= this.loadedMs()) {
      void this.ensureLoaded(this.positionMs + PREFETCH_MS);
    }
    if (this.loadedAll && this.nextItem >= this.items.length) {
      this.running = false;
    }
  }

  /** Where playback is, in ms from the first sample (idle gaps cut short). */
  position() {
    return this.positionMs;
  }

  isPlaying() {
    return this.running;
  }

  /** True once every batch is loaded and played. */
  isFinished() {
    return this.loadedAll && this.nextItem >= this.items.length;
  }

  /** The last failed load, until a load succeeds. Loads retry with backoff. */
  error(): unknown {
    return this.lastError;
  }

  /** The last value emitted for each stream. */
  values(): Map<string, V> {
    return new Map(this.lastValues);
  }

  // How far the loaded data reaches, in ms from the first sample.
  private loadedMs() {
    return this.items[this.items.length - 1]?.time ?? 0;
  }

  // Loads pages until the data reaches untilMs. Calls made while a load is
  // running raise its target instead of starting a second one.
  private ensureLoaded(untilMs: number): Promise<void> {
    this.loadTarget = Math.max(this.loadTarget, untilMs);
    if (!this.loading && this.now() >= this.retryAt) {
      const generation = this.generation;
      const loading: Promise<void> = (async () => {
        while (
          generation === this.generation &&
          !this.loadedAll &&
          this.loadedMs() < this.loadTarget
        ) {
          await this.loadPage();
        }
      })()
        .catch((error: unknown) => {
          if (generation !== this.generation) return;
          // Don't retry every frame: back off, 1 s doubling up to 10 s.
          this.lastError = error;
          this.failures++;
          const wait = RETRY_MS * 2 ** (this.failures - 1);
          this.retryAt = this.now() + Math.min(wait, MAX_RETRY_MS);
        })
        .finally(() => {
          // A reset may have replaced this load with a newer one.
          if (this.loading === loading) {
            this.loading = null;
            this.loadTarget = 0;
          }
        });
      this.loading = loading;
    }
    return this.loading ?? Promise.resolve();
  }

  private async loadPage() {
    const generation = this.generation;
    const page = await this.load(this.cursor);
    if (generation !== this.generation) return; // reset while loading
    this.lastError = undefined;
    this.failures = 0;
    this.cursor = page.next ?? undefined;
    if (page.next === null) this.loadedAll = true;
    for (const batch of page.batches) {
      for (const sample of batch.samples) {
        this.items.push({
          stream: batch.stream,
          serverTime: batch.start + sample.t,
          time: 0,
          v: sample.v,
        });
      }
    }
    // Batches from different streams overlap, so merge by time. Anything
    // already emitted is before nextItem and stays put.
    const tail = this.items
      .splice(this.nextItem)
      .sort((a, b) => a.serverTime - b.serverTime);
    // Lay the rest out on the replay timeline, cutting long gaps short.
    let previous = this.items[this.items.length - 1];
    for (const item of tail) {
      const gap = previous ? item.serverTime - previous.serverTime : 0;
      item.time =
        (previous?.time ?? 0) + Math.min(Math.max(gap, 0), this.maxGapMs);
      previous = item;
    }
    this.items.push(...tail);
  }
}
