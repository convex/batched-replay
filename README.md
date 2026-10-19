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

```ts
// convex/cursors.ts
import { components } from "./_generated/api";
import { exposeApi } from "@convex-dev/batched-replay";

export const { append, latest, history, streams } = exposeApi(
  components.batchedReplay,
  {
    retentionMs: 10 * 60_000, // omit to keep batches forever
    auth: async (ctx, op) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthorized");
      // For writes, return the stream key this caller may write to.
      if (op.type === "write") return identity.tokenIdentifier;
    },
  },
);
```

A room is a string you pick, a stream is one sender's key inside it. From your
own functions you can also use `new BatchedReplay<V>(components.batchedReplay)`.

## Send, play back, replay

```tsx
import { useSender, usePlayback, useHistory } from "@convex-dev/batched-replay/react";

// Send: batched and flushed every flushMs, and on unmount / pagehide.
const send = useSender(api.cursors.append, { room, stream: me, flushMs: 250 });
onPointerMove((e) => send({ x: e.clientX, y: e.clientY }));
// Discrete events are never thinned out by sampleMs: send(v, { keep: true })

// Watch everyone else, slightly behind live. Draw your own input locally.
const { values, stats } = usePlayback(api.cursors, {
  room,
  exclude: me,
  interpolate: true,
});

// Replay stored batches later, at any speed (Infinity = as fast as it loads).
const replay = useHistory(api.cursors, { room, speed: 10, onSample: draw });
replay.play(); // also pause(), seek(ms), setSpeed(n)
```

The `Sender`, `Player` and `HistoryPlayer` classes behind the hooks are plain
TypeScript, exported from `@convex-dev/batched-replay`, if you're not using React.

## Example

`example/` is a cursors demo: open it in two tabs and move the mouse. A slider
sets `flushMs` so you can compare smooth-but-behind with jumpy-and-expensive.

```sh
npm run dev
npm run dev:frontend
```

See `DESIGN.md` for how it works.
