import { DestroyRef, inject, signal, type Signal } from "@angular/core";
import type { SocketClient, SocketSnapshot } from "./types";

/** Subscription only: the application owns connect/disconnect/dispose. */
export function injectSocketState<T>(
  client: SocketClient<T>,
): Signal<SocketSnapshot> {
  const destroy = inject(DestroyRef);
  const state = signal(client.getSnapshot());
  destroy.onDestroy(client.subscribe(() => state.set(client.getSnapshot())));
  return state.asReadonly();
}
export function injectSocketMessage<T>(
  client: SocketClient<T>,
  listener: (message: T) => void,
): void {
  inject(DestroyRef).onDestroy(client.onMessage(listener));
}
