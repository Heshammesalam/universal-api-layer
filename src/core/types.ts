import type { ApiSession, SessionSnapshot } from "./session";
import type { ResponseSchema } from "./validation";
import type { FieldErrors } from "./errors";
export type Params = Record<
  string,
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[]
>;
/** Uses each platform's native Fetch types without requiring DOM libs in Node projects. */
export type ApiHeaders = NonNullable<RequestInit["headers"]>;
export interface ApiResponse<T = unknown> {
  readonly data: T | null;
  readonly headers: Headers;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
}
export interface RequestOptions<T = unknown> {
  /** Keep body-only results by default; full mode also exposes response metadata. */
  responseMode?: "data" | "full";
  schema?: ResponseSchema<T> | false;
  authRetry?: boolean;
  requiresAuth?: boolean;
  method?: string;
  params?: Params;
  body?: unknown;
  headers?: ApiHeaders;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface StreamOptions extends Omit<
  RequestOptions,
  "responseMode" | "schema"
> {
  /** text yields decoded UTF-8 chunks; sse yields complete SSE events. */
  format?: "text" | "sse";
  /** Maximum buffered SSE line/event length in UTF-16 code units. Default 1 MiB. */
  maxEventSize?: number;
}
export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string;
  /** Server retry hint only; this client never reconnects automatically. */
  readonly retry?: number;
}
export interface ClientOptions {
  baseUrl?: string;
  session?: ApiSession | null;
  /** Return a new access token. Shared across concurrent 401s and retried once. */
  refreshToken?: (
    signal: AbortSignal,
    session: SessionSnapshot,
  ) => Promise<string>;
  refreshTimeoutMs?: number;
  schema?: ResponseSchema<unknown>;
  getToken?: (
    signal: AbortSignal,
  ) => string | null | undefined | Promise<string | null | undefined>;
  headers?: ApiHeaders;
  timeoutMs?: number;
  fetch?: typeof fetch;
  credentials?: RequestInit["credentials"];
  normalizeErrors?: (data: unknown) => FieldErrors;
  /** Non-secret stable identity for intentional cache sharing/SSR hydration. Unique per client by default. */
  cacheScope?: string;
  /** Additional HTTP(S) origins allowed to receive this client's requests and credentials. */
  allowedOrigins?: readonly string[];
}
export interface QueryConfig<T, S = T | null> {
  schema?: ResponseSchema<T> | false;
  requiresAuth?: boolean;
  authRetry?: boolean;
  key: readonly unknown[];
  url: string;
  params?: Params;
  headers?: ApiHeaders;
  /** Non-secret account/tenant identity; change on authentication transitions. */
  cacheScope?: string;
  timeoutMs?: number;
  enabled?: boolean;
  staleTime?: number;
  retry?: boolean | number;
  select?: (response: T | null) => S;
}
export interface MutationConfig<T, V, S = T | null> {
  schema?: ResponseSchema<T> | false;
  requiresAuth?: boolean;
  authRetry?: boolean;
  url: string | ((variables: V) => string);
  method?: string;
  mapPayload?: (variables: V) => unknown;
  headers?: ApiHeaders;
  timeoutMs?: number;
  signal?: AbortSignal;
  select?: (response: T | null) => S;
  invalidateKeys?: readonly (readonly unknown[])[];
  /** all explicitly includes matching native TanStack queries in this QueryClient. */
  invalidateScope?: "client" | "all";
  onSuccess?: (data: S, variables: V) => unknown | Promise<unknown>;
}
