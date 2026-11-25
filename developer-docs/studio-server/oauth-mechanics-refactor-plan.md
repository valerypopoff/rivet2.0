# Shared OAuth mechanics refactor plan

Status: implemented and locally verified against `develop` baseline
`aa9b7d144111447d7680235fbf0c9912a1286b44`. Source/prebuilt characterization,
consumer, browser and repository results from 2026-11-23/24 are recorded below.
Hosted verification and deployment have not been performed for this refactor.
The design and ordered steps below
remain the preservation/acceptance contract.

## Objective and scope

Give the server UI and visitor web apps one implementation of their identical
OAuth mechanics while preserving each surface's current authentication policy,
settings context, read timing and observable behavior. A provider compatibility
change should have one implementation owner, and a shared fix should be exercised
through both existing entrypoints.

The source owners are:

- [`server-ui-auth.ts`](../../packages/studio-server-api/src/server-ui-auth.ts):
  server UI auth mode, provider/configuration checks, signing-secret selection,
  settings fingerprint, state/session policy, administrator allowlist and public
  helper exports.
- [`web-app-oauth.ts`](../../packages/studio-server-api/src/web-app-oauth.ts):
  visitor configuration, state/session policy, web-app OAuth router, account
  selection, callback errors and session-owner key.
- [`routes/ui-auth.ts`](../../packages/studio-server-api/src/routes/ui-auth.ts):
  server UI HTTP routes, trusted-proxy admission, prompt rendering and responses.
- [`ui-auth-utils.ts`](../../packages/studio-server-api/src/ui-auth-utils.ts):
  existing shared local-return-path handling. Reuse it unchanged.

The first two files contain approximately 600 and 671 lines at this baseline.
The extraction is justified by repeated signing, cookie and provider-request
logic, rather than by a target file length or promised performance improvement.

Keep application routes, public exports, auth modes, defaults, settings schemas,
stored settings, proxy configuration and deployment behavior unchanged. No new
dependency, worker, cache, persistent resource or environment variable is needed.
Recording formats and execution paths are outside the change. The hosted
recording-storage transition-wrapper repair remains separate functional work.

Do not add retries, provider deadlines, PKCE, token introspection, new audience
claims, stricter signed-payload validation or a different OAuth library as part
of this extraction. A behavior correction discovered during characterization
needs its own explicit scope and regression, rather than an incidental change
inside the move.

## Current contract to preserve

The [access and routing guide](access-and-routing.md) owns the product contract.
The baseline source determines details of this extraction, including differences
that a combined OAuth service could accidentally erase.

| Boundary | Server UI | Visitor web app | Preservation requirement |
| --- | --- | --- | --- |
| Auth mode | Deployment env selects `none`, `key` or `oauth`, with the existing legacy key-mode fallback. | Saved `web-app-auth` settings select the web-app mode. | Keep both mode readers and their current defaults. |
| Signing secret | `sessionSecret`, then `clientSecret`, then `RIVET_KEY`. | `sessionSecret`, then `clientSecret`; no `RIVET_KEY` fallback. | Secret selection and the distinct configuration errors stay with their surface. |
| Settings fingerprint | Includes UI mode, provider details, development policy for dummy auth, secret fingerprints, TTL and sorted administrator emails. | Includes visitor mode, provider details, development policy for dummy auth, client-secret fingerprint, callback URL and TTL. | Preserve each fingerprint's fields, values and JSON property order exactly. |
| Cookies | `rivet_ui_oauth_state` and `rivet_ui_oauth_session`; UI logout also clears `rivet_ui_token`. | `rivet_web_app_oauth_state` and `rivet_web_app_oauth_session`. | Preserve names, values, attributes, ordering and clearing behavior. |
| State comparison | Compares nonce, `returnTo`, state/cookie settings versions and current settings version. | Compares nonce and settings versions; its callback does not compare the two `returnTo` values. | Keep the two existing checks in their original owners. |
| Invalid-state return target | Derived from validated UI state; otherwise the existing sanitized fallback. | Can use the signed state/cookie fallback target before state validation, including provider-error responses. | Preserve redirect targets and error precedence for each surface. |
| Callback URL | Browser-facing `/__rivet_auth/oauth/callback` derived from the UI request origin. | Saved callback override, or the published-app base path plus `/auth/callback`; saved override is checked for HTTPS/localhost. | Resolve each callback at its existing call site and time. |
| Forwarded headers | UI helpers use the forwarded-header values; UI OAuth routes enforce trusted-proxy admission. | Visitor helpers check proxy trust before using forwarded host/protocol. | Keep trust checks and origin/security calculations local; no shared origin resolver. |
| State lifetime | Ten minutes; 24 random bytes encoded as base64url for the nonce. | Same. | Keep random generation, clock reads and payload construction in the current flow. |
| Session lifetime | Saved TTL or the 24-hour fallback. | `Math.max(60, saved TTL or the 24-hour fallback)`. | Keep the current expressions, even when normal settings validation makes their difference unreachable. |
| User admission | Nonempty current administrator email list must contain the normalized user. | Existing per-app email allowlist is checked by web-app consumers. | Keep deny-empty behavior, trusted-client rules and the two admission policies. |
| Return paths and account selection | Existing UI sanitizer and callback error mapping. | Additional removal of stale auth query parameters; optional `select_account` behavior. | Keep sanitization, prompt handling and URL query ordering with each surface. |
| Dummy provider | Existing deployment opt-in, verified development-client checks and dummy-code handling. | Existing visitor-mode/provider and development-client checks. | Leave dummy branches and their messages in the original modules. |
| Error translation | Includes the UI-specific forbidden mapping and current redirect-versus-500 handling. | Includes its `not enabled` mapping to `oauth_state` and current redirect-versus-500 handling. | Preserve status, messages, redirect codes, cache headers and cookie clearing. |
| Session ownership | UI session read/admission and public session projection. | Existing `web-app-owner:` HMAC key used for action/Socket ownership. | Keep the owner-key algorithm and its secret lookup in the applicable settings context. |

The signed envelope remains `base64url(JSON.stringify(payload)).HMAC`, using
SHA-256 and the current last-dot parsing. Verification still returns `null` for
the same invalid/missing values and signing-secret failures. Expiry remains
`Number(parsed.expiresAt) > Date.now()`; do not add coercion changes, finite-number
checks, a payload schema or a different exception boundary during the move.

Cookie parsing still accepts Express `Request` and Node `IncomingMessage`, joins
array headers as today, finds the first matching name and preserves values
containing `=`. Cookie serialization must retain the exact current punctuation,
field order and `Secure` suffix representation: HTTPS helpers currently produce
the substring `; ; Secure` because the suffix already starts with a semicolon.
Characterize and preserve it. The separate key-login route's cookie writer stays
unchanged; sharing OAuth mechanics does not require changing that serializer.

## Target ownership and helper interfaces

The implementation adds two internal modules under
`packages/studio-server-api/src/`. Both existing auth modules delegate to them.

| Module | Owns | Inputs and exclusions |
| --- | --- | --- |
| `oauth-browser-state.ts` | Signed-payload encoding/verification and cookie parsing/serialization. These are the small synchronous browser-state mechanics shared by both surfaces. | Receives a signing-secret resolver and an already calculated cookie-security suffix. Does not read settings/env, register routes or decide proxy trust, cookie names, TTL or admission. |
| `oauth-provider-client.ts` | External code/token HTTP exchange, profile HTTP/JSON reading, dotted claim lookup and email extraction. | Receives the current operation's external-provider fields and callback URL. Does not read settings, choose an auth mode, handle dummy auth or authorize a user. |

Keep the cookie helpers with the signed-payload primitives; a third source module
and a separate cookie test file add little ownership value for this small body.
The provider module remains separate because it owns HTTP/response mechanics.

Use direct functions with narrow arguments. Keep the graph directed from both
existing auth modules to the helpers; helpers never import an auth module or
register routes. Do not construct a combined sign-in coordinator or an options
object containing surface flags. Each original module keeps readable local
wrappers for its policy and preserves its existing export names and signatures.

The signed-payload interface should have this shape:

```ts
type ExpiringOAuthPayload = {
  expiresAt: number;
  [key: string]: unknown;
};

signOAuthPayload(
  value: ExpiringOAuthPayload,
  getSigningSecret: () => string,
): string;

readSignedOAuthPayload<T extends ExpiringOAuthPayload>(
  value: string | null,
  getSigningSecret: () => string,
): T | null;
```

The resolver is necessary to preserve lookup order and failure handling. Signing
encodes JSON before resolving the secret. Reading rejects an absent value or an
invalid last-dot delimiter before resolving the secret, and calls it inside the same
`try` that currently converts secret/HMAC failures to `null`. The clock stays at
the current verification point. Malformed JSON and invalid signatures still
require the secret/HMAC step before rejection, as today. Do not evaluate the
secret eagerly or cache it in a module-level instance.

For cookies, use `readOAuthCookie(request, name)`,
and `createOAuthCookie(name, value, maxAgeSeconds, securitySuffix)` in that same
module. Clearing can call the same serializer with an empty value and age zero;
verify equality with both old clear-cookie writers before replacing them.
Keep the exported UI `readCookie`,
`createCookie` and `clearCookie` entrypoints as wrappers/re-exports as appropriate
to their existing signatures. UI cookie wrappers still calculate their suffix
with the UI helper; visitor wrappers still use the visitor helper.

Keep the existing two awaits in each external token/profile wrapper: first the
HTTP response, then its parsed/validated JSON. The provider module exposes these
small operations rather than adding another asynchronous sign-in layer:

1. `requestOAuthToken(config, code, callbackUrl): Promise<globalThis.Response>`. `config`
   contains only token URL, client ID, client secret and the existing
   `body | basic` client-authentication method. Move form/header construction and
   return the original `fetch` promise directly from a non-`async` function.
2. `requestOAuthProfile(userUrl, accessToken): Promise<globalThis.Response>`. Move the bearer
   header and return the original profile `fetch` promise directly, also without
   an `async` wrapper.
3. `readOAuthProviderJsonResponse(response, description)` returns
   `Promise<Record<string, unknown>>`. Move the existing JSON reader and its exact
   validation/errors.
   The descriptions remain `token exchange` and `profile request`.
4. `readOAuthAccessToken(payload): string`. Move the existing nonempty-string
   check and error message, without trimming token values.
5. `readOAuthProfileEmail(profile, claimPath): string`. Move dotted claim
   traversal, the existing missing-claim error and trim/lowercase normalization.

For example, the existing external profile branch becomes:

```ts
const response = await requestOAuthProfile(config.userUrl, accessToken);
const profile = await readOAuthProviderJsonResponse(response, 'profile request');
// Keep the current surface's debug setting read and log here.
return readOAuthProfileEmail(profile, config.emailClaim);
```

Both wrappers keep configuration selection and dummy decoding. After profile
JSON settles, each reads the current `debugLogProfile` setting and emits its
existing prefix before extracting the claim using the configuration selected
when that profile operation started. This retains the original await positions
and logging order without transport callbacks or a whole-callback settings snapshot.

## Settings context and call ordering

The original plan incorrectly equated repeated synchronous reads with a fresh
global settings revision after every await. The full application already captures
one revision per HTTP request. Preserve both that consistency boundary and the
existing escape from it for long-lived authorization.

| Context | Source evidence and required behavior |
| --- | --- |
| Production HTTP routes | `createApiApp` installs `captureAppSettingsSnapshot` before it mounts the visitor OAuth router and before calling `mountControlPlaneRoutes`, which mounts the UI router. Both callbacks therefore run inside the request snapshot. The earlier source position of the UI mount is inside a function, not earlier runtime registration. |
| Synchronous settings reads | `webAppAuthSettingsRepository` participates in capture. `readWebAppAuthSettingsSync()` uses `VersionedSettingsRepository.readSync()`, which returns the request's stored snapshot when present. Preserve every lookup call and its ambient context; repeated calls need not observe another request's update. |
| Lightweight tests/direct helpers | The current `withUiAuthServer` and `withOAuthCallbackServer` fixtures mount routers without capture middleware. Their reads can observe repository updates between provider responses. Retain this direct-call behavior, but do not use it to certify production request consistency. |
| Separate requests | Start and callback are separate requests. A callback opened after a settings change captures the newer revision and applies the existing state/session fingerprint checks. A later protected request also uses its own snapshot. |
| Long-lived access | `watchAuthorization` and web-app Socket access checks use `runOutsideAppSettingsSnapshot` to reauthorize against current repository state. Preserve that behavior, session expiry checks and the existing owner-key calculation. |

The relevant owners are
[`app.ts`](../../packages/studio-server-api/src/app.ts),
[`app-settings-snapshot.ts`](../../packages/studio-server-api/src/middleware/app-settings-snapshot.ts),
[`settings-repository.ts`](../../packages/studio-server-api/src/app-settings/settings-repository.ts),
[`watch-authorization.ts`](../../packages/studio-server-api/src/watch-authorization.ts)
and [`web-app-action-websocket.ts`](../../packages/studio-server-api/src/web-app-action-websocket.ts).
None needs a production edit for this extraction. Do not add a new snapshot,
remove the existing snapshot or move policy reads outside their current context.

Within either context, retain the original operation order: configuration before
nonce/state creation; state validation before provider work; a configuration read
when each token/profile operation begins; debug-setting lookup after profile JSON;
then the existing fingerprint, allowlist, TTL and signing operations in each
surface's finalization order. These are lookups against the applicable context,
not a promise of a new database/global read at each point.

Characterize a controlled settings update during token/profile waits through
`createApiApp('control')` for both surfaces, and retain a representative direct
helper/router case. Perform the update through another request or an independent
context: a repository write inside the held request can update its own snapshot
map and would test a different situation. Record the original in-flight result
and the next request's admission before moving code. Test the existing OAuth
revocation path outside an opening snapshot as well. Reuse already-covered cases
instead of testing every setting at every await.

## Ordered implementation

### 1. Establish one behavior baseline

- Record HEAD, full diff, OS, actual Node/Yarn versions and exact commands.
  Follow [Refactor Baseline And Verification](../REFACTOR-BASELINE.md).
  The normal API job in `studio-server-verify.yml` currently requests Node major
  `24`; the separate source-contract job pins `24.22.1`. Use Node 24 for the
  implementation checks and record its resolved patch, rather than describing
  the whole suite as patch-pinned. Yarn is checked in at `4.17.1`.
- Confirm required workspace exports are built; use the maintained dependency
  build when missing. Record original auth exports, source hashes and synthetic
  cookie/state fixtures under ignored `artifacts/`. Freeze test time where needed
  so a ten-minute state fixture does not expire during the refactor.
- Extend the existing UI/visitor tests only for missing coverage, including UI
  external-provider body/basic authentication. Run these public-entrypoint cases
  on the original code. The new helper-unit cases run after helpers exist.
- Add a focused `src/tests/oauth-http.test.ts` for both callbacks through
  `createApiApp('control')`, with a held provider response and an independent
  settings update. Prove request-snapshot behavior, next-request rejection of
  stale state/session, and zero provider calls for invalid initial state. Retain
  representative direct-helper and current-policy revocation checks.
- Reuse the existing test HTTP and owned-child helpers. One small synthetic
  OAuth fixture can serve mounted HTTP tests and browser checks; avoid a generic
  auth test framework or a new deployment/proxy stack. Release held responses,
  close connections, settle the child and remove only its temporary roots in
  `finally`. Use a bounded failure deadline, not sleep-based ordering.
- Run the mounted scenario driver against source and a fresh API build before
  extraction. Use `runtimeTestEntry` for a child fixture that needs source and
  `prebuilt` modes. Save semantic receipts from both runs, rather than relocating
  `dist` and assuming workspace/package resolution will still work there.

Exit: the public-entrypoint baseline cases pass on the original code; expected
snapshot behavior and synthetic wire values are captured. The matrix below
distinguishes those cases from helper tests added after extraction.

### 2. Extract browser-state mechanics

- Add `oauth-browser-state.ts` and replace the duplicated signing/verification,
  cookie parsing and serialization bodies with narrow calls from both surfaces.
- Keep policy, fingerprints, payload construction, clocks, secret selection and
  origin/security decisions local. Preserve the secret-resolver catch boundaries
  and original exported helper signatures. Verify clear-cookie byte equality
  before sharing its serializer with creation.
- Add `src/tests/oauth-browser-state.test.ts` for independent wire/expiry/error
  branches once. Use synthetic reference values and observable behavior rather
  than a copied implementation or permanent source-text assertions.
- Run the affected characterizations. Compare the moved bodies and export names
  once during review; remove superseded private copies and unused imports.

Exit: browser-state mechanics have one owner and all original surface contracts
remain in place. If finishing this slice independently, complete its affected
compiled/browser checks and documentation before stopping.

### 3. Extract external-provider mechanics

- Add `oauth-provider-client.ts` with the request, response and claim operations
  above. Keep each wrapper's existing awaits and configuration/dummy branches.
- Keep debug lookup/logging, error classification, redirects, state validation
  and all user admission in their existing modules. Preserve fetch options and
  default redirect behavior; add no retry or provider timeout.
- Add `src/tests/oauth-provider-client.test.ts` only for independent shared
  branches; retain representative end-to-end success/failure cases through each
  original surface. In a nonredirecting fixture, a normal callback sends one
  token POST and one profile GET; invalid initial state/trust sends neither;
  token failure sends no profile request. UI administrator denial still follows
  successful token/profile reads.
- Run affected characterizations, including the mounted request-snapshot case.
  Helpers must not import either auth owner, read settings at import or construct
  resources. Remove private duplicates without adding a shared config schema.

Exit: external provider mechanics have one production implementation, with the
two original policies and observable outcomes preserved.

### 4. Verify final consumers and document completion

- Run the affected API consumers, discovery checks and build below. Re-run the
  same source/prebuilt scenario driver against the candidate in its normal API
  output location and compare to the baseline receipts. Build before consuming
  `dist`; do not replace shared compiled output concurrently with these probes.
- Prove compatibility in both directions: candidate readers accept baseline
  synthetic cookies/state, and deterministic candidate writer values match the
  values the baseline accepted. Preserve signed JSON ordering and fingerprint
  inputs, rather than adding a second permanent old implementation to tests.
- Run the focused headless browser spec described below on final source. Repeat
  affected checks after later changes, and reuse results for unchanged inputs.
  A mocked sign-out control alone is insufficient cookie/redirect evidence.
- Update `access-and-routing.md`, `refactor-history.md` and this plan's status
  with implemented owners and actual evidence. Keep the developer-docs index
  link, and update relevant layout documentation if the final file tree needs it.
- Review the diff and the optional ignored `ci-pre-push.local.md` before any
  commit/push, including its applicable security checks before a push. These
  steps do not authorize a push or deployment.

Use one cohesive change with two reviewable source slices; separate commits are
optional. Every completed source slice carries its tests/docs. Local completion,
hosted verification and release remain separately recorded evidence boundaries.

## Compatibility and regression matrix

| Area | Required observations | Test owner |
| --- | --- | --- |
| Wire compatibility | Candidate readers accept baseline synthetic state/session. Deterministic candidate writer values match baseline-accepted values. Preserve payload JSON, field order, fingerprints and bytes; expiry equality is expired. | Public surface cases before extraction; browser-state helper tests afterward; the same compiled scenario driver before/after. |
| Invalid envelopes | Missing value, invalid last-dot delimiter, wrong signature/length, malformed JSON, missing/expired expiry and throwing secret resolver preserve return-versus-throw behavior. Only absent values/invalid delimiters bypass secret resolution; JSON is decoded after signature verification. | Browser-state helper tests plus representative surface cases. |
| Secret and fingerprint policy | Each secret fallback; client/session secret rotation; UI administrator-list changes; visitor callback changes; dummy development-policy changes; surface-specific unchanged-setting behavior. | UI and visitor tests with saved settings. |
| Cookies | Missing/multiple/header-array cookies, first-name match, embedded `=`, HTTP/HTTPS creation and clearing, exact attributes and original exported helper signatures. | Primitive tests and actual HTTP Set-Cookie assertions. |
| Surface isolation | Each ordinary reader rejects the other surface's generated session/state under the same fixture settings. Empty UI admin/app allowlists deny access; UI logout preserves visitor session and visitor logout preserves UI session. Key/trusted-client behavior remains unchanged. | Surface tests, trusted-client/full-app checks and browser fixture. |
| State and redirects | Nonce/version mismatch, differing state/cookie return targets, missing state/code, provider `error`, unsafe return targets, saved callback and custom app base path. Preserve each surface's result, including its intentional differences. | Surface HTTP tests. |
| Provider requests | Body/basic auth, exact form fields, callback URL, bearer profile header, scope/account-selection query behavior; unchanged request count and no new retry. | Controlled loopback provider and request capture. |
| Provider failures | Token/profile non-2xx, invalid JSON, JSON array/null, missing/empty token, rejected network request and missing/non-string/nested email claim. Preserve status, message, error code, redirect/no-redirect and cookie clearing. | Shared provider tests plus representative cases through each HTTP surface. |
| Settings handoffs | A callback keeps its captured revision when an independent request changes settings during provider IO; the next request observes the new revision. Direct calls without capture keep their existing behavior. Long-lived OAuth authorization still escapes the old snapshot. | Mounted `oauth-http.test.ts`, representative existing surface cases and an OAuth revocation case in the existing authorization/Socket suite if missing. |
| Diagnostics | Existing debug opt-in reads and distinct prefixes remain at the same point. Normal responses/diagnostics gain no credentials or new profile payloads. Use only synthetic data in log assertions. | Surface tests. |
| Consumers | Settings-session projection, operator protection, trusted-client bypass, profile route exposure, published/latest web-app HTML, actions and Socket ownership use the same session policy. | Existing API consumer suites and targeted browser checks. |
| Source/compiled parity | Same exports, cookie compatibility and HTTP outcomes in source tests and compiled serving. Helpers perform no settings reads or resource acquisition on import. | The same mounted HTTP scenario in source/prebuilt child modes; one-time export/import review. |

Keep a small representative test per independent branch; avoid multiplying the
same malformed-input permutations across every consumer. Provider response holds
and settings mutations must restore their fixtures and settle owned requests in
`finally`, including failed assertions. New fixtures must not depend on the
developer's dotenv, cloud access, real identities or production settings.

## Verification commands and discovery

Run commands from the repository root with checked-in Yarn and the applicable
Node runtime. Record exact versions, exit codes and any omissions. Build missing
workspace dependencies first with `yarn studio-server:build:dependencies` and
check them with `yarn check:compiled-workspace-exports`. Avoid rebuilding already
verified unchanged prerequisites. The initial public-entrypoint baseline is:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/ui-auth.test.ts src/tests/web-app-oauth.test.ts
```

Include `src/tests/oauth-http.test.ts` in the baseline once its mounted cases are
added. After extraction, add `src/tests/oauth-browser-state.test.ts` and
`src/tests/oauth-provider-client.test.ts` to the focused run.

Add all three new files to `defaultApiTestFiles` in
`deploy/studio-server/scripts/api-test-files.mjs` in sorted order. Its guard
requires sorting and its shards use manifest index modulo four: new entries
can legitimately move existing files between shards. Verify complete,
exactly-once coverage rather than promising unchanged shard assignments:

```sh
yarn node deploy/studio-server/scripts/run-api-tests.mjs --check
yarn node --test scripts/ci/api-test-shards.test.mjs
```

Consumer verification on the final source:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/settings-repository.test.ts src/tests/trusted-clients.test.ts src/tests/api-profile.test.ts src/tests/app-settings.test.ts src/tests/release-gate-web-app-auth.test.ts src/tests/workflow-web-apps-filesystem.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run build
yarn check:file-tree
yarn studio-server:verify:test-style
yarn studio-server:verify:repo-structure
node scripts/checks/check-doc-links.mjs
```

For the mounted test, the source/prebuilt fixture driver should use the existing
`src/tests/helpers/runtime-test-entry.ts` resolver. Keep the test orchestrator in
source and run its owned API child in each mode. After building the API, repeat:

```powershell
$env:RIVET_API_TEST_RUNTIME = 'prebuilt'
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/oauth-http.test.ts
```

Restore the environment afterward and explicitly unset/use `source` for source
checks. A variable alone does not convert arbitrary source imports into compiled
tests; `oauth-http.test.ts` must actually use that resolver for its server child.
Compiled receipts must cover both callbacks, cookie admission and the request
snapshot case. This same maintained test replaces a separate ad hoc probe.
The filesystem consumer suite remains a compatibility fixture; supported server
deployment modes and storage/repository owners are unchanged.

## Focused browser verification

Add one self-contained `playwright-observe/oauth-mechanics.spec.ts` using the same
owned OAuth fixture as the mounted HTTP test. It starts its own local API and
synthetic provider and navigates to their explicit URLs, so it needs no ambient
developer server. Follow existing fixture networking/child-settlement patterns
so it also works with the hosted browser service. Use synthetic keys, empty
trusted-client bypass and test-owned roots established before app imports.

The fixture can have a thin local forwarding layer for the public UI-auth prefix
and verified test-edge headers. It exercises actual routers, readers and
admission; it does not certify NGINX configuration. Keep real proxy trust covered
by the unchanged consumer tests. Use minimal protected fixture pages rather than
bootstrapping the entire editor or executing graphs just to prove cookie use.

Two small journeys are sufficient: UI administrator sign-in/denial and logout;
visitor sign-in/allowlist and logout, with both cookies present to prove session
separation. Follow redirects, assert the browser stored the intended cookie,
and make a new protected request. HTTP tests own provider-error permutations and
HTTPS header formatting. Do not duplicate that matrix in Playwright.

The observe runner merges its dotenv over process env. Point `RIVET_ENV_FILE` to
an existing, empty test-owned file so developer dotenv values cannot replace the
fixture's browser settings. Preserve/restore the previous variables in the
invoking shell. Once the planned spec exists, the focused command is:

```powershell
$env:RIVET_ENV_FILE = '<absolute path to existing empty test-owned dotenv>'
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe oauth-mechanics.spec.ts
```

Use an installed Chromium via `PLAYWRIGHT_EXECUTABLE_PATH` if needed. Require both
journeys to execute, with no opt-in skip condition. Inspect failures under
`artifacts/playwright/` and name the failing UI step.

Register the spec in `scripts/ci/editor-test-shards.mjs` and update the explicit
inventory assertions in `scripts/ci/ci-performance.test.mjs`. The older
`workflow-library-layout.spec.ts` and `rivet-web-app.spec.ts` are not selected by
that hosted manifest at this baseline; their mocked sign-out tests cannot be the
sole browser gate. Run the `balanced editor shards` and `editor shard work` cases
after registration:

```sh
yarn node --test --test-name-pattern "balanced editor shards|editor shard work" scripts/ci/ci-performance.test.mjs
```

Use a local initial weight for selection bookkeeping only; refresh it with hosted
measurements later, including queueing if making a workflow-speed claim. Keep
the existing headroom assertions and safety windows. Finish root style checks
before builds/probes using their regenerated Core output when those checks are
part of final validation. A Kubernetes rehearsal is unnecessary for this change.

## Delivery, recovery and completion

Use independently reviewable changes: characterization first, signed/cookie
helpers next, provider mechanics next, then any remaining consumer evidence and
final documentation. Every implementation slice includes its relevant tests and
documentation and should be reviewable without changes from a later slice.

The application rollback is a normal revert of the affected extraction slice;
there is no data migration to reverse. Stable cookie bytes and fingerprint
algorithms allow the original and refactored code to read the same sessions.
Verify that compatibility before considering rollback safe. Follow ordinary
release qualification and access checks if the change is later released.

Local implementation completion checklist:

- [x] Exact implementation baseline, versions, diff and synthetic fixtures saved.
- [x] Missing characterizations pass on the original implementation first.
- [x] Signed payloads and cookies each have one shared implementation.
- [x] External provider exchange/profile/claim logic has one shared implementation.
- [x] Surface policy, HTTP snapshots, fresh long-lived authorization and exports preserved.
- [x] Wire compatibility established for baseline readers and candidate readers/writers.
- [x] Source and compiled HTTP/compatibility checks pass.
- [x] Affected API consumers and repository checks pass; new tests are discovered.
- [x] Required headless browser cases execute and pass with fixture cleanup.
- [x] Final developer docs describe the implemented ownership and evidence limits.

Release status: locally verified; hosted workflow execution and production
deployment remain separate. No implementation/local verification
work remains open; future hosted timing is still needed to replace the initial
local browser weight.

## Reassessment evidence and remaining work

On 2026-11-23 the plan was checked against both complete auth implementations,
their mounted route order, settings repository/capture middleware, revocation
owners, test harnesses, API discovery, browser selection/configuration, dotenv
merging and workflow runtime declarations. The reassessment changed:

- Three helper files to two; one browser-state test file covers signing/cookies.
- Global-freshness language to the actual request snapshot/direct-call/long-lived
  context distinction, with mounted HTTP characterization as a required gate.
- A relocated compiled baseline/ad hoc probe to the same maintained mounted
  scenario driven through the existing source/prebuilt child resolver.
- Broad/repeated browser runs and a new real-proxy stack to one focused,
  self-starting cookie/redirect spec in the existing hosted lane.
- An incorrect universal Node patch pin and unchanged-shard promise to the
  actual Node declarations and sorted index-based test selection.
- An overbroad malformed-envelope shortcut assertion to the exact delimiter,
  HMAC, JSON and expiry ordering. Old/new wire compatibility is now bidirectional.

Three targeted existing checks passed on local Node `v22.22.3`: request-lifetime
revision pinning, capture of every execution settings domain, and policy
revocation outside the opening snapshot. They validate the context correction;
they are not Node 24 qualification or OAuth callback characterization. The
current API manifest also passed discovery validation, and the browser selection
check confirmed both legacy presentation specs are excluded.

The earlier local audit's 48 auth/Evaluation passes remain historical context.
The plan-only reassessment changed no production source or test implementation;
its documentation-link, whitespace and stale-reference checks passed. The
implementation and validation below were performed afterward.

## Implementation and local evidence (2026-11-23)

Implementation follows the two-module design. The existing wrappers retain
configuration/dummy selection, fingerprints, settings context, allowlists,
callback validation and error translation. Shared request functions return the
original fetch promise; each surface keeps its two response/JSON awaits. Cookie
clearing uses the same serializer with an empty value and age zero, preserving
the original header bytes, including `; ; Secure`.

The fixture lives in `src/tests/helpers/oauth-http-server.ts` with its owned
child client in `oauth-http-fixture.ts`. It supplies synthetic credentials and
loopback endpoints, captures real token/profile requests, holds either response,
and provides minimal protected pages using the actual readers/admission policy.
Both real callback routers are mounted through `createApiApp('control')`.
The client resolves source/prebuilt entries before allocating its root, awaits
child settlement, checks containment before removing that root and propagates
unacknowledged cleanup. HTTP teardown also verifies the root was removed.

Baseline checks ran before the production extraction on Node `v24.22.3` and
checked-in Yarn `4.17.1`: 33 existing auth cases, 11 initial mounted cases in both
source and prebuilt modes, and two browser journeys passed. The two additional
return-target/direct-token characterizations also passed against the original
prebuilt API, bringing that baseline to 13 mounted cases. The final header
capture and fixture teardown assertions extend that same driver.

The synthetic pre-extraction receipt records both surface fingerprints, signed
session values, cross-surface rejection and exact HTTP/HTTPS cookie strings.
Candidate source/prebuilt runs compare to it. A permanent browser-state test
also checks the candidate signer and reader against a fixed baseline-accepted
token; no old production implementation is retained in the tests.

Final local results on Node `v24.22.3`, Windows:

| Check | Result and boundary |
| --- | --- |
| Focused source auth/helper/mounted suites | 58 passed after test review: 32 retained entrypoint cases, one signing-priority case, 9 shared-helper and 16 mounted/fixture cases. Zero failures/skips. |
| Candidate prebuilt mounted/fixture suite | 16 passed with always-on synthetic baseline checks. Repeated source scenarios, not additional distinct coverage. |
| Existing settings, trust, API-profile, app-settings, release-gate auth and web-app consumers | 167 passed again in the test review, zero failures/skips; includes real HTTP/Socket policy and revocation cases. |
| Real workflow-process suite | 9 passed after replacing the redundant idle process and racing reads with one acknowledged held-reply case. The seven recording/policy cases and their observation windows remain. |
| Headless browser journeys | Both passed before extraction and against candidate source/prebuilt API children, with real local redirects/cookies. A shared beforeAll fixture retains isolated browser contexts and resets settings between cases. |
| API discovery/shard regressions | Seven passed; sorted manifest membership and exactly-once selection retained. |
| Browser discovery/headroom regressions | Both passed with 43 selected specs and the unchanged 1,080-second work cap per shard. |
| API TypeScript build | Passed after the production extraction and fixture updates. |
| Root style suite | Full `yarn test:style` passed. Its Core asset build completed before the final API build and the final functional runs. |
| Studio Server guards | Test style, repository structure and migration ledger passed. Root style also passed file-tree/import, documentation-link and CI policy checks. |
| One-time structural comparison | The 28 UI and 22 visitor policy functions outside the seven moved/wrapped mechanics have identical syntax-tree bodies; original exports are unchanged. This audit is retained as evidence, not a permanent source-shape test. |

Local browser case work was approximately 1.8 seconds after sharing the owned
fixture; complete local runner time was 11.3 seconds including setup. The initial
manifest weight is five seconds, rounded up for case work. Shared startup uses
the existing setup headroom. This is not hosted timing, a runner-queue measurement
or a workflow-speedup claim; refresh the weight from hosted evidence when available.

Evidence is under ignored `artifacts/oauth-mechanics-refactor-20261123/`, including
source hashes/originals, the synthetic wire receipt and individual check logs.
No real provider credentials, private release packet or production state is used.
The provider stand-in establishes Rivet's behavior under the modeled responses;
it does not qualify a specific live identity provider.

### Follow-up code review

Review of the production extraction found no additional behavior change. The
surface-specific configuration, request snapshots, fresh reauthorization and
provider error translation remain with their original owners. Removed stray
blank lines left by the extraction; the shared helpers need no extra service,
factory or configurable policy layer.

The owned fixture did have a cleanup gap: if a ready child exited unexpectedly
between commands, `close()` could succeed without an acknowledgement. Cleanup
now requires both the shutdown acknowledgement and a clean exit. It waits for
the child's `close` event so pipes have drained before reporting diagnostics or
removing the contained root. A child that fails before readiness is terminated
without asking it to process a shutdown command. Startup errors remain the
primary cause, with cleanup failures aggregated when necessary.

Two real lifecycle regressions cover a crashed ready child and a Node startup
failure. They check root removal, stable repeated-close results and preservation
of startup diagnostics. Roots include the parent PID so the startup test can
check for leaked directories without observing another worker's fixtures. The
unexpected-exit assertion failed before the fix.

The minimal visitor page now generates sign-in state only for an anonymous
visitor. A signed-in visitor who fails the allowlist uses the existing logout
path to switch accounts. This removes unnecessary nonce/signature work and a
sign-in link that had no matching state cookie. The browser assertion reproduced
that fixture defect before the fix; product routes were unchanged.

Both mounted callback suites also exercise a provider dropping its token or
profile connection and a profile HTTP 503. They retain the existing callback
error codes, request counts and absence of a session cookie. Held-response tests
attach rejection handlers immediately and settle their outstanding requests
even when a settings mutation or release fails. The HTTP test driver has a
bounded request deadline; production fetch behavior gains no timeout or retry.

The follow-up reruns the focused source/prebuilt suites, API build, both browser
runtime modes, test-style guards and test discovery/headroom checks. The earlier
167 consumer checks and full root style result remain the implementation-stage
evidence; the review changes only fixture/test behavior and production whitespace.
Review logs use the `review-` prefix in the same ignored evidence directory.

### Adjacent-code review

The real visitor denial/logout routes already had the behavior missing from the
minimal fixture. They retain their existing account-switching path. Review of
the return-path sanitizer, request snapshots and fresh stream/Socket access
checks found no additional demonstrated defect; those policies remain unchanged.

The adjacent IPC/lifecycle review reproduced these fixture defects before fixing
them:

- A synchronous command serialization failure rejected its promise but left a
  live deadline and pending entry in the OAuth client. The regression observed
  one extra active timer. Both fixture clients now remove/settle a failed send
  through the same path for synchronous errors and asynchronous transport errors.
- The workflow API child continued serving after its owning IPC channel closed.
  The new disconnect regressions timed out before the fix. It now invokes the
  existing SIGTERM handler, including when ownership was lost during startup.
- The workflow client did not supply a send-error callback. A command against
  the closed channel hit its deadline instead of rejecting with the IPC error.
  Repeated closed-channel commands now reject without emitting unhandled errors.
- A recording-list reply still in flight after disconnect crashed the workflow
  child with `ERR_IPC_CHANNEL_CLOSED`, interrupting graceful drain. A local guarded
  reply function covers its reply sites, including readiness and errors. The
  real-process regression reproduced exit code 1 before the reply fix.

These changes affect test fixtures and their checks. The production OAuth helpers,
policy, routes, recording formats and shutdown grace remain unchanged. No generic
RPC framework, new production setting or new dependency was introduced.

The adjacent pass passed 58 source auth/helper/HTTP cases, 16 prebuilt HTTP/fixture
cases, the complete 10-case real workflow-process suite, the API build and the two
headless browser journeys in each runtime mode, with no failures or skipped cases.
Test-style, repository-structure, documentation-link and discovery/headroom checks
also passed. The workflow-process suite uses
its existing source child; the prebuilt evidence here applies to the OAuth child.
Logs and reproduction probes use the `adjacent-` prefix in the same ignored
evidence directory. The earlier consumer and full root-style results remain
implementation-stage evidence; focused repository guards are rerun for this pass.

### Test quality review

The review covered the shared-helper tests, both public auth suites, the mounted
HTTP driver, both browser journeys, the workflow-process suite, fixture cleanup
and the neighboring settings/trust/web-app consumer checks.

- Replaced five racing recording-list reads with an acknowledged held reply.
  The child completes the real list operation, registers a disconnect listener,
  then acknowledges `wait-recordings-reply`. Disconnect releases that exact
  reply. One case now covers owner loss, the late reply and repeated closed-channel
  errors, removing one full API startup while retaining the separate startup-loss
  case and all seven recording/policy cases.
- Strengthened startup-loss assertions to require exit code zero and no signal.
  A generic startup failure no longer satisfies that regression.
- Removed the duplicate visitor Basic-auth fetch mock. Real mounted callbacks
  cover body and Basic authentication for both surfaces, now checking every form
  entry, the exact secret/code, callback URL and bearer value. Added a small
  public-helper case for session/client/key signing precedence. It uses valid
  saved configurations and checks key-only visitor activation at the settings
  validator; a dummy visitor provider requires an explicit session secret.
- Made both baseline signed values and both positive session readers mandatory
  assertions. Removed the temporary receipt-capture/comparison environment knobs.
  The initial synthetic receipt remains provenance evidence, while normal CI
  checks its values directly. The browser-state baseline test freezes its clock.
- Snapshot cases independently verify the old signing key and the state-bound
  settings version before checking rejection on the next request. Failure cases
  verify the complete return location, exact state clearing, no-store header and
  request counts, with scenario-specific assertion messages. All HTTP-driver
  requests use its existing 15-second deadline.
- Concurrent teardown checks observable success/failure and root removal instead
  of promise identity. The helper, real HTTP and browser layers retain their
  distinct algorithm, routing and real-cookie responsibilities.

Negative controls confirmed that the strengthened tests reject a missing positive
visitor reader, an unrelated startup exit, a cookie re-signed with the new key
inside the old snapshot, and an unguarded late IPC reply. The latter used a
temporary fixture mutation, restored its original bytes and reran the healthy
case successfully. These probes are ignored evidence, with no permanent mutation
framework or fault flag added to the product.

The nine workflow-process cases took 80.9 seconds in one local run. Removing the
duplicate process saves one startup, with no reduced drain or recording window.
This is local evidence, not a hosted timing, runner-queue or CI speedup claim.
Current logs use the `test-review-` prefix in the ignored evidence directory.

### Final commit preparation — 2026-11-24

Removed the unused fixture session-owner projection and formatted the added test
blocks without reformatting the surrounding legacy cases. The full root style
suite passed before a fresh API build. Final source auth/helper/HTTP checks
(58), prebuilt HTTP/fixture checks (16), workflow-process cases (9), and both
headless browser journeys in each runtime mode passed. Studio Server test-style,
repository-structure and migration-ledger checks passed. CI browser discovery
listed 398 tests in the 43 selected files; listing is selection evidence, not
execution of all 398 cases. The unchanged 167-consumer result from the test review
remains applicable. Logs use the `commit-` prefix in the same ignored directory.

Private production packets, local operator scripts/receipts, generated Compose
configuration and credentials remain Git-ignored. The approved local dummy-auth
override is installation configuration, separate from this source refactor and
from the six launchers' default deny policy. Commit preparation did not deploy
new images or perform a production rollout.
