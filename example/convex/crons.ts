import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

// Housekeeping for the public demo. Cursors and tilt need none: their
// batches expire after ten minutes in the component.
const crons = cronJobs();

// Clears the shared drawing board once it's been idle for ten minutes, and
// trims the Strokes gallery.
crons.interval("tidy the drawing board", { minutes: 1 }, internal.drawing.tidy);

// Drops racer laps before their history expires.
crons.interval("delete old laps", { hours: 1 }, internal.racer.deleteOldLaps);

// Drops rate limit documents for streams that have gone quiet.
crons.interval(
  "delete old rate limits",
  { hours: 1 },
  internal.limits.deleteOldRateLimits,
);

export default crons;
