# Example backend

- `convex.config.ts` installs the component.
- `cursors.ts` and `drawing.ts` re-export its API with `exposeApi`. The demo has
  no sign-in, so both trust the client's anonymous stream key: don't ship that
  (see the root README for the signed-in version).
- `drawing.ts` also has an `onAppend` hook that keeps finished strokes in the
  app's own tables (`schema.ts`), and the mutations behind "Clear board" and
  "Clear strokes".
- The `*.test.ts` files use `convex-test` with the component registered from
  `@convex-dev/batched-replay/test` (see `setup.test.ts`).
