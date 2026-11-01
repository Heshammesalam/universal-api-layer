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
