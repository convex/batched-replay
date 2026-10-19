export type Sample<V> = { t: number; v: V };
export type Flush<V> = (batch: {
  samples: Sample<V>[];
  duration: number;
}) => Promise<unknown>;

export type SenderOptions<V> = {
  /** Sends one batch, usually by calling the app's append mutation. */
  flush: Flush<V>;
  /** How long a window collects samples before it is sent. */
  flushMs?: number;
  /** 0 keeps every sample; otherwise at most one per sampleMs, plus the last. */
  sampleMs?: number;
  now?: () => number;
};

// Matches the component's limits, so a long outage can't build a batch it
// would reject.
const MAX_BUFFERED = 2_000;
const MAX_WINDOW_MS = 60_000;

type Pending<V> = { at: number; v: V };

/**
 * Collects fast-changing values and sends them as one batch per window.
 * One flush at a time; samples from a failed flush are retried with the next.
 */
export class Sender<V> {
  private readonly flushFn: Flush<V>;
  private readonly flushMs: number;
  private readonly sampleMs: number;
  private readonly now: () => number;

  private buffer: Pending<V>[] = [];
  // The newest value thinned out by sampleMs; sent if nothing newer replaces it.
  private trailing: Pending<V> | null = null;
  private lastKeptAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private retryLater = false;

  constructor(options: SenderOptions<V>) {
    this.flushFn = options.flush;
    this.flushMs = options.flushMs ?? 250;
    this.sampleMs = options.sampleMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a value. Pass `keep: true` for discrete events (a click, a
   * pen-up) that sampleMs thinning must never drop.
   */
  push(value: V, options?: { keep?: boolean }) {
    if (this.disposed) return;
    const at = this.now();
    const sample = { at, v: value };
    const thin =
      this.sampleMs > 0 &&
      !options?.keep &&
      at - this.lastKeptAt < this.sampleMs;
    if (thin) {
      this.trailing = sample;
    } else {
      this.trailing = null; // a newer kept sample makes the thinned one moot
      this.buffer.push(sample);
      this.lastKeptAt = at;
    }
    this.capBuffer();
    this.schedule(this.flushMs - (at - this.windowStart()));
  }

  /** Send what's collected now (on unmount, on pagehide). */
  async flush() {
    if (this.inFlight) await this.inFlight;
    await this.send();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private takeTrailing() {
    if (!this.trailing) return;
    this.buffer.push(this.trailing);
    this.trailing = null;
  }

  private windowStart() {
    return this.buffer[0]?.at ?? this.now();
  }

  private schedule(delay: number) {
    if (this.timer !== undefined || this.inFlight || this.disposed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.send();
      },
      Math.max(0, delay),
    );
  }

  private send(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.takeTrailing();
    if (this.buffer.length === 0) return Promise.resolve();
    const sent = this.buffer;
    this.buffer = [];
    const start = sent[0].at;
    const duration = this.now() - start;
    const samples = sent.map(({ at, v }) => ({ t: at - start, v }));
    this.inFlight = this.flushFn({ samples, duration })
      .then(
        () => undefined,
        () => {
          // Keep the samples; they go out with the next window.
          this.buffer = sent.concat(this.buffer);
          this.capBuffer();
          this.retryLater = true;
        },
      )
      .finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    return this.inFlight;
  }

  // After a flush resolves, the next one goes out when the window that kept
  // collecting meanwhile is due, or a full flushMs later after a failure.
  private scheduleNext() {
    if (this.buffer.length === 0 && !this.trailing) return;
    const wait = this.retryLater
      ? this.flushMs
      : this.flushMs - (this.now() - this.windowStart());
    this.retryLater = false;
    this.schedule(wait);
  }

  private capBuffer() {
    const newest = this.buffer[this.buffer.length - 1];
    while (
      this.buffer.length > MAX_BUFFERED ||
      (newest && newest.at - this.buffer[0].at > MAX_WINDOW_MS)
    ) {
      this.buffer.shift();
    }
  }
}
