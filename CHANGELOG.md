# Changelog

## 0.5.0 - 2026-11-01

- Added lazy client.stream async generators for incremental UTF-8 text and complete SSE events, with typed output and bounded SSE buffers.
- Shared origin/auth/request transport, deadlines through body consumption, reader cancellation on abort/break, and session guards for already buffered events.
- HTTP 401 can refresh once before a successful stream starts; no automatic reconnect or replay after partial output.
- Vue/React streaming chat examples, real HTTP incremental delivery test, parser/cancellation/session regressions and packed consumer smoke/type checks.

## 0.4.0 - 2026-10-31

- Optional responseMode: full on client.request exposes parsed/validated data, response headers, status, statusText and URL, with precise overloads and unchanged data-only defaults.
- Explicit invalidateScope: all updates matching native TanStack queries in the same QueryClient; client remains the safe default scope in both adapters.
- Regression coverage for X-Total-Count pagination, schema/refresh/error metadata and POST/DELETE interoperability in React and Vue.
- Public source/test repository, Issues and CI links in npm metadata. Git history starts with the current source import rather than invented historical commits.
- Versioned, timestamped dependency inventory with lockfile digest and explicit distinction from a comprehensive security review.

## 0.3.1 - 2026-10-31

- Bypass the browser HTTP cache for managed sessions, including post-logout requests, and for Authorization-bearing requests. This complements TanStack namespace isolation during account changes. Public unmanaged requests retain normal HTTP caching.
- Added regressions for a pre-existing URL-only private HTTP cache and legacy/manual Bearer headers.

## 0.3.0 - 2026-10-31

- Managed authentication with setSession/logout, immutable public session snapshots and useApiSession in React/Vue.
- Account/tenant changes automatically isolate and clear owned query/mutation caches and cancel old work; same-user token rotations retain fresh data.
- Late and offline-paused mutation results cannot reintroduce prior-account state; public mutation callback variables remain unchanged.
- Default 15-second request deadline, including authentication, refresh waiting and async response validation; timeoutMs: 0 explicitly disables it.
- Optional coordinated token refresh: one callback for concurrent 401s, one request replay, separate bounded refresh deadline and fail-closed local logout on failure.
- Optional runtime schemas for core, queries and mutations: Standard Schema v1 (tested with Zod), parse/parseAsync objects and validator functions. Distinct validation errors preserve causes.
- requiresAuth disables private queries while logged out; authRetry: false prevents recursive refresh and allows endpoint-specific replay opt-out.
- Default retries exclude deterministic auth/validation/parse/client failures and respect explicit query/cache configuration.
- Split transport, public types, callbacks, session state and response validation into focused framework-independent modules.

### Migration

- Configure session/setSession instead of combining legacy getToken with refreshToken. User and tenant IDs must come from the authenticated backend; raw token changes cannot identify users.
- Long-running requests must explicitly increase or disable the new default deadline.
- Client-owned in-memory cache is purged on logout/session switches and when its last cache binding unmounts. Explicitly shared namespaces participate in the same purge; external persistence and server logout remain application-owned.
- SSR constructors must use matching initial user/tenant identities and stable non-secret client scopes; do not serialize access tokens.

## 0.2.0 ? 2026-10-31

### Security and correctness

- Client-specific cache namespaces, explicit non-secret account scopes and stable opt-in SSR identities.
- Only representation headers participate in cache keys; credentials and arbitrary API key headers are excluded.
- Cross-origin requests are blocked unless their origin is explicitly allowed. Unsafe URL forms are rejected before authentication; HTTP redirects are rejected to prevent indirect credential forwarding.
- Deadlines and cancellation cover token lookup, Fetch and response reading, including non-cooperative async providers.
- Empty successful responses return null, consistently supported by both adapters and declarations.
- Malformed success JSON rejects with a parse error. HTTP failures preserve response diagnostics.
- Auth and application callback failures have distinct ApiError codes with original causes.
- Shared bundle chunks preserve a single ApiError class identity across entry points.

### Tooling and compatibility

- Node >=22.13.0 and npm >=11.21.1. Ordinary isolated installs no longer need legacy-peer-deps on supported npm.
- Updated build/test tools, removed unnecessary test-only dependency chains and applied a patched minimatch override.
- Focused regression checks, strict JS/TS packed consumers, framework-version compatibility fixtures, lint/format and release checks.
- Added Linux/Windows CI and an enforced source-publication validation hook.
- CLI detects applications outside src; nullable-response-safe templates and examples.

### Migration from 0.1.x

- Handle null in request results and selection callbacks: response?.data ?? [].
- Absolute requests to different origins require allowedOrigins. Opting in permits credential forwarding.
- Use query cacheScope for account changes. Client scopes are unique unless explicitly configured; configure a stable scope for SSR hydration.
- Upgrade Node/npm to the supported minimums before installation or development.
