# LOC Reduction With Libraries: Reassessed

## Decision summary

There are four credible wrapper-owned candidates, but they are not equally
valuable or equally safe.

| Value rank | Candidate | Conservative net production LOC saving | Risk | Verdict |
|---|---|---:|---|---|
| 1 | Zod schemas for App Settings parsing and validation | 220-340 | Medium | Do incrementally |
| 2 | TanStack Query for selected dashboard server state | 150-260 | Medium | Do selectively |
| 3 | `lru-cache` for the two generic API cache areas | 90-140 | Medium | Do only as one combined change |
| 4 | OAuth4WebAPI plus JOSE/cookie primitives | 180-300 | High | Conditional; security project, not a first LOC project |

If all four migrations succeed, the realistic total is approximately
**640-1,040 net production LOC**. The first three account for approximately
**460-740 LOC**.

These estimates are deliberately lower than the original report. They exclude
tests, documentation, lockfiles, generated files, and temporary compatibility
code. Existing behavior tests should remain; reducing test LOC is not a goal.
The value rank describes expected maintainability payoff. The implementation
order near the end starts with smaller rollback boundaries and is therefore
slightly different.

## What "functionality does not change" means

For this plan, unchanged functionality includes more than matching the happy
path:

- no changes under the upstream `rivet/` checkout;
- no changed API request/response shapes or HTTP status codes;
- no changed settings defaults, persisted JSON shape, migration behavior, or
  secret-retention rules;
- no new retries, focus refetches, polling, or background requests visible to
  users or operators;
- no changes to modal state retention, project selection, preview tabs, save
  reconciliation, or recording-search cancellation;
- no changed OAuth provider requirements, callback paths, cookie attributes,
  allowlist behavior, session invalidation policy, or post-login return paths;
- no changed cache limits, byte accounting, eviction order, invalidation
  behavior, or telemetry;
- no one-time logout during an OAuth migration unless an explicit dual-read
  compatibility period is implemented.

Each migration must preserve the current public/domain interface and replace
only generic mechanics behind it.

## Estimation method

The estimates were recalculated from the current repository:

1. Count the current production modules that contain the relevant behavior.
2. Identify only generic mechanics that the proposed library can own.
3. Keep Rivet-specific policy, compatibility behavior, adapters, and public
   interfaces in the estimate.
4. Subtract the expected schema/query/cache/auth adapter code.
5. Report a range because the exact retained error mapping and compatibility
   code cannot be known until a small pilot is compiled and tested.

The upper end is not a target. If a migration needs more adapter code than
expected, it should be stopped rather than forcing the abstraction.

## Implementation outcome (2026-07-25)

This cleanup adopted only the two low-risk, wrapper-internal mechanics
replacements below. It deliberately did **not** combine all four candidates
into one change set: the remaining two require either a UI lifecycle migration
or an authentication compatibility/security project.

| Candidate | Outcome | Measured production LOC impact | Reason |
|---|---|---:|---|
| Zod App Settings primitives | Implemented | about -26 | Eight domains now share a small, Zod-backed primitive layer while keeping their own stored/draft/fallback policy. The realized saving is modest because that policy correctly remains local. |
| `lru-cache` | Implemented | about -73 | Managed endpoint pointers, revision materializations, compiled code, and managed `require` caches now delegate only conventional LRU bookkeeping. |
| TanStack Query | Deferred after pilot | 0 | The pilot added provider/query adapter code and made the existing stateful tree/settings flows longer. No Query migration remains in the codebase. |
| OAuth4WebAPI/JOSE/cookie | Deferred | 0 | This is still valuable only as a separately reviewed security and provider-compatibility project, with legacy-session migration and production-provider staging. |

The measured numbers exclude tests, documentation, lockfiles, and the existing
domain-specific code that must remain. They supersede the original projections
for the implemented work. The `idb` addition in `packages/studio-server-web` is not an LOC
candidate: it is a direct host dependency required by the current vendored
Rivet browser import graph.

## 1. Zod for App Settings

### Current evidence

The following eight API settings modules currently total about **1,645 LOC**:

- `packages/studio-server-api/src/web-app-auth-settings.ts`
- `packages/studio-server-api/src/deployment-storage-settings.ts`
- `packages/studio-server-api/src/public-route-settings.ts`
- `packages/studio-server-api/src/runtime-limit-settings.ts`
- `packages/studio-server-api/src/trusted-host-settings.ts`
- `packages/studio-server-api/src/executor-url-override-settings.ts`
- `packages/studio-server-api/src/node-executor-proxy-settings.ts`
- `packages/studio-server-api/src/workflow-endpoint-auth-settings.ts`

Not all of those lines are replaceable. The reusable portion consists mostly
of:

- object and primitive validation;
- string trimming, length limits, and single-line checks;
- enum and boolean coercion;
- integer coercion and bounds;
- URL parsing and protocol checks;
- optional/default field handling;
- repeated stored-object validation.

`zod` is already a direct dependency of `packages/studio-server-api`, but wrapper API code
does not currently import it. Zod supports preprocessing, transforms,
refinements, unions, defaults, and inferred TypeScript types:
[Zod documentation](https://zod.dev/api).

### What must remain custom

- `VersionedSettingsRepository`;
- atomic writes and file permissions;
- optimistic revision conflicts;
- schema-version migrations;
- request-scoped immutable snapshots;
- cross-process settings refresh;
- public/private response projections;
- preserving an existing secret when a draft sends an empty secret;
- deliberate fail-closed recovery for security-sensitive settings;
- domain-specific cross-field requirements such as managed storage requiring
  both database and object-storage configuration.

The repository is not a candidate for `conf`, `lowdb`, or another generic
settings store.

### Conservative LOC estimate

- Current settings-domain surface: about 1,645 LOC.
- Plausibly replaceable validation/normalization mechanics: about 700-900 LOC.
- Expected schemas, shared refinements, compatibility transforms, and error
  adapter: about 450-600 LOC.
- **Expected net saving: 220-340 LOC.**

### Specific risks

1. **Missing, empty, and null values can diverge.** Current code deliberately
   distinguishes an omitted field from an empty string in partial updates.
2. **Secret updates can be destructive.** A naive schema could turn an empty
   secret field into "clear the saved secret" instead of "keep it."
3. **Coercion can broaden accepted input.** Generic coercion may accept values
   that current code rejects, or reject currently accepted string booleans and
   numeric strings.
4. **Error messages can change.** Raw Zod issue text must not leak into the API
   if callers/tests depend on the existing operator-facing messages.
5. **Cross-field validation can run at the wrong time.** A partial draft must
   first merge with the previous snapshot before active-mode requirements are
   checked.
6. **Stored-file parsing and request-draft parsing are not identical.** Stored
   settings include metadata and must continue to honor migrations and
   fail-closed behavior.
7. **Unknown-key handling can change.** Whether legacy or future fields are
   retained, stripped, or rejected must be chosen per current behavior rather
   than by a global Zod default.

### Required guardrails

- Keep each module's exported functions and result types unchanged.
- Introduce shared primitive schemas/refinements, but keep separate stored and
  draft schemas where their behavior differs.
- Map Zod issues to the existing `badRequest(...)` messages.
- Add table-driven equivalence tests for omitted, empty, null, malformed, and
  boundary values before replacing each normalizer.
- Convert `runtime-limit-settings.ts` first. Stop after that pilot and compare
  real before/after production LOC before approving the remaining modules.

### Verdict

**Worth doing incrementally.** It reuses an existing direct dependency and
removes a broad category of repetitive code without replacing the repository
or persistence model.

## 2. TanStack Query for selected dashboard server state

### Current evidence

Several dashboard hooks manually implement asynchronous server-state
lifecycle:

- `useRunRecordingsController.ts` is 431 LOC and combines server pages with
  local filter/search state.
- `useWorkflowLibraryTree.ts` is 128 LOC and manually rejects stale refresh
  responses.
- `useSettingsFormResource.ts` is 151 LOC and owns revision-aware load/save
  state.
- `useProjectSettingsActions.ts` is 461 LOC, although most of it is
  project-publication policy and local draft state.
- Published-version history and runtime-library screens also maintain manual
  loading, error, refresh, and mutation state.

`@tanstack/react-query` is already a direct dependency of `packages/studio-server-web`
(currently locked to the v5 line), but wrapper dashboard code does not use it.
TanStack Query is specifically designed for fetching, caching, deduplicating,
invalidating, and updating server state:
[TanStack Query overview](https://tanstack.com/query/latest/docs/framework/react/overview).

### What it should own

- workflow-tree query results;
- recording workflow summaries and ordinary paged run results;
- settings resource reads;
- published-version list reads;
- mutation pending/error state;
- targeted query invalidation after successful mutations;
- request cancellation through the query function's `AbortSignal`.

### What must remain local/custom

- selected project and selected recording workflow;
- expanded folders;
- preview-tab lifecycle and editor bridge state;
- endpoint, web-app, OAuth, and settings form drafts;
- explicit settings baselines and scoped revert behavior;
- recording filter input fields;
- the cursor-driven full-text input scan, its accumulated matches, and the
  explicit Stop search behavior;
- project-tree optimistic mutations and path retargeting;
- modal hide-versus-explicit-close reset behavior;
- runtime-library SSE/job-log state.

### Conservative LOC estimate

- Surveyed hooks contain well over 1,000 LOC, but most is domain/client state.
- Replaceable fetch/loading/error/cancellation/invalidation mechanics are
  approximately 300-450 LOC.
- Query keys, provider setup, adapters, explicit defaults, and domain glue will
  require approximately 140-220 LOC.
- **Expected net saving: 150-260 LOC.**

### Specific risks

1. **TanStack defaults change behavior.** Retries, refetch-on-focus,
   refetch-on-reconnect, and stale-time behavior can create requests that do
   not happen today.
2. **Cached data can outlive the intended modal session.** Run recordings must
   still reset only on explicit close/reset, while hide-for-replay must retain
   its current state.
3. **Project saves have deliberate reconciliation timing.**
   `useWorkflowLibraryTree` currently delays its post-save refresh and keeps
   the visible tree on background-refresh failure.
4. **Input filtering is not a normal infinite query.** It can return empty
   non-terminal windows, has a scan cursor rather than a display page, appends
   unique matches, and supports explicit cancellation.
5. **Mutation invalidation can cause UI flicker.** Project publication,
   rename/move, preview replacement, and save flows already have carefully
   ordered local updates.
6. **Settings conflicts need their current baseline behavior.** A `409`
   refreshes only the saved baseline and must not discard the user's current
   draft.
7. **Query-key mistakes can cross-contaminate projects or filters.** Every
   project path, workflow id, route kind, page, and applied filter that affects
   a response must be represented in the key.

### Required guardrails

- Use a wrapper-owned `QueryClient` with compatibility defaults:
  `retry: false`, `refetchOnWindowFocus: false`, and
  `refetchOnReconnect: false`, unless a specific existing flow already does
  otherwise.
- Prefer explicit invalidation over time-based freshness. For resources that
  currently refresh only on explicit events, use an infinite `staleTime` or
  otherwise disable refetch-on-mount as appropriate.
- Match each screen's current reset boundary explicitly; use local state or
  targeted query removal rather than allowing cache garbage-collection
  defaults to decide when a user's session state disappears.
- Keep `workflowApi.ts` as the transport boundary.
- Start with read-only published-version lists or ordinary recording pages.
- Do not migrate preview/editor/project-move state into the query cache.
- Preserve old data during background reconciliation where the current UI
  does so.
- Keep the existing Playwright behavior tests as acceptance tests.

### Verdict

**Worth doing selectively, not as a dashboard rewrite.** A blanket conversion
would move client state into the wrong abstraction and could increase code.

## 3. `lru-cache` for generic process-local LRU mechanics

### Current evidence

Two API areas manually implement conventional bounded LRU mechanics:

1. `packages/studio-server-api/src/routes/workflows/managed/execution-cache.ts`
   - item-count LRU for endpoint pointers;
   - byte-budget LRU for revision materializations.
2. `packages/studio-server-api/src/runtime-libraries/managed-code-runner.ts`
   - count-bounded compiled-function LRU;
   - count-bounded managed `require` cache.

`lru-cache` supports item limits, byte-size limits, custom size calculation,
entry-size limits, access-order promotion, and disposal callbacks:
[official `lru-cache` documentation](https://github.com/isaacs/node-lru-cache#readme).

The package is currently a direct dependency of `packages/studio-server-web`, not
`packages/studio-server-api`. The API must add its own direct dependency; relying on a
transitive or sibling-package installation would be incorrect.

### What must remain custom

- workflow-id to endpoint-cache-key reverse indexing;
- workflow-scoped and global invalidation APIs;
- exact UTF-8 byte measurement for project and dataset contents;
- rejecting a materialization larger than the per-entry limit;
- the boolean return from `setRevisionMaterialization`;
- cache-size telemetry and test controls;
- runtime-library release snapshot keys;
- clearing Node's `require.cache` when the active release changes;
- managed-require group tracking and node-modules path tracking;
- in-flight load deduplication, which is not LRU behavior.

The filesystem execution cache is explicitly out of scope because most of its
code implements filesystem freshness and version fencing rather than generic
eviction.

### Conservative LOC estimate

- Current generic LRU bookkeeping across the two files: about 190-240 LOC.
- Expected adapters, reverse-index callbacks, telemetry/test seams, and release
  invalidation glue: about 90-130 LOC.
- **Expected net saving: 90-140 LOC.**

Replacing only `managed/execution-cache.ts` would likely save just **35-60
LOC**, which is not enough to justify a new API dependency. The candidate is
worth doing only if both generic LRU implementations can use the same direct
dependency without compromising their contracts.

### Specific risks

1. **Eviction callbacks can corrupt the reverse index.** Replacement,
   explicit deletion, eviction, and clear operations have different disposal
   reasons.
2. **Byte accounting can change.** `maxSize` must use the current UTF-8 byte
   calculation, including datasets, and oversized entries must still remove an
   existing entry with the same revision id.
3. **Zero and test-adjusted limits can behave differently.** The code-runner
   tests can change the cache limit at runtime.
4. **Compiled-function cache metrics can drift.** Cache hit/miss counts and
   reported cache size are externally used for performance diagnosis.
5. **Managed `require` invalidation is security/correctness sensitive.** A new
   active runtime-library release must never reuse the previous release's
   require function or Node module cache.
6. **The library may retain references differently during replacement.** This
   matters for compiled functions and project contents under memory pressure.

### Required guardrails

- Add explicit tests for endpoint-pointer LRU order, replacement, clear, and
  reverse-index cleanup before migration.
- Add exact byte-boundary and same-key oversize replacement tests.
- Run the existing managed code-runner cache/telemetry/release-rotation tests
  unchanged.
- Benchmark repeated Code/Expression execution before and after; this change
  must not trade fewer LOC for slower hot-path access.

### Verdict

**Worth doing as one narrowly scoped cache-mechanics change.** Do not spread
the library into domain-specific freshness caches.

## 4. OAuth4WebAPI plus JOSE/cookie primitives

### Current evidence

The authentication implementation includes:

- `packages/studio-server-api/src/web-app-oauth.ts`: 686 LOC;
- `packages/studio-server-api/src/server-ui-auth.ts`: 612 LOC;
- `packages/studio-server-api/src/routes/ui-auth.ts`: 397 LOC.

The two auth services duplicate generic mechanics such as:

- HMAC-signed state/session envelopes;
- constant-time signature checks;
- cookie parsing and serialization;
- authorization URL construction;
- authorization-code token exchange;
- Basic versus request-body client authentication;
- OAuth error normalization;
- profile requests and JSON response handling.

[`oauth4webapi`](https://github.com/panva/oauth4webapi) implements low-level
OAuth 2/OpenID Connect protocol routines, including authorization-code flows,
PKCE, client authentication, and response processing.
[`jose`](https://github.com/panva/jose) implements standards-based JWS/JWT/JWE
signing, verification, and encryption.

Neither is currently a direct wrapper API dependency. `jose` and `cookie`
appear transitively in the API lockfile, but importing transitive dependencies
would be unsupported; any adopted library must be declared directly.

### What must remain custom

- `none`, key, and OAuth mode selection;
- separate server-UI administrator and per-web-app email allowlists;
- arbitrary configured profile URL and dot-path email claim extraction;
- dummy local OAuth provider;
- trusted-host bypass;
- trusted forwarded-header/origin policy;
- callback URL derivation from dynamic public route settings;
- local-only return-path sanitization;
- `prompt=select_account` logout/relogin behavior;
- settings-version invalidation after provider, secret, scope, claim, mode, or
  session-policy changes;
- stable non-PII web-app owner keys used by WebSocket run ownership;
- current operator-facing failure codes and pages.

### Conservative LOC estimate

- The two auth services contain about 1,298 LOC, but most policy remains.
- Shared protocol, envelope, cookie, and duplicated response mechanics account
  for approximately 350-500 replaceable LOC.
- A compatibility adapter, policy callbacks, direct dependency wiring, and
  dual-read session migration will require approximately 150-250 LOC.
- **Expected net saving: 180-300 LOC.**

The 397-line UI auth route is mostly HTML and route policy; it should not be
counted as library-replaceable.

### Specific risks

1. **The product supports generic OAuth, not only OIDC.** Requiring discovery,
   issuer metadata, ID tokens, or OIDC `sub` semantics would break supported
   providers.
2. **Stricter token-response processing can reject a provider accepted today.**
   The current contract requires a successful JSON response containing a
   non-empty `access_token`; additional mandatory fields would change behavior.
3. **Enabling PKCE changes authorization and token requests.** It should not be
   made mandatory until every supported/configured provider has been tested.
4. **Changing the cookie format logs users out.** To meet the no-functionality-
   change requirement, the migration needs legacy-cookie read support for at
   least the maximum existing session TTL while writing only the new format.
5. **Cookie attributes can drift.** Names, `Path=/`, `HttpOnly`,
   `SameSite=Lax`, conditional `Secure`, and expiry behavior must remain exact.
6. **State binding can weaken or become incompatible.** Nonce, return path,
   settings version, expiry, and the state cookie must remain correlated.
7. **OAuth errors can map differently.** Provider denial, stale state, invalid
   profile claims, disabled OAuth, and changed settings currently lead to
   specific redirect/error behavior.
8. **The two auth surfaces are not interchangeable.** Server UI access and
   per-app access have different allowlists and return destinations.
9. **Principal identity affects live WebSocket actions.** Changing the owner
   key derivation could make reconnect/cancel authorization fail for existing
   runs.
10. **Security-sensitive custom code may merely move into adapters.** If the
    pilot does not remove enough protocol code, the dependency is not earning
    its cost.

### Required guardrails

- First extract a shared internal OAuth flow interface while preserving the
  current implementation and tests.
- Add provider-contract fixtures for the exact currently supported token and
  profile response shapes.
- Introduce OAuth4WebAPI behind that interface without requiring OIDC discovery
  or new provider fields.
- Treat PKCE as a separately reviewed compatibility/security change, not as an
  incidental LOC-reduction detail.
- If JOSE changes cookie serialization, implement legacy-read/new-write
  migration and test it with rotated and unchanged settings.
- Validate against the real production provider in staging in addition to the
  dummy provider.
- Preserve all existing OAuth and UI-auth tests as black-box tests.

### Verdict

**Conditionally worth doing for security ownership and standards maintenance,
not for LOC reduction alone.** It should be last. Abort the migration if the
generic-provider compatibility layer leaves less than roughly 150 net LOC
removed or requires broader provider assumptions.

## Candidates rejected after reassessment

### `jsonpath-plus`

Do not adopt it. The custom path parser is only about 77 lines inside the much
larger recording-input filter, while the library documents that it is not
actively maintained. Its broader JSONPath semantics would also change the
accepted filter language:
[JSONPath Plus notice](https://jsonpath-plus.github.io/JSONPath/docs/ts/index.html).

### Kysely or a full ORM

Do not adopt it as an LOC project. Kysely is a credible type-safe SQL builder,
but managed workflow queries encode publication locking, revision consistency,
stored procedures, transaction hooks, cache invalidation, and PostgreSQL-
specific behavior. Fluent query-builder code may be as long as the current
SQL, while migration risk is high:
[Kysely documentation](https://www.kysely.dev/).

It may be reconsidered later for type safety or migration discipline, but that
is a different goal.

### Generic settings stores

Do not replace `VersionedSettingsRepository` with `conf`, `lowdb`, or similar.
The current repository owns request snapshots, optimistic revision conflicts,
atomic writes, migrations, cross-process polling, and Kubernetes/shared-volume
behavior.

### Queue libraries

Do not replace the recordings persistence queue merely to save LOC. Its
`setImmediate` start, post-response serialization behavior, queue-full policy,
cleanup scheduling, and reset semantics are deliberate and regression-tested.

### React Hook Form

Do not add it solely for LOC reduction. App Settings uses scoped saves,
server-side validation, secret placeholders, per-tab unsaved state, and
revision-conflict baseline refresh. A second form abstraction would save little
unless the UI validation/product model is intentionally redesigned.

### Editor bridge RPC libraries

Do not replace the bridge with a generic RPC layer. The bridge is already
decomposed, and source validation, command guards, FIFO behavior,
acknowledgements, preview promotion, and project path retargeting are product
contracts.

### `execa`

Do not add it just to replace `packages/studio-server-api/src/utils/exec.ts`. Windows command
shim resolution, proxy-bootstrap `NODE_OPTIONS` cleanup, streaming events,
output limits, and process handles would still require adapters; expected net
savings are too small.

## Recommended implementation order

1. **Zod pilot:** convert runtime limits only and measure the actual diff.
2. **Zod remainder:** continue one settings domain per change only while the
   measured savings remain within the estimate.
3. **LRU consolidation:** migrate both generic API LRU areas together.
4. **TanStack Query pilot:** migrate one read-only list, then ordinary recording
   pagination, before any project mutation flow.
5. **OAuth modernization:** perform as a separately reviewed security project
   with real-provider staging.

Do not combine these candidates in one pull request. Each has a different
rollback boundary and different proof requirements.

## Verification requirements

For every candidate:

- record production LOC before and after, excluding tests/lockfiles/generated
  files;
- run existing tests unchanged before deleting old implementation code;
- add equivalence tests for every newly identified edge case;
- run `yarn studio-server:test`;
- run `yarn studio-server:verify:repo-structure`;
- run `git diff --check`.

Additional proof:

- **Zod:** focused App Settings API tests, stored-file corruption tests,
  partial-update tests, and secret-preservation tests.
- **TanStack Query:** `yarn studio-server:verify:web-pure` plus Playwright coverage for the
  affected modal/tree behavior.
- **LRU:** managed execution-cache tests, managed code-runner tests, and a
  before/after hot-path benchmark.
- **OAuth:** full web-app OAuth and UI-auth tests, proxy/forwarded-origin tests,
  legacy-cookie compatibility tests, and a staging login/logout/account-switch
  check against the production provider.
