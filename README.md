# universal-api-layer

[Source, tests and maintenance history](https://github.com/Heshammesalam/universal-api-layer) | [Issues](https://github.com/Heshammesalam/universal-api-layer/issues) | [CI](https://github.com/Heshammesalam/universal-api-layer/actions/workflows/ci.yml)

A framework-independent Fetch HTTP client with separate React and Vue adapters powered by TanStack Query v5. Use the same transport from JavaScript or TypeScript. The core imports neither framework, each adapter imports only its own framework, and published declarations preserve that separation.

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
