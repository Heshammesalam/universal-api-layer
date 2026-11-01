import {
  getCurrentScope,
  onScopeDispose,
  shallowReadonly,
  shallowRef,
} from "vue";
import type { Ref } from "vue";
import { ApiError } from "../core/errors";
import type { SocketClient, SocketSnapshot } from "./types";

function assertScope() {
  if (!getCurrentScope())
    throw new ApiError(
      "Socket composables require an active Vue effect scope",
      0,
      {},
      undefined,
      "configuration",
    );
}
/** Subscribes only; the application owns connect/disconnect and may share a client. */
export function useSocketState<T>(
  client: SocketClient<T>,
): Readonly<Ref<SocketSnapshot>> {
  assertScope();
  const state = shallowRef(client.getSnapshot());
  onScopeDispose(
    client.subscribe(() => {
      state.value = client.getSnapshot();
    }),
  );
  return shallowReadonly(state);
}
export function useSocketMessage<T>(
  client: SocketClient<T>,
  listener: (message: T) => void,
) {
  assertScope();
  onScopeDispose(client.onMessage(listener));
}
