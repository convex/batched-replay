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
  /** Fired once per sample as the position passes it, in time order. */
  onSample?: (stream: string, value: V, time: number) => void;
  now?: () => number;
};

// Start loading the next page when less than this much is left to play.
const PREFETCH_MS = 10_000;

type Item<V> = { stream: string; time: number; v: V };

/**
 * Plays stored batches on a local clock, from the first batch, at any speed.
 * Like Player, it has no timers: call `tick` every frame.
 */
export class HistoryPlayer<V, Cursor = unknown> {
  private readonly load: HistoryPlayerOptions<V, Cursor>["load"];
  private readonly onSample?: HistoryPlayerOptions<V, Cursor>["onSample"];
  private readonly now: () => number;

  private items: Item<V>[] = [];
  private nextItem = 0; // index of the first sample not yet emitted
  private origin: number | undefined; // server time of the first batch
  private cursor: Cursor | undefined;
  private loadedAll = false;
  private loading: Promise<void> | null = null;
  private loadTarget = 0;

  private speed: number;
  private running = false;
  private positionMs = 0;
  private lastTickAt = 0;
  private lastValues = new Map<string, V>();

  constructor(options: HistoryPlayerOptions<V, Cursor>) {
    this.load = options.load;
    this.onSample = options.onSample;
    this.speed = options.speed ?? 1;
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
      const { stream, v, time } = this.items[this.nextItem++];
      this.lastValues.set(stream, v);
      this.onSample?.(stream, v, this.origin! + time);
    }
    if (this.positionMs + PREFETCH_MS >= this.loadedMs()) {
      void this.ensureLoaded(this.positionMs + PREFETCH_MS);
    }
    if (this.loadedAll && this.nextItem >= this.items.length) {
      this.running = false;
    }
  }

  /** ms from the first batch. */
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

  /** The last value emitted for each stream. */
  values(): Map<string, V> {
    return new Map(this.lastValues);
  }

  // How far the loaded data reaches, in ms from the first batch.
  private loadedMs() {
    return this.items[this.items.length - 1]?.time ?? 0;
  }

  // Loads pages until the data reaches untilMs. Calls made while a load is
  // running raise its target instead of starting a second one.
  private ensureLoaded(untilMs: number): Promise<void> {
    this.loadTarget = Math.max(this.loadTarget, untilMs);
    this.loading ??= (async () => {
      while (!this.loadedAll && this.loadedMs() < this.loadTarget) {
        await this.loadPage();
      }
    })().finally(() => {
      this.loading = null;
      this.loadTarget = 0;
    });
    return this.loading;
  }

  private async loadPage() {
    const page = await this.load(this.cursor);
    this.cursor = page.next ?? undefined;
    if (page.next === null) this.loadedAll = true;
    this.origin ??= page.batches[0]?.start;
    if (this.origin === undefined) return;
    for (const batch of page.batches) {
      for (const sample of batch.samples) {
        this.items.push({
          stream: batch.stream,
          time: batch.start + sample.t - this.origin,
          v: sample.v,
        });
      }
    }
    // Batches from different streams overlap, so merge by time. Anything
    // already emitted is before nextItem and stays put.
    const tail = this.items
      .splice(this.nextItem)
      .sort((a, b) => a.time - b.time);
    this.items.push(...tail);
  }
}
