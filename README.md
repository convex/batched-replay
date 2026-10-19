# @convex-dev/batched-replay

Realtime-ish data on plain Convex. A sender batches fast-changing values
(cursors, pen strokes, game movement) into one mutation every ~250 ms; watchers
replay each batch with its original timing. It looks smooth and live, runs a
little behind, and costs a handful of writes a second instead of 60. Batches are
kept, so a whole session can be replayed later.

## Install

```sh
npm install @convex-dev/batched-replay
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import batchedReplay from "@convex-dev/batched-replay/convex.config.js";

const app = defineApp();
app.use(batchedReplay);
export default app;
```

## Expose an API

A room is a string you pick (a page, a board, a game). A stream is one sender's
key inside it.

```ts
// convex/cursors.ts
import { v } from "convex/values";
import { components } from "./_generated/api";
import { exposeApi } from "@convex-dev/batched-replay";

export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    // What one sample is. Checked on every append, and it types the hooks.
    // Leave it out and samples are v.any().
    value: v.object({ x: v.number(), y: v.number() }),
    // How long batches are kept after they end. Leave it out to keep them
    // forever (for replays).
    retentionMs: 10 * 60_000,
    // Throw to stop someone watching a room.
    authorizeRead: async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
    },
    // Return the stream key this caller writes to. `stream` is what the
    // client asked for; here it's only trusted as a per-tab session id.
    authorizeWrite: async (ctx, { stream }) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      return `${identity.tokenIdentifier}:${stream ?? "default"}`;
    },
  },
);
```

Both callbacks get the full query or mutation `ctx`, so they can check your own
tables (is this user in this room?). Annotate `ctx` with your app's `QueryCtx`
or `MutationCtx` from `./_generated/server` for typed `ctx.db` access.

**One stream key per tab.** The server lays each stream's batches end to end on
one timeline. If two devices (or two tabs) write the same key, their batches
interleave and keep clamping against each other, so the stream jitters. Make the
key the user plus a session id each tab picks for itself (for example
`crypto.randomUUID()` kept in `sessionStorage`), as above.

The example app has no sign-in, so its `authorizeRead` allows everyone and its
`authorizeWrite` trusts the client's anonymous key. Don't ship that.

From your own functions you can also use the class:
`new BatchedReplay(components.batchedReplay)` has `append`, `latest`, `history`,
`streams` and `clear`. `clear` isn't in `exposeApi`, since it's destructive:
wrap it in your own mutation with your own checks.

## Send

```tsx
import { useSender } from "@convex-dev/batched-replay/react";

const send = useSender(api.cursors.append, {
  room,
  stream: tabId,
  flushMs: 250, // one write per 250 ms while there's anything to send
  onError: (error) => console.warn(error), // it retries, with backoff
});
onPointerMove((e) => send({ x: e.clientX, y: e.clientY }));
// Discrete events are never thinned out by sampleMs:
send(value, { keep: true });
```

It flushes on unmount and `pagehide`. A failed send keeps its samples and
retries after `flushMs`, doubling up to 5 s. Samples over a minute old are
dropped, since the server won't take a batch longer than that.

## Play back

```tsx
import { usePlayback } from "@convex-dev/batched-replay/react";

const { values, stats } = usePlayback(api.cursors, {
  room,
  self: tabId, // your own stream: draw your own input locally, with no delay
  interpolate: true,
});
// values: Map<stream, { x, y }> of everyone active in the last minute.
// stats: { delayMs, bufferedMs, batchesPerSecond, samplesPerSecond }
```

It plays a little behind the server, by default just far enough to cover how
late batches have been arriving (about 330 ms with a 250 ms flush), and never
more than `maxDelayMs` (2 s). `onSample(stream, value, time)` fires for every
sample, in order, even if the tab was hidden for a while. Missed batches are
fetched from `history` and played in order.

For a drawing, where every stroke matters:

```tsx
usePlayback(api.drawing, {
  room,
  self: tabId,
  // Replay the whole stored history through onSample first, instantly and
  // in order, then carry on live with no gap and nothing twice.
  fromStart: true,
  onSample: (stream, sample) => draw(stream, sample),
  // Someone cleared the room. With fromStart, the (now empty) history is
  // replayed again afterwards.
  onReset: () => clearCanvas(),
});
```

## Replay

```tsx
import { useHistory } from "@convex-dev/batched-replay/react";

const replay = useHistory(api.drawing, { room, speed: 10, onSample: draw });
replay.restart(); // load from the start, picking up new batches, and play
replay.pause(); // also play(), seek(ms), setSpeed(n)
// replay.position, replay.playing, replay.finished, replay.error
```

Idle stretches longer than `maxGapMs` (2 s) are cut short, so a timelapse
doesn't sit through an hour of nothing. A failed page load retries after 1 s,
doubling up to 10 s, and shows up as `error`.

The `Sender`, `Player` and `HistoryPlayer` classes behind the hooks are plain
TypeScript, exported from `@convex-dev/batched-replay`, if you're not using
React.

## Cost

- **Writes:** one `append` per sender per flush, so about 4 a second per person
  while they're moving, with a 250 ms flush. Nothing while they're idle.
- **Reads:** every viewer subscribes to `latest` for each active stream, so each
  append re-runs that query once per viewer: about senders x viewers re-runs a
  second, times 4. Ten people in a room all moving is about 400 a second; fifty
  is about 10,000. The stream list changes at most every 5 s per stream.
- **Abuse:** a client can call `append` as fast as it likes. Put
  [`@convex-dev/rate-limiter`](https://www.convex.dev/components/rate-limiter)
  in `authorizeWrite` (say, 10 appends a second per user) for anything public.
- **Retention:** batches are stored until `retentionMs` after they end, then a
  cron deletes them each minute. Without `retentionMs` they're kept forever, so
  storage grows by every sample ever sent: one person moving a cursor at 60
  samples a second is roughly 5 MB an hour. Keep forever only what you'll
  replay, like drawings.

## Example

`example/` has two demos, switched by `#cursors` and `#drawing`. Cursors: open
it in two tabs and move the mouse; a slider sets `flushMs` so you can compare
smooth-but-behind with jumpy-and-expensive. Drawing: a shared board where
everyone else's strokes replay at the speed they were drawn, with a timelapse.

```sh
npm run dev
npm run dev:frontend
```

See `DESIGN.md` for how it works.
