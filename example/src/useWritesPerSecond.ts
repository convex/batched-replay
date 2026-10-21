import { useCallback, useEffect, useRef, useState } from "react";

// Counts the writes actually sent in the last second, for the HUD. Pass
// `countWrite` to useSender's onSend.
export function useWritesPerSecond() {
  const sentAt = useRef<number[]>([]);
  const [writesPerSecond, setWritesPerSecond] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      const since = performance.now() - 1000;
      sentAt.current = sentAt.current.filter((at) => at > since);
      setWritesPerSecond(sentAt.current.length);
    }, 200);
    return () => clearInterval(id);
  }, []);
  const countWrite = useCallback(() => {
    sentAt.current.push(performance.now());
  }, []);
  return { writesPerSecond, countWrite };
}
