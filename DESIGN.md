# @convex-dev/replay: design (v0.1)

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
}).index("by_room", ["room", "stream"]),
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
- `batches.latest` (query). Args `{ room, stream, count? }` (default 3, max 20). The newest `count` batches for one stream, oldest first. This is the live subscription. Returning a few, not one, means a watcher that misses an intermediate query update can still fill the gap by `seq`.
- `batches.history` (query). Args `{ room, stream?, after?, limit? }`. Batches in timeline order for a room (or one stream), for replays. Use convex-helpers' `paginator` or an explicit cursor, since `.paginate()` doesn't work inside components. Must not skip batches that share a `start`.
- `streams.list` (query). Args `{ room }`. All streams in the room with `firstStart` and `lastEnd`. The client decides which are active.
- `streams.clear` (mutation). Args `{ room, stream? }`. Delete a stream's (or a whole room's) batches and stream docs, in bounded chunks, rescheduling itself if there's more (for "clear the canvas").
- `crons.ts`: every minute, delete batches with `expiresAt < now` in bounded chunks (reschedule if more remain), and delete `streams` docs whose `lastEnd` is older than the longest retention and have no batches left.

All public component functions have `args` and `returns` validators.

## App-side client (`src/client/index.ts`)

```ts
export class Replay {
  constructor(component: ComponentApi, options?: { retentionMs?: number })
  append(ctx, { room, stream, samples, duration })   // passes options.retentionMs
  latest(ctx, { room, stream, count? })
  history(ctx, { room, stream?, after?, limit? })
  streams(ctx, { room })
  clear(ctx, { room, stream? })
}

// Ready-made functions to re-export, like the template's exposeApi:
export const { append, latest, history, streams } = exposeApi(components.replay, {
  retentionMs?: number,
  // Return the stream key this caller may write to, or throw.
  // For reads, return anything or throw to deny.
  auth: async (ctx, op: { type: "write"; room: string; stream?: string } | { type: "read"; room: string }) => string,
});
```

The app's `append` takes `{ room, stream?, samples, duration }` from the client.
The `auth` callback picks the actual stream key, so a client can't write into
someone else's stream unless the app allows it. Typed generics so the app can
say what `v` is (`Replay<{ x: number; y: number }>` or similar) without the
component validating it.

## Plain TS cores (`src/client/sender.ts`, `src/client/player.ts`)

No React in these, so they work in any framework and are unit-testable with fake timers.

### Sender

```ts
const sender = new Sender({
  flush: (args: { samples, duration }) => Promise<unknown>,  // calls the app's append mutation
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
  delayMs?: number,               // default flushMs + 150
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
- Keep the core simple first. Adaptive playback speed (Sujay's 0.8x / 1.2x idea) is a nice-to-have once the fixed delay works.

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
- `usePlayback(api: { latest, streams }, { room, exclude?, delayMs?, interpolate?, onSample? })`. Subscribes to `streams.list` once, then to `latest` for each active stream with `useQueries`, feeds a `Player`, ticks it on `requestAnimationFrame`. Returns `{ values: Map<stream, V>, stats }`, re-rendering each frame only while something is playing. `exclude` is your own stream key, since you draw your own input locally with no delay.
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
