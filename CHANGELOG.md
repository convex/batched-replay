# Changelog

## 0.1.1

- Setting up trusted publishing

## 0.1.0

First release. Senders batch fast-changing values (cursors, pen strokes, game
movement) into one mutation every ~250 ms, and watchers replay each batch with
its original timing, a little behind live.

- `exposeApi` builds `append`, `latest`, `history` and `streams` functions to
  re-export, with `authorizeRead`, `authorizeWrite`, a `value` validator and an
  `onAppend` hook for mirroring batches into your own tables.
- React hooks: `useSender`, `usePlayback` (live, optionally starting from the
  whole stored history) and `useHistory` (replays and timelapses at any speed).
  The plain TypeScript `Sender`, `Player` and `HistoryPlayer` behind them work
  without React.
- `usePlayback` takes `snapshot: { load, apply }`, to start from your own
  snapshot (say, a table `onAppend` keeps) instead of replaying the whole
  history, carrying on from the batch after each stream's `seq`. The `Player`
  method behind it is `startAfter`.
- `usePlayback` takes `maxStreams` (default 100) for rooms with a crowd.
- `useSender` takes `onSend`, called as each batch goes out.
- Batches are kept for `retentionMs`, or forever for replays, and rooms can be
  cleared in bounded chunks with `BatchedReplay.clear`.
