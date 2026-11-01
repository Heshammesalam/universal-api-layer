import type { ApiClient, ApiError, ResponseSchema } from "../core";

export type SocketData = string | ArrayBuffer | Blob;
export type SocketSendData =
  string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>;
export interface SocketEvents {
  open: { readonly type: string };
  error: { readonly type: string };
  message: { readonly type: string; readonly data: unknown };
  close: {
    readonly type: string;
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
  };
}
/** Structural native WebSocket interface, also injectable in tests/non-browser runtimes. */
export interface SocketTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: "blob" | "arraybuffer";
  send(data: SocketSendData): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
  removeEventListener<K extends keyof SocketEvents>(
    type: K,
    listener: (event: SocketEvents[K]) => void,
  ): void;
}
export interface SocketSnapshot {
  readonly status:
    "idle" | "connecting" | "open" | "reconnecting" | "closed" | "disposed";
  /** Retries used since the latest explicit connect(), including across short-lived opens. */
  readonly reconnectAttempt: number;
  readonly error: ApiError | null;
  readonly close: Readonly<{
    code: number;
    reason: string;
    wasClean: boolean;
  }> | null;
}
export interface SocketOptions<T> {
  /** Absolute ws(s) URL, or an abortable provider for short-lived connection tickets. */
  url: string | ((signal: AbortSignal) => string | Promise<string>);
  /** Required for a URL provider. Exact ws(s) origins, not URL prefixes. */
  allowedOrigins?: readonly string[];
  protocols?: readonly string[];
  sessionClient?: Pick<ApiClient, "getSessionSnapshot" | "subscribeSession">;
  /** Defaults to true when sessionClient is provided. */
  requiresAuth?: boolean;
  /** json (default) parses text JSON; raw preserves native string/ArrayBuffer/Blob data. */
  format?: "json" | "raw";
  schema?: ResponseSchema<T>;
  reconnect?:
    | false
    | {
        maxAttempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
        jitter?: boolean;
      };
  connectTimeoutMs?: number;
  maxMessageSize?: number;
  maxPendingMessages?: number;
  maxBufferedAmount?: number;
  webSocketFactory?: (url: string, protocols: string[]) => SocketTransport;
}
export interface SocketClient<T = unknown> {
  connect(): void;
  disconnect(code?: number, reason?: string): void;
  dispose(): void;
  /** Sends only while OPEN and under the buffer limit; never queues or replays. */
  send(data: SocketSendData): void;
  sendJson(value: unknown): void;
  getSnapshot(): SocketSnapshot;
  subscribe(listener: () => void): () => void;
  onMessage(listener: (message: T) => void): () => void;
  onError(listener: (error: ApiError) => void): () => void;
}
