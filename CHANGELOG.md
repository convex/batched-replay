# Changelog

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
- Batches are kept for `retentionMs`, or forever for replays, and rooms can be
  cleared in bounded chunks with `BatchedReplay.clear`.
