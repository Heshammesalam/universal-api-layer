# universal-api-layer

[Source, tests and maintenance history](https://github.com/Heshammesalam/universal-api-layer) | [Issues](https://github.com/Heshammesalam/universal-api-layer/issues) | [CI](https://github.com/Heshammesalam/universal-api-layer/actions/workflows/ci.yml)

A framework-independent Fetch HTTP client with optional React/Vue adapters powered by TanStack Query v5 and an Angular DI/RxJS adapter. Use the same transport from JavaScript or TypeScript. The core imports neither framework, each adapter imports only its own framework, and published declarations preserve that separation.

## Requirements and installation

Node **22.13+** and npm **11.21.1+**, or a modern browser with Fetch, AbortController and Web Crypto. Use a supported, updated Node release for development and production. The npm minimum avoids the older optional-peer resolver bug; `--legacy-peer-deps` is not needed on supported npm.

```sh
# If your npm is older, update it first:
npm install --global npm@11.21.1

# Core only (no framework dependencies):
npm install universal-api-layer

# React 18 or 19:
npm install universal-api-layer react@^19 react-dom@^19 @tanstack/react-query@^5

# Vue 3.3+:
npm install universal-api-layer vue@^3.5 @tanstack/vue-query@^5

# For TypeScript React projects:
npm install --save-dev typescript @types/react@^19 @types/react-dom@^19
```

Frameworks and query adapters are optional peers, external to the bundles. Install only the peers for your chosen adapter. ESM imports are supported; CommonJS require is outside this release's scope.

## Angular 20.3, 21 and 22

Angular uses an optional DI/RxJS adapter without React, Vue or their TanStack packages. In an existing Angular application:

```sh
npm install universal-api-layer rxjs@^7.8.2
npx universal-api-layer init --framework angular
```

Angular scaffolding is TypeScript-only. It creates `src/api.providers.ts` and `src/ApiExample.ts`, detects @angular/core, refuses overwrites and leaves existing bootstrap files intact. Add the provider to application configuration and import the standalone example into a view.

```ts
// app.config.ts
import { ApplicationConfig } from "@angular/core";
import { createApiClient } from "universal-api-layer";
import { provideApiClient } from "universal-api-layer/angular";
export const appConfig: ApplicationConfig = {
  providers: [provideApiClient(() => createApiClient({ baseUrl: "/api" }))],
};
```

The factory runs in Angular's injection context once per providing injector. Prefer factories for SSR/request-local clients; do not share an authenticated client across server requests. An existing client instance is also accepted. injectApiClient() returns the core client. injectApiSession() returns a readonly, token-free session Signal with DestroyRef cleanup.

```ts
import { Component, DestroyRef, inject, signal } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ApiService } from "universal-api-layer/angular";
@Component({
  selector: "users-panel",
  standalone: true,
  template: `<button (click)="load()">Load</button>
    <pre>{{ result() }}</pre>`,
})
export class UsersPanel {
  private readonly api = inject(ApiService);
  private readonly destroy = inject(DestroyRef);
  readonly result = signal("");
  load() {
    this.api
      .request$("/users", { responseMode: "full" })
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (response) =>
          this.result.set(
            JSON.stringify({
              users: response.data,
              total: response.headers.get("X-Total-Count"),
            }),
          ),
        error: (error) => this.result.set(error.message),
      });
  }
}
```

ApiService exposes typed request$ and stream$ with the core's request/full-response and text/SSE overloads. They are **cold**: each subscription starts an independent operation. Unsubscribe aborts only that subscription. Destroying the providing injector cancels its ApiService operations and prevents future subscriptions; it does not log out shared clients or close sockets/direct core calls owned elsewhere. Directly constructed new ApiService(client) instances must be disposed by their owner. External AbortSignal, session guards, refresh, deadlines, schemas and ApiError semantics remain active. Multiple mutation subscriptions mean multiple server operations.

The adapter uses Fetch: Angular HttpClient interceptors, its testing backend and HttpClient transfer cache do not apply. Configure session/headers/refresh on createApiClient. It does not add an Angular query cache, retries, deduplication or automatic invalidateKeys handling. Refetch explicitly after writes or integrate an application-owned cache. React/Vue TanStack behavior is unchanged.

For SSE, api.stream$("/chat", { method: "POST", body: { message: "Hello" }, format: "sse", timeoutMs: 120_000 }) emits complete ServerSentEvent values. Use takeUntilDestroyed or unsubscribe from a Stop action. Parse/validate each event's data according to your backend contract. RxJS cancellation closes the reader; no automatic replay is added.

Angular WebSocket helpers come from universal-api-layer/websocket/angular: injectSocketState(socket) returns a readonly Signal, and injectSocketMessage(socket, listener) registers a lifecycle-cleaned subscriber. Call these helpers in an injection context. They subscribe only; the owner connects/disconnects/disposes. Open browser-only sockets in afterNextRender and register socket.dispose with DestroyRef. Existing origin/session/reconnect limits apply. Clear displayed user data on account changes.

Complete standalone examples in [examples/angular](./examples/angular) cover HTTP with explicit refetch, cancellable SSE and WebSocket chat. The example is zoneless; the adapter uses standard Signals/Observables. Packed Angular CLI production builds, strict templates and DOM HTTP/mutation behavior are tested. Use the matching Node/TypeScript toolchain ([Angular compatibility](https://angular.dev/reference/versions)): Angular 22 requires Node ^22.22.3 / ^24.15.0 / >=26 and TypeScript 6.0. Other SDK entrypoints retain the package's minimum runtime. Angular/RxJS remain optional peers and are not bundled into the other entrypoints.

## HTTP client

```ts
import { createApiClient, ApiError } from "universal-api-layer";
export const client = createApiClient({
  baseUrl: "/api",
  // Requests time out after 15 seconds by default.
});
const users = await client.request<{ data: User[] }>("/users", {
  params: { page: 1, search: "Bahaa" },
});
// users is { data: User[] } | null.
```

Create the client once during application bootstrap. The default request deadline is **15,000 ms** (`DEFAULT_TIMEOUT_MS`), including authentication, shared refresh waiting, Fetch, body reading and asynchronous response validation. Set timeoutMs on the client or an individual request to override it; `timeoutMs: 0` explicitly disables it. Timeouts must be finite and non-negative. Cancellation rejects promptly even for a non-cooperative provider; providers should also respect their AbortSignal to stop underlying work.

For authenticated applications, use the managed session API below. The legacy getToken callback remains supported for externally managed authentication, but it cannot identify accounts by itself and cannot be combined with managed session configuration or automatic refresh.

`request<T>(url, options)` returns `Promise<T | null>`. Empty successful bodies, including HTTP 204/205, return **null**, which both query adapters can cache. JSON content types are parsed, other non-empty bodies return text. Malformed successful JSON throws an `ApiError` with code `parse`. Type arguments describe the expected payload; they do not perform runtime schema validation unless you supply a schema as described below.

Request options: `method`, `params`, `body`, `headers`, `signal`, `timeoutMs`, `schema`, `requiresAuth`, `authRetry`. Null/undefined parameters are omitted and arrays repeat the key. Objects are serialized as JSON. Strings, FormData, Blob, URLSearchParams, ArrayBuffer and typed-array views pass through. Do not set a JSON Content-Type when sending FormData. Client options also include `headers`, `credentials`, a custom `fetch`, `normalizeErrors`, `cacheScope`, `allowedOrigins`, `session`, `refreshToken`, `refreshTimeoutMs` and a default `schema`. Configuration headers are snapshotted when the client is created.

### Reading response headers and pagination

request remains body-only by default. Opt into parsed data plus metadata without consuming the response twice:

```ts
const response = await client.request<Post[]>("/posts", {
  responseMode: "full",
  params: { _page: 1, _limit: 9 },
});
const posts = response.data; // Post[] | null
const totalHeader = response.headers.get("X-Total-Count");
console.log(response.status, response.statusText, response.url);
```

Full mode returns ApiResponse<T>: data, a separate native Headers snapshot, status, statusText and url. Schemas, deadlines, cancellation, errors and token refresh work identically; metadata describes the final successful response after refresh. Existing calls without responseMode keep returning T | null. Missing/unavailable headers return null. Validate a total count before using it for pagination rather than silently substituting the current page length.

For a cross-origin API, the backend must expose custom response headers, for example `Access-Control-Expose-Headers: X-Total-Count`. The library cannot bypass browser CORS restrictions. Fetch's visible status can also differ from the Network panel when the browser reconstructs a cached response after HTTP 304.

When using full responses inside a native useQuery, return a JSON-friendly projection such as `{ posts: response.data, total: Number(totalHeader) }` from queryFn. Do not persist a native Headers instance as cache data; JSON serialization does not preserve its methods.

### Streaming chat: text and SSE

`client.stream(url, options)` returns a lazy, single-use async generator. The request starts on the first iteration; chunks/events arrive before the response finishes. It uses the same URL allowlist, credentials, managed session, JSON request body, cancellation and pre-response 401 refresh as `request`. Streaming requests use HTTP cache: no-store. They do not use the TanStack query cache or automatic query/mutation retries.

```ts
const controller = new AbortController();
let answer = "";
for await (const chunk of client.stream("/chat", {
  method: "POST",
  body: { message: "Hello" },
  signal: controller.signal,
  timeoutMs: 120_000,
})) {
  answer += chunk; // decoded UTF-8 text; update your Vue ref/React state here
}
// A Stop button can call controller.abort().
```

The default `format: "text"` yields strings. Network chunk boundaries are arbitrary, so one chunk is not necessarily a token, line or JSON object. The decoder preserves UTF-8 characters split across reads.

For SSE, use `format: "sse"`. A successful body must have `Content-Type: text/event-stream` (parameters are allowed). HTTP 204/205 ends without messages. Each emitted `ServerSentEvent` has string `event` (default `message`), `data` and `id`, plus an optional numeric `retry` hint. The parser handles LF/CR/CRLF, comments/heartbeats, UTF-8 BOM, multiline data and persistent IDs. Only blank-line-terminated events with a data field are dispatched; incomplete events at EOF are discarded. The latest valid retry hint is exposed, but never schedules a reconnect. This is a Fetch-based SSE consumer, not the browser EventSource reconnection API. Parsing follows the [HTML SSE event-stream rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).

```ts
// Example backend contract: data contains { delta: string }, then [DONE].
for await (const event of client.stream("/chat", {
  method: "POST",
  body: { message: "Hello" },
  format: "sse",
  signal: controller.signal,
  timeoutMs: 120_000,
})) {
  if (event.data === "[DONE]") break;
  if (event.event === "error") throw new Error("Chat server error");
  const payload: unknown = JSON.parse(event.data);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("delta" in payload) ||
    typeof payload.delta !== "string"
  ) {
    throw new Error("Invalid chat event");
  }
  answer += payload.delta;
}
```

`[DONE]`, JSON shapes and application error events are backend-specific; they are not interpreted automatically. Streaming bypasses client whole-response schemas. Parse and validate each complete SSE `data` payload yourself (or with your schema library). NDJSON and WebSocket protocols are not parsed by this API.

The total deadline remains **15 seconds by default**, including body consumption. Increase `timeoutMs` for chat; `timeoutMs: 0` disables it explicitly. This is a total deadline, not an inactivity timeout. `break`, generator `return()`, thrown consumer errors and `AbortController.abort()` close the reader and transport. Always consume with `for await`/`finally` or abort when leaving a view. Managed logout/account switches abort active streams and prevent buffered old-session events being yielded. Clear already displayed conversation state when your application changes accounts; streamed UI state is not part of the library query cache.

There is **no reconnect or replay after a successful response starts**, including after partial data, parse errors or connection loss. HTTP 401 may refresh/replay once before any successful stream body is read; disable `authRetry` if your endpoint cannot safely accept this, and implement server-side idempotency where needed. `maxEventSize` defaults to 1,048,576 UTF-16 code units and bounds each SSE line and accumulated event data; exceeding it throws `ApiError` with code `parse`. Text streams are consumed incrementally without assembling the full response.

Ready-to-use examples with Send/Stop, cleanup and safe text rendering: [Vue StreamingChat.vue](./examples/vue/src/StreamingChat.vue) and [React StreamingChat.tsx](./examples/react/src/StreamingChat.tsx). Render the component in its example application's main view and provide `/api/chat` on your backend. The backend must flush chunks/events; configure proxies to avoid buffering and configure CORS for cross-origin requests. Existing `/posts` demo endpoints do not provide a chat stream.

### WebSocket: a separate optional transport

```ts
import { createSocketClient } from "universal-api-layer/websocket";
const socket = createSocketClient({
  url: "wss://chat.example.com/socket",
  protocols: ["chat.v1"], // optional; must be supported by your server
  schema(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      !("text" in value) ||
      typeof value.text !== "string"
    ) {
      throw new Error("Invalid chat message");
    }
    return { text: value.text };
  },
});
const off = socket.onMessage((message) => console.log(message.text));
const offState = socket.subscribe(() =>
  console.log(socket.getSnapshot().status),
);
socket.connect(); // lazy: construction does not open a connection
// Send from your UI only when getSnapshot().status === "open":
// socket.sendJson({ type: "chat.send", text: "Hello" });
// Later: off(); offState(); socket.dispose();
```

This is raw WebSocket, not Socket.IO, Laravel Echo or a channel/room protocol. The backend must implement the agreed URL, subprotocol and message shapes. The core WebSocket import has no framework or third-party WebSocket runtime dependency. It uses native WebSocket in supported browsers and Node 22.13+, or an explicit trusted `webSocketFactory` implementing `SocketTransport`.

`connect()` starts connection setup and returns void; observe `subscribe`/`getSnapshot()` or `onError` for asynchronous results. `disconnect(code?, reason?)` stops connecting/reconnecting and allows a later explicit `connect()`. `dispose()` additionally clears subscriptions and permanently disables the client. `getSnapshot()` is stable until state changes, frozen and contains `status`, `reconnectAttempt`, `error` and server `close` information. Status is idle/connecting/open/reconnecting/closed/disposed. Subscriptions return unsubscribe functions and state callbacks run on every snapshot change, not just on open transitions. Callback exceptions are isolated and reported to error listeners without recursively invoking failing error listeners.

Incoming text is parsed as JSON by default. Optional `schema` validates/transforms each decoded message, including asynchronous Standard Schema/parse validators; processing preserves arrival order. Invalid JSON/schema messages are dropped and reported via `onError` and snapshot.error, while the connection remains active. `format: "raw"` preserves string/ArrayBuffer/Blob data instead. `send(data)` sends native text/binary data; `sendJson(value)` serializes once. Type arguments do not validate data by themselves.

**There is no outgoing queue or automatic message replay.** Sending while not OPEN throws `ApiError` with code `network`; exceeding the outgoing buffer limit throws code `backpressure`. Successful send means the platform accepted the data for transmission, not that the server received or committed it. Application acknowledgements, unique message IDs, deduplication and explicit retry decisions belong to your backend/application protocol.

Reconnect defaults to at most **5 attempts per explicit connect()**, using exponential delay from 500 ms up to 30 seconds, with jitter between 50% and 100% of that delay. The retry budget does not reset on short-lived successful opens; reaching it closes the client until you explicitly connect again. Reconnect applies to close codes 1001/1005/1006/1011/1012/1013/1014 and transient setup/handshake timeout failures. Normal 1000, protocol/policy failures and application codes (including authentication failures) stop. `reconnect: false` disables retries. Configure `{ maxAttempts, baseDelayMs, maxDelayMs, jitter }` to override the bounded policy. Reconnect recreates the transport but does not resend messages or rejoin backend-specific rooms automatically.

`connectTimeoutMs` defaults to 10,000 and includes ticket lookup/handshake. It is cleared after open; there is no automatic idle timeout or application heartbeat. Implement a heartbeat contract with your server if required. `maxMessageSize` and `maxBufferedAmount` default to 1,048,576 bytes; `maxPendingMessages` defaults to 64 messages awaiting async processing. Oversized incoming messages/backlog overflow report `backpressure` and close without automatic reconnect. Native WebSocket has no receive-stream backpressure API; these limits bound this client's message processing, not every platform/network buffer. Size/buffer limits are positive safe integers, and connection/reconnect timers must be between 1 and 2,147,483,647 ms. maxAttempts also permits zero.

#### WebSocket authentication and sessions

Browser WebSocket constructors do not accept arbitrary Authorization headers ([native constructor API](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)). The SDK does not put access tokens in URLs/subprotocols or copy HTTP credentials into a socket. Use server-authenticated cookies or a server-issued short-lived, scoped connection ticket. For tickets, use an abortable URL provider and pin its exact allowed ws(s) origins:

```ts
const socket = createSocketClient({
  sessionClient: client, // same managed HTTP client used for login/logout
  allowedOrigins: ["wss://chat.example.com"],
  url: async (signal) => {
    const ticket = await client.request<{ url: string }>("/socket-ticket", {
      method: "POST",
      requiresAuth: true,
      signal,
      schema(value: unknown) {
        if (
          !value ||
          typeof value !== "object" ||
          !("url" in value) ||
          typeof value.url !== "string"
        ) {
          throw new Error("Invalid connection ticket");
        }
        return { url: value.url };
      },
    });
    if (!ticket) throw new Error("Missing connection ticket");
    return ticket.url;
  },
});
```

A URL provider is called on every connection attempt and must declare allowedOrigins. URLs must be absolute ws:// or wss:// without embedded credentials or fragments; use wss:// in production. A static URL defaults to its own origin, or must match an explicit allowlist. The allowlist protects connection targets; server-side authentication and Origin validation remain necessary. Short-lived ticket URLs are credentials too: avoid logging them or using long-lived access tokens there. The client does not add connection URLs to snapshots; providers and custom errors must also avoid sensitive diagnostics.

When sessionClient is supplied, requiresAuth defaults to true. Set it explicitly false only for an intentionally public connection. Logout/account/tenant changes close the socket, cancel pending tickets/backoff, and prevent old messages/async validations from being delivered. Session binding also clears retained error/close diagnostics after server-initiated closure; it remains subscribed until disconnect/dispose or a session transition. Always release a finished client. Login does not reopen it automatically; explicitly connect after authenticating. Same-identity HTTP token rotation does not reauthenticate an already-open socket: disconnect/connect explicitly if your backend requires fresh credentials. Browser handshake errors do not expose an HTTP 401 for automatic socket refresh; the HTTP ticket request can use the HTTP client's coordinated refresh normally. Clear already displayed chat state on account changes; socket messages are not owned by the TanStack cache.

#### React and Vue socket subscriptions

Optional adapters are available from `universal-api-layer/websocket/react` and `universal-api-layer/websocket/vue`. Both export `useSocketState(socket)` and `useSocketMessage(socket, listener)`. React state uses useSyncExternalStore; Vue state is a readonly ref and composables require an active effect scope. Both clean subscriptions on unmount/scope disposal. They do **not** connect or close a shared client automatically: the component/application owns connect/disconnect/dispose. Create request-local clients during SSR and open them only in browser lifecycle callbacks.

Complete examples: [React WebSocketChat.tsx](./examples/react/src/WebSocketChat.tsx) and [Vue WebSocketChat.vue](./examples/vue/src/WebSocketChat.vue). They expect a development raw WebSocket server at ws://localhost:3000/chat that accepts `{ type: "chat.send", text: string }` and sends `{ text: string }`. They bound displayed history, clear it on session changes, and clean the connection when leaving the view. The React example uses disconnect on cleanup to support Strict Mode effect replay; use dispose when an imperative owner is permanently finished with a client. The existing JSONPlaceholder posts endpoint is not a WebSocket server.

### Managed login/logout and automatic cache isolation

After a successful login, pass the server-confirmed identity once:

```js
client.setSession({
  userId: String(loginResponse.user.id),
  token: loginResponse.access_token,
  // tenantId: String(loginResponse.tenant.id), // for multi-tenant applications
});

// On logout: cancel old work, clear owned in-memory caches, drop the token.
client.logout();
```

ApiProvider and createApiPlugin connect session changes to their caches automatically. No per-query account scope or manual QueryClient.clear call is needed in managed mode. A session userId is a cache/UI identity, not proof of authentication; your backend must still authorize every request. Tokens live only in this client instance's memory. The library does not write localStorage or sessionStorage. Managed-session requests (including after local logout) and requests carrying Authorization use Fetch cache: no-store, bypassing the browser HTTP cache. Public unmanaged requests retain the normal HTTP cache behavior. TanStack caching still works in both cases. Your backend/CDN and service worker must also enforce correct private-data caching policies; custom fetch implementations must honor these Fetch options.

Use requiresAuth for private endpoints so queries remain disabled while logged out:

```js
const me = useApiQuery({ key: ["me"], url: "/me", requiresAuth: true });
```

Read the current identity with useApiSession from the appropriate adapter. React gets an immutable SessionSnapshot; Vue gets a readonly computed ref (`session.value.userId` in scripts). Direct requests and mutations with requiresAuth reject before HTTP when there is no identified session. Use direct client.request for login/logout endpoints, then update the local session. Login requests should use authRetry: false.

### Automatic token refresh

Refresh is opt-in because endpoints and payloads vary between backends:

```js
const client = createApiClient({
  baseUrl: "/api",
  session: null,
  refreshToken: async (signal) => {
    const response = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include", // example: an HttpOnly refresh cookie
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("Refresh failed");
    const body = await response.json();
    return body.access_token;
  },
});
```

Once setSession has established an identity, an HTTP 401 triggers one shared refresh per client, then each affected request retries once with the new token. Late responses using the old token reuse the refreshed credentials rather than starting another refresh. A second 401, failed refresh or refresh deadline expires the local session and clears its caches. The original cause is retained on an auth ApiError. The default shared refresh deadline is also 15 seconds; refreshTimeoutMs overrides it (0 explicitly disables it). One caller timing out does not cancel a refresh needed by other callers.

Logout/account changes abort the refresh and prevent late results from restoring the old identity. Refreshing the same user's token does not invalidate successful cached data. All automatic refresh state is per client instance, including during SSR. Use authRetry: false for login/refresh requests or endpoints where replay is inappropriate. If your refresh callback uses this same API client instead of native fetch, its refresh request **must** set authRetry: false and pass the signal, to avoid recursive refresh/waiting on itself. Callback code is responsible for its own backend-specific cookie/CSRF and token-persistence behavior.

### Runtime response validation

Supply schema on a query, mutation or direct request; it runs automatically before selection and caching. A client-level schema can validate a common response envelope, with per-request schemas overriding it and schema: false opting out. Async validation is supported and shares the request deadline.

```js
// Optional: npm install zod
import { z } from "zod";
const UsersResponse = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string() })),
});
const users = useApiQuery({
  key: ["users"],
  url: "/users",
  requiresAuth: true,
  schema: UsersResponse,
  select: (response) => response?.data ?? [],
});
```

The package accepts [Standard Schema v1](https://standardschema.dev/schema) schemas, parse/parseAsync objects, or a function which validates and returns the value (possibly transformed). No validator library is bundled or required. Empty successful responses are validated too: allow null in the schema when appropriate. A validator must return a value; undefined is rejected. Without a configured schema, only transport/JSON parsing checks run because the library cannot know your API's shape. Validation failures reject as ApiError with code validation, HTTP response status and original issues/error in cause; invalid data is never cached as a successful query. Server 4xx field errors remain HTTP errors and are not passed through success schemas. Schemas validate network responses, not arbitrary data injected into a QueryClient or restored by a third-party persister. Use a consistent response contract for each query key; include a schema/API version in the key when changing that contract, and version or clear persisted caches during such migrations.

### Origin boundaries

Relative URLs append to baseUrl. Same-origin absolute HTTP(S) URLs are supported. Different-origin absolute URLs are **blocked before retrieving credentials**, unless their origin is explicitly allowed:

```ts
const client = createApiClient({
  baseUrl: "https://api.example.com/v1",
  allowedOrigins: ["https://uploads.example.com"],
  getToken: () => authStore.token,
});
```

Opting in authorizes sending the client's credentials and headers to that origin. In a browser, a relative baseUrl uses the application's origin; in Node, use an absolute baseUrl or explicitly list permitted origins for absolute requests. Protocol-relative URLs, backslashes, non-HTTP(S) schemes and embedded URL credentials are rejected. Redirects are rejected rather than implicitly forwarding arbitrary credential headers to another origin; request the final permitted URL directly. Never put secrets in URLs or query parameters.

### Errors and validation

`ApiError` extends Error and exposes `status`, `fieldErrors`, `data`, `code` and the original `cause` when available. Codes are `http`, `network`, `timeout`, `cancelled`, `auth`, `parse`, `configuration`, `callback`, and `validation`. HTTP errors retain the server body in `data`; other errors retain their original failure through `cause`.

Laravel-style `{ message, errors: { email: ["Required"] } }` responses normalize automatically. `laravelErrors` is exported, or supply `normalizeErrors(data)` for another validation format. Exceptions from selection, payload/URL mapping, error normalization and onSuccess callbacks become `ApiError` with code `callback`, rather than being mistaken for HTTP failures. A failed mutation onSuccess callback can put a successfully committed request into error state; inspect the code/cause before retrying a write.

## React

```tsx
import {
  ApiProvider,
  useApiQuery,
  useApiMutation,
} from "universal-api-layer/react";
import { client } from "./api";
root.render(
  <ApiProvider client={client}>
    <App />
  </ApiProvider>,
);

function Users({ search, page }: { search: string; page: number }) {
  const users = useApiQuery<{ data: User[] }, User[]>({
    key: ["users"],
    url: "/users",
    params: { search, page },
    select: (response) => response?.data ?? [],
  });
  if (users.isPending) return <p>Loading...</p>;
  if (users.error) return <p>{users.error.message}</p>;
  return <pre>{JSON.stringify(users.data)}</pre>;
}
```

ApiProvider always installs QueryClientProvider. It creates one stable QueryClient per mount, or uses an explicitly supplied `queryClient` from `@tanstack/react-query`. Construct supplied clients outside rendering. Hooks follow the Rules of Hooks and expose ordinary React state: `data`, `error`, `isPending`, `isLoading`, `isFetching`, `refetch()`.

## Vue

```ts
import { createApiPlugin } from "universal-api-layer/vue";
import { client } from "./api";
app.use(createApiPlugin({ client }));
app.mount("#app");
```

The plugin installs VueQueryPlugin and provides the API client on that app. Pass a `queryClient` from `@tanstack/vue-query` to reuse an existing cache. Call composables synchronously in setup or script setup.

```vue
<script setup>
import { computed, ref } from "vue";
import { useApiQuery } from "universal-api-layer/vue";
const search = ref("");
const page = ref(1);
const params = computed(() => ({ search: search.value, page: page.value }));
const { data, error, isPending } = useApiQuery({
  key: ["users"],
  url: "/users",
  params,
  select: (response) => response?.data ?? [],
});
// Scripts use data.value, error.value, isPending.value.
</script>
<template>
  <p v-if="isPending">Loading...</p>
  <p v-else-if="error">{{ error.message }}</p>
  <pre v-else>{{ data }}</pre>
</template>
```

Vue `key`, `url`, `params`, `enabled` and query `cacheScope` accept plain values, refs, computed refs and reactive getters. For example `params: () => ({ page: page.value })`. Reading a ref's value into a plain object snapshots it; pass a ref/computed/getter to retain reactivity. Templates unwrap top-level refs. Other options are plain values/functions. Cached query data should be treated as immutable.

## Cache identity, accounts and SSR

Both adapters append client scope, query scope, URL, parameters and representation headers to your supplied key. Each client receives a unique scope by default, so separate clients can safely share a QueryClient. Parameters update identity and fetch the corresponding data. Prefix invalidation with `["users"]` still matches all appended variants.

Only `Accept`, `Accept-Language` and `Content-Type` header values are included in keys. Authorization, cookies and arbitrary API key headers are never copied to cache identity. For other representation-varying headers, add their **non-secret** identifier to the explicit key.

Managed sessions automatically include non-secret user/tenant identity and a session revision in keys. setSession for a different user/tenant or logout cancels old requests and clears this client's query and mutation namespace from attached QueryClients; unrelated clients' namespaces remain intact. Rotating a token for the same identity preserves fresh data. The adapters also suppress late mutation callbacks/results from old sessions, including offline paused mutations. Releasing the last provider/plugin binding clears that client's cached data in that QueryClient.

The optional per-query cacheScope still supports extra non-secret partitioning. Applications that keep the legacy getToken mode must continue managing account changes explicitly; the client cannot safely infer identity from an arbitrary token. Never put tokens in keys, params, cache scopes or custom header identifiers.

For SSR, create a fresh client and QueryClient per request. Configure a stable non-secret client cacheScope and the same initial session user/tenant in the server and browser constructors for hydration. Do not serialize access tokens into hydration data. In-memory cleanup does not erase third-party persisted storage: configure your persister to remove stored client data on logout as well. Local session clearing does not invalidate server cookies or refresh tokens; call your backend logout endpoint when applicable.

Queries also support `enabled`, `staleTime`, `retry`, `headers`, `timeoutMs`, `schema`, `requiresAuth` and `authRetry`. Explicit query or QueryClient retry settings take precedence. Otherwise, only network/timeout/HTTP 5xx failures retry (up to three retries); deterministic validation, auth, parsing and HTTP 4xx failures do not. TanStack cancellation reaches the HTTP request, including token lookup: `queryClient.cancelQueries({ queryKey: ["users"] })`.

## Mutations in both frameworks

```ts
const createUser = useApiMutation({
  url: "/users",
  method: "POST",
  invalidateKeys: [["users"]],
});
createUser.mutate({ name: "Bahaa", email: "bahaa@example.com" });

const updateUser = useApiMutation<
  { data: User },
  { id: number; name: string },
  User | null
>({
  url: (variables) => `/users/${variables.id}`,
  method: "PATCH",
  mapPayload: (variables) => ({ name: variables.name }),
  select: (response) => response?.data ?? null,
  invalidateKeys: [["users"]],
});
```

Default method is POST; variables form the default request body. `mutateAsync` returns a promise. Invalidation within this client namespace is awaited before `onSuccess(data, variables)`. Mutations support headers, timeoutMs and an explicit AbortSignal. Use a fresh controller after cancelling.

React: `createUser.error?.fieldErrors`, `createUser.isPending`. Vue scripts: `createUser.error.value?.fieldErrors`, `createUser.isPending.value`. Vue's `mutate`, `mutateAsync` and `reset` are functions and do not use `.value`. TypeScript generics are response, mutation variables, and selected result; query generics are response and selected result. Defaults include null. JavaScript uses the same API without type arguments.

### Native TanStack queries and explicit invalidation scope

By default invalidateKeys matches only this API client's owned queries in its current QueryClient. To update matching queries created with native useQuery as well, opt in explicitly in either adapter:

```js
const createPost = useApiMutation({
  url: "/posts",
  invalidateKeys: [["posts"]],
  invalidateScope: "all",
});
const deletePost = useApiMutation({
  url: (id) => `/posts/${id}`,
  method: "DELETE",
  mapPayload: () => undefined,
  invalidateKeys: [["posts"]],
  invalidateScope: "all",
});
```

all means every matching prefix in the same QueryClient, including native queries and other client namespaces; it does not invalidate unrelated keys or other QueryClients. The default client scope is unchanged. Both scopes await invalidation before onSuccess. An alternative is a targeted native `queryClient.invalidateQueries({ queryKey: ["posts"] })` in onSuccess; do not configure both paths for the same key unless you intentionally need duplicate work.

Invalidation opt-in does not make native queries session-owned. Private native queries still need appropriate session-aware keys and logout cleanup, or should use useApiQuery. Native public lists can keep their existing useQuery and use full-mode client requests in queryFn to access pagination headers.

For JSONPlaceholder demos, POST and DELETE are simulated and do not persist server state. A correct refetch can therefore return the original list. Use a persistent backend or controlled test server to verify lasting changes; the integration tests cover POST/DELETE refetches with such a backend.

## CLI

```sh
npx universal-api-layer init --framework vue --language javascript
npx universal-api-layer init --framework vue --language typescript
npx universal-api-layer init --framework react --language javascript
npx universal-api-layer init --framework react --language typescript
```

Framework/language flags control scaffolding, never runtime switches. Detection reads package dependencies, language configs and application source extensions, including Vue script language and projects without src. Ambiguous choices prompt in a terminal or fail with actionable flags in non-interactive mode.

Creates `src/api.js`/`.ts` and one example component: Vue `.vue` with plain script setup or lang=ts, React `.jsx`/`.tsx`. Existing files are preserved unless --force is explicit. Dependency and provider/plugin instructions are printed; application entries and package manifests are not edited. Next.js/Nuxt integration remains manual: configure client provider boundaries/plugins and isolated SSR state for those frameworks.

## Examples and development

`examples/react` and `examples/vue` are Vite apps with development-only mock APIs. Run `npm ci` and `npm run build` at the repository root, then install dependencies and run `npm run dev` inside either example directory. Production examples need a real /api server. API fragments above assume your own User type, auth store and application bootstrap.

```sh
npm run lint
npm run typecheck
npm test                 # Builds first, including on a clean checkout
npm run check:consumers  # Packs and tests isolated installs without peer bypass flags
npm run audit:all
npm run format:check
npm run check            # Full release checks
```

Consumer checks cover core JS/TS, React JS/TS and Vue JS/TS, with strict declaration checks (including a Node-only project without DOM libs) and absent-framework assertions. Built React/Vue consumers also render in JSDOM and exercise queries, validation errors, mutations and invalidation. `UAL_COMPATIBILITY=minimum` selects React 18, Vue 3.3 and TanStack 5.0 for compatibility fixtures. CI checks the minimum Node version and current Node 24 on Linux/Windows. The workflow is committed to the public repository; inspect the linked Actions run for actual hosted results. Local checks and hosted CI are reported separately.

prepublishOnly runs the full check suite for source-directory publication. Local tarballs can be created with npm pack and should only be published after those checks pass. The minimatch override selects the security-patched release for development tools; lint and build validate compatibility. Update it as upstream tools adopt the fix. [CHANGELOG.md](./CHANGELOG.md) lists the migration changes.

## Security evidence and maintenance

`npm audit` is an inventory of dependency versions matched against known advisories. A zero result is not a comprehensive security audit, penetration test or guarantee about the HTTP/auth code. SDK repository dependencies, packed consumers and an application's production graph are separate scopes. Do not use an old application's production-only result as evidence for a different SDK release.

Run `npm run audit:report` to generate [the versioned dependency inventory](https://github.com/Heshammesalam/universal-api-layer/blob/main/reports/dependency-audit.json), including UTC time, package version, runtime/tool versions, lockfile SHA-256 and separate full/production-selection scopes. Optional frameworks installed as development dependencies may be excluded by omit=dev. Each application must audit its own installed lockfile after upgrading. See [SECURITY.md](./SECURITY.md) for the reporting policy and limitations.

Public Git history starts with the current source import. Prior release notes in CHANGELOG.md are historical documentation, not reconstructed commits or evidence of a long maintenance track record.
