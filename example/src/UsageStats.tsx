import { formatBytes, useUsage } from "./usage";

const PRICING_TITLE =
  "This tab's share since you opened it: every write and every update Convex pushes to it counts as a function call. See Convex pricing to work out what it would cost.";

// Two lines for a HUD: this tab's function calls, and roughly how much data.
export default function UsageStats({ className }: { className?: string }) {
  const usage = useUsage();
  return (
    <>
      <div className={className}>
        {usage.calls.toLocaleString()} function calls:{" "}
        {usage.writes.toLocaleString()} writes, {usage.updates.toLocaleString()}{" "}
        updates
      </div>
      <div className={className}>
        {usage.callsPerMinute.toLocaleString()} a minute, ≈{" "}
        {formatBytes(usage.bytesSent)} sent, {formatBytes(usage.bytesReceived)}{" "}
        received{" "}
        <a
          className="usage-info"
          href="https://www.convex.dev/pricing"
          target="_blank"
          rel="noreferrer"
          title={PRICING_TITLE}
          aria-label={`Convex pricing. ${PRICING_TITLE}`}
        >
          ⓘ
        </a>
      </div>
    </>
  );
}
