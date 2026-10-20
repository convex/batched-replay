# Example app

Two demos of `@convex-dev/batched-replay`, switched by `#cursors` and `#drawing`
in the URL:

- **Cursors** (`src/Cursors.tsx`, `convex/cursors.ts`): open it in two tabs and
  move the mouse. A slider sets the sender's `flushMs`.
- **Drawing** (`src/Drawing.tsx`, `convex/drawing.ts`): a shared board that
  replays everything drawn so far, then everyone else's strokes live, with a
  timelapse. `onAppend` copies finished strokes into the app's own `strokes`
  table, shown in the Strokes sidebar, which survives "Clear board".

Run it from the root of the repo:

```sh
npm run dev
npm run dev:frontend
```

The component also needs an app that uses it to run codegen, which is the other
reason this is here.
