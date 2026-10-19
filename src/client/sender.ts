export type Sample<V> = { t: number; v: V };
export type Send<V> = (batch: {
  samples: Sample<V>[];
  duration: number;
}) => Promise<unknown>;

export type SenderOptions<V> = {
  /** Sends one batch, usually by calling the app's append mutation. */
  send: Send<V>;
  /** How long a window collects samples before it is sent. */
  flushMs?: number;
  /** 0 keeps every sample; otherwise at most one per sampleMs, plus the last. */
  sampleMs?: number;
  /** Called each time a send fails. Its samples are retried, with backoff. */
  onError?: (error: unknown) => void;
  now?: () => number;
};

// Matches the component's limits, so a long outage can't build a batch it
// would reject.
const MAX_BUFFERED = 2_000;
const MAX_WINDOW_MS = 60_000;
// Retries wait flushMs, then twice that each time, up to this.
const MAX_BACKOFF_MS = 5_000;

type Pending<V> = { at: number; v: V };

/**
 * Collects fast-changing values and sends them as one batch per window.
 * One send at a time; samples from a failed send are retried with the next.
 */
export class Sender<V> {
  private readonly sendFn: Send<V>;
  private readonly flushMs: number;
  private readonly sampleMs: number;
  private readonly onError?: (error: unknown) => void;
  private readonly now: () => number;

  private buffer: Pending<V>[] = [];
  // The newest value thinned out by sampleMs; sent if nothing newer replaces it.
  private trailing: Pending<V> | null = null;
  private lastKeptAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private failures = 0; // in a row
  private retryAt = 0; // after a failure, nothing goes out before this

  constructor(options: SenderOptions<V>) {
    this.sendFn = options.send;
    this.flushMs = options.flushMs ?? 250;
    this.sampleMs = options.sampleMs ?? 0;
    this.onError = options.onError;
    // performance.now() never steps backwards the way the wall clock can
    // (sleep, time sync), which would make the server reject a batch.
    this.now = options.now ?? (() => performance.now());
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
    if (this.buffer.length > MAX_BUFFERED) this.buffer.shift();
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
      Math.max(0, delay, this.retryAt - this.now()),
    );
  }

  private send(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.takeTrailing();
    // The server rejects a batch longer than a minute, so samples that old
    // (left over from failed sends) are dropped.
    const now = this.now();
    this.buffer = this.buffer.filter((s) => s.at >= now - MAX_WINDOW_MS);
    if (this.buffer.length === 0) return Promise.resolve();
    const sent = this.buffer;
    this.buffer = [];
    const start = sent[0].at;
    const duration = now - start;
    // Keep times in order and inside the window, whatever the clock did.
    let last = 0;
    const samples = sent.map(({ at, v }) => {
      last = Math.min(duration, Math.max(last, at - start));
      return { t: last, v };
    });
    this.inFlight = this.sendFn({ samples, duration })
      .then(
        () => {
          this.failures = 0;
          this.retryAt = 0;
        },
        (error: unknown) => {
          // Keep the samples; they go out with the next window, after a
          // backoff of flushMs, then twice that each time, up to 5 s.
          this.buffer = sent.concat(this.buffer).slice(-MAX_BUFFERED);
          this.failures++;
          const backoff = this.flushMs * 2 ** (this.failures - 1);
          this.retryAt = this.now() + Math.min(backoff, MAX_BACKOFF_MS);
          this.onError?.(error);
        },
      )
      .finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    return this.inFlight;
  }

  // After a send resolves, the next one goes out when the window that kept
  // collecting meanwhile is due (or when the backoff ends, after a failure).
  private scheduleNext() {
    if (this.buffer.length === 0 && !this.trailing) return;
    this.schedule(this.flushMs - (this.now() - this.windowStart()));
  }
}
