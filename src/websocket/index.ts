import { ApiError } from "../core/errors";
import { abortable } from "../core/callbacks";
import { validateResponse } from "../core/validation";
import type {
  SocketClient,
  SocketOptions,
  SocketSnapshot,
  SocketTransport,
  SocketEvents,
  SocketSendData,
} from "./types";
export type * from "./types";

const retryCodes = new Set([1001, 1005, 1006, 1011, 1012, 1013, 1014]);
const encoder = new TextEncoder();
function configuration(message: string): never {
  throw new ApiError(message, 0, {}, undefined, "configuration");
}
function limit(value: number, name: string, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647)
    configuration(`${name} is outside its supported integer range`);
  return value;
}
function socketUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configuration("An absolute ws(s) URL is required");
  }
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.includes("#") ||
    value.includes("\\")
  )
    configuration("Invalid WebSocket URL");
  return url;
}
function byteSize(value: SocketSendData): number {
  if (typeof value === "string") return encoder.encode(value).byteLength;
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
    return value.byteLength;
  return configuration("Unsupported WebSocket message data");
}
function validateClose(code: number, reason: string) {
  if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999))
    configuration("Close code must be 1000 or between 3000 and 4999");
  if (typeof reason !== "string" || encoder.encode(reason).length > 123)
    configuration("Close reason must be at most 123 UTF-8 bytes");
}
export function createSocketClient<T = unknown>(
  config: SocketOptions<T>,
): SocketClient<T> {
  const options = { ...config };
  const format = options.format ?? "json";
  if (format !== "json" && format !== "raw")
    configuration("Socket format must be json or raw");
  const connectTimeout = limit(
    options.connectTimeoutMs ?? 10_000,
    "connectTimeoutMs",
  );
  const messageLimit = limit(
    options.maxMessageSize ?? 1_048_576,
    "maxMessageSize",
  );
  const pendingLimit = limit(
    options.maxPendingMessages ?? 64,
    "maxPendingMessages",
  );
  const bufferedLimit = limit(
    options.maxBufferedAmount ?? 1_048_576,
    "maxBufferedAmount",
  );
  const reconnect =
    options.reconnect === false
      ? undefined
      : {
          maxAttempts: 5,
          baseDelayMs: 500,
          maxDelayMs: 30_000,
          jitter: true,
          ...options.reconnect,
        };
  if (reconnect) {
    limit(reconnect.maxAttempts, "maxAttempts", 0);
    limit(reconnect.baseDelayMs, "baseDelayMs");
    limit(reconnect.maxDelayMs, "maxDelayMs");
    if (
      reconnect.baseDelayMs > reconnect.maxDelayMs ||
      typeof reconnect.jitter !== "boolean"
    )
      configuration("Invalid reconnect settings");
  }
  const requiresAuth = options.requiresAuth ?? Boolean(options.sessionClient);
  if (requiresAuth && !options.sessionClient)
    configuration("requiresAuth requires a sessionClient");
  if (typeof options.url !== "string" && typeof options.url !== "function")
    configuration("Socket url must be a string or provider");
  const origins = new Set(
    (options.allowedOrigins ?? []).map((value) => {
      const url = socketUrl(value);
      if (url.pathname !== "/" || url.search)
        configuration("allowedOrigins must contain exact ws(s) origins");
      return url.origin;
    }),
  );
  if (typeof options.url === "string") {
    const origin = socketUrl(options.url).origin;
    if (options.allowedOrigins === undefined) origins.add(origin);
    if (!origins.has(origin)) configuration("WebSocket origin is not allowed");
  } else if (!origins.size)
    configuration("URL providers require allowedOrigins");
  const protocols = [...(options.protocols ?? [])];
  if (
    new Set(protocols).size !== protocols.length ||
    protocols.some(
      (value) =>
        typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(value),
    )
  )
    configuration("Invalid WebSocket subprotocols");
  let snapshot: SocketSnapshot = Object.freeze({
    status: "idle",
    reconnectAttempt: 0,
    error: null,
    close: null,
  });
  const stateListeners = new Set<() => void>();
  const messageListeners = new Set<(data: T) => void>();
  const errorListeners = new Set<(error: ApiError) => void>();
  let wanted = false,
    disposed = false,
    generation = 0,
    attempts = 0,
    pending = 0;
  let socket: SocketTransport | undefined;
  let controller: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let detach: (() => void) | undefined,
    unsubscribeSession: (() => void) | undefined;
  let revision: number | undefined;
  let chain = Promise.resolve();
  function listenerError(cause: unknown) {
    const error = new ApiError(
      "WebSocket listener failed",
      0,
      {},
      undefined,
      "callback",
      cause,
    );
    for (const listener of [...errorListeners]) {
      try {
        listener(error);
      } catch {
        /* Do not recursively invoke a failing error listener. */
      }
    }
  }
  function update(value: Partial<SocketSnapshot>) {
    snapshot = Object.freeze({
      ...snapshot,
      ...value,
      reconnectAttempt: attempts,
    });
    for (const listener of [...stateListeners]) {
      try {
        listener();
      } catch (cause) {
        listenerError(cause);
      }
    }
  }
  function report(error: ApiError) {
    update({ error });
    for (const listener of [...errorListeners]) {
      try {
        listener(error);
      } catch {
        /* Isolate subscribers. */
      }
    }
  }
  function sessionValid() {
    const state = options.sessionClient?.getSessionSnapshot();
    return (
      (!state || state.revision === revision) &&
      (!requiresAuth || Boolean(state?.userId))
    );
  }
  const current = (id: number) =>
    wanted && !disposed && id === generation && sessionValid();
  function release(code = 1000, reason = "") {
    generation++;
    clearTimeout(timeout);
    clearTimeout(retry);
    timeout = retry = undefined;
    detach?.();
    detach = undefined;
    controller?.abort(
      new ApiError(
        "WebSocket attempt cancelled",
        0,
        {},
        undefined,
        "cancelled",
      ),
    );
    controller = undefined;
    const previous = socket;
    socket = undefined;
    pending = 0;
    chain = Promise.resolve();
    if (previous && previous.readyState < 2) {
      try {
        previous.close(code, reason);
      } catch {
        /* Already unavailable. */
      }
    }
  }
  function stop(
    code = 1000,
    reason = "",
    state: {
      status?: "closed" | "disposed";
      close?: SocketSnapshot["close"];
      clearError?: boolean;
      keepSession?: boolean;
    } = {},
  ) {
    wanted = false;
    release(code, reason);
    if (!state.keepSession) {
      unsubscribeSession?.();
      unsubscribeSession = undefined;
    }
    update({
      status: state.status ?? "closed",
      ...(state.close === undefined ? {} : { close: state.close }),
      ...(state.clearError ? { error: null } : {}),
    });
  }
  function failed(
    error: ApiError,
    canRetry: boolean,
    close: SocketSnapshot["close"] = null,
  ) {
    const id = generation;
    report(error);
    if (!current(id)) return;
    release();
    if (canRetry && reconnect && attempts < reconnect.maxAttempts) {
      const delay = Math.min(
        reconnect.maxDelayMs,
        reconnect.baseDelayMs * 2 ** Math.min(attempts, 30),
      );
      attempts++;
      const nextGeneration = generation;
      update({ status: "reconnecting", close });
      if (!current(nextGeneration)) return;
      retry = setTimeout(
        () => {
          retry = undefined;
          if (current(nextGeneration)) void attempt();
        },
        reconnect.jitter
          ? Math.floor(delay * (0.5 + Math.random() * 0.5))
          : delay,
      );
    } else {
      wanted = false;
      update({ status: "closed", close });
    }
  }
  async function attempt() {
    release();
    const id = generation;
    if (!current(id)) return;
    controller = new AbortController();
    const signal = controller.signal;
    timeout = setTimeout(() => {
      if (current(id))
        failed(
          new ApiError(
            "WebSocket connection timed out",
            0,
            {},
            undefined,
            "timeout",
          ),
          true,
        );
    }, connectTimeout);
    update({ status: attempts ? "reconnecting" : "connecting", close: null });
    try {
      const value =
        typeof options.url === "string"
          ? options.url
          : await abortable(
              () =>
                (
                  options.url as (
                    signal: AbortSignal,
                  ) => string | Promise<string>
                )(signal),
              signal,
            );
      if (!current(id)) return;
      const url = socketUrl(value);
      if (!origins.has(url.origin))
        configuration("WebSocket origin is not allowed");
      const factory =
        options.webSocketFactory ??
        ((target: string, protocols: string[]) => {
          if (typeof globalThis.WebSocket !== "function")
            configuration("WebSocket is unavailable; provide webSocketFactory");
          return new globalThis.WebSocket(target, protocols);
        });
      const transport = factory(url.href, [...protocols]);
      if (!current(id)) {
        transport.close(1000);
        return;
      }
      socket = transport;
      transport.binaryType = "arraybuffer";
      const onOpen = () => {
        if (!current(id)) return;
        clearTimeout(timeout);
        timeout = undefined;
        update({ status: "open", error: null, close: null });
      };
      const onError = () => {
        if (current(id))
          report(
            new ApiError(
              "WebSocket transport error",
              0,
              {},
              undefined,
              "network",
            ),
          );
      };
      const onClose = (event: SocketEvents["close"]) => {
        if (!current(id)) return;
        const close = Object.freeze({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        if (event.code === 1000) {
          stop(1000, "", { close, keepSession: true });
        } else
          failed(
            new ApiError(
              "WebSocket connection closed",
              0,
              {},
              undefined,
              "network",
            ),
            retryCodes.has(event.code),
            close,
          );
      };
      const onMessage = (event: SocketEvents["message"]) => {
        if (!current(id) || snapshot.status !== "open") return;
        const data = event.data;
        if (!(
          typeof data === "string" ||
          data instanceof ArrayBuffer ||
          data instanceof Blob
        )) {
          report(
            new ApiError(
              "Unsupported incoming WebSocket data",
              0,
              {},
              undefined,
              "parse",
            ),
          );
          return;
        }
        if (byteSize(data) > messageLimit || pending >= pendingLimit) {
          report(
            new ApiError(
              "WebSocket incoming message limit exceeded",
              0,
              {},
              undefined,
              "backpressure",
            ),
          );
          if (current(id)) stop(1000, "Message limit exceeded");
          return;
        }
        pending++;
        chain = chain
          .then(async () => {
            if (!current(id)) return;
            let parsed: unknown = data;
            if (format === "json") {
              if (typeof data !== "string")
                throw new ApiError(
                  "Expected a JSON text WebSocket message",
                  0,
                  {},
                  undefined,
                  "parse",
                );
              try {
                parsed = JSON.parse(data);
              } catch {
                throw new ApiError(
                  "Invalid JSON WebSocket message",
                  0,
                  {},
                  undefined,
                  "parse",
                );
              }
            }
            const result = options.schema
              ? await abortable(
                  () => validateResponse(options.schema!, parsed, 0),
                  signal,
                )
              : (parsed as T);
            for (const listener of [...messageListeners]) {
              if (!current(id)) break;
              try {
                listener(result);
              } catch (cause) {
                listenerError(cause);
              }
            }
          })
          .catch((cause) => {
            if (current(id))
              report(
                cause instanceof ApiError
                  ? cause
                  : new ApiError(
                      "WebSocket message processing failed",
                      0,
                      {},
                      undefined,
                      "parse",
                      cause,
                    ),
              );
          })
          .finally(() => {
            if (current(id)) pending--;
          });
      };
      transport.addEventListener("open", onOpen);
      transport.addEventListener("error", onError);
      transport.addEventListener("message", onMessage);
      transport.addEventListener("close", onClose);
      detach = () => {
        transport.removeEventListener("open", onOpen);
        transport.removeEventListener("error", onError);
        transport.removeEventListener("message", onMessage);
        transport.removeEventListener("close", onClose);
      };
    } catch (cause) {
      if (current(id))
        failed(
          cause instanceof ApiError
            ? cause
            : new ApiError(
                "WebSocket connection setup failed",
                0,
                {},
                undefined,
                "network",
              ),
          !(cause instanceof ApiError) || cause.code === "network",
        );
    }
  }
  function send(data: SocketSendData) {
    if (
      !wanted ||
      !sessionValid() ||
      !socket ||
      socket.readyState !== 1 ||
      snapshot.status !== "open"
    )
      throw new ApiError(
        "WebSocket is not open; message was not queued",
        0,
        {},
        undefined,
        "network",
      );
    if (socket.bufferedAmount + byteSize(data) > bufferedLimit)
      throw new ApiError(
        "WebSocket outgoing buffer limit exceeded",
        0,
        {},
        undefined,
        "backpressure",
      );
    try {
      socket.send(data);
    } catch (cause) {
      throw new ApiError(
        "WebSocket send failed; delivery is unknown",
        0,
        {},
        undefined,
        "network",
        cause,
      );
    }
  }
  return Object.freeze({
    connect() {
      if (disposed) configuration("Socket client is disposed");
      if (wanted) return;
      if (requiresAuth && !options.sessionClient?.getSessionSnapshot().userId)
        throw new ApiError(
          "An authenticated session is required",
          401,
          {},
          undefined,
          "auth",
        );
      revision = options.sessionClient?.getSessionSnapshot().revision;
      wanted = true;
      attempts = 0;
      unsubscribeSession?.();
      unsubscribeSession = options.sessionClient?.subscribeSession(() => {
        if (!sessionValid())
          stop(1000, "Session changed", { close: null, clearError: true });
      });
      update({ error: null, close: null });
      if (wanted) void attempt();
    },
    disconnect(code = 1000, reason = "") {
      validateClose(code, reason);
      if (!disposed) stop(code, reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop(1000, "Disposed", {
        status: "disposed",
        close: null,
        clearError: true,
      });
      stateListeners.clear();
      messageListeners.clear();
      errorListeners.clear();
    },
    send,
    sendJson(value: unknown) {
      let data: string | undefined;
      try {
        data = JSON.stringify(value);
      } catch (cause) {
        throw new ApiError(
          "Message is not JSON serializable",
          0,
          {},
          undefined,
          "configuration",
          cause,
        );
      }
      if (data === undefined) configuration("Message is not JSON serializable");
      send(data);
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) configuration("Socket client is disposed");
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onMessage(listener: (message: T) => void) {
      if (disposed) configuration("Socket client is disposed");
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    onError(listener: (error: ApiError) => void) {
      if (disposed) configuration("Socket client is disposed");
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
  });
}
