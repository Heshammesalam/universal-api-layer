import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SocketClient } from "./types";

/** Subscribes only; the application owns connect/disconnect and may share a client. */
export function useSocketState<T>(client: SocketClient<T>) {
  return useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
}
export function useSocketMessage<T>(
  client: SocketClient<T>,
  listener: (message: T) => void,
) {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(
    () => client.onMessage((message) => latest.current(message)),
    [client],
  );
}
