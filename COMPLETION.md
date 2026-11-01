# Completion report: 0.3.1

Date: 2026-10-31. The implementation is complete; registry publication is recorded separately below. Historical 0.1.1 findings are retained in REVIEW.md and the 0.2.0 remediation is listed in CHANGELOG.md.

## Added

- Managed in-memory sessions: setSession, logout and immutable token-free snapshots. Changing user/tenant creates a new revision; rotating the same identity's token preserves fresh data.
- React/Vue session subscriptions, namespace-scoped cache purge, automatic cancellation of old work, stale-restore cleanup and reference-counted cache bindings. Logout clears owned query/mutation data while unrelated namespaces remain intact.
- Late and offline-paused mutateAsync calls settle without reintroducing old-account data; per-call callback variables keep the public API shape.
- Managed-session and Authorization-bearing requests use cache: no-store to bypass native HTTP cache; public unmanaged requests keep normal HTTP cache behavior. TanStack caching remains active.
- Default 15-second request deadline, request/client overrides and explicit timeoutMs: 0 opt-out. Shared token refresh has its own bounded default deadline.
- Optional coordinated refresh: concurrent 401s share a callback, requests replay once, late old-token 401s reuse the new token, logout prevents old refresh results restoring a session, and refresh failure clears local auth/cache state.
- Optional network response validation: Standard Schema v1 (including real Zod tests), parse/parseAsync objects and async validator functions. Validation precedes selection/cache success; issues survive as ApiError.cause with code validation.
- requiresAuth gates private queries/direct calls. authRetry: false supports login/refresh endpoints without recursion. Default retries exclude deterministic validation/auth/client failures and honor explicit QueryClient/query settings.
- Focused core modules, README recipes and migration notes. No schema library or extra framework runtime dependency is bundled.

## Validation

The current-runtime full check passed: lint, strict types, build/declarations, **112 tests**, all six packed JS/TS core/React/Vue consumers, zero npm audit findings and formatting. Packed browser smoke checks include query/mutation/field validation/invalidation and managed login/account switching/logout.

The final 0.3.1 minimum-runtime matrix passed all 112 tests and six packed consumers on Node 22.13 with React 18.0, Vue 3.3 and TanStack Query 5.0. Across the current/minimum matrices, 12 isolated consumers passed. Both matrices include browser-bundle login/account-switch/logout smoke checks and packed core refresh/schema checks.

## Integration boundaries

Use setSession with a server-confirmed non-secret user/tenant identity after login, and logout for local cleanup. No safe account identity can be inferred from arbitrary token changes; legacy getToken users must migrate to managed sessions for automatic isolation. Library logout does not invalidate backend cookies/refresh sessions or erase third-party persisted storage. Configure backend logout/persister cleanup in the application.

Refresh endpoints and response shapes are backend-specific, so refreshToken and schema must be configured to activate those features. A validator must return its validated value, including null where appropriate. Schemas validate network responses; use consistent keys/contracts and version external persisted cache data. Callback implementations must respect AbortSignal where possible. SSR uses fresh request-local clients/caches and matching initial user/tenant identities with stable non-secret client namespaces.

## Publication

Version 0.3.0 was published after owner 2FA approval and verified as latest with SHA-1 0d651d7aa5648eb6b20da0ec838904db4c1516b7. Version 0.3.1 was published after owner 2FA and verified as public latest. Registry SHA-1 3e9eb33b602b9cea99967b754c1391efe7d55713 matches the tested artifact. A fresh install of public latest on Node 22.13 passed shared refresh, response schemas, native HTTP-cache bypass, default timeout and logout checks, without React/Vue/query adapters/Zod installed. Old-version cleanup is complete after owner 2FA authorizations. Removed 0.1.0, 0.1.1, 0.2.0 and the superseded 0.3.0; the initial 0.0.0-stage placeholder had already been removed. Final public registry verification returned versions=["0.3.1"], latest=0.3.1 and the matching artifact SHA-1. The entire package was never unpublished, so current availability was preserved throughout.

## 0.4.0 update � 2026-11-01

Adds opt-in `responseMode: "full"` metadata and explicit `invalidateScope: "all"` for native TanStack queries. Existing body-only requests and client-owned invalidation remain the defaults. The new metadata and native React/Vue invalidation regression tests bring the suite to 125 passing tests on Node 24. The separate Vue consumer has eight passing tests and a successful production build using the candidate artifact.

Public source: https://github.com/Heshammesalam/universal-api-layer . The initial import starts the public maintenance history; it does not reconstruct earlier development commits. Check Actions for hosted CI results.

`reports/dependency-audit.json` records the package version, lockfile digest, timestamp and separate repository/full and production-selected dependency scans. Zero known advisories is not a comprehensive security audit. Publication of 0.4.0 and registry consumer verification remain pending until explicitly recorded.

Hosted CI for commit 1eed56f passed all three jobs: Linux Node 22.13/minimum dependencies, Linux Node 24/current dependencies, and Windows Node 24/current dependencies. Each job passed the 125 tests, six packed consumers, lint/types, dependency audit and formatting. Evidence: https://github.com/Heshammesalam/universal-api-layer/actions/runs/41285639857 . The first Windows run exposed checkout line-ending differences; `.gitattributes` now normalizes text to LF.

Version 0.4.0 was published after owner browser authentication and is publicly available as latest. Registry SHA-1 `f49ab13cf50b97dafa46c0cb403f849a4bf9ef82` matches the final artifact. Source is tagged `v0.4.0` at commit `c5409eae06b9b5db91874358e5f4585696c2d2f3`; npm repository metadata points to the public repository. The real Vue consumer was upgraded from its local candidate tarball to registry `^0.4.0`; all eight integration tests and its production build passed. Its separate timestamped production dependency report identifies installed SDK 0.4.0 and the consumer lockfile digest, with zero known advisories. That report belongs to the consumer and is not included in this public SDK repository. After owner npm authentication, 0.3.1 was removed. Final public registry verification confirmed that 0.4.0 is the only available version and latest, with the matching artifact SHA-1.

## 0.5.0 streaming update � 2026-11-01

Adds lazy client.stream() generators for incremental UTF-8 text and SSE events, without whole-body buffering or automatic reconnect. Shared transport retains origin restrictions, credentials, managed auth and a single 401 refresh before successful response consumption. Stream requests always use no-store. Deadlines remain active through reading; explicit abort, consumer break/return and logout/account switches close active streams. Already buffered old-session events are guarded before delivery. SSE line/event data limits prevent unbounded parser buffers; JSON decoding and per-event schemas remain application-specific.

The 27 new tests include real local HTTP incremental delivery, UTF-8 split bytes, SSE framing and metadata, buffer limits, abort/deadline cleanup, account changes, refresh and partial-connection failures without replay. The initial complete suite passed 151 tests; the additional paused-consumer cleanup regression brings the suite to 152. All 27 streaming tests passed after the final cleanup adjustment. Vue/React examples include Stop and unmount cleanup; packed TypeScript consumer checks also compile those examples. A repeated local CLI scaffold test exceeded its five-second budget under parallel process startup; its three-process integration check now has a bounded 15-second budget. Registry publication and final hosted CI results will be recorded after verification. The versioned dependency inventory has been regenerated for 0.5.0 and the current lockfile; it is not a comprehensive security audit.

Final 0.5.0 source commit 41ca34342567e7c8a0e925bce5960281c692af68 passed the complete local prepublishOnly gate: 152 tests, six packed core/React/Vue JavaScript/TypeScript consumers, strict declarations including Node-only core types and the new chat examples, lint, formatting and zero known dependency advisories. Hosted CI passed Linux Node 22.13/minimum peers, Linux Node 24/current peers, and Windows Node 24/current peers: https://github.com/Heshammesalam/universal-api-layer/actions/runs/41288897932 . Source is tagged v0.5.0. Version 0.5.0 was published after owner npm authentication and is publicly available as latest. Registry SHA-1 21b8092a9755eabd49f3e4797f4730a1cdb463df matches the final tested artifact. The actual Vue consumer was upgraded from public npm to ^0.5.0: all eight integration tests and its production build passed. Direct smoke checks against that installed package passed incremental SSE before EOF, text streaming and abort. Its separate timestamped production dependency report identifies SDK 0.5.0 and the current consumer lockfile digest, with zero known advisories; this is not a comprehensive security audit. After a renewed owner npm authentication session, 0.4.0 was removed. Final public registry verification confirmed 0.5.0 as the only available version and latest, with matching SHA-1 21b8092a9755eabd49f3e4797f4730a1cdb463df.

## 0.6.0 WebSocket update - 2026-11-01

Adds an optional framework-independent raw WebSocket client and separate React/Vue subscription adapters. Native WebSocket is used in supported browsers/Node, with a structural factory for tests/custom runtimes; ws is a development-only test server. Connections are lazy and explicitly owned. No outgoing message queue, replay, delivery acknowledgement, channel protocol or Socket.IO compatibility is implied.

The transport includes connection deadlines, bounded retry/backoff/jitter, terminal close-code handling, incoming byte/backlog and outgoing buffered-byte limits, ordered async schema validation and isolated subscribers. Session changes close active sockets, cancel ticket providers/retries and block stale messages. Origin-pinned ticket providers support backend-specific browser authentication without forwarding HTTP bearer tokens. Session-bound diagnostics are cleared on account changes, including after server closure; explicit disconnect/dispose cleans session subscriptions.

All 52 new WebSocket tests passed, including real native-client/server exchange, React Strict Mode/Vue scope cleanup, reconnect budgets, backpressure, URL origins, stale tickets/messages and diagnostic cleanup. The initial full check passed 202 tests and all six packed JS/TS consumers; two later diagnostic regressions bring the final suite to 204 tests. Packed consumers also exercise WebSocket exports, ordered messages/session closure, Node-only declaration compatibility and compilation of React/Vue chat components. Final source CI and public publication will be recorded after verification. The versioned dependency inventory was regenerated for 0.6.0 with zero known advisories; this is not a comprehensive security audit.
