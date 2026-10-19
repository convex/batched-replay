import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import type { FunctionReference } from "convex/server";
import { Sender, type Sample } from "../client/sender.js";

type AppendRef<V> = FunctionReference<
  "mutation",
  "public",
  { room: string; stream?: string; samples: Sample<V>[]; duration: number },
  unknown
>;

/**
 * Returns `send(value)`. Values are batched and sent with the app's `append`
 * mutation every `flushMs`; the last batch goes out on unmount and pagehide.
 * Pass `{ keep: true }` for discrete events that `sampleMs` must not thin.
 */
export function useSender<V>(
  append: AppendRef<V>,
  options: {
    room: string;
    stream?: string;
    flushMs?: number;
    sampleMs?: number;
  },
) {
  const appendMutation = useMutation(append);
  const appendRef = useRef(appendMutation);
  useEffect(() => {
    appendRef.current = appendMutation;
  });
  const senderRef = useRef<Sender<V> | null>(null);
  const { room, stream, flushMs, sampleMs } = options;

  useEffect(() => {
    const sender = new Sender<V>({
      flush: (batch) => appendRef.current({ room, stream, ...batch }),
      flushMs,
      sampleMs,
    });
    senderRef.current = sender;
    const onPageHide = () => void sender.flush();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void sender.flush();
      sender.dispose();
      senderRef.current = null;
    };
  }, [room, stream, flushMs, sampleMs]);

  return useCallback((value: V, sendOptions?: { keep?: boolean }) => {
    senderRef.current?.push(value, sendOptions);
  }, []);
}
