# @convex-dev/batched-replay: design (v0.1)

Working name. A Convex component for "realtime-ish" high-frequency data: the
sender batches fast-changing values (cursor positions, pen strokes, game
movement, sensor readings) into one mutation every few hundred ms, and every
watcher replays each batch with its original timing. It looks smooth and live,
it runs a little behind (about one flush interval plus network), and it costs a
handful of writes a second instead of 60. Because the batches are kept, you can
also replay a whole session later (a drawing timelapse, a racing-game ghost).

Prior art to credit and learn from, not copy:
- AI Town's `HistoricalObject` and engine playback (server-side game loop, one write a second).
- https://github.com/get-convex/multiplayer-cursors (Sujay and Ian, 2024): server timestamps, adaptive playback clock.
- https://github.com/Iann29/convex-multiplayer-cursors: a cursors-only component (x, y only).
- Mike's 2025 video and https://github.com/mikecann/convex-realtime-cursors.

What makes this one different: any data shape, several streams per room, the
batches are kept (replay and history are first-class), and the sender and
player cores are plain TypeScript with thin React hooks on top.

## Concepts

- **room**: a string the app picks. A set of streams watched together (a whiteboard, a game lobby, a page).
- **stream**: a string key, unique within a room. One sender's sequence of samples (a user's cursor, a user's pen, one game entity). The app decides the key, usually from auth.
- **sample**: `{ t, v }`. `t` is ms from the start of its batch, `v` is any Convex value the app chooses.
- **batch**: one stored document holding a stream's samples for one flush window, stamped with server time.

## Component schema (`src/component/schema.ts`)

```ts
batches: defineTable({
  room: v.string(),
  stream: v.string(),
  seq: v.number(),                 // per stream, 0, 1, 2...
  start: v.number(),               // server ms, timeline start of this batch
  end: v.number(),                 // server ms, start + duration
  samples: v.array(v.object({ t: v.number(), v: v.any() })),
  expiresAt: v.optional(v.number()), // undefined = keep forever
})
  .index("by_stream", ["room", "stream", "seq"])
  .index("by_room_start", ["room", "start"])
  .index("by_expiresAt", ["expiresAt"]),

streams: defineTable({
  room: v.string(),
  stream: v.string(),
  firstStart: v.number(),
  lastEnd: v.number(),             // touched at most every TOUCH_MS (5 s), see append
})
  .index("by_room", ["room", "stream"])
  .index("by_room_lastEnd", ["room", "lastEnd"]),

rooms: defineTable({ room: v.string(), epoch: v.number() })  // bumped by clear
  .index("by_room", ["room"]),
```

Why two tables: the live per-stream query reads only `batches` for one stream,
and the room's stream list reads only `streams`. So an append invalidates that
one stream's subscriptions and nothing else, and the stream list changes at
most every 5 s per stream rather than on every batch.

## Component functions

Modules named after what they deal with: `batches.ts`, `streams.ts`, plus `crons.ts`.

- `batches.append` (mutation). Args `{ room, stream, samples, duration, retentionMs? }`. Returns `{ seq, start, end }`.
  - Validate: 1 to 2,000 samples, `t` within `[0, duration]` and non-decreasing, `0 <= duration <= 60_000`. Throw a clear error otherwise.
  - `now = Date.now()`. Read the stream's latest batch (`by_stream` desc, first).
  - `start = now - duration`. If a previous batch exists and `start < prev.end`, clamp `start = prev.end` so a stream's timeline never overlaps or goes backwards (this absorbs network jitter). If clamping would put `start` more than 1,000 ms after `now - duration`, re-anchor to `now - duration` instead (a one-off latency spike shouldn't push the stream into the future forever). `end = start + duration`.
  - `seq = prev ? prev.seq + 1 : 0`. `expiresAt = retentionMs === undefined ? undefined : end + retentionMs`.
  - Upsert the `streams` doc: insert on first batch, otherwise patch `lastEnd` only if it's more than 5,000 ms old.
- `batches.latest` (query). Args `{ room, stream, count? }` (default 1, max 20). The newest `count` batches for one stream, oldest first. This is the live subscription. A watcher that misses an intermediate query update fills the gap by `seq` from `history`, so one is enough: a load test at 50 people (2026-10-20) showed 2 doubled each viewer's bandwidth for nothing.
- `batches.history` (query). Args `{ room, stream?, after?, limit? }`. Batches in timeline order for a room (or one stream), for replays. Use convex-helpers' `paginator` or an explicit cursor, since `.paginate()` doesn't work inside components. Must not skip batches that share a `start`.
- `streams.list` (query). Args `{ room, limit? }`. Returns `{ epoch, streams }`: the `limit` (default 100) most recently active streams, newest first, with `firstStart` and `lastEnd`. The client decides which are active.
- `streams.clear` (mutation). Args `{ room, stream? }`. Delete a stream's (or a whole room's) batches and stream docs, in bounded chunks, rescheduling itself if there's more (for "clear the canvas"). The last chunk bumps the room's epoch.
- `crons.ts`: every minute, delete batches with `expiresAt < now` in bounded chunks (reschedule if more remain), then (in a separate mutation) delete the `streams` docs of streams with no batches left.

All public component functions have `args` and `returns` validators.

## App-side client (`src/client/index.ts`)

```ts
export class BatchedReplay {
  constructor(component: ComponentApi, options?: { retentionMs?: number })
  append(ctx, { room, stream, samples, duration })   // passes options.retentionMs
  latest(ctx, { room, stream, count? })
  history(ctx, { room, stream?, after?, limit? })
  streams(ctx, { room })
  clear(ctx, { room, stream? })
}

// Ready-made functions to re-export, like the template's exposeApi:
export const { append, latest, history, streams } = exposeApi(components.batchedReplay, {
  value?: Validator,             // each sample's v; default v.any()
  retentionMs?: number,
  authorizeRead: async (ctx, { room }) => void,              // throw to deny
  authorizeWrite: async (ctx, { room, stream? }) => string,  // the stream key
});
```

The app's `append` takes `{ room, stream?, samples, duration }` from the client.
`authorizeWrite` picks the actual stream key, so a client can't write into
someone else's stream unless the app allows it. `value` is the validator for
each sample's `v` on `append` (and in the `returns` of `latest` and `history`),
and its type flows through to the React hooks.

## Plain TS cores (`src/client/sender.ts`, `src/client/player.ts`)

No React in these, so they work in any framework and are unit-testable with fake timers.

### Sender

```ts
const sender = new Sender({
  send: (args: { samples, duration }) => Promise<unknown>,  // calls the app's append mutation
  onError?: (error) => void,
  flushMs?: 250,
  sampleMs?: 0,      // 0 = keep every sample; >0 = at most one per sampleMs, always keeping the trailing one
  now?: () => number // injectable for tests
});
sender.push(value)   // records { t: now - windowStart, v }
sender.flush()       // force now (on unmount, on pagehide)
sender.dispose()
```

- A window starts at the first `push` after the previous flush, so an idle sender sends nothing.
- Flush `flushMs` after the window started. `duration = flushTime - windowStart`.
- Single-flight: while a flush is in flight, keep collecting; the next flush goes as soon as it resolves (or at the next tick, whichever is later). If a flush fails, keep its samples and retry them with the next window (cap the buffer so it can't grow forever).
- Discrete events (a click, a pen-up) are just values, and must never be dropped by `sampleMs` thinning.

### Player

```ts
const player = new Player<V>({
  delayMs?: number,               // default: automatic, see below
  interpolate?: boolean | ((a: V, b: V, alpha: number) => V), // true = lerp numeric fields, step the rest
  onSample?: (stream, value, time) => void,  // fired once per sample as the playhead passes it, in order
  now?: () => number,
});
player.ingest(stream, batches)    // feed results of `latest` as they arrive; dedupe by seq
player.tick()                     // advance to the current playhead; call from requestAnimationFrame
player.value(stream)              // current (optionally interpolated) value at the playhead
player.streams()                  // streams with any data
player.stats()                    // { delayMs, bufferedMs per stream, samplesPerSecond, batchesPerSecond }
```

- Clock: one room-wide playhead in server time, `playhead = estimatedServerNow - delayMs`. Estimate the server clock from each batch as it arrives: `offset = max over the last ~10 s of (batch._creationTime - localArrivalTime)`. `_creationTime` is when the server inserted it, which is a real server-time sample.
- Samples are placed at `batch.start + sample.t` and emitted in order. Batches that arrive late but are still ahead of the playhead play normally. Samples already behind the playhead when they arrive are emitted immediately (so discrete events are never lost) unless they're more than a few seconds old.
- When a stream runs out of buffer, hold its last value.
- Start-up: a new player shows each stream's last known value straight away rather than waiting.
- Automatic delay (the default): the player measures how long after its first sample each live batch was in its hands, and plays the worst of the last 5 s plus 50 ms behind. That covers the flush window, network time and jitter without being told any of them, and follows a sender that changes its flush rate. It eases towards the target, growing faster (0.2 ms per ms) than it shrinks (0.05), because running dry shows as a stutter. The batches a new subscription delivers in one go don't count, since they were written before anyone was listening. Before any live batch it guesses one window plus 150 ms.

### History replay

```ts
const replay = new HistoryPlayer<V>({ load: (after) => Promise<page>, speed?: 1, onSample, ... })
replay.play(); replay.pause(); replay.seek(time); replay.setSpeed(10);
```

Plays stored batches on a local clock from the first batch, at any speed,
including "instant" (emit everything, for rebuilding a canvas on load). This is
what the timelapse and ghost demos use.

## React (`src/react/index.ts`)

- `useSender(appendMutationRef, { room, stream?, flushMs?, sampleMs? })` returns `send(value)`. Flushes on unmount and `pagehide`.
- `usePlayback(api: { latest, streams, history? }, { room, self?, fromStart?, delayMs?, maxDelayMs?, interpolate?, onSample?, onReset? })`. Subscribes to `streams.list` once, then to `latest` for each active stream with `useQueries`, feeds a `Player`, ticks it on `requestAnimationFrame`. Returns `{ values: Map<stream, V>, stats }`, re-rendering each frame only while something is playing. `self` is your own stream key, since you draw your own input locally with no delay.
- `useHistory(api: { history }, { room, stream?, speed? })` wraps `HistoryPlayer` with play, pause, seek and speed.

## Example app (`example/`)

Replace the template's comments demo with a cursors page that proves it works:
open it in two tabs and move the mouse.
- Your own cursor is local. Everyone else's plays back through `usePlayback`.
- A small HUD: writes a second you're sending, batches a second you're receiving, the current delay, and a slider for `flushMs` (16 ms to 1,000 ms) so you can see smooth-but-behind against jumpy-and-expensive.
- Anonymous ids are fine (a random id in localStorage). No auth needed for the demo, but go through `exposeApi` with an `auth` callback so the pattern's right.

More demos (drawing with timelapse, a tiny game with ghosts) come later in the same example app.

## Tests

- Component (convex-test): `seq` increments; `start/end` clamping and the 1 s re-anchor; validation errors; `latest` ordering and `count`; `streams` touch throttling (no patch within 5 s); `history` order and paging without skipping equal `start`s; `expiresAt` cleanup and `clear` in chunks.
- Sender (fake timers): windows, single-flight, failure retry, `sampleMs` thinning keeps trailing samples and never drops discrete events.
- Player (injected clock): placement in server time, ordered `onSample`, dedupe by `seq`, late arrivals, hold on starvation, interpolation, offset estimate.

## Decided while building (2026-10-19)

- `history` returns `{ batches, next }`; pass `next` back as `after`. The cursor is `{ start, creationTime, seq }`, so batches that share a `start` aren't skipped. No convex-helpers dependency.
- `Sender.push(value, { keep: true })` marks discrete events that `sampleMs` thinning must never drop.
- `Player` dedupes by batch `_id`, not `seq`, because `seq` restarts after `clear`. (Changed in the fix round below: by `seq`, with `_creationTime` to spot a restart.)
- `exposeApi` doesn't expose `clear`. It's destructive, so it's only on the `BatchedReplay` class.
- The React hooks key their subscriptions on `getFunctionName(...)`, because `api.x.y` is a new object every render and `useQueries` resubscribes (and loops) on a new input object.
- The automatic delay replaced "flushMs + 150". Measured headless with a 60 Hz sender on the local backend: 250 ms flush plays 330 ms behind, steady, at 3.9 writes/s; 1 s flush plays 1,080 ms behind, steady; a 50 ms flush (18 writes/s) plays 540 to 765 ms behind, because batches start queueing.

### Fix round after the three-model review (2026-10-19)

The review is in
`convex-videos/batching-component/research/component-review-2026-10-19.md`. What
changed, and why:

- **"Too old" is decided when a batch arrives, not when the playhead passes
  it.** `tick` used to drop samples more than 3 s behind the playhead, and
  browsers pause `requestAnimationFrame` in hidden tabs, so a viewer who looked
  away came back to holes. Now every sample from a live batch is emitted, in
  order, however late. Only a subscription's first result (its "snapshot",
  written before we were listening) is cut: samples more than 3 s behind a known
  playhead are skipped, and before any live batch, none of them fire.
- **Only live batches teach the clock.** Snapshots no longer feed the
  server-clock offset or the automatic delay; joining a room that's been idle
  for 30 s used to replay its last 750 ms as if live. Before the first live
  batch, `value()` holds each stream's last known value. The offset is cached
  when a batch arrives instead of recomputed on every `playhead()`.
- **The automatic delay is capped at `maxDelayMs` (2 s).** Batches later than
  that are left out of the target and just play late, so one 60 s batch (a retry
  after a blip) no longer drags the whole room minutes behind.
- **`streams.list` returns the newest N streams** (index `by_room_lastEnd`,
  default 100) instead of the first 1,000 by key, so visitor 1,001 is visible.
  `usePlayback` judges "active" against the estimated server clock, or before
  that against the newest `lastEnd` in the list, never the local clock: a viewer
  whose clock was a minute fast used to subscribe to nobody, ever.
- **Gaps are filled by `seq`.** The player takes each stream's batches in seq
  order. One after a gap waits while the missing ones are fetched with `history`
  (by stream, after seq), for up to 2 s, then it plays on without them. Dedupe
  is by seq now (with `_creationTime` to tell a cleared stream that started
  again at 0 from an old batch delivered again), which is the same as dedupe by
  `_id` within a stream and doesn't need a growing set of ids. `latest` returns
  2 batches, not 3: one spare covers a skipped update, and gap fill covers the
  rest. That's a third less bandwidth per viewer.
- **History, then live, is built in** (`usePlayback(..., { fromStart: true })`):
  `Player.loadHistory` plays every stored batch through `onSample` at once, then
  live results carry on from each stream's last seq, with gap fill covering
  anything written in between and new streams filled from seq 0. The drawing
  demo's hand-rolled rebuild lost strokes drawn during it.
- **Clearing a room bumps its epoch** (a `rooms` table), returned by
  `streams.list`. `usePlayback` resets the player and calls `onReset` when it
  changes, and with `fromStart` replays the (now empty) history. The epoch is
  bumped by the last chunk of a clear, so the history it replays is really
  empty. It's bumped for single-stream clears too, since a `fromStart` viewer
  has that stream's strokes drawn and needs to start again.
- **Senders back off.** A failed send waits `flushMs`, doubling up to 5 s
  (pushes respect the backoff too), and calls `onError`. Samples more than 60 s
  old are dropped at send time, so `duration` can't pass the server's limit and
  get stuck being rejected.
- **`HistoryPlayer` backs off** after a failed page load (1 s doubling to 10 s,
  it used to retry every frame) and exposes `error()`. `maxGapMs` (2 s) cuts
  idle stretches short in replays.
- **Validation** rejects non-finite `t` and `duration` (NaN used to pass). Clear
  and the expiry cron delete at most 100 rows per mutation, and also stop once
  less than 2 MiB is left of the transaction's 16 MiB read budget
  (`ctx.meta.getTransactionMetrics()`, Convex 1.36+). A batch can be up to the 1
  MiB document limit, so a row count alone can't be safe without being tiny
  (about 6 rows), and tiny chunks would mean dozens of cleanup mutations a
  second for a busy cursor room. The cron's "is this stream empty now?" check
  reads a batch per stream, so it runs as its own mutation with the same guard.
- **API:** `exposeApi` takes `value` (a validator) and splits `auth` into
  `authorizeRead(ctx, { room })` and `authorizeWrite(ctx, { room, stream })`,
  both with the full ctx. `exposeApi`'s return type is spelled out
  (`ExposedApi<V>`), since the functions built inside a generic function lose
  their argument types otherwise. Sender option `flush` is now `send`;
  `usePlayback`'s `exclude` is now `self`.
- **Drawing demo:** the board is `usePlayback({ fromStart: true, onReset })`
  alone; the timelapse plays on its own canvas over the board, so nothing has to
  be rebuilt when it ends.

## The room feed (parked, 2026-10-20)

Ian suggested `db.vars.commitTs` and the Batch Worker component: a per-room worker merges the room's new batches into one feed, so viewers subscribe once per room instead of once per person. It's built on the `room-feed` branch (438c227) and load-tested against a cloud deployment (the video folder's research/component-limits-2026-10-20.md). Writes stayed fast to 100 people and subscriptions dropped 50x, but the worker loop sometimes paused for 6 to 8 s at 50 people with no errors, it dropped frames unless it sent the newest two, and it costs more for small rooms: the loop is a scheduled function, which is billed at about 10 calls a second per busy room, so it only beats per-stream subscriptions once about 4 people are moving. Parked: per-stream subscriptions stay the only mode, with the limits in the README.
