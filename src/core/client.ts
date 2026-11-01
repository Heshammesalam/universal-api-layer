import { readStream } from "./stream";
import { ApiError } from "./errors";
import { createSessionState } from "./session";
import { abortable, invokeCallback } from "./callbacks";
import { laravelErrors } from "./helpers";
import { validateResponse } from "./validation";
import type { ApiSession } from "./session";
import type {
  StreamOptions,
  ServerSentEvent,
  Params,
  ApiHeaders,
  ApiResponse,
  ClientOptions,
  RequestOptions,
} from "./types";
export const DEFAULT_TIMEOUT_MS = 15_000;
const representationHeaders = [
  "accept",
  "accept-language",
  "content-type",
] as const;
export function createApiClient(config: ClientOptions = {}) {
  const options = { ...config };
  if (
    options.getToken &&
    (options.session !== undefined || options.refreshToken)
  )
    throw new ApiError(
      "Use session/setSession instead of getToken with managed authentication or token refresh",
      0,
      {},
      undefined,
      "configuration",
    );
  let managedAuth = options.session !== undefined;
  const session = createSessionState(options.session);
  let refreshJob:
    | {
        revision: number;
        version: number;
        controller: AbortController;
        promise: Promise<void>;
      }
    | undefined;
  function setSession(value: ApiSession | null) {
    session.validate(value);
    managedAuth = true;
    const oldVersion = session.getTokenVersion();
    session.set(value);
    if (
      refreshJob &&
      (refreshJob.revision !== session.getSnapshot().revision ||
        oldVersion !== session.getTokenVersion())
    )
      refreshJob.controller.abort(
        new ApiError(
          "Session credentials changed",
          0,
          {},
          undefined,
          "cancelled",
        ),
      );
  }
  const logout = () => setSession(null);
  async function refresh(
    revision: number,
    version: number,
    signal: AbortSignal,
  ) {
    session.assert(revision);
    if (session.getTokenVersion() !== version) return;
    if (
      !refreshJob ||
      refreshJob.revision !== revision ||
      refreshJob.version !== version
    ) {
      const controller = new AbortController();
      const timeout = options.refreshTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeout) || timeout < 0)
        throw new ApiError(
          "refreshTimeoutMs must be finite and non-negative",
          0,
          {},
          undefined,
          "configuration",
        );
      const timer = timeout
        ? setTimeout(
            () =>
              controller.abort(
                new ApiError(
                  "Token refresh timed out",
                  0,
                  {},
                  undefined,
                  "auth",
                ),
              ),
            timeout,
          )
        : undefined;
      const job = { revision, version, controller, promise: Promise.resolve() };
      session.requests.add(controller);
      job.promise = abortable(
        () => options.refreshToken!(controller.signal, session.getSnapshot()),
        controller.signal,
      )
        .then((token) => {
          session.assert(revision);
          if (session.getTokenVersion() !== version) return;
          if (typeof token !== "string" || !token.trim())
            throw new ApiError(
              "Refresh did not return an access token",
              401,
              {},
              undefined,
              "auth",
            );
          session.updateToken(token, revision, version);
        })
        .catch((cause) => {
          session.assert(revision);
          if (session.getTokenVersion() !== version) return;
          const error = new ApiError(
            "Token refresh failed",
            401,
            {},
            undefined,
            "auth",
            cause,
          );
          session.set(null, error);
          throw error;
        })
        .finally(() => {
          clearTimeout(timer);
          session.requests.delete(controller);
          if (refreshJob === job) refreshJob = undefined;
        });
      // Every request awaits through abortable; a caller timing out cannot leave an unhandled refresh rejection.
      void job.promise.catch(() => {});
      refreshJob = job;
    }
    const pending = refreshJob.promise;
    await abortable(() => pending, signal);
  }
  const defaultHeaders = new Headers(config.headers);
  const cacheScope =
    config.cacheScope ??
    globalThis.crypto.randomUUID?.() ??
    Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  const baseUrl = config.baseUrl ?? "";
  const browserOrigin =
    typeof location !== "undefined" && /^https?:$/.test(location.protocol)
      ? location.origin
      : undefined;
  const parseUrl = (value: string, base?: string) => {
    const parsed = new URL(value, base);
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new ApiError(
        "Only HTTP(S) URLs without embedded credentials are supported",
        0,
        {},
        undefined,
        "configuration",
      );
    return parsed;
  };
  if (
    /\\|^\/\//.test(baseUrl) ||
    (/^[a-z][a-z\d+.-]*:/i.test(baseUrl) && !/^https?:\/\//i.test(baseUrl))
  )
    throw new ApiError("Invalid baseUrl", 0, {}, undefined, "configuration");
  const baseOrigin = /^https?:\/\//i.test(baseUrl)
    ? parseUrl(baseUrl).origin
    : browserOrigin;
  const allowedOrigins = new Set(
    (config.allowedOrigins ?? []).map((origin) => parseUrl(origin).origin),
  );
  if (baseOrigin) allowedOrigins.add(baseOrigin);
  function targetUrl(url: string, params?: Params) {
    if (
      /\\|^\/\//.test(url) ||
      (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:\/\//i.test(url))
    )
      throw new ApiError(
        "Invalid request URL",
        0,
        {},
        undefined,
        "configuration",
      );
    let path = /^https?:\/\//i.test(url)
      ? url
      : `${baseUrl.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
    if (/^https?:\/\//i.test(path)) {
      const parsed = parseUrl(path);
      if (!allowedOrigins.has(parsed.origin))
        throw new ApiError(
          "Request origin is not allowed. Add its exact origin to allowedOrigins to opt in to credential forwarding.",
          0,
          {},
          undefined,
          "configuration",
        );
      path = parsed.href;
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {}))
      if (value != null)
        for (const item of Array.isArray(value) ? value : [value])
          query.append(key, String(item));
    const hashIndex = path.indexOf("#");
    const beforeHash = hashIndex === -1 ? path : path.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : path.slice(hashIndex);
    const encoded = query.toString();
    return (
      beforeHash +
      (encoded ? (beforeHash.includes("?") ? "&" : "?") + encoded : "") +
      hash
    );
  }
  function queryKey(
    key: readonly unknown[],
    url: string,
    params?: Params,
    headers?: ApiHeaders,
    scope?: string,
  ) {
    const merged = new Headers(defaultHeaders);
    new Headers(headers).forEach((value, name) => merged.set(name, value));
    // Never copy Authorization, Cookie or arbitrary API key headers into serializable keys.
    const vary = representationHeaders.flatMap((name) =>
      merged.has(name) ? [[name, merged.get(name)]] : [],
    );
    return [
      ...key,
      {
        universalApiLayer: 1,
        scope: cacheScope,
        session: session.getSnapshot(),
        account: scope,
        url,
        params,
        headers: vary,
      },
    ];
  }
  function request<T = unknown>(
    url: string,
    request: RequestOptions<T> & { responseMode: "full" },
  ): Promise<ApiResponse<T>>;
  function request<T = unknown>(
    url: string,
    request?: RequestOptions<T> & { responseMode?: "data" },
  ): Promise<T | null>;
  function request<T = unknown>(
    url: string,
    request: RequestOptions<T>,
  ): Promise<T | null | ApiResponse<T>>;
  async function request<T = unknown>(
    url: string,
    request: RequestOptions<T> = {},
  ): Promise<T | null | ApiResponse<T>> {
    for await (const context of transport(url, request)) {
      const { response, signal, assert } = context;
      try {
        const data = await readData(response, signal);
        const schema =
          request.schema === false
            ? undefined
            : (request.schema ?? options.schema);
        const validated = schema
          ? await abortable(
              () => validateResponse(schema, data, response.status),
              signal,
            )
          : data;
        assert();
        if (request.responseMode === "full")
          return Object.freeze({
            data: validated as T | null,
            headers: new Headers(response.headers),
            status: response.status,
            statusText: response.statusText,
            url: response.url,
          });
        return validated as T | null;
      } catch (cause) {
        throw requestError(cause, signal);
      }
    }
    throw new ApiError("Missing response", 0, {}, undefined, "network");
  }
  function requestError(cause: unknown, signal: AbortSignal) {
    if (signal.aborted) return signal.reason;
    if (cause instanceof ApiError) return cause;
    return new ApiError(
      "Network request failed",
      0,
      {},
      undefined,
      "network",
      cause,
    );
  }
  async function readData(response: Response, signal: AbortSignal) {
    const raw = await abortable(() => response.text(), signal);
    let data: unknown = raw === "" ? null : raw;
    if (
      raw &&
      response.headers.get("content-type")?.toLowerCase().includes("json")
    ) {
      try {
        data = JSON.parse(raw);
      } catch (cause) {
        if (response.ok)
          throw new ApiError(
            "Invalid JSON response",
            response.status,
            {},
            undefined,
            "parse",
            cause,
          );
      }
    }
    return data;
  }
  function stream(
    url: string,
    request: StreamOptions & { format: "sse" },
  ): AsyncGenerator<ServerSentEvent, void, unknown>;
  function stream(
    url: string,
    request?: StreamOptions & { format?: "text" },
  ): AsyncGenerator<string, void, unknown>;
  function stream(
    url: string,
    request: StreamOptions,
  ): AsyncGenerator<string | ServerSentEvent, void, unknown>;
  async function* stream(
    url: string,
    request: StreamOptions = {},
  ): AsyncGenerator<string | ServerSentEvent, void, unknown> {
    if (
      request.format !== undefined &&
      request.format !== "text" &&
      request.format !== "sse"
    )
      throw new ApiError(
        "Stream format must be text or sse",
        0,
        {},
        undefined,
        "configuration",
      );
    const maxEventSize = request.maxEventSize ?? 1_048_576;
    if (!Number.isSafeInteger(maxEventSize) || maxEventSize <= 0)
      throw new ApiError(
        "maxEventSize must be a positive safe integer",
        0,
        {},
        undefined,
        "configuration",
      );
    const headers = new Headers(request.headers);
    if (request.format === "sse" && !headers.has("Accept"))
      headers.set("Accept", "text/event-stream");
    for await (const { response, signal, assert } of transport(
      url,
      { ...request, headers },
      true,
    )) {
      try {
        yield* readStream(
          response,
          signal,
          assert,
          request.format ?? "text",
          maxEventSize,
        );
      } catch (cause) {
        throw requestError(cause, signal);
      }
    }
  }
  async function* transport(
    url: string,
    request: RequestOptions = {},
    streaming = false,
  ) {
    if (
      request.responseMode !== undefined &&
      request.responseMode !== "data" &&
      request.responseMode !== "full"
    )
      throw new ApiError(
        "responseMode must be data or full",
        0,
        {},
        undefined,
        "configuration",
      );
    const timeout =
      request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const revision = session.getSnapshot().revision;
    if (request.requiresAuth && !session.getSnapshot().userId)
      throw new ApiError(
        "An authenticated session is required",
        401,
        {},
        undefined,
        "auth",
      );
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0))
      throw new ApiError(
        "timeoutMs must be a finite non-negative number",
        0,
        {},
        undefined,
        "configuration",
      );
    let target: string;
    try {
      target = targetUrl(url, request.params);
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new ApiError(
        "Invalid request configuration",
        0,
        {},
        undefined,
        "configuration",
        cause,
      );
    }
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () =>
      controller.abort(
        new ApiError(
          "Request cancelled",
          0,
          {},
          undefined,
          "cancelled",
          request.signal?.reason,
        ),
      );
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });
    const timer = timeout
      ? setTimeout(
          () =>
            controller.abort(
              new ApiError("Request timed out", 0, {}, undefined, "timeout"),
            ),
          timeout,
        )
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      session.requests.delete(controller);
      request.signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cleanup);
    };
    // A consumer may be paused at a yield when it aborts and never resume it.
    // Release session/timer registrations promptly, not only on generator return.
    controller.signal.addEventListener("abort", cleanup, { once: true });
    try {
      controller.signal.throwIfAborted();
      const headers = new Headers(defaultHeaders);
      new Headers(request.headers).forEach((value, name) =>
        headers.set(name, value),
      );
      let token: string | null | undefined;
      try {
        token = await abortable(
          () =>
            managedAuth
              ? session.getToken()
              : options.getToken?.(controller.signal),
          controller.signal,
        );
      } catch (cause) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new ApiError(
          "Authentication token lookup failed",
          0,
          {},
          undefined,
          "auth",
          cause,
        );
      }
      if (token) headers.set("Authorization", `Bearer ${token}`);
      let body: BodyInit | undefined;
      if (request.body !== undefined) {
        if (
          typeof request.body === "string" ||
          request.body instanceof FormData ||
          request.body instanceof Blob ||
          request.body instanceof URLSearchParams ||
          request.body instanceof ArrayBuffer ||
          ArrayBuffer.isView(request.body)
        )
          body = request.body as BodyInit;
        else {
          body = invokeCallback(() => JSON.stringify(request.body));
          if (!headers.has("Content-Type"))
            headers.set("Content-Type", "application/json");
        }
      }
      const send = async () => {
        session.assert(revision);
        if (managedAuth) {
          headers.delete("Authorization");
          const currentToken = session.getToken();
          if (currentToken)
            headers.set("Authorization", `Bearer ${currentToken}`);
        }
        const version = session.getTokenVersion();
        const response = await abortable(
          () =>
            (options.fetch ?? globalThis.fetch)(target, {
              method: request.method ?? "GET",
              headers,
              body,
              signal: controller.signal,
              credentials: options.credentials,
              redirect: "error",
              cache:
                streaming || managedAuth || headers.has("Authorization")
                  ? "no-store"
                  : "default",
            }),
          controller.signal,
        );
        session.assert(revision);
        return { response, version };
      };
      const pendingRefresh =
        refreshJob?.revision === revision ? refreshJob.promise : undefined;
      if (request.authRetry !== false && pendingRefresh)
        await abortable(() => pendingRefresh, controller.signal);
      let { response, version } = await send();
      if (
        response.status === 401 &&
        request.authRetry !== false &&
        options.refreshToken &&
        session.getSnapshot().userId
      ) {
        // Release the rejected response before replaying its buffered request body.
        void response.body?.cancel().catch(() => {});
        await refresh(revision, version, controller.signal);
        ({ response, version } = await send());
        if (response.status === 401) {
          const error = new ApiError(
            "Refreshed credentials were rejected",
            401,
            {},
            undefined,
            "auth",
          );
          session.set(null, error);
          throw error;
        }
      }
      if (!response.ok) {
        const data = await readData(response, controller.signal);
        throw new ApiError(
          typeof data === "object" && data && "message" in data
            ? String(data.message)
            : response.statusText || "Request failed",
          response.status,
          invokeCallback(() =>
            (options.normalizeErrors ?? laravelErrors)(data),
          ),
          data,
        );
      }
      yield {
        response,
        signal: controller.signal,
        assert: () => {
          controller.signal.throwIfAborted();
          session.assert(revision);
        },
      };
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (cause instanceof ApiError) throw cause;
      throw new ApiError(
        "Network request failed",
        0,
        {},
        undefined,
        "network",
        cause,
      );
    } finally {
      controller.abort(
        new ApiError("Request closed", 0, {}, undefined, "cancelled"),
      );
      cleanup();
    }
  }
  return Object.freeze({
    cacheScope,
    queryKey,
    setSession,
    logout,
    getSessionSnapshot: session.getSnapshot,
    subscribeSession: session.subscribe,
    assertSession: session.assert,
    async withSession<T>(
      operation: () => T | Promise<T>,
      revision = session.getSnapshot().revision,
    ): Promise<T> {
      session.assert(revision);
      const controller = new AbortController();
      session.requests.add(controller);
      try {
        return await abortable(operation, controller.signal);
      } finally {
        session.requests.delete(controller);
      }
    },
    ownsQuery(key: readonly unknown[]) {
      const value = key.at(-1);
      return (
        !!value &&
        typeof value === "object" &&
        "universalApiLayer" in value &&
        value.universalApiLayer === 1 &&
        "scope" in value &&
        value.scope === cacheScope
      );
    },
    request,
    stream,
  });
}
export type ApiClient = ReturnType<typeof createApiClient>;
