> Historical review of 0.1.1. The 0.2.0 release addresses the findings below; see CHANGELOG.md and COMPLETION.md for current validation. The original observations are retained for traceability.

# Package review: universal-api-layer 0.1.1

Reviewed 2026-10-31. Scope: implementation, adapters, CLI, package metadata, existing tests, isolated installation and dependency audit. This review changes no runtime code and publishes nothing.

Verdict: a useful early release with a sound core/adapter separation, but not yet a mature production-ready library. Passing the current suite does not cover several reproduced edge cases.

## Findings, ordered by priority

### 1. P1 ? Sensitive request headers are serialized into query keys

Location: `src/core/index.ts:179` and `:208`; both adapters call this function.

`queryIdentity` copies every per-query header, including Authorization and API keys, into the cache key. A query configured with `{ headers: { Authorization: 'Bearer DEMO_SECRET' } }` produced a dehydrated cache containing `DEMO_SECRET` in plain text. This affects explicitly supplied query headers, not tokens added only by `getToken`. Persisted caches, query diagnostics and SSR dehydration can expose the copied credential.

Fix: exclude credentials from public cache keys; use a non-secret account/tenant cache scope and a documented allowlist for representation-varying headers. Add dehydration/persistence regression checks.

### 2. P1 ? A shared QueryClient does not isolate different API clients

Location: `src/core/index.ts:179`, `src/react/index.tsx:44`, `src/vue/index.ts:63`.

Identity includes the relative request URL but no client/base URL/cache scope. Using one QueryClient with two API clients for different tenants and the same key/relative URL returned tenant A's cached response for tenant B when the data was fresh. With stale data, the wrong cached value can still appear before a refetch. This requires cache sharing; separate QueryClients avoid it. The README's logout-clear guidance is useful but does not isolate simultaneous clients.

Fix: introduce a stable non-secret cache scope, preserve prefix invalidation, document authentication transitions, and test shared-cache isolation in both adapters.

### 3. P2 ? Cancellation and timeout do not settle a pending token lookup

Location: `src/core/index.ts:65-80`.

The timer aborts the fetch controller, but execution first awaits `getToken()`. With `timeoutMs: 5` and an unresolved token promise, the request was still pending after 40ms. External cancellation has the same limitation. It only rejects once the token promise settles and execution reaches fetch.

Fix: make the caller-facing request reject promptly on abort/timeout during authentication too. Consider a signal-aware token callback and handle the underlying promise without unhandled rejections. Add tests for never-settling and delayed token providers.

### 4. P2 ? Successful empty responses fail in both query adapters

Location: `src/core/index.ts:118`, `src/react/index.tsx:50`, `src/vue/index.ts:69`.

The core returns undefined for an empty/204 response. TanStack Query rejects undefined query data. Reproduction using the shared query engine failed with `Error: ["empty"] data is undefined`, despite HTTP 204. This also breaks the claim that query errors are always ApiError instances.

Fix: define an explicit empty-response contract, such as null, reconcile its TypeScript types and selection behavior, and test 204/empty 200 responses through both adapters. See [TanStack query functions](https://tanstack.com/query/latest/docs/framework/react/guides/query-functions).

### 5. P2 ? Default npm installation still fails

Location: `package.json:36`, `scripts/consumers.mjs:72`.

A fresh installation of the packed 0.1.1 package with npm 11.6.2 and no framework dependencies reproduced ERESOLVE: the optional Vue Query compatibility tree selected Vue 2, conflicting with the Vue 3 peer constraint. Existing consumer checks pass only with `--legacy-peer-deps`, which bypasses peer validation. The workaround is documented, but it is not evidence that default installation or peer compatibility works.

Fix: investigate a supported peer/package-manager strategy and validate an ordinary installation in CI. Keep any workaround explicit and test framework/query version compatibility separately. This is a dependency-resolution issue, not evidence that the core imports a framework.

### 6. P2 ? Credentials are forwarded to arbitrary absolute HTTP URLs

Location: `src/core/index.ts:79-98`.

With an authenticated client based at `https://trusted.example/api`, calling `request('https://other.example/collect')` passed the configured Bearer token to the other host in the fetch options. Actual network transmission depends on the runtime and browser CORS policy. This requires the application to pass a different-origin URL; the README already advises using trusted URLs. Nonetheless, an origin-scoped default would be safer for URLs supplied by users, API responses or dynamic mutation configuration.

Fix: restrict credential forwarding to approved origins by default and require explicit opt-in for cross-origin authenticated requests. Test both allowed and disallowed origins.

### 7. P2 ? Development dependency advisories need remediation

`npm audit` reported 9 affected packages: 2 critical, 6 moderate and 1 low. Critical severity is attributed to tinypool and propagated to Vitest; it does not mean two independent critical bugs in this library. `npm audit --omit=dev` reported zero findings in this installation. These results are point-in-time and do not prove every optional peer configuration is safe.

The tinypool advisories require additional conditions, such as prototype pollution; this review did not demonstrate an exploitable path in the library or current test run. Upgrade compatible development tools and re-run checks rather than applying forced upgrades blindly.

References: [worker options advisory](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3), [run options advisory](https://github.com/advisories/GHSA-85c8-ppgw-ccpr).

### 8. P2 ? Declared Node minimum exceeds actual API compatibility

Location: `package.json:80`, `src/core/index.ts:108`, `src/cli/index.ts:83`.

The package claims Node >=18 but uses URLSearchParams.size, introduced in Node 18.16.0, and recursive readdir, introduced in Node 18.17.0. In older Node 18 releases the size property is absent, so the conditional used to append query parameters is false. Runtime reproduction on those older Node versions was not performed; this finding follows from the documented API versions.

Fix: raise the engine floor to the actual supported version or provide compatible implementations. Test the declared minimum rather than compiling exclusively against Node 24 types. See [Node URL API](https://nodejs.org/api/url.html#urlsearchparamssize) and [Node filesystem API](https://nodejs.org/api/fs.html#fspromisesreaddirpath-options).

## Other improvements

- Malformed successful JSON currently returns a string cast to T. Decide and document whether malformed JSON should produce a parsing error rather than reach `select` as an unexpected type.
- User callbacks such as select/onSuccess can throw ordinary Errors while hook types promise ApiError. Revisit the error contract, keeping server errors distinct from application callback failures.
- Split long adapter integration scenarios into focused behavioral tests. Cover default provider stability, app isolation, client switching, reactive Vue refs/computed/getters, empty responses, authentication failures, malformed JSON, FormData and network errors.
- Add automated CI/release checks across declared framework/Node versions. prepack currently builds but does not require successful tests or consumer checks before publication.
- Add checked-in formatting/lint configuration, release notes and real repository/homepage/issue links when available. These improve maintainability; they are secondary to correctness and installation.
- CLI testing depends on pre-existing dist output; make a clean-checkout test workflow build it explicitly. The language detector is primarily oriented around src and does not inspect projects laid out only at the root.
- README and completion notes still include historical statements about nothing having been published; align them with the released state.

## Positive findings and verification

The transport has no framework imports; framework lifecycle logic is separated; bundle externals and optional peers are explicit. Request params participate in query identity, Vue uses computed configuration, React owns a stable default QueryClient, and prefix invalidation is preserved. JS/TS templates, examples and packed consumer checks are useful foundations.

Re-ran `npm run typecheck` and `npm test`: passed, all 15 tests. Reproduced findings 1-6 against the built package/core and shared TanStack query engine with synthetic tokens and stub fetch functions; no real credentials were transmitted. The timeout probe used an unresolved token provider; the empty-response probe used HTTP 204; the isolation probe used two clients and one cache with staleTime Infinity. The fresh default npm install failed as described. Existing packed-consumer success with the documented workaround was established previously; the full matrix was not rerun in this review.

Recommended order: credential/cache isolation, timeout and empty-response contracts, installation strategy and regression coverage, development dependency updates, then CI/release and documentation polish. Do not describe the release as fully hardened until these are addressed and verified.
