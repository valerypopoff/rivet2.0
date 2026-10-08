# Development

## Shared dropdown styling

`packages/studio-server-web/dropdown-styles.css` is loaded in both the dashboard
and hosted editor. It removes Atlaskit's inset colored left-edge shadow from
dropdown options, including portalled menus. Hover/selected backgrounds, input
focus rings, menu shadows and keyboard selection remain unchanged. Keep this
override at the shared Studio Server boundary, not in individual select controls
or upstream standalone desktop styles.
The installed Atlaskit 16 uses `react-select-…-option-…` IDs and does not
consistently expose option/listbox roles; the shared selector covers those
option rows as well as semantic options.

Verify the dashboard and editor paths with headless
`yarn studio-server:ui:observe run-recordings-modal.spec.ts hosted-file-menu.spec.ts
--grep "Any is first|shared Studio Server modal dimensions"`.

## Shared modal sizing

`packages/studio-server-web/modal-sizing.css` owns all Studio Server modal
dimensions, loaded by the dashboard stylesheet and the hosted editor stylesheet.
Actual modal dialogs (`role="dialog"`, `aria-modal="true"`) use 960px width/max-width
and 700px min-width; every dimension is capped to the owning viewport minus 32px
(16px side gutters). The cap takes precedence over the desktop minimum on small
screens, including the editor iframe's narrower viewport. Popovers, menus and
non-modal input-path suggestions are not affected. Height and content scrolling
remain each dialog's responsibility. Do not add separate dashboard width props
or page-specific width overrides; change the shared variables instead.
Only the immediate Atlaskit positioner (identified by its direct dialog child's
`data-modal-stack` marker) uses the same dimensions and auto side margins;
changing only the dialog leaves the library's smaller mobile/desktop wrapper
constraints in effect and can move the dialog off-center.
Do not size arbitrary dialog parents: custom JSON/response-inspector modal
backdrops must still fill the viewport. Responsive Run Activity drawers retain
their own full-width drawer layout even when accessibility marks them modal.
Hosted Settings and Project Settings navigation stacks above the content at
editor viewport widths of 700px or less. This lives in `hosted-editor.css`,
without changing standalone desktop styles or the shared outer dimensions.

Verify with headless `yarn studio-server:ui:observe modal-sizing.spec.ts
project-info-modal-sections.spec.ts hosted-file-menu.spec.ts scheduled-runs.spec.ts`.
The sizing helper measures actual width, min/max constraints, centering and viewport gutters
in the dialog's own document. Dashboard coverage includes stacked schedule dialogs
and narrow viewports; embedded Settings/Project Settings retain their behavioral
tests while checking the same contract and stacked narrow-screen settings layout.
The CSS integration fixture also checks full-screen custom backdrops, outside-click
dismissal and drawer exclusion. No Kubernetes rehearsal is needed.
The small dashboard sizing scenario is also in the production-bundle CI browser
lane, so the stylesheet must work without Vite development style injection.

## Scheduled runs regression checks

See [Scheduled runs](./scheduled-runs.md) for ownership, storage schema 14 and
restore safety. After changes, run `yarn build:runtime`, API `test:files` for
`scheduled-runs.test.ts`, `scheduled-run-execution.test.ts` and
`managed-workflow-schema-migrations.test.ts`, plus the affected operational
copy/first-start/recording suites. Run headless
`yarn studio-server:ui:observe scheduled-runs.spec.ts`; it drives the modal against
a disposable authenticated API process, SQLite scheduler and cross-project
recording execution, including lost Create/Run/Retry responses, real server
restart persistence, stale edits, temporary list outages and cancelling a waiting
HTTP node. Unit checks also cover acknowledgement budgets/rollback and an outcome
write failure after successful execution. Use `PLAYWRIGHT_BASE_URL` for a frontend served
directly when the ambient authenticated proxy is unavailable. No Kubernetes
rehearsal is required for modal changes. Concurrency/clock correctness on managed
storage also needs the real PostgreSQL integration check described in the feature
document, rather than relying only on SQL mocks.
The standard web suite also includes `scheduled-run-api.test.ts` for malformed
acknowledgements and overlapping retired-response races; the browser check verifies
that accepted-action reconnection warnings disappear when the list recovers.
`scheduled-runs.test.ts` also exercises writable adoption of the original
three-table SQLite schema and unmarked current databases, preserving history,
installation binding and request receipts. Unknown versions and damaged schemas
must fail without DDL; `local-operational-schema.test.ts` retains strict selected
authority checks. If startup reports unexpected/missing scheduler tables, inspect
only schema metadata and integrity first. The known old schema upgrades on normal
writable startup; deleting the database or weakening all schema checks is not a fix.

See [GitHub Actions performance](ci-performance.md) for measured branch-workflow
bottlenecks, bounded API/browser concurrency, shared desktop artifacts, and the
verification boundaries that must remain intact when optimizing CI.

Portable exports have a dedicated [project-bundle contract and verification guide](project-bundles.md).
That guide covers public ESM/CommonJS loader checks, legacy alias dataset ownership,
release coordination, and the opt-in bounded packaging capacity probe.
Changes to dependency collection must be verified through saved storage adapters,
the public Node loader and the browser download flow, not source-text assertions.

## Automatic local first start

Supported Compose startup initializes SQLite metadata/settings/operational stores
and checksum-addressed file artifacts only when all four source roots are empty.
Keep first-run classification before serving children initialize defaults. Never
infer a new installation from an empty project list: settings-only, recordings-only,
empty-folder and retained-control installations are old installations too.
`local-upgrade-ui.mjs` owns the durable first-run UUID/phase and supervisor lease
boundary; `initialize-empty-installation.ts` owns independent empty-source checks,
default settings seeding, exact candidate/schema verification and live selection.
An interrupted initializer must retry without exposing legacy serving.
Check its retained `initializing` phase before preparation eligibility: unexpected
control-volume entries or conflicting root overrides must block startup, never
turn it into legacy serving. Validate deployment root/key ownership even for
unpublished records. Ready publication can reuse a private empty or partial `.next`
file left by a crash/short write only when it is an exact prefix of the original
ready record; conflicting contents are rejected. Missing established journals,
ledgers and independent bindings are not recreated.
`dev-backend-supervisor.mjs` supplies both offline control commands through the
workspace's current TypeScript source and TSX loader. Do not let development
first start fall back to the production image's compiled initializer: that code
may be stale while API/executor watchers use the checkout.

The supervisor threads cancellation through both offline commands. On shutdown,
wait for the writer's `close` event before releasing the reserved-volume lease;
do not reject immediately from an abort event while the writer can still mutate
SQLite. Use the existing backend shutdown grace for termination escalation, not
a time limit on normal work. Leave unpublished installation identity intact for
retry. Also reconcile a stop arriving while the child health listener is opening,
before its own signal handlers are installed. Regression fixtures exercise both
windows, including a Linux writer that ignores SIGTERM and requires SIGKILL.

Regression commands:

```powershell
node --test deploy/studio-server/images/api/local-upgrade-ui.test.mjs deploy/studio-server/images/api/backend-supervisor.test.mjs
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/local-first-run.test.ts src/tests/local-upgrade-runtime.test.ts src/tests/proxy-image-contract.test.ts
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
yarn studio-server:ui:observe packages/studio-server-web/playwright-observe/local-storage-upgrade-prompt.spec.ts
```

The first-run runtime fixture exercises SQLite-backed project/settings writes,
public-route projection and restart persistence without creating retained
JSON/project authorities. Supported Compose proxies poll the authenticated
`/internal/app-settings/proxy-config` endpoint, just as managed proxies do; never
mirror SQLite settings back into legacy JSON merely to update nginx. Validate
initial configuration, route/timeout refresh and last-valid configuration retention
on API failure when changing that wiring. Browser
coverage verifies hidden upgrade settings for fresh/completed/managed storage,
legacy reminders on reload and incomplete SQLite recovery access. These checks
do not replace production-data backup/restore or image release qualification.
The real UI migration fixture has a five-minute cumulative subprocess limit for
its several API/executor restarts; each individual status phase remains bounded
at 55 seconds. Single-phase runtime fixtures retain their shorter limits.

## Collapsible recording families

`recording-run-hierarchy.ts` groups the current recording results by exact
`executionIdentity.correlationId`. A unique non-Subgraph row is the primary;
children start folded and expand into individually virtualized, indented rows.
Do not group by project/graph name or infer immediate nesting from the root key.
Missing or ambiguous primaries get an explicit context group, never a synthetic
recording. Ordinary pagination and status filtering operate on individual
recordings; their expand count says `in current results`. **Filter by input**
searches only primary/root recordings (non-`subgraph_project` rows, including legacy
rows without surface metadata). It never promotes a child-only match into a root.
Expanding a matching root fetches all linked child metadata through the authenticated
`GET /api/workflows/recordings/:recordingId/sub-runs` path, in pages of at most 100.
These children bypass both input and status predicates and do not inflate match
counts or search progress. Loading/failed disclosure controls provide feedback and
retry; complete families are published only after all pages load. View replacement
aborts pending child reads and discards late replies. An absent or ambiguous primary
key cannot manufacture ancestry. Changing workflow/page/filter resets expansion;
appending root matches preserves expanded correlation keys.

Each page must identify the requested primary/page, contain only linked Subgraph
rows, make unique-ID progress and retain a consistent total. Final unique-ID count
must equal that total; repeated, incomplete or changing pages fail without publishing
a partial family and can be retried. This is a consistency check, not a database
snapshot: recordings can change after loading. Child-load errors are primary-owned
and independent of root-search errors; retrying one cannot erase another failure.
The observer covers repeated pages, concurrent count changes, incomplete pages,
unrelated rows and a stopped root search followed by child retry.

`RunRecordingsModal.tsx` retains expansion while hidden for replay, but
explicit close resets it. Folding never invokes replay loading, and deletion remains per recording.

Virtual offsets are index-based, but measured heights are recording-row-owned.
`refreshRecordingRowMeasurements` compares rows by identity before pruning their
height cache: a moved, offscreen primary that gains a disclosure control must not
retain its old height. Unchanged moved rows keep their measurements.

Called-project recording status follows execution failure, not the truthiness of
an error message. Core retains the actual Error until finalizing a child; an empty
message still produces `failed` metadata and an error terminal in its replay.
The caller may handle that failure through the Subgraph error output and still
finish successfully. Successful Abort Graph remains successful; unsuccessful abort
rejects the child and records failure. These are covered in
`GraphProcessor.asyncBranches.test.ts`, together with nested correlation and
upload-before-caller-completion checks.
The headless `local-editor-recordings.spec.ts` also checks actual Browser
cross-project failures and error aborts: the child upload must contain a failed
replay while a caller using the error output uploads a successful parent with
the same correlation. Uploads are intercepted; no working project is modified.

The local-editor recording API bounds parent and child error summaries to
16,384 characters instead of rejecting an otherwise valid replay for a longer
diagnostic. This affects list metadata only: replay content remains unchanged,
non-string summaries are rejected, and the total upload-size limit still applies.
The `oversized diagnostic` HTTP regression checks both upload routes, stored
failure status, bounded summaries and preservation of the full replay diagnostic.
Pruned split-run replay tests assert Core's canonical scalar
`control-flow-excluded` sentinel for a wholly unused output port. Exclusion is not
an array value type, even when the successful sibling outputs are aggregated.

Live cross-project execution events carry `execution.projectScope`. The shared
Browser/Node dispatcher and inactive-project snapshot reducer retain them in
Run Activity but do not project their graph/node IDs into the caller's canvas,
output buffers or LLM round history. This matters when duplicated projects reuse
IDs. Interactive child prompts remain answerable; child node terminals remove
only the matching prompt without writing caller node data or resetting the
caller's selected output-history page. Standalone child
replay remains visible through Core's finite `replayRecordedAt` provenance.
`executionIdentity`, `remoteExecutorHelpers`, and `projectExecutionSnapshotEvents`
tests cover the active/inactive projection boundary and replay compatibility.

Run `yarn workspace @valerypopoff/rivet-studio-server-web test` for hierarchy
invariants (duplicates, ambiguous/absent roots, exact keys, incremental search,
large families), and `yarn studio-server:ui:observe run-recordings-modal.spec.ts`
in headless mode for keyboard expand/collapse, indentation, child replay, filters,
page-split families and deletion/failed-refresh regression coverage.

## Recording duration display

`RecordingRunsTable.tsx` formats recording durations to two decimal places in
milliseconds or seconds (including the seconds component of minute durations).
Rounded integer centiseconds carry values at minute boundaries correctly, without
converting a formatted string back to a number. Invalid, missing, negative or
non-finite timings display `Unavailable` rather than crashing the modal or
presenting a misleading zero.
This is presentation-only: stored `durationMs`, replay timings and statistics
retain their original precision. The recordings-modal observer covers fractional
milliseconds, seconds and minute-boundary rounding.

## Called-project recordings in the caller browse scope

The recordings modal requests `includeSubgraphRuns=true` for an individual
workflow. Its scope includes direct recordings plus `subgraph_project` recordings
sharing a nonempty correlation ID with a retained, non-Subgraph recording owned by
that workflow. This includes nested called projects, but does not treat an inbound
child recording as an anchor that pulls in the caller's other children. Each row
shows the replay-owning project path; only Subgraph rows show the related run key. Any remains
the deduplicated all-recordings scope.

Filesystem, authoritative SQLite, and managed PostgreSQL apply the same
metadata-only scope to ordinary counts, status filters and offset pages. Bounded
input search uses the common root-only predicate and root-only `scopeCounts`, for
both Any and an individual workflow. Child discovery queries only metadata tied
to a retained primary ID, never child input artifacts. Deleting a discovered child
removes it without changing root matches/progress; deleting a matched root retires
its discovered children and rescans roots after a successful catalog refresh.
Search deduplication is owned by
the individual search effect's local Set, not a second mutable ref shared across
replacement searches.
Keyset continuations are bound to the include-child flag and reject non-boolean
flag payloads, preventing a malformed or direct-only
continuation from silently selecting an expanded scope. The fingerprint includes
the root-only search policy so pre-change child-inclusive cursors fail explicitly.
The backend option defaults to false to preserve migration verification and
existing direct-project consumers. Statistics and retention ownership are unchanged.
After a confirmed delete, the current view removes that row immediately. A later
catalog/scope refresh failure reports that deletion succeeded but refresh failed;
it must not restore the deleted row or imply the mutation can safely be repeated.
The same acknowledgement subtracts that row from known page/scope counts, its
owning project's catalog counts and Any totals, including its failed/suspicious
status. Counts never go below zero; successful refresh replaces these local
adjustments with server counts. Failed DELETE requests do not adjust counts.
Cached counts for a different workflow are invalidated rather than guessed.
Deleting a non-Subgraph root with a shared correlation key can also remove its
retained children from the caller browse scope. Both ordinary pages and filtered
matches retire that obsolete scope immediately, even if the following catalog
refresh fails. An active input search restarts through the existing guarded search
effect after the catalog refresh succeeds.
Deleting a discovered child does not rescan roots. A filtered root deletion
restarts the guarded root scanner, including in Any; ordinary Any deletion reloads
only its current page. Roots without a correlation key cannot anchor related
children. Workflow-selector counts explicitly say `in this project`: they describe
recording ownership, whereas selecting a workflow expands the table to related
children. Any's count remains the unique all-recordings total.

Historical recordings without correlation metadata cannot be linked reliably.
If their root recording has been deleted, child replays remain available under
Any or their own project, but are no longer discoverable through that root's
project scope. Listing never infers relationships from names, timestamps or paths.

Regression coverage: `recording-workflow-scope.test.ts`,
`workflow-recordings-http.test.ts`, `sqlite-workflow-backend.test.ts`, and
`managed-recordings.test.ts`. Run the complete headless modal observer with
`yarn studio-server:ui:observe run-recordings-modal.spec.ts` for durations,
expanded scopes, bad/input filtering, source labels, parent/child deletion,
post-delete refresh failures and request races. Set `PLAYWRIGHT_HEADLESS=1` and
`PLAYWRIGHT_SLOW_MO=0`; set `PLAYWRIGHT_BASE_URL` when not using the default URL.
For a focused HTTP execution check, run:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files --test-name-pattern="input search matches only roots" src/tests/workflow-recordings-http.test.ts
```

The managed service test mocks query execution; `recording-workflow-scope.test.ts`
executes the equivalent predicate in SQLite. These are not live PostgreSQL
integration tests.

## Recording input-path history

Run recordings remembers trimmed input JSON paths when Apply accepts the filter.
The history is browser-local (`rivet.run-recordings.input-path-history.v1` in
localStorage), shared across workflow scopes and browser tabs on the same origin,
and retained across modal close and page reload. Only paths are remembered, not
filter values or recording payloads; history is not stored in server settings.
Exact, case-sensitive paths are deduplicated and ordered most recently
used first. Focusing or clicking the path field opens the saved-path dropdown;
Arrow Down enters it, Tab navigates its selection/delete buttons, and Escape
returns to the field without closing the recording modal. Selecting a path edits
only the draft; deleting one affects only history, not the draft or active search.
Paths rejected by Apply's client-side validation are not remembered. Unavailable
browser storage falls back to in-memory history without preventing searches or
showing recovery warnings.
Uncommitted history changes remain authoritative in memory after a failed write,
so refocusing cannot forget a new path or resurrect a deleted one from stale
storage. The helper retains this fallback for the browser document, including
modal close/reopen. Pending per-path add/delete actions are retried against the
latest readable list, rather than overwriting it with an old whole-list snapshot.
This preserves unrelated additions and deletions made in another browser tab.
Shared history is still a best-effort browser preference, not transactional
multi-writer project storage. The dropdown itself can take focus so clicking its
padding or scrolling a long list does not dismiss it.
It cannot preserve failed writes across a page reload while storage is unavailable.
Cleared storage is treated as an empty history, not as an inaccessible backend.

The Web workspace test `recording-input-path-history.test.ts` covers normalization
and unavailable storage, including pending-edit rebasing. Run
`yarn studio-server:ui:observe run-recordings-modal.spec.ts --grep "input path"`
headlessly for deduplication, workflow switching, selection, deletion, keyboard
behavior, long-list scrolling, shared-origin tabs and reload persistence.

## HTTP Call settings regression

HTTP Call keeps retry, fail-on-status and catch controls in the final shared
collapsible **Error behavior** group. Its nested retry toggle still owns Repeat
times and Cooldown; Binary Output remains outside the group. This is layout-only:
serialized keys, output ports and runtime handling are unchanged. The Core
`HttpCallNode.editors.test.ts` checks the hierarchy, and the headless observer
`http-call-failure-headers.spec.ts` checks folding, retained values after retry is
disabled/re-enabled, independent fail/catch controls, control/body wiring and
terminal retry-response evidence. Core also checks that constructing the grouped
editors does not mutate authored data or change the node's port definitions.

Run all `test/model/nodes/HttpCallNode.*.test.ts` files in the Core workspace,
then `yarn studio-server:ui:observe http-call-failure-headers.spec.ts` with
`PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0` against the current frontend.

## Tunnel-friendly development

Use `yarn studio-server:dev:tunnel` when forwarding the browser port through a
VS Code tunnel. Forward the same proxy port as ordinary dev (for example 8081),
not the private API or frontend service ports. `yarn studio-server:dev` switches
back to Vite hot reload. Both commands use the same Compose project and data
mounts; this is a frontend mode, not a staging deployment or storage upgrade.
Save browser edits before deliberately switching modes.
The launcher gracefully reloads nginx after frontend readiness; Compose must not
restart the proxy merely because `web` was recreated. This preserves existing
executor WebSockets while refreshing nginx's upstream address resolution. Direct
Compose-only web recreation requires that same reload afterward.

Tunnel mode automatically watches the frontend and bundles it using the existing
hosted Vite aliases/plugins. API and executor development watchers are unchanged.
Expect a slower first start and rebuild than HMR: a successful rebuild causes a
full-page refresh, not component hot replacement. There are no thousands of Vite
source-module requests or Vite HMR connections in the browser. Source maps remain
available for debugging; this mode is development-only, not a public production
server. Keep normal tunnel sign-in and Rivet UI authentication enabled.

This frontend's full build is resource-intensive. Local verification measured
roughly 80–90 seconds per native build, 127–155 seconds per Linux container build,
and about 5.3 GiB aggregate Node resident memory during a Linux/Node 20 build (not guaranteed
maximums). Allocate sufficient Docker RAM
alongside the backend; do not assume a 4 GiB production VM can run this development
builder. Each compiler child exits after publication, releasing its heap.
Tunnel mode allows a 15-minute startup health grace (live mode retains 3 minutes);
a successful check becomes ready immediately. Each compilation also has a
15-minute deadline so a hung plugin cannot indefinitely block later source edits.

The build process and HTTP server are separate. A successful build is copied to
an immutable generation before it becomes current. HTML pins scripts, CSS,
Monaco/deserialize workers and lazy imports to that generation, and the dashboard
pins its iframe to the same generation. Failed builds retain the previous bundle.
Status travels over authenticated, unbuffered `/__rivet_dev/events` SSE. Connection
loss reconnects without reloading or discarding the workspace.
Initial connection failure is visible even before the first status arrives.

The development notice shows building/failure/update status, horizontally centered
at the bottom of the full browser viewport. Build errors, reconnect notices,
checkpoint status and the safe-refresh action share that position. Keep 16px side
gutters, wrap long messages/actions on narrow screens, and bound the notice to
the viewport height with internal scrolling for tall errors. Center with auto margins
rather than a transform: transforming this parent would constrain its fixed
full-viewport refresh shield to the banner. The tunnel browser fixture measures
centering at desktop/mobile widths, short-screen vertical gutters/scrolling,
and the shield's viewport coverage and hit testing outside the notice.
Automatic refresh requires all project tabs to be clean with known baselines, no active saves,
loads, bridge commands, graph/Evaluation runs or editor modal work, and a freshly
committed, reloadable browser checkpoint. The iframe is briefly input-locked;
the parent rechecks permission synchronously immediately before navigation.
Canvas drags, connection gestures and focused inline inputs block refresh before
the input lock can blur them; an uncommitted gesture need not be dirty yet.
Visible dashboard forms, alert dialogs and busy rename rows also block refresh,
even after their input loses focus; retained hidden forms do not block it.
If unsafe, it stays on the current bundle and offers **Refresh when safe**.
Save work, finish runs, and close open settings/inline forms before using it.
This button never forces a discard. An absent or old editor bridge fails closed.
Ordinary browser reload is still the user's explicit action, with existing unload
protection. An initial nested module-import failure now presents a retry action
instead of an endless editor spinner, in both frontend modes.
The dependency-free HTML shell also catches entry-module resource errors before
any editor JavaScript executes. Entry's nested-import handler uses that same
failure surface. It does not reset recovery or create automatic reload loops;
late resource/runtime errors cannot replace an already-ready editor.

Source changes are debounced and builds are serialized in fresh compiler children,
not incremental Rollup builds: hosted plugins dispose build resolver state, and
output directories must not be cleared while another build is being published.
Parent IPC disconnection stops orphan watchers/compilers before a replacement
can write the shared working directory. The HTTP supervisor also tracks the
compiler PID and terminates it on watcher failure: synchronous compilation can
delay the compiler's own disconnect handler.
Compilation starts only after the supervisor acknowledges that ownership.
Retired watcher callbacks and compiler deadlines cannot affect a replacement.
The web container uses Docker's init process to reap exited orphan subprocesses.
Edits observed during a build are coalesced into the next build; superseded
results do not become the current frontend generation.
Vite's watch-only polling server covers frontend/shared/Core/App sources, Vite
config, source-alias helpers, App's imported `graphs/` templates, workspace package/TypeScript config and lockfile changes, and public assets (including
additions and deletions) for Docker Desktop bind compatibility. Lockfile/dependency
changes still require rerunning the launcher to reconcile installed dependencies.
Changes to the launcher or `dev/*.mjs` server implementation require a web restart.
The watch-only Vite server has HMR disabled; it opens no unused HMR socket.

The named `tunnel_cache` volume stores deduplicated hardlinked generations, capped
at 2 GiB of unique objects and 128 generations. Old generations are deliberately
not deleted while an old tab could still request a lazy chunk. At the limit,
publication fails visibly while the existing bundle keeps serving.
Failed-publication objects without any retained-generation hardlink are reclaimed
when the next compiler initializes the cache; retained generations are never
pruned. Objects from a partial publication must not permanently consume the
available budget.
To reset the retained-generation cache,
close old browser tabs, stop the dev stack, and remove **only** that Compose
project's `tunnel_cache` volume, then restart. Never use `docker compose down -v`
for this: it would also remove local application/database volumes. A fresh web
process waits for its first successful build rather than treating another
checkout's cached HTML as current.

Verification:

```powershell
yarn studio-server:verify:tunnel

# Longer Linux/Docker gate (installed dev dependency volume required):
yarn studio-server:verify:tunnel:integration
yarn workspace @valerypopoff/rivet-app exec tsc -p tsconfig.hosted-development.json --noEmit
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:8081' # configured tunnel-mode proxy
yarn studio-server:ui:observe tunnel-development.spec.ts
```

The bundle-refresh cases require tunnel mode; the bootstrap failure/retry cases
also run against ordinary Vite. The spec mocks API fixture data and covers nested
import failure, entry-resource failure before editor modules load, Retry and late
resource/runtime errors that must not replace a working editor, initial SSE
failure/reconnect, build feedback, safe clean refresh,
generation pinning, pending dashboard forms/rename rows, an active canvas drag,
an inactive dirty tab and aborted recovery transactions. The native server tests cover cache limits, failed publication,
old chunks, SSE, path validation, deduplication, retired watcher callbacks and
compiler deadlines. Generated bundle reads in server tests inspect only test-owned
artifacts, never production source. Bootstrap behavior is checked in the real browser,
not by extracting and executing inline HTML source in a mock VM. Pure launcher
tests exercise `developmentFrontendEnv`; the static repository gate
(`yarn studio-server:verify:repo-structure`) owns the parsed Compose YAML, package
command and authenticated/unbuffered SSE proxy contracts. Also run the existing node
editor/Save regressions against the bundled frontend. Local checks do not certify
an authenticated external tunnel: test the actual forwarded URL separately,
including tunnel sign-in, SSE reconnect and frontend/backend edits.
The fixture signs in through the existing UI gate with the runner's `RIVET_KEY`
when required; a login screen must not be misreported as a module-load timeout.
Refresh tests wait for the real checkpoint handshake: editor mount readiness
does not imply that startup recovery effects have finished settling.
The ordinary-Vite bootstrap retry assertion reacquires the iframe across
dependency-optimizer reloads, retrying only destroyed/detached document contexts;
other evaluation failures still fail the test.

The integration gate creates UUID-labelled disposable code/cache volumes, copies
only frontend build inputs (not `.env`, project roots or desktop build trees),
and mounts the existing dev dependency volume read-only. It does not bring the
normal Compose stack up/down. It compares live/tunnel Compose service objects:
only web configuration may differ, and data mounts must be identical. Tunnel
startup retains the existing Google browser-override typecheck.

Real TSX, CSS and Core edits must reach published assets. A syntax error must
retain the last successful generation; repair must publish a new one. An API-only
source edit must not schedule a frontend build. The gate measures cold fixture
readiness and separate warm rebuilds, sampled aggregate Node RSS and unique cache
bytes, then runs the safety browser suite. A second browser pass measures the
same cold dashboard/editor case against ordinary Vite mode. These measurements
exclude dependency installation and do not qualify a production VM's capacity.
Reports live under `artifacts/rivet-tunnel-<uuid>/`; browser metrics also live in
`artifacts/tunnel-browser-measurements/`. The gate removes only its labelled
container and volumes on completion/failure, retaining diagnostic artifacts.
Cleanup attempts every owned resource even when one is locked, and preserves the
original test failure instead of replacing it with a secondary cleanup error.
A successful test run with failed cleanup remains a failed verification; PASS is
printed only after cleanup succeeds.

The browser suite additionally proves that clean-but-pending saves and active
workflows block refresh, save failures retain dirty edits, and an acknowledged
retry permits a checkpointed refresh restoring the active tab. It never forces
project saves or interrupts execution to apply a frontend update.
Refresh permission is bound to the exact recovery provider that committed the
checkpoint. Provider replacement during or after preparation invalidates that
permission, even if the retired provider still reports healthy recovery.
Connection loss during preparation cancels the request and releases input locks.
The refresh expiry remains active while navigation begins. If a browser blocks
navigation or a user cancels a `beforeunload` prompt, the dashboard shield,
keyboard lock and iframe permission expire instead of trapping the old page.
The bundled browser suite covers cancelled navigation and subsequent editing.
Asset compression honors an explicit `gzip;q=0`, and response pipelines retire
both file and gzip streams when a tunnel client disconnects.

October 3 isolated Linux/Node 20 checks measured approximately 133–152 seconds
for cold readiness and 125–142 seconds for CSS/TSX/Core rebuilds. Unique cached
payloads grew from about 162 MiB to 249 MiB across four generations. The same
mocked dashboard/editor startup made 37 bundled requests (zero source modules),
versus roughly 670–1000 requests in ordinary Vite mode (520–830 source modules);
local browser startup was about 1.2–1.8 seconds in either mode. These are
checkout-specific observations, not tunnel latency or capacity guarantees.
Vite dependency-optimizer warmth affects the counts: the baseline is a fresh
browser document, not an untouched Vite server's first request. Repair latency
also includes superseded builds, so it is not a clean rebuild baseline. See the
retained per-run measurements and browser reports rather than treating these
figures or a historical test count as a performance SLA.

Final external acceptance remains manual: launch `studio-server:dev:tunnel`,
forward the configured proxy port, sign in through the actual VS Code tunnel,
and open/edit a project. Check a harmless frontend edit, failed build/repair,
dirty-tab deferral, SSE reconnection and your intended backend change through a
controlled workflow. Keep tunnel/UI authentication enabled. The isolated gate's
API-only edit checks watcher separation, not a live API/executor execution path.

See also: [Mistakes and Misconceptions](./mistakes-and-misconceptions.md)
See also: [Repo structure](./repo-structure.md)
See also: [Wrapper ManagedCodeRunner Speed Plan](./wrapper-managed-code-runner-speed-plan.md)
See also: [Local metadata storage upgrade](./local-metadata-upgrade.md)

## Local metadata conversion verification

Reminder and storage-activation policy regressions run headlessly with
`yarn studio-server:ui:observe local-storage-upgrade-prompt.spec.ts`: postpone/reload,
in-progress reload, completed SQLite, managed exclusions, final restart, stalled
setup/status reads and stale preparation capabilities. Both inactive backend buttons
are blocked until a separate verified migration exists. API `app-settings.test.ts`
verifies that forged local-to-managed and managed-to-local drafts cannot modify
settings. `workflow-storage-config.test.ts` covers managed credential/location
updates and retained credentials from older filesystem detours. Managed fixtures
use `seedDeploymentStorageSettings` to model an already-provisioned disposable
installation, not a prohibited live Storage-tab switch. The real runtime rehearsal
also checks setup completion before and after the final coordinated restart.

The `operator setup status` runtime case asserts the complete public setup response
both before opt-in and with a provisioned manual root, including explicit
`uiPreparationAvailable` and `uiRestartAvailable` booleans. It checks each capability
independently while keeping paths, keys and the supervisor token out of the response;
unsigned sessions remain forbidden. Direct fixture processes clear inherited UI
supervisor capabilities, endpoint and reserved root; only the real supervised cases
advertise them. Include this case when changing the setup API, not only the copy/live
rehearsal: an obsolete exact-response fixture can fail Linux CI even when migration
itself passes.

The single-host local upgrade remains opt-in. Updated Compose mounts the reserved
control volume and advertises supervisor-owned UI preparation; the signed operator
can prepare persistent journals, migrate and request necessary backend restarts
entirely from the normal wizard. Individual fingerprint and inspection controls are
advanced alternatives. Manual/custom launchers retain explicit environment/provisioning
requirements. The owning runbook explains backup certification, paused activation,
coordinated restarts and key-free offline rollback. A browser migration is not a
substitute for rehearsing a separately restored copy of production data.

New local App Settings are plaintext schema-version-2 JSON rows. The supported Compose
wizard needs none of `RIVET_LOCAL_METADATA_UPGRADE_ENABLED`,
`RIVET_LOCAL_METADATA_CONTROL_ROOT` or `RIVET_LOCAL_METADATA_ENCRYPTION_KEY` in user
dotenv configuration. Old UI bootstrap keys are retained only to decode old databases;
manual encrypted installations retain their original key until live conversion succeeds.
Custom-root adoption first needs one updated-launcher boot with that root; it persists
an independently bound pointer, not a new journal. Protect plaintext volumes/backups
and do not downgrade to schema-v1-only images. Managed PostgreSQL encryption is unchanged.

`sqlite-settings-store.test.ts` covers plaintext reopen/CAS, missing-key refusal on
legacy ciphertext, paused read-only preservation, transactional conversion/rollback,
revision/timestamp preservation and POSIX permissions before schema creation/conversion
(including an unrestricted umask), conversion write-fence checks, and the standalone
backup guard against databases actually created by the API. `local-upgrade-ui.test.mjs` covers key-free
preparation, old bootstrap compatibility, root discovery, lost-binding refusal and
interrupted manual-pointer publication without replacing its independent binding.
`local-upgrade-backup.test.mjs` covers version-1 encrypted/plaintext and version-2
UI-owned backups using real version-1/version-2 settings schemas, plaintext row restoration,
unsupported/damaged settings refusal and manual pointer/App Data binding preservation.
The runtime `UI prepares` and `copy verifies plaintext settings`
cases and the guided Playwright flow omit key attestations. Older-server browser
fixtures intentionally retain their key controls to exercise compatibility.

The production-cutover command includes `local-upgrade-ui.test.mjs` and supervisor
private-control/restart tests. The runtime suite's `UI prepares` case uses real API
and executor processes, the offline provisioner, browser-backup attachments and
every normal migration transition on owned fixtures. `shutdown-deadline.test.ts`
checks timer release; a successful shutdown must not keep Node alive until an unused
grace timeout. Automatic validation waits for combined readiness, not merely an API
status response. Headless UI coverage checks the consolidated flow, reconnect,
readiness delay and explicit final acknowledgement.
The real supervised flow also reads proxy startup settings without an operator
cookie and checks UI authentication while paused, both before copy and after the
SQLite restart. Writes and public workflow GET execution must still return 503.

Run `local-browser-backup.test.ts` for archive/restore, capacity, drift, path
and permission/link preservation; run it on Linux as well as Windows.
The Linux archive suite must also run as UID/GID 10001:10001 to exercise
read-only scratch cleanup; root can mask permission failures. The runtime
suite's `authenticated browser backup` case checks signed authentication,
separate key/archive attachments, cross-origin denial, forged/stale receipts,
archive tampering, interrupted jobs and unreadable optional backup status,
paused live/history exports, read-only tree browsing and verified copy.
Backup creation and copy verification each receive a fresh polling deadline;
preceding attachment checks must not consume the copy phase's CI budget. Browser
`local-storage-upgrade.spec.ts` covers background progress across reload,
native attachment navigation without replacing the workspace, explicit
download attestations, stale/failed receipt gates and available legacy recovery
despite unreadable backup evidence. These use owned fixtures or mocked operator
APIs, never convert real development data.

The marker-only `vm-migration-maintenance.test.ts` fixture clears inherited local control-root configuration while running, so containerized tests cannot consult the serving installation's transition journal; it restores the environment afterward. Full local-selection admission is covered separately by the isolated runtime fixtures.

Run the API `local-upgrade-runtime.test.ts` with the artifact/catalog/settings,
candidate/snapshot/transition/recovery suites. It exercises durable copy,
independent process startups, selected serving, restart fences and corrupt
candidate recovery. Also run `studio-server:verify:production-cutover`, the
API typecheck, executor build, formatting/test-style checks, and headless
`studio-server:ui:observe local-storage-upgrade.spec.ts`. UI checks mock the
operator API and never convert the development stack's data. Use Linux Node 24
for container-runtime evidence as well as Windows checks. The runtime suite
includes stage/commit termination, disk-full/permission failures and retry;
`local-copy-capacity.test.ts` and `local-upgrade-diagnostics.test.ts` cover
resource refusal and secret-safe failure categories. Copy inspection now returns
an additive disk estimate: decoded recordings once, separate metadata/library
and operational snapshot reserves, allocation/path overhead, one transient
bundle and fixed headroom. The actual converter/extraction fixture samples disk
allocation; it is not a production-data high-water qualification. HTTP copy
admission records a durable job and returns 202 before expensive capacity,
source-fingerprint and archive checks. A refusal becomes a failed job with a
fixed stage/reason, before a candidate is created; acceptance is not success.
The UI retains compatibility with older synchronous 409 refusals. Workflow
failures carry an opaque project reference; an authenticated, read-only lookup
provides its current path to the panel without persisting paths or parser/SQL
messages in reports. Core's optional `{ logErrors: false }` deserialization and
Node file-reader option suppress parser warnings for these protected reads;
ordinary callers retain their existing warnings. Strict migration history reads
must not silently omit corrupt archived versions. See the owning
[upgrade runbook](./local-metadata-upgrade.md) for the formula and limitations.
Migration publication helpers accept the already checked project/dataset/settings
snapshot, so derived status and legacy resolution cannot bypass memory limits by
reopening drafts. History readers without that snapshot use bounded reads too;
permission/IO errors remain distinct from missing snapshots. Generated-fixture
tests guard these IO boundaries without reading application source text.
Budget regressions assert the fixed `source-bundle-limit` reason rather than
human-facing message wording, and cover direct and enclosing-budget reuse.
The supervised UI runtime fixture passes bootstrap `--import` paths as file
URLs, so Windows drive-letter paths work as well as Linux deployment paths.

Run `studio-server:verify:local-upgrade-images` with exact API/web/proxy image
references for the packaged, unmocked browser/conversion/restart/recovery gate.
It owns disposable volumes only, keeps API/executor egress isolated, and must
not point at VM/dev mounts. See the owning runbook for image environment names
and the remaining actual-VM-data rehearsal. `local-metadata-control --capacity`
provides a read-only resource preflight for that later rehearsal.
`local-metadata-control --check-workflows` reads the bounded workflow/publication
source without writing, opening control databases or certifying migration.
It emits counts or fixed diagnostic fields (failure exit 2). The runtime suite
covers held preflight IO, background fingerprint failure, same-job retries and
read-only project reference authorization. Do not rebuild/delete Core or Node
outputs concurrently with runtime tests that load those outputs in child
processes; that races the test harness, not migration authority.

Packaged-rehearsal SQLite probes use read-only connections with a bounded
five-second lock wait, rather than SQLite's default immediate failure beside
live API writes. Persistent locks and identity/integrity failures still block
qualification. Run `node --test deploy/studio-server/scripts/local-upgrade-rehearsal-safety.test.mjs`
for real journal/catalog contention and read-only regressions; this supplements,
not replaces, the complete packaged browser gate.

The image gate also bounds individual readiness/status reads across Compose
configuration and execution, rejects success after the polling deadline, and
does not retry ownership failures. Source-integrity receipts must contain valid
SHA-256 fingerprints before comparison; web-app policy evidence must identify
one complete binding rather than silently choosing among duplicates. The same
safety suite covers stalled/late probes and malformed or ambiguous evidence.

Local conversion and the legacy VM-to-managed importer cannot operate together.
The latter is blocked while local transition control is enabled, rather than
silently exporting retained stale files after SQLite cutover.

Both development and production Compose nginx templates preserve the complete
request `Host`, including a non-default port, with the normal nginx fallback for
Host-less HTTP/1.0 requests. Do not substitute `$host` directly on upstream
requests: it strips the port, making the operator API reject a legitimate
`Origin: http://localhost:8081` as cross-origin. Keep the API's origin check;
never work around this by relaxing authentication or trusting forwarded headers.
After changing a mounted template, restart only the dev proxy so its entrypoint
renders the new configuration; a plain nginx reload does not render templates.

`verify-proxy-dns.mjs` checks real upstream Host preservation through all three
templates for hostname/port, IPv6/port and default-port authorities. Run headless
`studio-server:ui:observe local-storage-upgrade-origin.spec.ts` on an enabled,
provisioned dev instance to verify the real gateway/API boundary. It sends only
malformed JSON to the action route, never a valid pause/copy/activation command,
and checks unchanged maintenance/transition state. Cross-origin and missing-intent
requests must remain forbidden. The ordinary `local-storage-upgrade.spec.ts`
continues to mock operator mutations and is safe against existing dev data.

Status polling has a ten-second request deadline. A hung response locks the
operator controls just like a failed or expired session; polling retries and
unlocks only after a fresh status response. Do not apply this short deadline to
inventory, fingerprint, copy or validation actions. A rejected action's error
must remain visible when status polling succeeds again.

## Model-node failure controls

LLM Chat and Classifier Evaluate share the node-owned error boundary documented
in [editor-bridge.md](./editor-bridge.md#model-node-error-behavior). The default
still throws failures. Explicit Catch all failures returns scalar Run failed /
Run error ports and excludes ordinary answer outputs. Disabling status throwing
handles only typed non-2XX failures. Keep explicit graph cancellation uncaught,
preserve retry and profile-fallback ordering, and do not cache caught failures or publish them
through the display-only terminal nodeError channel.

Focused verification:

```sh
yarn workspace @valerypopoff/rivet2-core exec tsx --test --test-concurrency=4 test/model/nodes/RunFailureNodes.test.ts test/model/nodes/LLMChatV2Node.test.ts test/model/chat-v2/*.test.ts test/model/classifier/*.test.ts test/model/nodes/HttpCallNode.*.test.ts test/model/SplitRunProcessor.test.ts test/model/GraphProcessor*.test.ts
PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe model-error-behavior.spec.ts jev-nodes.spec.ts --grep 'Error behavior switches|Classifier cards|legacy Jev'
```

The browser regression signs in through `authenticateIfNeeded` when the local UI
gate is enabled; `RIVET_KEY` must be available to the runner. It checks both Error
behavior toggles, dynamic ports, body summaries, exact saved fields and reload,
plus the adjacent Classifier card and legacy-Jev editor regressions. Expand
collapsed settings sections and click
visible switch labels rather than the hidden checkbox underneath their styled
track. Core tests cover the switch matrix, configuration/response failures,
causal errors, retry recovery, valid 2XX
responses, cancellation, profile fallback, diagnostics and editor cache hits.
They also cover null-prototype/cyclic thrown values, throwing accessors,
provider AbortErrors versus actual caller cancellation, Classifier local timeouts,
tool-continuation and cache failures, and Classifier rejected-body cleanup on final
failures, automatic retries, cleanup errors and indefinitely pending cleanup promises.
Real GraphProcessor split-run cases mix caught failures with successes in either
order and verify aligned failure flags, errors and normal-output array types.
Cancellation races also exercise a provider returning success after abort: no
successful model activity or cache entry may be published. Classifier deadline
tests cover late headers, late JSON reads, indefinitely pending transports and
disposing late responses; stream interruption must exclude partial LLM answers.
Keep response-read causes and HTTP statuses intact even if body cleanup fails.
The formatter regression creates real foreign-realm errors, including a nested
cause, rather than testing only same-realm objects with an AbortError name.

## HTTP body lifecycle verification

Media admission must match the JSON parser (`application/json` and `application/*+json`, not arbitrary `+json` suffixes). Check already-disconnected requests before installing stream listeners: authorization can await storage while the client disconnects, so relying only on future abort events strands parser capacity until timeout.

HTTP body lifecycle regressions live in `src/tests/body-admission.test.ts` in the API package. Test open uploads, not just complete buffers: overflow must return 413 before EOF, and cancellation must detach readers and close decoders before releasing permits. `body-reader.ts` owns bounded receipt; Express parses only the resulting finite stream. Never replace that boundary with a live Express parser, whose error path can drain an upload until EOF.

## Project workspace lifecycle regressions

Tree selection checks must use an overflowing folder list, not only a tiny tree. The `tree selection survives` browser case verifies that distant folder expansion stays in view, keyboard Enter/Space and Ctrl-click expand/collapse preserve the selected card, and reopening its own ancestor reveals the selected project again without reloading it. This catches scroll jumps from an overly broad expansion-map dependency as well as click-away deselection.

Keep opening and dirty-state behavior under the shared app owners (`useActivateOpenedProject`, `useWorkspaceHostOpenProject`, `useSyncProjectDirtyState`). Host wrappers may adapt IO, titles, Evaluation caching and executor policies, but must not duplicate activation or certify a recovered snapshot as clean.

Run the app hook/transition tests (`useLoadProject.test.tsx`, `useWorkspaceHostSave.test.tsx`, `projectActivationCoordinator.test.ts`, `staticDataCacheCoordinator.test.ts`, `projectEditorState.test.ts`, `workspaceTransitions.test.ts`, `projectUnsavedChanges.test.ts`) and the hosted web unit suite. Race tests must cover fresh opens versus tab activation, delayed path loads versus a newer selection, placeholder cancellation, edits/renames during hydration, and external rename followed by Undo. Include save failure and save-completion-after-switch cases; a successful older save must not clear newer edits. Also check scratch recovery without baselines, closing replacement tabs during IO, static-data edits during cache clearing and stale node callbacks after a tab switch. Cache failures must not poison later operations or mix independent workspaces.

Storage regressions also run `workspaceRecovery.test.ts`, `hybridStorage.test.ts`, `indexedDB.test.ts`, and `BrowserDatasetProvider.test.ts`: cover transaction abort after request success, quota/serialization failure with successful retry, atomic dataset replacement rollback, late dataset loads, inactive imports, project-scoped exports during tab switches, checkpoint forks on reload/duplicate, corrupt/missing records, and a recovery choice racing an older write. Hosted `deserialize-worker.test.ts` covers worker cancellation, timeout and subsequent usability; `editor-project-refresh.test.ts` covers deferred inactive refresh and a tab closed during preparation. A successful real project save must stay successful even when browser recovery fails.

The shared hook tests also exercise file-picker reopens of edited tabs and picker results arriving after a newer selection. The picker itself has no artificial deadline; cancellation guards apply to parsing/import after selection. Keep `browserFileInput.test.ts` in the verification set when changing asynchronous picker callbacks or native/browser IO signatures.

Required browser checks include `project-tree-activation.spec.ts`, `project-preview-mode.spec.ts`, `dashboard-save-button.spec.ts` and focused `workflow-tree-sync.spec.ts` cases. The activation test uses mocked workflow IO: it checks active/inactive edits, dirty indicators across page reload, saved-baseline reset only after persistence, resource-target restoration, delayed recovery cancellation, and reused-path identity rejection. Its static audio fixture verifies payload recovery despite a deliberately stale cache, then checks that a save retains the right project's payload. Inspect browser reports in `artifacts/playwright/`; no Kubernetes rehearsal is needed for these workspace UI changes.

The activation spec additionally uses two same-origin pages to verify isolated unsaved recovery and injects a checkpoint quota error to verify visible failure only while edits remain unsaved, truthful Save completion, and automatic retry. Its tree-selection case clicks actual padding on both sides of a nested project row, toggles unrelated folders and the selected project's ancestor, and clicks blank tree space: the selected card must remain and no extra project load may occur. Clicking another project must replace both row selection and the card. Run this focused check with `yarn studio-server:ui:observe test project-tree-activation.spec.ts --grep "tree selection survives"`. `indexedDB.test.ts` additionally closes the actual cached database without emitting a termination event and checks automatic reconnection, preserved records, and later writes; an aborted transaction must still reject. Mocked editor tests must call `mockHostedEditorBootstrap` so they do not depend on an ambient API's authentication or Evaluation library. Run the observe runner with `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`. When browser downloads are unavailable, `PLAYWRIGHT_EXECUTABLE_PATH` can select an already installed Chromium; the runner then skips its automatic install (the explicit `:install` command still installs). This is a local testing override, not a release qualification shortcut.

Its missing-checkpoint case must verify the dashboard actually reveals the iframe, Retry loading retries hydration without writing defaults, the recovery dialog opens/closes, and explicit Start empty can reach a normal ready handshake. Unrelated bootstrap failures (for example, the shared Evaluation service) must offer Retry loading without proposing destructive workspace replacement. Seeing a failure only in console/network is insufficient: controls must remain usable before the normal editor bridge exists.

Also cover close/move during the deferred import itself, not just during file reads. Restoring a valid snapshot must preserve cached datasets and accepted revisions while recovering a missing saved baseline; a verified native snapshot must not require another disk read on every tab switch. `hosted-project-revision-tracker.test.ts` and `editor-project-refresh.test.ts` verify cancelled reload rollback, concurrent path moves, pruned tabs, and save exclusion during reload. A cancelled refresh emits no false load-error notification.

The activation browser spec opens the same project in two windows, saves in one, reloads the other's unsaved snapshot, and checks that its save still uses the original expected revision and preserves dirty state on a 409. It also saves successfully while browser recovery fails, reloads the previous checkpoint, and proves that the recovered tab still uses its earlier expected revision. Wait for the committed checkpoint itself before testing reload, not only the rendered status. Revision authority belongs inside the atomic workspace checkpoint, not a separate session/localStorage cache. Missing revision context must block in-place save until the existing Reload/Keep mine review completes; do not adopt legacy independent caches. Unit coverage restores a checkpoint's own authority after explicit selection, protects initial IO binds through loading-placeholder updates, and keeps provisional load/reload revisions out of durable recovery until registration/replacement succeeds. Identical background observations must not dirty recovery or produce unnecessary unload warnings.

The lifecycle spec's reload scenarios use `waitForWorkspaceCheckpoint` to read the selected IndexedDB checkpoint and verify the active project, complete ordered tab list and any expected unsaved edits before navigating. A visible tab does not acknowledge the debounced recovery write, and `pagehide` cannot guarantee asynchronous IO after document teardown. This prerequisite applies to clean tabs too, including failed-tree and deleted-sidebar-selection scenarios. The helper resolves the current iframe on each read, so successive reloads never reuse a detached frame. It observes normal persistence without forcing a flush, saving to the server or adding fixed sleeps; reload and independent sidebar selection assertions remain unchanged.

The activation and Temperature specs share the read-only checkpoint reader in `playwright-observe/helpers/workspaceRecovery.ts`; scenario-specific assertions stay in their owning specs. Activation reload checks verify the active tab and ordered tab titles as well as node positions, since matching geometry alone can acknowledge an older workspace. Its static-cache and inactive-recovery scenarios also wait for normal persistence before reload. Grouped browser storage retains the one-second idle debounce but schedules checkpoints at least every five seconds during continuous editing; this is a scheduling bound, never an IO durability promise. The fake-clock busy-edit regression must verify the periodic checkpoint and the final trailing edit, alongside explicit-flush, cancellation, backend replacement and failure/retry tests.

Project v4 includes an optional `data` string record for static file/image payloads, separate from plugin `attachedData`. Saves must pass the captured payload to the IO provider before any await; do not clear the static-data dirty flag after persisting graph metadata alone. Run `test/utils/serialization.test.ts` in core for round-trip and malformed-payload coverage, and the app save test for edits arriving during persistence. Older v4 files without this field remain valid.

The active `projectDataState` is persisted with the workspace's `project` group. Mount it in `RivetAppLoader` before legacy cache recovery, so a clear/hydrate failure cannot make the next reload restore another tab's residual cache. `useLoadStaticData` imports the old cache only when no authoritative payload exists, overlays concurrent edits, and rejects results after any newer activation, including same-project reload. Nonempty legacy cache imports remain dirty until a real save; recovery alone cannot certify that their payload reached the project file. Deferred Monaco cleanup must recheck that the project is still closed both before and after importing the cleanup module; an immediate reopen may be using those models again.

## Node settings ownership regressions

The canonical [editor-session and Monaco contract](../MONACO-EDITOR-SURFACES.md#node-settings-ownership)
covers cloned project/graph/node IDs, irreversible callback lifetimes, synchronous
canonical edits and warm-buffer limits. [Workspace state](../EDITOR-WORKSPACE-STATE.md)
owns activation, dirty baselines and isolated browser recovery; these guarantees
apply to desktop/custom providers too, not just Studio Server.

Run the focused `NodeEditorSessionContext.test.tsx`, `nodeEditorSession.test.ts`,
`codeEditorModelCache.test.ts` and `nodeLibrary.test.ts` owner suites, then the App
typecheck and affected App/web suites. The root `yarn test:app` includes component
TSX tests; direct workspace `test` alone does not.

For the browser gate, use a fresh production build/preview rather than HMR,
set `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0` and `PLAYWRIGHT_BASE_URL` to
that preview, then run:

```sh
yarn studio-server:ui:observe node-editor-ownership.spec.ts node-editor-lifecycle.spec.ts project-tree-activation.spec.ts project-preview-mode.spec.ts dashboard-save-button.spec.ts
```

Inspect `artifacts/playwright/` for the current run. Tests must retain autofocus
and check both visible text and saved/recovered node data, including immediate
switch/Save/close, Undo/Redo while focused, authoritative reload, read-only variants
and AI completion after switching or cancellation. These browser fixtures mock
hosted IO and do not certify a production backend or native file dialog. No
database migration or Kubernetes rehearsal is needed for these editor changes.

## Setup commands

- `corepack enable`
  - makes the repository-pinned Yarn release available on a fresh machine
- `yarn install --immutable`
  - installs every Rivet and Studio Server workspace from the root `yarn.lock`
  - uses the repository-pinned Yarn release and PnP linker
  - fails when package manifests and the lockfile disagree
  - is the only supported dependency installation path; do not add nested
    lockfiles or package-local installs
- `yarn studio-server:build`
  - builds the Rivet packages required by Studio Server, then all five Studio
    Server workspaces in dependency order
  - is the fastest complete check that workspace exports and generated outputs
    line up after a cross-package change
- `yarn studio-server:setup:k8s-tools`
  - uses `RIVET_K8S_HELM_BIN`, system Helm on PATH, or an existing cached copy without a network request
  - only when none is available, downloads the pinned Helm release into `.data/tools/helm/` and verifies its SHA-256 checksum
  - retries transient download failures with a bounded timeout; failures report the asset URL and underlying cause
  - use this when you want Kubernetes verification or the local Kubernetes launcher to work without a system Helm install

## Versioning

The five private `@valerypopoff/rivet-studio-server-*` workspaces form one
Studio Server product and use one lockstep package version. Their current
version is `1.22.0`. `yarn studio-server:verify:repo-structure` rejects version
drift between the API, web, executor, shared, and bootstrap manifests.

These private package versions are release metadata, not npm publication or
container selectors. Studio Server images are built together from one Git
commit and promoted by immutable OCI digest. The Helm chart's `version` and
`appVersion` are separate chart metadata and must not be changed merely to
bump the private workspace manifests.

## Main commands

The root `yarn security:audit` gate checks the complete JavaScript dependency
tree, including Studio Server's container bootstrap and the documentation
toolchain. Keep newly reported high-severity findings blocking unless a
documented exception is deliberately reviewed. The root Yarn resolutions pin
Joi 17.13.8 for Docusaurus and Undici 6.28.1 for its 6.x consumers; the
bootstrap package also requires the patched Undici range. Axios is kept at
1.20.0 or later in its 1.x line for Gentrace consumers, covering the September
2026 URL, redirect, proxy, HTTP/2, and option-handling advisories. When changing
these pins, regenerate `yarn.lock` and the committed PnP cache, then rerun the audit
and the bootstrap build. The three `brace-expansion` resolutions follow its
separate 1.x, 2.x, and 5.x compatibility lines for the respective `minimatch`
consumers; do not replace them with one cross-major override.

The October 2026 audit fixes also require Compression 1.8.2, Proxy-addr
2.0.8 and Source-map-js 1.2.2. Root resolutions keep these transitive fixes
in the zero-install graph, including Express's `~2.0.7` Proxy-addr dependency.
The Docusaurus `tinypool@^1.0.2` edge is deliberately overridden to 2.1.2:
both critical prototype-pollution advisories require the 2.x fix, and the
repository's Node 22 baseline satisfies its Node 20/22 requirement. Keep this
override scoped to that dependency edge rather than forcing arbitrary future
Tinypool consumers onto it. Validate the Docusaurus worker-thread SSG path
(`future.faster.ssgWorkerThreads`, with
`future.v4.removeLegacyPostBuildHeadAttribute`, and
`DOCUSAURUS_SSG_WORKER_THREAD_COUNT=2`) when updating it; a normal single-threaded
docs build does not exercise Tinypool. These fixes add no audit exceptions.
See the upstream [Compression advisory](https://github.com/advisories/GHSA-vc2v-76pw-4v95),
[Proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
[Source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), and
Tinypool [worker-options](https://github.com/advisories/GHSA-5gmw-xhrv-c9v3) /
[run-options](https://github.com/advisories/GHSA-85c8-ppgw-ccpr) advisories.

`yarn test:style` also runs `dependency-security-regressions.test.mjs` against
Express's and Docusaurus's actual transitive dependencies. These behavioral
checks cover spoofed forwarded addresses with short mapped/zero-leading IPv6
trust prefixes, correct IPv4/mapped subnet matching, and inherited worker
environment, arguments, and per-run filenames. Worker checks run in bounded,
disposable child processes and use harmless sentinels, not executable payloads.
They protect the security fixes without adding a full docs build to every test
run; they do not replace the worker-thread SSG compatibility build above.
Run them alone with
`yarn node --test scripts/checks/dependency-security-regressions.test.mjs`.

The command contract is deliberate: `yarn dev` starts the Rivet desktop/editor,
while `yarn studio-server:dev`, `yarn studio-server:prod`, and
`yarn studio-server:prod:custom` own Studio Server development and deployment.
The retired `npm run prod` and `npm run prod:custom` commands have no
compatibility aliases.

| Command                                                                                                                                                                                                                         | What it does                                                                                                                                                                                                             | Typical use                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `yarn studio-server:clean`                                                                                                                                                                                                      | Prints a Docker-host-wide preflight, then requires explicit confirmation before pruning stopped containers, unused networks/images, and builder cache; Docker volumes are preserved                                      | Recover VM disk space after repeated pulls/builds or `ENOSPC` failures                                              |
| `yarn studio-server:dev` / `yarn studio-server:dev:docker`                                                                                                                                                                      | Starts or reuses the Docker dev stack, reconciles changed Compose files or overlays, and reloads the proxy after the services are ready                                                                                  | Closest-to-production browser testing                                                                               |
| `yarn studio-server:dev:docker:recreate`                                                                                                                                                                                        | Rebuilds and recreates the complete Docker dev stack                                                                                                                                                                     | Force a full reset after Dockerfile, image, or mounted-runtime changes                                              |
| `yarn studio-server:dev:docker:build`                                                                                                                                                                                           | Builds the Docker dev images from the monorepo root                                                                                                                                                                      | Validate image inputs without starting services                                                                     |
| `yarn studio-server:dev:docker:config`                                                                                                                                                                                          | Renders the unexpanded Docker dev Compose topology without starting containers or printing dotenv values                                                                                                                 | Inspect launcher/Compose structure safely                                                                           |
| `yarn studio-server:dev:docker:services`                                                                                                                                                                                        | Lists the Docker dev services enabled by the selected dotenv and Compose profiles                                                                                                                                        | Verify whether optional managed dependencies are active                                                             |
| `yarn studio-server:prod:config`                                                                                                                                                                                                | Renders the unexpanded production Compose topology without pulling images or starting containers                                                                                                                         | Inspect production launcher/Compose structure safely                                                                |
| `yarn studio-server:prod:services`                                                                                                                                                                                              | Lists the production services enabled by the selected dotenv and Compose profiles                                                                                                                                        | Verify profile selection without pulling images or starting containers                                              |
| `yarn studio-server:dev:docker:down` / `yarn studio-server:dev:down`                                                                                                                                                            | Stops the Docker dev stack                                                                                                                                                                                               | Cleanup                                                                                                             |
| `yarn studio-server:dev:recreate`                                                                                                                                                                                               | Alias for `yarn studio-server:dev:docker:recreate`                                                                                                                                                                       | Preserve the pre-monorepo command surface                                                                           |
| `yarn studio-server:dev:docker:ps`                                                                                                                                                                                              | Shows Docker dev container status                                                                                                                                                                                        | Diagnostics                                                                                                         |
| `yarn studio-server:dev:docker:logs`                                                                                                                                                                                            | Streams Docker dev logs                                                                                                                                                                                                  | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test`                                                                                                                                                                                        | Builds local images, deploys the local Kubernetes rehearsal stack, and starts a proxy port-forward                                                                                                                       | Most authentic local browser rehearsal against managed external services                                            |
| `yarn studio-server:dev:kubernetes-test:recreate`                                                                                                                                                                               | Rebuilds images, recreates the local Kubernetes rehearsal namespace/release, and restarts the proxy port-forward                                                                                                         | Reset the local Kubernetes rehearsal cleanly                                                                        |
| `yarn studio-server:dev:kubernetes-test:config`                                                                                                                                                                                 | Generates the local Kubernetes values file and renders the Helm manifest                                                                                                                                                 | Verify local Kubernetes launcher wiring without deploying                                                           |
| `yarn studio-server:dev:kubernetes-test:ps`                                                                                                                                                                                     | Shows local Kubernetes rehearsal pods, deployments, statefulsets, and services                                                                                                                                           | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test:logs`                                                                                                                                                                                   | Streams logs for the local Kubernetes rehearsal release                                                                                                                                                                  | Diagnostics                                                                                                         |
| `yarn studio-server:dev:kubernetes-test:down`                                                                                                                                                                                   | Stops the proxy port-forward and removes the local Kubernetes rehearsal release/namespace                                                                                                                                | Cleanup                                                                                                             |
| `yarn studio-server:dev:local`                                                                                                                                                                                                  | Starts API, web, and executor as local processes                                                                                                                                                                         | Process-level debugging                                                                                             |
| `yarn studio-server:dev:local:api`                                                                                                                                                                                              | Starts only the API locally                                                                                                                                                                                              | API debugging                                                                                                       |
| `yarn studio-server:dev:local:web`                                                                                                                                                                                              | Starts only the Vite web app locally                                                                                                                                                                                     | Frontend work                                                                                                       |
| `yarn studio-server:dev:local:executor`                                                                                                                                                                                         | Starts only the executor locally                                                                                                                                                                                         | Executor debugging                                                                                                  |
| `yarn studio-server:prod`                                                                                                                                                                                                       | Pulls the prebuilt Rivet 2 images, force-recreates the production-style Docker stack, and waits for health                                                                                                               | Normal VM deployment/update path                                                                                    |
| `yarn studio-server:staging`                                                                                                                                                                                                    | Checks the staging checkout, image revisions, and existing data mounts before running digest-pinned staging images in the same VM stack                                                                                  | Rehearse a verified staging build against the existing VM data                                                      |
| `yarn studio-server:prod:restart`                                                                                                                                                                                               | Force-recreates the production-style Docker stack from already-local images without pulling or building                                                                                                                  | Pick up `.env` changes without changing the running image version                                                   |
| `yarn studio-server:prod:custom`                                                                                                                                                                                                | Builds and force-recreates the production-style Docker stack from the current monorepo commit                                                                                                                            | Test unpublished Rivet and Studio Server changes together                                                           |
| `yarn studio-server:test`                                                                                                                                                                                                       | Verifies the migration ledger, cleanup safety contract, builds Studio Server dependencies/workspaces, runs API and pure web tests, and executes host-compatibility, test-style, repo-structure, and Kubernetes contracts | Required one-command pre-push gate for Studio Server changes                                                        |
| `yarn studio-server:verify:filesystem`                                                                                                                                                                                          | Runs the repo-local compatibility baseline for single-host filesystem mode                                                                                                                                               | Check that filesystem mode still has build/test and launcher-contract coverage                                      |
| `yarn studio-server:verify:filesystem:docker`                                                                                                                                                                                   | Verifies the filesystem Docker launcher shape with a disposable env/fixture root                                                                                                                                         | Check that Docker launcher config still supports filesystem mode without managed services                           |
| `yarn studio-server:verify:local-docker`                                                                                                                                                                                        | Verifies managed-storage local-Docker launcher shape with a disposable env/fixture root                                                                                                                                  | Check that the managed rehearsal still enables local Postgres plus explicit object-storage wiring                   |
| `yarn studio-server:verify:local-docker:split`                                                                                                                                                                                  | Runs split-topology repo-local checks plus local-Docker launcher validation                                                                                                                                              | Check that split-era control/execution contracts still fit the local-Docker managed rehearsal model                 |
| `yarn studio-server:verify:migration-ledger`                                                                                                                                                                                    | Reconciles every file in the preserved Studio Server import tree with its reviewed monorepo disposition and current destination                                                                                          | Prove that no tracked source file was silently omitted during consolidation                                         |
| `yarn studio-server:verify:repo-structure`                                                                                                                                                                                      | Verifies the intended authored repo layout and blocks legacy path drift                                                                                                                                                  | Catch misplaced runtime/deployment/tooling files before they spread                                                 |
| `yarn studio-server:verify:clean`                                                                                                                                                                                               | Runs the Docker-host cleanup authorization, target, and command-set regression tests without contacting Docker                                                                                                           | Protect the cleanup safety contract                                                                                 |
| `yarn studio-server:verify:dev-watcher`                                                                                                                                                                                         | Runs the API dev-watch workspace-output recovery regression test                                                                                                                                                         | Catch a Core/Node/Evaluations rebuild stranding the API watcher                                                     |
| `yarn studio-server:verify:test-style`                                                                                                                                                                                          | Verifies test command manifests and test-suite style guardrails                                                                                                                                                          | Catch accidental focused tests, missing command entries, broad suite reintroduction, and upstream-source assertions |
| `yarn studio-server:verify:web-pure`                                                                                                                                                                                            | Runs the pure web helper tests with `tsx --test`                                                                                                                                                                         | Catch regressions in extracted non-React dashboard/protocol helpers quickly                                         |
| `yarn studio-server:verify:kubernetes`                                                                                                                                                                                          | Runs Kubernetes launcher/chart contract tests, including protected capacity/Evaluation runner configuration, then renders the local rehearsal values path and lint-renders the production overlay                        | Catch local/prod chart or operator-runner drift before handing the repo to operators                                |
| `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`                                          | Calls one published/latest workflow endpoint repeatedly and prints workflow and optional CodeRunner timing headers                                                                                                       | Measure filesystem or managed execution behavior safely                                                             |
| `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10`                                                                                                       | Publishes the benchmark fixture into an isolated temp filesystem workflow root and compares legacy-compatible CodeRunner flags with the optimized path                                                                   | Repeat the local graph-fixture before/after benchmark without touching real workflows                               |
| `yarn workspace @valerypopoff/rivet-studio-server-api run build && yarn workspace @valerypopoff/rivet-studio-server-api run recording-input:benchmark --scenario recent --recordings 250 --payload-kib 32 --read-latency-ms 25` | Compares async parent decoding and worker decoding, single/multi-window HTTP pagination, cold/warm/shared loads, and a benchmark-only tokenizer using production SQLite queries                                          | Measure recording-input search changes before claiming a latency or event-loop improvement                          |
| `yarn studio-server:runtime-libraries:managed:audit`                                                                                                                                                                            | Audits managed runtime-library release/job/object state and writes a JSON snapshot                                                                                                                                       | Inspect live managed runtime-library state safely                                                                   |
| `yarn studio-server:runtime-libraries:managed:prune`                                                                                                                                                                            | Builds a dry-run prune plan for managed runtime-library state                                                                                                                                                            | Review cleanup impact before applying it                                                                            |
| `yarn studio-server:ui:observe:install`                                                                                                                                                                                         | Installs Playwright Chromium for observable frontend runs                                                                                                                                                                | First-time browser setup                                                                                            |
| `yarn studio-server:ui:observe`                                                                                                                                                                                                 | Runs the headed slow-motion Playwright flow against the current hosted app                                                                                                                                               | Watch the browser click through a real scenario                                                                     |
| `yarn studio-server:ui:observe:debug`                                                                                                                                                                                           | Runs the same flow with Playwright Inspector enabled                                                                                                                                                                     | Step through or pause browser actions                                                                               |
| `yarn studio-server:ui:observe:report`                                                                                                                                                                                          | Opens the last Playwright HTML report                                                                                                                                                                                    | Review traces, screenshots, and videos after a run                                                                  |
| `yarn studio-server:ui:ci`                                                                                                                                                                                                      | Runs headless hosted-editor regressions against a fresh Vite host, including output paging, sidebar, streaming, workspace recovery and node-editor ownership/lifecycles                                                  | Reproduce the current hosted-editor CI browser gate locally after installing Chromium                               |

`yarn studio-server:clean` is intentionally Docker-volume-safe but Docker-host-wide. It first prints the selected Docker context/endpoint, a concise Docker disk summary, and counted stopped-container, custom-network, and image inventories (showing at most 20 rows from each inventory). Docker evaluates the latter two inventories for unused resources only at prune time. Run `yarn studio-server:clean -- --dry-run` to stop there. An interactive terminal must then type `PRUNE`; automation must pass `--confirm-host-prune`. The command rejects remote or unknown endpoints before Docker preflight unless the caller also supplies both `--allow-remote-docker-host` and `--confirm-host-prune`. When it resolves the currently selected context, it pins that context on every later Docker invocation so a concurrent `docker context use` cannot retarget the cleanup. This prevents an inherited Docker context or `DOCKER_HOST` from silently cleaning another machine.

The authorized cleanup can remove stopped containers, unused custom networks, unused images, and unused builder cache for **any** project on the selected host. It does not pass `--volumes`, run `docker volume prune` or `docker system prune`, or invoke Compose teardown. Local Compose volumes that may hold Postgres data, app data, workspace cache, or runtime-library state are preserved; filesystem workflow and recording host paths are also outside Docker's prune surface. The tradeoff is that stopped-container metadata/logs are lost, stopped stacks may need to recreate/pull images, and custom/dev builds may rebuild layers. `yarn studio-server:verify:clean` tests this contract without contacting Docker; a failure during a real prune stops subsequent steps and reports the already-completed, non-reversible cleanup.

## Deploying a verified staging build to a VM

Push Studio Server changes to `develop` for the normal Build and Verify Studio Server checks, then open a PR into `staging`. That PR runs Verify Studio Server but not the repository-wide Build matrix. If staging branch protection requires the old `Build` check, replace that requirement with the Studio Server `verify` check; otherwise the PR will wait for a check that no longer runs.

A relevant `staging` push runs Build Images, whose reusable verifier checks Studio Server once before the VM candidate is promoted. It builds four immutable candidate images and runs the candidate image and local-upgrade rehearsals, but skips the desktop/Rust Build matrix, duplicate standalone verification, and managed Kubernetes Kind gate. The separate protected Kubernetes provider/capacity/Evaluation gates remain explicit manual dispatches. `staging` never updates `latest` or the durable production release pointer; those remain `main`-only. Retagging the four images is not atomic, so a failed promotion can leave `staging` aliases at different versions. The alias alone is never proof that the latest push passed or that all four images match.

For a VM rehearsal, wait for the **Build Images** run for the intended `staging` commit to succeed, switch the VM checkout to that commit on the `staging` branch, and run `yarn studio-server:staging`. It uses the same Compose project, dotenv, TLS overlay, durable volumes, and launcher-derived artifact paths as production. Before recreating containers it requires a clean tracked checkout and an existing API container in the selected Compose project; it checks the API/initializer artifact bind mounts and named app-data, workspace, and SQLite metadata volumes against that container. It then pulls all four `:staging` image aliases, verifies their source-revision labels against Git HEAD, and pins the three running services to the pulled immutable digests. It renders Compose again and requires every service, including the artifact initializer, to use the verified digest and unchanged mounts. It also checks that the API image contains the combined-backend supervisor. A failed check leaves the running containers alone. If the old API container was deleted, restore or inspect the intended Compose project and data volumes before using another deployment method; this command will not guess which state belongs to the VM. The command neither edits `.env` nor starts the local storage upgrade. Do not infer a green CI run merely from matching aliases: image promotion is not atomic, so confirm the intended Build Images run in GitHub first.

The older manual route remains available: set exactly one `RIVET_IMAGE_TAG=candidate-<commit SHA>-<run ID>-<run attempt>` from a successful run in the VM `.env`, then run `yarn studio-server:prod`. Do not use the default `latest` tag to test staging; it is the main-branch production alias. If `.env` contains a staging tag or individual image overrides from a VM trial, remove or update them explicitly before a later main-line production deployment. Pulling a staging image does not select it for Compose by itself.

Running staging images against the production VM's existing data is still a live deployment, not an isolated rehearsal. Back up and test restore of the persistent roots and encryption key first; after new writes or a storage/schema upgrade, changing the image tag back may not restore the old data contract. Promote to `main` only after the staging run and VM checks are satisfactory; the `main` run must pass its own gates before it advances `latest` and the production release pointer.

## Proxy DNS recovery and health

Proxy startup fetches the authenticated, read-only
`GET /internal/app-settings/proxy-config` snapshot before starting Nginx. The
migration request barrier must permit this exact method/path during migration
maintenance and local-selection restart/validation fences; otherwise recreating
the proxy while storage is paused locks operators out of the recovery UI. The
route still requires proxy authentication and returns `Cache-Control: no-store`.
Do not broaden this exception to other internal routes, writes, or public GET
execution routes. `api-profile.test.ts` recreates combined/control API apps after
persisting each fence and checks unchanged settings/journal bytes, rejected
credentials, method/path lookalikes, and continued execution/write fencing.
`vm-migration-maintenance.test.ts` checks exact-route drain accounting and permits
the recovery read without clearing or rewriting a damaged maintenance marker.
These tests read only test-owned temporary journal/marker artifacts, not
implementation source, and carry the required `test-style: fixture-read`
annotations; see [repository test guardrails](../BUILD-AND-CI.md#yarn-teststyle).
The companion executor startup configuration exception is also exact `GET` only;
its loopback, proxy-token and executor-token requirements remain unchanged.

Proxy service destinations use runtime DNS resolution consistently across the
development, Compose production, and packaged image templates. Do not add literal
service `proxy_pass` destinations: their startup-resolved upstreams can also shadow
variable-based destinations and retain an obsolete container IP. The existing
30-second DNS cache bounds address refresh; a service restart can briefly interrupt
requests, but recovery must not require a proxy restart. The dev launcher's reload
after startup remains an additional safeguard.

The dev proxy health check exercises `/` through the normal UI authentication gate
and separately checks the web service. Both must return HTTP 200; a login page is
valid, but cannot conceal a failed web service. No credentials or auth bypass are
introduced. The auth prefix rewrite preserves nested paths and query strings, and
explicit redirect rules retain the original upstream redirect behavior.

Run `node deploy/studio-server/scripts/verify-proxy-dns.mjs` with Docker available
after modifying these routes. It uses an isolated network and disposable mock
containers with the real templates. The fixture explicitly allocates and verifies
a private `/24` subnet before assigning fixed mock addresses; it safely retries
another private range when an existing Docker network overlaps. This is required
because Docker rejects `--ip` on its automatically addressed bridge networks.
It verifies API/web IP replacement without Nginx reload, recovery within 45 seconds,
health failures/recovery, auth, redirects, POST bodies, SSE, and WebSocket upgrades.
It removes only its own fixtures. Also
run the API proxy-image contract tests and `yarn studio-server:ui:observe proxy-routing.spec.ts`
with `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`; require a fresh report under
`artifacts/playwright/`, not merely a successful launcher exit.
The Studio Server deployment-contracts gateway CI lane also runs the isolated DNS fixture.

## Environment loading

Studio Server launcher scripts load env with `deploy/studio-server/scripts/lib/dev-env.mjs`.

Current behavior:

- they look for `.env` first, then `.env.dev`
- if `.env` exists, `.env.dev` is ignored
- if `RIVET_ENV_FILE` is set, the launchers and compatibility verification scripts use that explicit env file instead of `.env` / `.env.dev`
- Docker launchers attach that exact selected dotenv as a runtime-only `env_file` for the combined backend in both production and development. This makes arbitrary provider credential aliases available to published workflow endpoints, web-app actions, and editor Node-executor runs without copying the host's unrelated ambient environment or injecting the dotenv into `web`/browser code.
- Treat projects allowed to run in Node/headless mode as trusted code. A Code node with `Allow process` enabled can inspect the executor/API process environment, so the runtime-only dotenv boundary protects browser JavaScript but is not a sandbox between server-side workflows and other secrets in that dotenv.
- missing values get defaults for:
  - `RIVET_WORKSPACE_ROOT`
  - `RIVET_APP_DATA_ROOT`
  - `RIVET_RUNTIME_LIBRARIES_ROOT`
- if `RIVET_ARTIFACTS_HOST_PATH` is present, the launcher resolves it to an absolute host path and derives:
  - `RIVET_WORKFLOWS_HOST_PATH=<artifactsRoot>/workflows`
  - `RIVET_WORKFLOW_RECORDINGS_HOST_PATH=<artifactsRoot>/workflow-recordings`
  - `RIVET_RUNTIME_LIBS_HOST_PATH=<artifactsRoot>/runtime-libraries`
- image builds use the repository root as their only build context; the root
  Yarn metadata and required workspace sources therefore come from one commit
- if `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, or `RIVET_RUNTIME_LIBS_HOST_PATH` is present, the launcher resolves it to an absolute host path before invoking Docker Compose
- explicit `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` values override the derived paths from `RIVET_ARTIFACTS_HOST_PATH`

Operational note:

- `deploy/studio-server/.env.example` is the minimal single-host Docker Compose starting point: host port, durable artifact root, UI access mode, and shared key. The launchers and Compose own internal ports, service defaults, image selection, and role values. Kubernetes rehearsals use their dedicated `.env.kubernetes-local.example` template. Keep optional tuning and overrides in the relevant operator guidance, and keep App Settings values out of the copied environment template.
- `Settings` -> `Storage` is the operator surface for choosing filesystem versus managed storage and saving managed database/object-storage credentials. Fresh/upgraded single-host deployments persist this domain in SQLite; legacy file mode uses `settings/deployment-storage.json`. Kubernetes persists the same typed domain as encrypted PostgreSQL settings; migration seeds a missing row from validated Helm/Vault values in memory, APIs load it directly, and the co-located executor receives an authenticated loopback snapshot. No Kubernetes startup settings projection is written. If no value exists in single-host mode, built-in `Local folders` plus `Local Docker Postgres` defaults seed the first revision. Restart/recreate Docker services or roll out Kubernetes API/executor pods after changing storage settings so singleton backends are rebuilt.
- Switching `Settings` -> `Storage` does **not** migrate existing data. `Settings` -> `Migration` on a filesystem-backed single-host VM tests the destination, activates a persistent source maintenance barrier, drains admitted work, then runs the copy and separate verify child processes. Its status file contains no credentials; an interrupted job must be retried with freshly entered secrets. The source remains paused after success. The detailed inventory, CLI fallback, and operator-controlled Kubernetes traffic cutover are in [VM to managed migration](vm-to-managed-migration.md). Never enable destination serving pods on a partial copy.
- Kubernetes requires `appSettings.backend=postgres`. Prefer a dedicated Secret/Vault value for `RIVET_APP_SETTINGS_ENCRYPTION_KEY`; `RIVET_KEY` is a compatibility fallback. Rotation is a three-rollout operation: first deploy the old primary with the new key as the accepted secondary, then deploy the new primary with the old key as secondary, and remove the old key only after every pod runs the new primary. This prevents old rolling-update pods from encountering rows encrypted with a key they do not know.
- `RIVET_ARTIFACTS_HOST_PATH` remains the launcher bootstrap/default for filesystem-mode host mounts
- `RIVET_WORKFLOWS_HOST_PATH`, `RIVET_WORKFLOW_RECORDINGS_HOST_PATH`, and `RIVET_RUNTIME_LIBS_HOST_PATH` remain compatibility overrides for the launcher
- the staging launcher requires an existing API container and refuses rendered artifact binds or named data volumes that differ from its mounts; this protects a VM's project tree, settings, and SQLite metadata against a healthy-looking deployment backed by newly created empty storage. Planned data moves need a separate reviewed procedure, not a staging image update.
- use the repo launchers (`yarn studio-server:dev`, `yarn studio-server:prod`, `yarn studio-server:dev:docker:*`, or the Docker launcher scripts) for Docker runs; a raw `docker compose --env-file .env ...` invocation only reads the variables already present in the env file and does not derive absolute workflow, recording, or runtime-library host paths from `RIVET_ARTIFACTS_HOST_PATH`. When those per-path host variables are omitted, Compose falls back to isolated `.data/workflows`, `.data/workflow-recordings`, and `.data/runtime-libraries` directories under the repo rather than the external artifact root.
- Docker launchers intentionally drop ambient host `NODE_OPTIONS` unless `.env` defines `NODE_OPTIONS` explicitly. This keeps Yarn 4/PnP host preloads such as `--require F:\...\.pnp.cjs` from being interpolated into Linux container startup commands while leaving non-Docker local runners alone.
- The Docker development `web` and `api` services install their disposable dependencies with Yarn's `node-modules` linker, but the repository itself stays on tracked Yarn PnP loaders. Before each container-side install, the Compose helper snapshots the host `.pnp.cjs` and `.pnp.loader.mjs` and restores their contents and ownership only if that install removed them. This makes `yarn studio-server:dev` safe to run alongside normal host Yarn commands. If the loaders are already missing, it fails before changing dependencies and tells you to run `corepack enable && yarn install --immutable`; do not work around it with a raw `npm install`.
- Docker dev mode bind-mounts the owning monorepo package sources. The API and
  executor consume built Rivet workspace exports, while the hosted web build
  aliases selected editor sources and hosted overrides through Vite.
- A Docker Desktop/Windows host-file bridge failure can surface as esbuild
  `input/output error` messages for many unrelated Core imports. Those imports
  are not missing: Docker cannot read `/workspace`. The launcher makes a
  read-only Core-source bind-mount probe before bringing up a new Docker dev
  stack, and stops with a direct host-mount diagnostic instead of leaving proxy
  `502` noise. If the bridge fails after a successful probe, the launcher
  recreates the dev stack once; if that retry also has the exact kernel error,
  it tears the failed stack down and reports the host-mount cause. Named volumes
  and mounted workflow, recording, runtime-library, and app data are preserved.
  Do not remove imports or rebuild dependency volumes to address such errors.
  Restore Docker Desktop access to the checkout (restart Docker Desktop, or use
  a checkout on the WSL filesystem), then rerun `yarn studio-server:dev`; it is
  not a Core compilation error.
- The hosted web package declares every browser dependency imported by its
  source graph directly. Keep those versions aligned with the owning Rivet
  workspaces instead of relying on incidental transitive dependencies.
- Set `PINECONE_API_KEY` in the launcher env file for Node-executed Pinecone Knowledge Stores, including the `Sync Knowledge Source` node. Both Docker launchers pass it only to the combined backend, where API and executor processes inherit it. This covers published endpoint/web-app runs and editor Node-executor runs without exposing the secret to the browser. The same runtime-only path supports arbitrary built-in LLM credential aliases such as `BILLING_OPENAI_KEY`; configure the matching environment-variable name on the LLM Chat or LLM Profile node. Do not add server-only credentials to `RIVET_ENV_ALLOWLIST`; that allowlist is only for browser-visible hosted-env lookups. Pinecone Knowledge Stores are not supported by the Browser executor. Kubernetes deployments using the Vault dotenv integration should add the key to that injected dotenv so both API and executor processes inherit it.
- Changing a launcher dotenv credential does not mutate an already-running process environment. Recreate the relevant Docker services with `yarn studio-server:dev:docker:recreate` for development or `yarn studio-server:prod:restart` for production; a browser reload alone is not enough. Browser-executor aliases additionally require the exact variable name in `RIVET_ENV_ALLOWLIST`, then a container recreate and browser reload, unless the credential is supplied through Rivet Settings or the API-key input port. Protected server-credential names remain denied even when listed; this includes sensitive-name variants and common database credentials such as `PGPASSWORD`, `MONGODB_URI`, and `REDIS_URL`. Use a purpose-specific `*_API_KEY` alias for an intentionally browser-visible provider key instead of reusing a password, secret, token, credential, database, signing, encryption, or object-storage credential name.
- `Settings` -> `Environment variables` stores runtime overrides through the active App Settings repository. The compact settings table keeps saved values masked by default; an authenticated no-store eye action reveals only one requested value. These values override launcher dotenv values for every new workflow endpoint, web-app, and editor Node-executor run; active runs retain their captured immutable overlay. Kubernetes control and execution APIs read the encrypted PostgreSQL setting, and the co-located editor executor retrieves the current overlay through its authenticated loopback API. The `Browser` checkbox opts one value into Browser-executor lookup; protected secret-like names remain denied. External Remote Debugger processes do not receive wrapper-managed variables.
- App Settings -> `General` controls trusted-client bypasses. Verified saved client IPs/networks bypass the UI key gate, web-app auth, and workflow endpoint bearer checks. Hostnames and the legacy `RIVET_UI_TOKEN_FREE_HOSTS` env var never authorize access. Forwarding proxy networks are deployment-owned; see [Trusted clients](trusted-clients.md). App Settings -> `Shell execution` controls editor-side allowed-command timeout and captured-output limits, not workflow execution. Proxy settings polling still updates route/timeout configuration, but no longer distributes bypass policy.
- App Settings -> `Workflow endpoints` controls the published/latest workflow route slugs, the default-on `Authorization: Bearer <RIVET_KEY>` requirement for public workflow endpoint calls, and the nginx HTTP request timeout for `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_APPS_BASE_PATH}`. The auth and timeout values live in the active `workflow-endpoint-auth` and `runtime-limits` domains (SQLite for fresh/upgraded local installations, legacy `settings/workflow-endpoint-auth.json` and `settings/runtime-limits.json` in file mode, or encrypted PostgreSQL in managed mode). The timeout is saved in seconds and defaults to `180`.
- App Settings -> `Web apps` -> `Button data` controls the largest JSON payload a web-app button may send when running a graph. It is shown in MiB, defaults to `100 MiB`, and is stored as `webAppActionRequestLimitBytes` in the runtime-limits settings domain. Saving updates API-side HTTP parsing immediately. The proxy receives the non-secret limit through its settings source and safely reloads nginx; Kubernetes uses the authenticated internal snapshot while single-host deployments use the file watcher. WebSocket `maxPayload` is captured when an API process starts, so gracefully restart/roll out API pods after active actions complete to apply a changed limit to new sockets. The `1 MiB` to `1 GiB` bound does not override an outer ingress/CDN/body limit.
- HTTP parsing is route-owned, never application-global: protected control-plane and workflow routes authenticate before decoding, while web-app actions complete their existing route/gate/OAuth/project preflight before decoding. The preflight captures the current action body limit, has a 15-second client deadline, and retains one of its 16 permits until any timed-out storage work settles; do not release that permit merely because the response timed out. The same shared admission controller covers JSON and URL-encoded sign-in forms. The process permits at most four simultaneous body parsers and at most `1 GiB` of body reservations. Unknown-length and compressed requests reserve their full decoded route limit; known identity-encoded requests reserve their declared length. An async handler keeps its parsed-body reservation until its own work settles, even after a client disconnect, while releasing the short-lived parser slot. This admission is separate from graph-run capacity and must remain so. JSON routes reject body-bearing unsupported media types before their handlers run. Do not move a broad JSON or URL-encoded parser above those route boundaries. See `access-and-routing.md` for the complete route inventory, exact limits, error codes, and receive-timeout behavior.
- App Settings -> `Docker` controls how long the npm Docker launchers wait for Compose services to become healthy. The saved value is in seconds and defaults to `1200` when the settings file or a running container is unavailable. Kubernetes does not use this setting.
- Storage/database `.env` values are ignored by the Docker API/executor runtime. Use the Storage tab for workflow/runtime-library storage and database settings; in object-storage mode `RIVET_RUNTIME_LIBRARIES_ROOT` remains only a local cache/workspace
- optional managed runtime-library readiness tuning uses:
  - `RIVET_RUNTIME_LIBRARIES_SYNC_POLL_INTERVAL_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_RETENTION_MS`
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_STATUS_CLEANUP_INTERVAL_MS`
- split-topology launches can also override:
  - `RIVET_API_PROFILE=combined|control|execution`
  - `RIVET_DEPLOYMENT_TOPOLOGY=single-host|replicated` — operational metadata for `Settings` -> `Deployment`; it describes the actual launcher topology and does not create replicas
  - `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint|editor|none`
  - `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=true|false`

## Compatibility matrix

The non-cluster compatibility modes that should keep working are:

| Storage/runtime shape                        | Support status                                                               | What it is for                                                                                              | What must be true                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem + combined`                      | Supported                                                                    | Primary backward-compatible single-host operation                                                           | Local workflow tree and runtime-library root remain authoritative                                                                      |
| `filesystem + control`                       | Supported                                                                    | Secondary control-plane-only debugging and admin validation                                                 | Control-plane/admin/latest routes still boot without managed services                                                                  |
| `filesystem + execution`                     | Unsupported by design                                                        | None                                                                                                        | `RIVET_API_PROFILE=execution` must fail fast unless storage mode is `managed`                                                          |
| `managed + local-docker + combined`          | Supported                                                                    | Existing Postgres plus explicit object-storage rehearsal path through Docker dev or production-style Docker | Start the `workflow-managed` Compose profile and enter the MinIO URL/keys in Settings before restarting into object-storage mode       |
| `managed + local-docker + control/execution` | Supported through repo-local split validation and local dependency rehearsal | Split-era compatibility checks without Kubernetes                                                           | Split route/profile contracts must stay valid while storage still uses local Docker Postgres plus explicitly configured object storage |

Compatibility rules:

- `filesystem` compatibility is single-host only
- `local-docker` means the Storage tab uses the optional local Docker Postgres metadata database; object storage is still configured separately
- Docker combined-mode rehearsal is necessary but not sufficient to prove the real split runtime shape
- the repo-local split verification command proves the control-plane versus execution-plane contract; live Kubernetes validation is still required for real in-cluster routing and scaling behavior

## Local Kubernetes launcher

The repo now includes a local Kubernetes rehearsal launcher:

- `yarn studio-server:dev:kubernetes-test`
- `yarn studio-server:dev:kubernetes-test:recreate`
- `yarn studio-server:dev:kubernetes-test:down`
- `yarn studio-server:dev:kubernetes-test:config`
- `yarn studio-server:dev:kubernetes-test:ps`
- `yarn studio-server:dev:kubernetes-test:logs`
- `yarn studio-server:verify:kubernetes`

Current behavior:

- it builds local `proxy`, `web`, `api`, and `executor` images from the current workspace
- the API image build runs the workspace TypeScript build before it touches the cluster, so a type-contract failure stops the rehearsal before any Helm deployment changes
- the managed-schema migration validates catalog definitions after applying them; PostgreSQL may remove redundant outer parentheses from partial-index predicates, which the validator treats as equivalent rather than rejecting a healthy fresh database
- Minikube imports freshly built images sequentially and names each image as it starts; the first local deployment can therefore take several minutes before Helm begins, rather than appearing stalled
- every local `build`, `dev`, and `recreate` run stamps images with a fresh local tag, because Minikube can retain an older image behind a reused `:dev` tag; `up` reuses the recorded tag from the preceding build. Set `RIVET_K8S_IMAGE_TAG` only when you deliberately want to manage that identity yourself
- it deploys the real Helm chart into a dedicated local namespace
- it targets `RIVET_K8S_CONTEXT` explicitly without mutating your global `kubectl` current-context
- if `RIVET_K8S_CONTEXT` is unset, it uses the current `kubectl` context when one exists
- if no current `kubectl` context is set and `minikube` is installed, it falls back to the `minikube` context automatically
- on Docker Desktop Kubernetes, it imports the freshly built images into the cluster nodes automatically
- on Minikube, it loads the freshly built images with `minikube image load --daemon=true`
- on Minikube-backed `dev`, `up`, and `recreate`, it starts the target Minikube profile automatically if it is not already running
- it keeps `web=1`
- it keeps `backend=1`
- it scales the legitimate local rehearsal targets:
  - `proxy`
  - `execution`
- it creates Kubernetes secrets from the local Kubernetes renderer inputs:
  - `RIVET_KEY`
  - `RIVET_K8S_DATABASE_CONNECTION_STRING`
  - `RIVET_K8S_STORAGE_URL` or the explicit `RIVET_K8S_STORAGE_*` tuple
  - `RIVET_K8S_STORAGE_REGION` is always required; the signing region is never inferred from a storage URL. With a dotted virtual-host bucket, also set `RIVET_K8S_STORAGE_BUCKET` explicitly.
  - `RIVET_K8S_STORAGE_ACCESS_KEY_ID`
  - `RIVET_K8S_STORAGE_ACCESS_KEY`
- it starts a local `kubectl port-forward` for the proxy service so the app is available on `http://127.0.0.1:${RIVET_K8S_PROXY_PORT:-RIVET_PORT:-8080}`
- the proxy startup normalizes `RIVET_PROXY_RESOLVER` so Kubernetes DNS service hostnames resolve to the IPs nginx expects

Operational notes:

- this launcher is for the supported Kubernetes topology only:
  - `proxy>=2`
  - `web=1`
  - `backend=1`
  - `execution>=2`
- the scalable tiers do not grow in fixed pairs:
  - a new `execution` pod is only another execution-plane API pod
  - a new `proxy` pod is only another nginx proxy pod
- for endpoint-heavy load, `execution` is the primary scale target and `proxy` is the secondary ingress tier
- it is intentionally opinionated toward external managed Postgres plus external S3 or S3-compatible storage
- it does not replace the production chart or create a second deployment contract; it is a local wrapper around the same chart the real deployment should use
- by default it prefers:
  - the explicit `RIVET_K8S_CONTEXT`, if set
  - otherwise the current `kubectl` context, if one exists
  - otherwise the `minikube` context when the Minikube CLI is installed
  - otherwise the historical fallback `docker-desktop`
- Helm resolution order is:
  - `RIVET_K8S_HELM_BIN`
  - system `helm`
  - cached Helm under `.data/tools/helm/`
- if no explicit, system, or cached Helm is available, the launcher fails with an instruction to run `yarn studio-server:setup:k8s-tools`
- optional launcher-specific overrides are:
  - `RIVET_K8S_CONTEXT`
  - `RIVET_K8S_CLUSTER_PROVIDER`
  - `RIVET_K8S_CLUSTER_DOMAIN`
  - `RIVET_K8S_MINIKUBE_PROFILE`
  - `RIVET_K8S_MINIKUBE_BIN`
  - `RIVET_K8S_NAMESPACE`
  - `RIVET_K8S_RELEASE`
  - `RIVET_K8S_PROXY_PORT`
  - `RIVET_K8S_PROXY_REPLICAS`
  - `RIVET_K8S_WEB_REPLICAS`
  - `RIVET_K8S_EXECUTION_REPLICAS`
  - `RIVET_K8S_LOAD_LOCAL_IMAGES`

### Self-contained Minikube rehearsal

For a local machine that does not already have a safe Postgres and
S3-compatible endpoint, use the repository's disposable dependency manifest.
It creates a dedicated namespace with one Postgres instance, one MinIO
instance, and two 2 GiB local claims. It does not contact production services
and its credentials are intentionally public development-only values.

From PowerShell:

```powershell
minikube start -p rivet-local --driver=docker --cpus=4 --memory=8192
Copy-Item deploy/studio-server/.env.kubernetes-local.example .env.local
kubectl --context rivet-local apply -f deploy/studio-server/kubernetes-test/local-dependencies.yaml
kubectl --context rivet-local -n rivet-local rollout status deployment/rivet-local-postgres --timeout=180s
kubectl --context rivet-local -n rivet-local rollout status deployment/rivet-local-minio --timeout=180s
$env:RIVET_ENV_FILE = '.env.local'
yarn studio-server:dev:kubernetes-test
```

The launcher's proxy port-forward exposes the editor at
`http://127.0.0.1:8090`. Inspect the deployed components with
`yarn studio-server:dev:kubernetes-test:ps`, or stream their logs with
`yarn studio-server:dev:kubernetes-test:logs`.

To remove the entire rehearsal—including its database and object-storage
contents—run:

```powershell
$env:RIVET_ENV_FILE = '.env.local'
yarn studio-server:dev:kubernetes-test:down
minikube delete -p rivet-local
```

Do not use `:down` against a namespace that contains any work you intend to
keep: the local launcher deliberately deletes its namespace.

For the operator-facing chart contract and handoff checklist, see:

- [Kubernetes](./kubernetes.md)

## Observable Playwright flow

Routine browser recovery is deliberately invisible, including while a checkpoint is pending or after it commits. `WorkspaceRecoveryStatus.test.tsx` covers silent automatic retry, warnings only for persistently unprotected unsaved work, dismissal after actual project Save, memory-only storage without disabled controls, and unload protection while no panel is rendered; its scoped Node import adapter unwraps Atlaskit's CommonJS button export without changing the production component. `workspaceRecoveryRetry.test.ts` uses deterministic timers to check current-snapshot retries, bounded backoff, pointer-only repair, non-overlapping attempts, unmount/retirement cancellation, and nonretryable corrupt authorities. Its native timer receiver regression guards against browser-only `Illegal invocation`: injectable timer defaults must wrap native functions, never call copied `setTimeout`/`clearTimeout` methods on a plain scheduler object. `useInitializeWorkspace.test.tsx` checks transient bootstrap retries and the explicit Retry loading path; neither may flush defaults over an unreadable selected checkpoint. The project activation browser suite waits for matching node positions in the persisted checkpoint rather than a success notification, verifies silent transient writes and session-object reacquisition, and checks that real project Save removes a recovery warning without a misleading error toast. The recovery chooser is tested from blocked bootstrap only, preserving the original records and frozen independent-window selection. Never automatically select an unrelated or older checkpoint to make an error disappear, and never delete unsaved recovery records to relieve quota. Keep genuine unsaved-work warnings actionable; hiding routine status must not disable background writes or unload safeguards.

The focused evaluation accounting check is `yarn studio-server:ui:observe evaluation-metrics.spec.ts`. It runs the shared profile/tool fixture through Browser execution and the real Node executor, checks unavailable-cost presentation, and reloads both runs to verify durable evidence. See [execution event accounting](../EVALUATIONS.md#execution-event-accounting) for the fixture contract and API/CLI lifecycle coverage.

`graph-port-rename.spec.ts` uses mocked hosted-project load/save endpoints to rename Graph Input and Graph Output IDs through the editor. It parses every saved project to verify collision ownership, input defaults and port order, output fan-out and bend metadata, unrelated connections, and recursive callers. It also verifies exact persisted graph restoration through Undo and Redo. The companion App characterization tests cover non-UI boundaries that are impractical to author in the browser fixture: absent current graphs, exact/disabled boundary IDs, frozen inputs, same-graph multiple callers, collision ordering, and merged recursive output restoration.

The repo now includes a headed Playwright workflow for frontend debugging and demos where you want to watch the browser actions live.

Current behavior:

- `yarn studio-server:ui:observe` launches Chromium in headed mode with `slowMo`, trace capture, video capture, and HTML reporting enabled
- `yarn studio-server:ui:ci` is intentionally separate from the interactive observer: it starts a fresh Vite preview of the built hosted frontend bound explicitly to IPv4 `127.0.0.1`, runs the explicit spec files enumerated in `packages/studio-server-web/playwright.ci.config.ts` headlessly, and retains trace/video/screenshots only on failure. CI restores the same-commit `studio-server-web/dist` from its build job; locally run `yarn workspace @valerypopoff/rivet-studio-server-web run build` first. These cover output paging, dashboard contracts, portable project-bundle downloads and local execution, sidebar wrapping, streaming nodes, project activation, node-editor ownership/lifecycle, and optional numeric editing. Testing the bundle avoids HMR and thousands of source-module requests per isolated context, which can exhaust local socket buffers. Keep Vite CLI options directly after `run preview`; an extra Yarn `--` separator prevents Vite from receiving the host binding and makes Playwright's IPv4 readiness probe time out. The configured `PLAYWRIGHT_CI_PORT` is also passed to Vite so the readiness probe and server cannot silently diverge. Ordinary developer observation can still target a live Vite host.
- Browser observations that seed a project in local browser storage must also use `mockHostedEditorBootstrap` for the read-only configuration and evaluation-library requests. This keeps the observation about editor behavior rather than the authentication state of an unrelated API process on the developer's machine. `waitForDashboardReady` waits for both the loading overlay to disappear and the workflow-library shell to become visible: checking only that a possibly absent loading overlay is hidden can race the initial React mount and make later sidebar assertions flaky.
- the reusable Studio Server verifier runs that same explicit browser set in the `editor-regression` job after the hosted build. It installs Chromium, uploads `artifacts/playwright/` on failure, and the final verifier rejects a skipped or failed applicable browser job
- the runner loads the same `.env` / `.env.dev` file as the Docker scripts, so UI-gated hosts automatically reuse `RIVET_KEY`
- unless `PLAYWRIGHT_BASE_URL` is already set, the runner targets `http://127.0.0.1:${RIVET_PORT}` from your env file, defaulting to `8080`
- the main hosted-editor observable spec uses mocked workflow/project API responses to open a two-node project, then visibly exercises the hosted editor focus, copy, cut, and paste path without mutating workflow storage
- trace, video, screenshots, and the HTML report are written under `artifacts/playwright/`
- `llm-temperature.spec.ts` uses two projects with cloned graph/node IDs and
  mocked workflow storage to cover incomplete exponent input, sequential typing
  with trailing zeroes, decimal/zero precision, clearing optional
  Temperature, immediate saves and tab switching, required-field invalid drafts,
  Undo/Redo, settings close/reopen and committed unsaved recovery after reload.
  Legacy saved variants load as empty read-only Temperature without making the
  project dirty; returning to current settings retains the current value.
  It also verifies rounded unit conversion and parent-clamped values after blur,
  including rejection that leaves the stored value unchanged, and Prompt Designer's
  actual preview requests against an owned loopback-only mock provider, cloned
  attachment identities and restarting/closing a delayed preview.
  Run headlessly with `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, and
  `yarn studio-server:ui:observe llm-temperature.spec.ts` against the current
  checkout. Core's `test/model/chat-v2/temperature.test.ts` covers profile
  normalization, historical repair, input validation, serialization and both
  SDK transports including actual mocked provider wire bodies. Legacy YAML
  tests inject `null` and `.nan` after serialization and verify repair on load
  for main node data, saved variants and node-library source variants. A full
  Profile → JSON recovery → Chat pipeline check also proves an unset value is
  omitted from requests instead of resurrecting Chat's creation default. App's
  `src/components/editors/numberEditorValue.test.ts` covers optional/required
  blanks, fractional precision, integer unit conversion and overflow. These
  checks are supplemented by
  `src/components/promptDesigner/usePromptDesignerRunActions.test.tsx`, which
  holds settings lookups and transport responses past restart, attachment
  change and unmount (including A → B → A and a transport ignoring abort).
  Only the current request may update the result or clear its progress state.
  All these tests use no real provider credentials or production project writes. The
  Temperature browser scenarios are also included in the CI browser gate.
- `watch-conditional-remote.spec.ts` runs a real Node processor and debugger
  WebSocket against the hosted editor with a controlled local LLM stream. It
  covers a conditional producing Subgraph feeding two calls to the same Watch
  graph with different field arguments, parallel branches, and independent
  conditional Stops. Keep assertions for live delivery, caller-pinned
  first-three/Terminal pages, inline/fullscreen output, final-only ordinary
  consumers, and replay of the host-recorded execution. This catches missing
  execution history at the producer boundary; broadening the editor's history
  selector cannot repair a stream that was never forwarded. On Windows, this
  fixture retries only an explicitly observed pre-mount local navigation or
  Vite script failure (`ERR_NO_BUFFER_SPACE` or
  `ERR_INSUFFICIENT_RESOURCES`); it does not retry editor, debugger,
  execution, history, or replay assertions.
- `watch-streaming-output.spec.ts` seeds isolated editor projects and verifies
  live named-input streaming into a once-called Subgraph (also at two levels),
  final-only ordinary consumers, nested Stop, and retained inline/fullscreen
  Watch pages after navigation and recording export/replay. Core regressions also
  cover startup failure/exclusion buffers and late callbacks across processor
  reuse with two simultaneous Subgraph consumers; these must not manufacture
  additional history pages in another invocation.
  Its SSE producer is held open until the browser observes branch execution;
  the evaluation-library fixture is isolated from server authorization.
  It also verifies
  streaming-wire arrows, chunk port labels, a dynamically derived named
  Subgraph output connected to Watch, the default overflow policy, and
  contextual scheduling controls. Run it against a target built from the current
  checkout. Core's `GraphProcessor.asyncBranches.test.ts` and
  `StreamingOutputWatch.test.ts` separately cover execution ordering, cancellation,
  first-Stop selection, snapshot isolation, exclusions, direct/nested/Data Bus
  Subgraph and Referenced Graph Alias output propagation, and final-only
  conditional Graph Output, frozen, duplicate, split, and Error-output named boundaries,
  plus subgraph cost accounting and rejection of **Start Async Branch** nodes
  with runnable downstream work
  at every nested Watch-Subgraph depth. Ordinary awaited Subgraphs remain valid inside a Watch;
  detached async work must start only after Stop returns to normal execution.
  The editor applies the same check while wiring when its local project graph is
  available, including recursively referenced local Subgraphs; Core remains the
  fail-closed authority for manually edited, cached, remote, or otherwise
  incomplete project topology.
  `getEditorRunFromPlan(...)` is the shared local/remote partial-execution guard:
  starting from **Watch streaming** may reuse the upstream producer's saved
  final output once, but a repeated branch node, **Stop watching streaming**,
  or a node after Stop must not be planned by preloading the Watch boundary. Keep
  the planner's error actionable: run from Watch for the final snapshot, or from
  the producer for a live stream. Core independently rejects direct/runtime cache
  injection into an active Watch source, boundary, or repeated branch.

- The Streaming node group contains **Stream value**, **Catch streaming chunks**,
  **Watch streaming**, and **Stop watching streaming** only, in that display
  order. This is an explicit menu order, not an alphabetic rename of node types;
  existing `watchStreamingOutput` and `stopWatchingStreamingOutput` graph data
  must remain readable. Stream value is
  an ordinary pass-through node that publishes one Core `onPartialOutputs` event;
  Graph Output and Subgraph keep their existing final-result contracts. Catch
  registers a once-only processor boundary for one source port: it snapshots
  the first N updates, ignores an identical terminal duplicate, commits one
  ordinary output when N arrives or the source ends, and never schedules a
  repeated Watch branch. Its count is runtime-clamped to 1..1024; Conditional
  and Many modes are rejected. If the producer fails before N chunks, Catch
  does not release a partial array as a successful ordinary value. Keep
  `StreamingWatchTopology` demand tracing in
  sync for both Watch and Catch so named inputs and same-/cross-project Subgraph
  outputs reach them before child completion. A child failure after an early
  emission remains a failed run; previously started caller side effects cannot
  be undone. Verify same-/cross-project early delivery, count=1 exactly-once
  downstream execution, short streams, duplicate final values, and replay.
  Their canvas headers share the wave icon in `NodeTitleLabel`; the two new
  serialized types are `streamValue` and `catchStreamingChunks`.
  Wire arrows are presentation-only and require a known partial-producing
  source; a normal value connected to Watch or Catch remains a plain wire and
  is delivered only at completion. The authenticated cross-project preview
  includes only Graph Output node IDs proven streamable by the server's full
  target topology. Derive those IDs with the target project's registered
  built-in provider plugins as well as core nodes; otherwise a provider stream
  can run correctly but its cross-project wire loses its arrow. Unavailable
  external plugins remain unmarked rather than guessing. Probe all graph
  boundaries in one topology pass, not one full-project traversal per graph;
  retain graph IDs as data keys without prototype inheritance. The browser keeps
  this hint outside the serializable
  `Project` state, so previews still disclose no executable node configuration
  or datasets. Core runtime topology remains permissive for ordinary final
  values; never use the arrow filter to gate Watch/Catch execution.

Managed-state safety:

- most browser-visible specs should stay non-mutating and prefer mocked API responses when the behavior under test is modal/controller/UI wiring rather than storage persistence
- every spec must seed or intercept the workflow state it needs; an empty workflows volume with no pre-existing folders or projects is the supported suite baseline
- hosted-editor shortcut/focus coverage should also prefer mocked workflow/project routes when the behavior only needs an open project shape, not durable workflow storage
- browser-only fixture assets must resolve from direct `studio-server-web` dependencies; observable specs must not use another workspace's `package.json` as a module-resolution anchor
- mutating workflow specs are blocked against Storage-tab `Object storage` mode unless `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` is set explicitly
- specs that assert managed virtual workflow paths should call the managed-mode guard and skip under filesystem stacks; filesystem runs should not be expected to produce `/managed/workflows/...` save paths
- shared Playwright workflow helpers use Playwright's request context for setup and cleanup, not `page.evaluate(fetch(...))`, so they go through the same proxy-auth path as the real browser shell
- if a mutating spec creates real workflow state in managed mode, it is responsible for explicit cleanup before the run finishes

Typical usage:

1. start the app you want to watch, for example `yarn studio-server:dev` or `yarn studio-server:prod:custom`
2. if this is the first Playwright run on the machine, run `yarn studio-server:ui:observe:install`
3. run `yarn studio-server:ui:observe`
4. if you want the Playwright Inspector alongside the browser, run `yarn studio-server:ui:observe:debug`
5. after the run, open `yarn studio-server:ui:observe:report`

Windows PowerShell override example:

1. `$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8086'`
2. `$env:PLAYWRIGHT_SLOW_MO='500'`
3. `yarn studio-server:ui:observe`

### Subgraph output-pruning verification

Canvas connection pruning must distinguish an unavailable Subgraph definition
from a resolved graph with no ports. Cross-project previews are asynchronous;
older saved callers may not contain `targetBoundary`. Until the exact
project/version/graph resolves, preserve their persisted connections and do not
mark the caller dirty. Preview failure or a missing local/external graph is not
permission to delete wires. A saved external boundary remains the authored
contract even when the preview fails or changes; genuinely stale ports in a
resolved contract still use the existing pruning behavior.
`connectionValidation.test.ts` covers these cases and latest/published key
isolation. `cross-project-subgraph-loading.spec.ts` holds or rejects each
version's preview, checks clean tabs and rendered ports/wires after resolution,
then checks exact saved connections through mocked storage. It runs in the CI
editor lane and requires no real project writes or model calls.

The same availability rule applies to node-edit reconciliation, including the
node at the other end of the edited node's wire. Unknown Subgraph ports preserve
existing wires; restoring a recoverable wire still requires confirmed ports on
both ends, and a known removed port on either peer still breaks the connection,
even if the other peer's definition is unavailable. Keep this rule
shared with canvas pruning rather than adding loading delays to edits.
Legacy reference reloads clear their old closure before loading, then merge
their results with independently loaded, version-keyed Subgraph previews.
A failed reload must not erase those previews. Subgraph controls and canvas
ports use one shared, version-keyed preview cache: a control must not retain a
private preview that shadows a newer refresh from another control. A shared
cache reset reloads current definitions; unavailable definitions continue to
preserve authored wires in the meantime.
The browser regression also edits both connected peers before preview completion
and releases successful/failed legacy-reference loads after the preview arrives;
the caller's ports, wires and clean saved state must survive both orderings.
Shared-refresh cases keep two Subgraph controls mounted, refresh one of them,
and verify both display the same current target without dirtying the caller.
`node-editor-lifecycle.spec.ts` also verifies that retired preview responses
cannot contaminate the next project after a tab switch. Its workspace bootstrap
authenticates when the proxy UI gate is enabled, so the same check works on both
the authenticated local tunnel and CI fixtures.

`subgraph-output-pruning.spec.ts` opens a project with two connected Subgraph instances
sharing a child graph and a third caller with no consumed outputs. It enables
**Skip unused outputs** on the first connected instance, verifies its enabled-only
canvas-body status beneath the graph selector, help text and Undo/Redo, and saves
into mocked workflow storage. A fresh browser
context reloads that saved file (not the original editor's local snapshot), then
runs the graph with the Browser executor and checks requested/excluded output
values alongside the unchanged full-execution instance. It follows the optimized
caller into its own child invocation, navigates explicitly to the full caller's
history, and verifies that the skipped caller shows no current child execution
while historical navigation remains available. Recording persistence
is disabled for this fixture, and unexpected mutation requests are blocked.
It does not require managed-storage mutation opt-in or real model calls.

`subgraph-node-executor-pruning.spec.ts` complements that Browser-only coverage
by selecting **Node** and observing the real hosted executor WebSocket connection
(`/ws/executor/internal` on the Docker dev target).
Its two callers share the same child graph, but only the opted-in caller may
omit the unused branch's node events; the full caller must still run it. The
fixture mocks project loading, disables recording persistence, blocks unexpected
HTTP mutations, and uses only local Text nodes. It does not mock execution or
make model calls. It verifies two child node starts for the optimized caller and
four for the full caller, not merely the caller-facing excluded output. Browser
success or a local Node unit test is not evidence that
the deployed backend image's hosted executor contains the changed engine.

`packages/app-executor/bin/executor.outputSelection.test.mts` separately starts
the actual app-executor host in an isolated local process and sends real
`set-dynamic-data` and `run` WebSocket messages. On the same socket and project ID,
with the editor cache enabled, toggling the setting off/on/off must start 8/5/8
nodes, preserve the shared prerequisite once, and omit the unused branch's
lifecycle events only in the selected run. Run it with
`yarn workspace @valerypopoff/rivet-app-executor test`. This catches upload/cache
regressions but still does not prove freshness of an existing Docker image.

`workflow-recordings-http.test.ts` covers the separate headless HTTP path using
temporary filesystem workflow/recording roots and a local test server. Concurrent
published/latest requests invoke an opted-in Subgraph in both many-parallel and
many-sequential modes. The test reads the persisted recording and replay-project
artifacts, replays them, and checks ordered results, omitted node events, excluded
caller outputs, and distinct per-request/per-item execution identities. It uses
only Graph Input/Output and Text nodes, with no model calls or production writes.
Run `yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-recordings-http.test.ts`
after building Core and Node. For loops, processor reuse, and the CLI path, also
run Node's `outputSelectionRepeatedCalls.test.ts` and `yarn test:cli`.

Run against a verified current-source hosted app and, for the Node scenario, a
verified current executor image. The Docker dev web is source-mounted, but its
executor is an image-built snapshot: incremental host Core/Node builds do not
refresh that container. Refresh the intended executor before claiming hosted
Node parity; rebuilding or recreating an unrelated stack is not a prerequisite:

```powershell
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:8081' # Use the verified app's port.
yarn studio-server:ui:observe subgraph-output-pruning.spec.ts
yarn studio-server:ui:observe subgraph-node-executor-pruning.spec.ts
yarn studio-server:ui:observe subgraph-prompt-cancellation.spec.ts
```

The app's `executionSelectors.test.ts` also covers mixed full/pruned child
invocations: a skipped node has no current output/status, while deliberately
selected historical runs remain available. `authoringSemantics.test.ts` verifies
the graph-builder catalog's independently authored, default-off boolean setting.
`subgraphExecutionNavigation.test.ts` feeds real Core events through the
production snapshot reducer and navigation selectors, including nested skipped
callers, delayed child starts, selected parent process pages, and historical runs.
Build Core before running authoring tests, since they consume its package exports.
See [Core Engine](../CORE-ENGINE.md) and [Execution Data Flow](../EXECUTION-DATA-FLOW.md)
for selection semantics and runtime regression coverage; this browser check does
not substitute for scheduler tests.

`subgraph-prompt-cancellation.spec.ts` uses mocked workflow storage and the
Browser executor to run a selected child whose User Input loses a race, followed
by a still-running second prompt. It verifies that only the current question is
shown, answering completes the graph, unused output stays excluded, and Stop
clears the pending-question button. The fixture uses only built-in nodes and a
short local Delay, with no external model calls or real workflow writes.

## Local direct-process mode

`yarn studio-server:dev:local` starts:

- API on `http://localhost:3100`
- Vite web app on `http://localhost:5174`
- executor websocket service on port `21889`

The local executor is the wrapper entrypoint, not the upstream standalone executable. It injects an HTTP-backed LLM Profile health store into Node-mode editor runs. By default it calls `http://127.0.0.1:3100/api/workflows/llm-profile-health`; set `RIVET_LLM_PROFILE_HEALTH_API_URL` only when the local API is exposed elsewhere. `RIVET_KEY` must match the API because the executor derives the normal trusted proxy token from it. When a key is configured, the Vite development proxy derives the same proxy-auth digest server-side for its `/api/*` forwarding; the browser never receives the shared key or that header value.

The dashboard's outer Project Settings > LLM profile suspension tab administers that same
server state. It is intentionally outside the embedded Rivet editor, and the
embedded provider configuration carries only the runtime store. Upstream
standalone Rivet can save Reliability settings but does not enforce them or
create local suspension state. The tab keeps an expired suspension visible as
awaiting recovery, then marks its leased recovery request as in progress, so an
empty panel means there is no suspension or pending recovery lifecycle.

Important constraints:

- host Node must be `24+` for local API execution because the API now uses Node's built-in `node:sqlite`
- this mode does not recreate the nginx trusted-proxy layer
- the Vite dev server only proxies `/api/*` to the API and `/ws/executor*` to the executor; when `RIVET_KEY` is configured, its `/api/*` proxy adds the derived internal proxy-auth header server-side
- Vite does not proxy the published/latest workflow route families, Rivet web app route families, `/ui-auth`, or `/ws/latest-debugger`; it remains a narrower development seam than the deployed nginx proxy
- use it for service-level debugging, direct API/executor work, or frontend iteration that does not rely on fully wired hosted-shell control-plane routing
- Docker dev remains the best path for testing the full hosted browser flow exactly as deployed

## Docker launcher behavior

### Single-VM HTTPS without host nginx

Production Compose can run the existing Rivet nginx proxy and the VM's public
TLS/private-HTTP edge in **one container**. Set these deployment values in the
launcher dotenv (use your actual hostnames and existing certificate files):

```dotenv
RIVET_PROXY_PUBLIC_HOST=rivet.example.com
RIVET_PROXY_INTERNAL_HOST=rivet-1.internal.example.com
RIVET_PROXY_TLS_CERT_HOST_PATH=/opt/tls/rivet.crt
RIVET_PROXY_TLS_KEY_HOST_PATH=/opt/tls/rivet.key
RIVET_PORT=80
RIVET_HTTPS_PORT=443
```

Replace the single `RIVET_PORT=8080` entry from `.env.example` with
`RIVET_PORT=80`; duplicate keys can leave Compose publishing 8080 even when
the operator intended port 80. After the cutover is verified, the OS nginx
service and its site configuration are not needed for Rivet. Keep the old site
configuration available for rollback, and disable the host service at boot
only after direct-origin checks pass. The Docker proxy remains nginx; this
change moves TLS and routing into the app's Compose stack, not out of nginx.

The production launcher validates both hostnames and certificate paths, then
adds `docker-compose.vm-tls.yml`. Public HTTP redirects to HTTPS; public HTTPS
offers HTTP/2, and both public HTTPS and private-host HTTP pass through the
unchanged Rivet route/auth proxy on a
loopback-only listener. Unknown hostnames return 404. The certificate and key
are mounted read-only and must be readable by container UID 10001. A typical
root-only `0600` private key will fail at nginx startup even though the launcher
can see the file. Grant container UID 10001 read access to a dedicated key copy,
or use a restricted ACL after confirming it works inside the bind mount. A
`root:10001` key with mode `0640` is another option when host group 10001 is
not used by unrelated processes. Verify key readability from a temporary proxy
container before stopping host nginx; never make the key world-readable.
The proxy's nginx hash bucket supports the longest DNS hostname accepted by the
launcher; the VM TLS fixture exercises that limit so long private hostnames
cannot prevent the proxy from starting.
Recheck the key's UID/group access after certificate rotation, then recreate
the proxy container. A non-default `RIVET_HTTPS_PORT`
is included in the HTTP redirect. Before switching traffic, render
`yarn studio-server:prod:config`, verify ports 80/443 are free, and check the
public HTTPS, private HTTP, WebSocket, SSE, OAuth, and published routes. Keep
the old host nginx available for a controlled rollback until the new path is
verified. Do not bind the private hostname to a publicly reachable interface
without a firewall/network ACL: a Host header is not access control. The
current Compose configuration does not itself enforce private-host isolation;
see [the deferred isolation work](access-and-routing.md#future-work-enforce-private-host-isolation-on-a-single-vm)
before treating that hostname as internal-only.

The proxy image has a read-only root filesystem in production Compose. Nginx
configuration, PID, and request-body scratch space use a bounded `/tmp`
`tmpfs`; this avoids persistent proxy disk writes, **not** filesystem writes
altogether. Large concurrent uploads can exhaust that memory budget and fail
closed. The production web image is also read-only and has bounded `/tmp` and
`/var/tmp` scratch. The combined backend keeps its existing persistent
workflow, recording, settings, and runtime-library mounts, while `/tmp` and
`/var/tmp` use separate disposable `tmpfs` mounts (512 MiB each by default).
`TMPDIR`, npm, and XDG caches point into `/tmp`; hosted plugin installs pass an
explicit `/tmp` pnpm store. The runtime image carries a pinned pnpm binary, so
it does not download a package-manager binary on each startup. The backend
entrypoint reapplies these scratch paths after any optional dotenv load and
clears uppercase `NPM_CONFIG_CACHE`, which npm would otherwise prefer over the
lowercase cache setting. Standalone launches outside the Compose single-host
topology retain their own temporary-directory configuration. Application data
keeps its existing durable paths. Override
`RIVET_API_TMPFS_SIZE` or `RIVET_API_VAR_TMPFS_SIZE` in the launcher dotenv only
after checking the VM's available memory and the workload's high-water mark;
tmpfs consumes RAM as files are written, and a full mount fails writes. The
backend root filesystem stays writable because a startup-only read-only smoke
does not yet prove compatibility with every user workflow and hosted package
plugin. Backend scratch permits execution because plugins and workflows may
run temporary executables there; only the proxy uses `noexec`. The one-shot
filesystem artifact initializer also has bounded scratch and a read-only root;
it changes only the mounted artifact directories. Docker development retains its
source/dependency volumes and is not a read-only-root rehearsal. Without the
four VM TLS values above, production Compose retains its original single HTTP
listener for an external TLS terminator.

Run `node deploy/studio-server/scripts/verify-vm-nginx-tls.mjs` to exercise the
actual image with a disposable certificate, mock services, public/private
hosts, forwarded-header spoofing, endpoint planes, and executor WebSocket. The
fixture chooses temporary loopback host ports explicitly so its checks do not
depend on Docker's automatic published-port discovery. Its mock upstreams run
in a sibling container on a disposable private Docker network, rather than
depending on container-to-host gateway access. The
GitHub deployment-contract job runs this fixture on Linux. It needs Docker and
OpenSSL; on a host without OpenSSL, supply disposable certificate/key paths as
`RIVET_VM_TLS_FIXTURE_CERT` and `RIVET_VM_TLS_FIXTURE_KEY` together; a partial
pair is rejected before the fixture starts. Generated or supplied TLS files are
copied into a private temporary host directory, leaving supplied originals
untouched while making the copies readable by the non-root nginx container. A
startup failure includes bounded logs from both containers. Certificate
generation, Docker operations, and HTTP, WebSocket, and TLS probes have
timeouts so a stalled daemon, image pull, or connection cannot hang this CI
step indefinitely.
Keep fixture regressions behavioral: the focused API contract tests invoke the
fixture with invalid certificate configurations, while the Docker gate checks
real routing and TLS. Do not add assertions over the fixture's source text;
`yarn test:style` rejects new source-reading tests.

The Docker launchers now render layered Compose files:

- production Compose runs API and executor processes under one supervisor in the API image, but retains distinct API port `80` and executor websocket port `21889`. Its health check on `21890` becomes ready only after both processes are ready. An exit of either process terminates the other and restarts the container.
- the VM nginx container routes `/ws/executor*` to `api:21889`; the executor binds to `0.0.0.0` inside Docker so this separate proxy can reach it. The executor's LLM health and execution-environment API calls use co-located loopback `127.0.0.1:80`. The shared runtime dotenv remains backend-only.
- Docker development runs both source watchers in one backend container. The executor watcher forwards ready/not-ready signals when it rebuilds, so the supervisor's `21890` health check reflects the actual executor, and the proxy routes to `api:21889`. The local direct-process mode is unchanged.
- `PORT` in `.env` must not become a shared port for both child processes; changing the executor port also requires changing the proxy upstream.

- `yarn studio-server:dev` / `yarn studio-server:dev:docker:*` use `deploy/studio-server/compose/docker-compose.managed-services.yml` plus `deploy/studio-server/compose/docker-compose.dev.yml`; set `RIVET_METRICS_ENABLED=true` only when a private host or Docker-network scraper needs the direct API container's pull-only `/metrics` endpoint. The public proxy intentionally does not route that endpoint.
- Published web-app Chat state and Stored Values use browser IndexedDB. The API-only `RIVET_WEB_APP_BROWSER_STORAGE_*` settings bound the optional on-demand WebSocket storage RPC; Compose and Helm supply safe defaults. See [web-app-browser-storage.md](web-app-browser-storage.md) before changing limits or proxy timeouts, because these ceilings must be sized with execution-replica memory and admission capacity.
- `yarn studio-server:prod`, `yarn studio-server:prod:prebuilt`, `yarn studio-server:prod:restart`, and `yarn studio-server:prod:custom` use `deploy/studio-server/compose/docker-compose.managed-services.yml` plus `deploy/studio-server/compose/docker-compose.yml`
- the shared file only contributes the optional managed Postgres/MinIO services; enable them explicitly with `COMPOSE_PROFILES=workflow-managed` when rehearsing object-storage mode locally. The disposable MinIO server uses the same release-and-digest-pinned Docker Hub image as the managed API test and Kubernetes fixtures. The managed blob store creates its bucket on startup; a separate MinIO client container is not needed. Every service in the managed Compose layer retains the dev-stack fingerprint label used by the launchers. The fixture runs as root only to write its initially root-owned local volume; this is not a production storage recommendation.

Current behavior:

- the browser entrypoint is still `http://localhost:8080` through nginx by default; override it with `RIVET_PORT` if needed
- `yarn studio-server:prod` (and its explicit `yarn studio-server:prod:prebuilt` alias) pulls prebuilt images under `ghcr.io/valerypopoff/rivet2.0-studio-server/{proxy,web,api}:${RIVET_IMAGE_TAG:-latest}`, then force-recreates the stack with `--no-build` and removes the former standalone executor container as an orphan. Set `RIVET_PROXY_IMAGE`, `RIVET_WEB_IMAGE`, or `RIVET_API_IMAGE` to pin a service to a matching release image. The API image must contain the combined-backend supervisor and bundled executor. `RIVET_EXECUTOR_IMAGE` no longer selects a production Compose container; the separate image remains published for predecessor rollback and explicit standalone use. The minimal `.env.example` omits these optional image overrides; Compose supplies the current GHCR namespace by default. The retired `cloud-hosted-rivet2-wrapper/*` packages are not release targets for this monorepo.
- `yarn studio-server:staging` uses that same launcher and Compose project but overrides dotenv image selectors only for this invocation with digest-pinned images verified against the clean staging checkout. It requires an existing API container and checks its three artifact binds plus the persistent named volumes against rendered Compose. On Linux a non-root port probe for 80/443 may receive `EACCES`; the launcher then checks `ss` for a real listener and fails closed if `ss` is unavailable. Docker still enforces port publishing. The normal `yarn studio-server:prod` command retains its explicit `.env` image selection; staging does not persist a tag change.
- `yarn studio-server:prod:restart` skips the pull/build step and force-recreates the stack from the images already present locally. Use it after changing `.env` when you want containers to pick up new env values without updating to newer GHCR images.
- Project Settings reads route prefixes from runtime `/api/config`, not the prebuilt web bundle. App Settings edits workflow and web-app route domains through one typed settings repository. API dispatch is dynamic, and the proxy regenerates its server-block include, validates it with `nginx -t`, and reloads. Kubernetes proxies poll the authenticated `/internal/app-settings/proxy-config` projection; single-host proxies watch their local files. The modal waits for `/api/config` to report the active paths before showing `Saved.`, so no manual stack restart is required.
- Server UI access starts from deployment env, then uses the active settings repository for OAuth provider/session details and admin emails. Bootstrap with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`, save OAuth and admin settings, then switch the deployment env to `oauth`. Changing the env mode requires process restart/rollout; changing saved OAuth/admin settings propagates through the repository and invalidates old sessions.
- App Settings -> `Run recordings` saves recording queue depth, newest-runs-per-endpoint, and age retention through the active repository. Fresh/upgraded local mode stores the domain in SQLite; Kubernetes uses encrypted PostgreSQL, and the legacy file backend retains `settings/run-recordings.json`. Legacy `RIVET_RECORDINGS_MAX_PENDING_WRITES`, `RIVET_RECORDINGS_MAX_RUNS_PER_ENDPOINT`, and `RIVET_RECORDINGS_RETENTION_DAYS` are ignored. Each settings tab keeps one separated Save/Revert row for all changes in that tab.
- App Settings -> `Web apps` -> `Auth`, `OAuth`, and `Server UI access` edit one web-app-auth domain. `Key`, `OAuth`, and `No gate` retain their existing behavior. Fresh/upgraded local mode uses private SQLite; the legacy file backend uses owner-only `settings/web-app-auth.json`, and Kubernetes stores the payload encrypted in PostgreSQL. Legacy web-app/OAuth env values are ignored. OAuth state and session cookies remain bound to the saved revision, so provider, credential, scope, allowlist, or session-policy changes fail closed and may require visitors to sign in again.
- App Settings -> `Workflow endpoints` -> `Access control` writes workflow endpoint bearer-token policy through the active repository (SQLite for fresh/upgraded local mode, `settings/workflow-endpoint-auth.json` for legacy file mode, or encrypted PostgreSQL for managed mode). It defaults to requiring `Authorization: Bearer <RIVET_KEY>`, and the legacy `RIVET_REQUIRE_WORKFLOW_KEY` env var is ignored so workflow endpoint auth has one operator-owned source of truth.
- App Settings -> `Workflow endpoints` -> `Routes` and App Settings -> `Web apps` -> `Routes` edit one public-route settings domain. In file mode it is `settings/public-routes.json`, with the old `settings/web-app-routes.json` as a read-only import fallback. Fresh/upgraded local mode stores it in SQLite; Kubernetes uses PostgreSQL. Supported Compose and Kubernetes proxies consume the authenticated API projection rather than a settings-file mirror. Slugs are unique single top-level path segments and cannot collide with reserved routes.
- App Settings -> `Storage` configures the existing workflow/runtime-library backend through the active settings repository. `Local folders` uses launcher-mounted artifacts and hides inactive database controls; existing `Object storage + PostgreSQL` deployments show S3-compatible storage and database controls. The managed button is disabled for local installations and the API rejects activation before a settings write. Files-to-SQLite completion is required first, and a later SQLite-to-managed transfer still needs a separate verified adapter. Saving managed credentials or taking a filesystem-mode detour does not bypass this policy. Secrets are never returned to the browser. Storage/database env values are ignored by Docker API/executor runtime. Restart Docker or roll out Kubernetes after credential/configuration changes so singleton backends use the new configuration.
- Managed workflow schema changes live in ordered immutable migrations under `packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts`. Migration 1 is the workflow baseline; migration 2 adds encrypted `app_settings`; migration 3 adds the fenced maintenance lease and deletion outbox; migration 4 adds reconciliation state and integrity findings. Never edit a released migration or checksum. The Helm pre-install/pre-upgrade Job validates deployment storage in memory and runs schema migration before enabling the PostgreSQL settings backend. Each absent row independently uses a matching regular, valid legacy JSON file or falls back to the candidate bootstrap/default; never switch the entire app-data root to a partial legacy tree. The missing deployment-storage row is seeded from validated Helm/Vault values, while an existing row remains authoritative. Serving API pods remain verify-only. Add each future change as N+1 with complete manifest, backward-compatibility declaration, and concurrency/upgrade coverage.
- Web-app action graph context strips browser/session headers such as `cookie`, `authorization`, proxy auth, and verified client-address hints. Keep public web-app actions on that narrower context contract; workflow endpoint routes may still expose request headers because they are API-style execution surfaces with their own bearer/trusted-client contract.
- Web-app actions carry a browser-owned `storage` snapshot for Rivet Stored Value nodes. Both the HTTP compatibility route and the WebSocket gateway must return the per-run `storagePatch`; do not persist or reuse that snapshot server-side unless a deliberate trusted host store is introduced.
- App Settings -> `Node executor proxy` stores runtime `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and optional executor/debugger websocket overrides through the active repository; `.env` proxy/URL overrides are ignored. In Kubernetes, API processes read PostgreSQL snapshots directly and refresh their dispatcher after saves; the co-located executor waits for an authenticated loopback snapshot before accepting work and polls it for proxy changes. A failed refresh retains its last valid proxy configuration. No Kubernetes proxy-settings compatibility JSON is written. Selected SQLite uses authenticated loopback runtime-config protocol 2 and proxy refreshes without settings-file mirrors; legacy single-host mode retains owner-only JSON files and polling. Blank websocket overrides keep host-derived defaults, including HTTPS-to-WSS hardening.
- In file mode, App Settings writes use unique temporary files followed by atomic rename. In SQLite and PostgreSQL modes, updates use compare-and-swap revisions; a stale explicit revision returns `409` rather than overwriting another administrator. PostgreSQL notification failure after commit is logged without reporting the committed save as failed. Notifications accelerate replica invalidation, while revision polling repairs missed notifications and retries repository refreshes whose revision was not yet acknowledged.
- Missing legacy file-backed settings or absent database rows normally mean first-run defaults; in replicated Kubernetes mode, a missing deployment-storage row must be seeded by the migration Job before serving pods start. A present malformed file or an unreadable/decryption-failed database row fails loudly instead of falling back to env/defaults. Web-app auth remains fail-closed. Every HTTP request pins one immutable settings snapshot, so a concurrent save cannot mix policy revisions within the request.
- `Web apps`, `OAuth`, and `Server UI access` edit the same web-app-auth record. The modal loads that record once per opening and keeps the shared draft while those tabs are switched, so changing tabs cannot overwrite unsaved OAuth or admin-email edits with a second fetch.
- For local web-app OAuth testing without a real provider, open App Settings -> `Web apps` -> `Auth` and choose `OAuth`, then open App Settings -> `OAuth`, choose `Local dummy`, provide a session signing secret, and optionally set the default dummy email. The Sign in flow then opens `/apps/auth/dummy` unless the active published-app route prefix has changed, accepts a test email, and returns through the same callback/session-cookie path as real OAuth. Dummy OAuth requires deployment opt-in plus a verified development client network; see [Trusted clients](trusted-clients.md). It must not be used in shared or production deployments. OAuth web-app allowlists are fail-closed, so add the dummy email to the app's allowed-email list before testing access.
- `yarn studio-server:prod:custom` rebuilds all four images and the stack from the current monorepo commit
- dev Docker exposes the API directly on `http://localhost:3100` for diagnostics, but it binds that port to `127.0.0.1` by default through `RIVET_LOCAL_BIND_HOST`; keep it private/firewalled on shared or public machines because the hosted auth model expects browser traffic to enter through nginx
- local-docker managed Postgres and MinIO diagnostic ports also bind to `127.0.0.1` by default. Set `RIVET_LOCAL_BIND_HOST=0.0.0.0` only on a trusted/firewalled network.
- credentialed CORS is same-origin by default. Set `RIVET_CORS_ALLOWED_ORIGINS` only when a known external browser origin must call the API or workflow routes directly.
- `yarn studio-server:dev` is idempotent: it reuses a healthy existing dev stack rather than restarting services just because the command is run again. Use `yarn studio-server:dev:docker:recreate` after Dockerfile, image, or mounted nginx-template changes; API, executor, and web source are watched in their live-mounted dev services. The API dev watcher watches the built Core, Node, and Evaluations entrypoints while `tsx` is running. A workspace rebuild briefly removes those outputs before emitting replacements; when they return, it restarts only the API watcher so `tsx` cannot remain alive after its API child failed to reload. It does not hide ordinary API startup or compile failures. If the root lockfile changed, the launcher instead rebuilds and restarts the **whole dev stack** in one Compose operation; this keeps its shared development dependencies coherent. The dev backend explicitly clears the production-image entrypoint so its Compose development command owns dependency installation and both source-watch processes. If an earlier dev stack was started with different Compose source files or overlays—for example, before adding `.env`, which adds the backend runtime-env overlay, or after changing the dev Compose configuration—the launcher force-removes only the project's stale development containers, then lets Compose start the complete stack again. This avoids waiting for the production API's long graceful-stop window during local recovery. Ordinary `.env` value changes are left to Docker Compose's normal per-service reconciliation, avoiding an unnecessary full-stack restart. Optional local managed services receive the same identity label, so enabling that profile does not cause repeat restarts. The automatic replacement preserves the project network and never uses `--volumes`, so the named dependency/app-data volumes and mounted workflows, recordings, runtime libraries, and repository remain intact. A requested `dev:docker:recreate` also caps its development-only shutdown wait at 20 seconds. Saved public-route changes normally apply through the proxy watcher without rerunning the launcher. If a new proxied route such as `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}` falls through to the Studio UI, check the proxy logs for a failed nginx reload before using `yarn studio-server:dev:docker:recreate` for a full reset. Loaded-recording playback is local to the selected editor project and does not create a new local recording artifact; **Export recording** in the action bar overflow menu exports the original loaded evidence, while **Save Recording** remains a direct action only for the most recent normal local run when no recording is loaded. Canceling the hosted browser save picker is terminal for that export attempt and must not trigger the anchor-download fallback; the fallback is reserved for an unavailable or unusable picker API. This keeps hosted recording downloads and Run Activity timing independent of the accelerated playback delivery clock.
- A failed node can retain display-only checkpoint outputs on its terminal `nodeError` event. LLM Chat uses this for its attempted request messages, partial response/tool/reasoning state, enabled request/response bodies, usage, and attempt diagnostics, so a recorded failure must show that evidence beside the error even when partial-output recording is off. The pipeline begins a checkpoint immediately before the AI SDK executor; that is an attempted request, not a confirmed network delivery, and no setup/cache/preflight path may fabricate **Messages Sent**. Fallback display clearing must never overwrite the invocation-owned checkpoint. Split terminal evidence includes every started item that produced output or a checkpoint; the app merges it by split index to preserve older partial sibling pages and must compare complete split maps before releasing stored references. All checkpoint values are inspection evidence, never successful graph outputs or downstream data. A remote `abort` is only cancellation notification: the executor/app retains the request-scoped recorder and routing until root `done`/`error`, so late node checkpoint/error frames are captured. Evaluation captures obey the same rule: an error-path cleanup first checks for a request-scoped root terminal instead of treating the rejected caller promise as recording completion. A disconnected or explicitly disposed capture settles as unavailable rather than masquerading as a completed recording. The hosted editor stores ordinary checkpoints as `outputData` and split checkpoints as `splitOutputData`, and must ignore a late detached `partialOutput` after that invocation reaches a terminal state. `run-recordings-modal.spec.ts` verifies this exact browser path with a failed LLM replay.
- The proxy preserves the request port for browser-facing URLs by deriving `X-Forwarded-Host` from the request `Host` header. This matters for local OAuth and dummy OAuth on `http://localhost:8081`; if generated links start pointing at `http://localhost/...`, check the forwarded-host maps before changing API URL generation. Incoming `X-Forwarded-Host` / `X-Forwarded-Proto` headers are ignored unless `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true`, which should only be used behind a trusted ingress that overwrites client-supplied forwarded headers.
- proxy startup scripts are Linux shell scripts; dev Compose mounts them from the repo, while production images bake them into the proxy image. The repo pins `*.sh` files to LF line endings so Windows checkouts do not inject CRLF characters into `/bin/sh`
- The proxy does not serve a static UI-gate prompt. It protects dashboard/editor, API, and editor websocket routes with nginx `auth_request`, then proxies denied browser requests to the API-rendered `/ui-auth/prompt`. The prompt posts or redirects with a sanitized local `return_to` path so successful key or OAuth sign-in returns to the requested dashboard/editor or published web-app URL instead of always landing on `/`. Dev and production nginx templates proxy URI-suffixed auth/websocket targets through `set` upstream variables; keep that pattern for named locations such as `@web_with_ui_gate_prompt`, because nginx rejects `proxy_pass http://host/path` directly inside named locations.
- standard proxied HTTP routes default to a `180s` upstream timeout through App Settings -> `Workflow endpoints`; websocket routes stay long-lived separately
- the local Docker stacks keep `RIVET_API_PROFILE=combined` by default, so `/api/*`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, `${RIVET_LATEST_APPS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, and `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` all land on the same `api` container there
- the `web` service runs the Vite dev server inside the container with live bind mounts
- the dev proxy mounts `deploy/studio-server/compose/nginx/default.dev.conf.template`; keep the Compose-relative path at `./nginx/...` when moving deployment files, otherwise nginx starts with its stock welcome page while still appearing healthy
- the dev stack keeps container dependency state in Docker named volumes and keys its freshness marker to the root Yarn metadata. The live-mounted web and combined backend services set `YARN_NODE_LINKER=node-modules` for their entire process lifetime, so post-install workspace commands use the same layout as the mounted dependency volume. They also put `YARN_INSTALL_STATE_PATH` inside that volume and use the shared named Yarn cache. Vite's optimized-dependency cache has its own named volume, so its atomic directory swaps never run inside a Windows bind mount. A container install must never overwrite the host checkout's PnP install state or add platform-specific cache archives to it. Do not reuse host-native unplugged artifacts inside Linux containers. Development uses the isolated `rivet-studio-server-dev` Compose project. Production detects a single historical standalone `ops_rivet_data` or `compose_rivet_data` volume and adopts that Compose project identity for an in-place monorepo cutover. `compose` remains the fresh-install default. If both legacy volumes exist, set `RIVET_STUDIO_SERVER_COMPOSE_PROJECT` explicitly rather than letting production data selection be ambiguous.
- Docker dev runs the live-mounted web Vite server plus both backend source watchers in one API container; `yarn studio-server:prod:custom` still builds the standalone executor image for rollback, while its running stack uses only `proxy`, `web`, and `api`
- the launchers compute host bind mounts before calling Compose. With `RIVET_ARTIFACTS_HOST_PATH=../` from the repo root, both dev and production-style Docker mount `<repo>/../workflows` at `/workflows`, `<repo>/../workflow-recordings` at `/workflow-recordings`, and `<repo>/../runtime-libraries` at `/data/runtime-libraries`. If you bypass the launcher and run Compose directly, set those three `RIVET_*_HOST_PATH` values explicitly; otherwise Compose uses isolated repo-local `.data/*` directories and will not show the external workflow tree.
- the production web image installs from the root Yarn metadata, builds the required Rivet workspaces, then builds `studio-server-web`; the root `package.json` remains the About-modal version source
- the API image builds `core`, `node`, `evaluations`, shared/bootstrap, and the API through workspace commands from the same source revision
- the web image builds `core`, `evaluations`, shared, and the hosted web workspace through the root workspace graph
- hosted Evaluations use the full upstream `EvaluationStore` contract. Suite/dataset/baseline definitions live in the API store (`evaluation-runs.sqlite` in filesystem mode or PostgreSQL in managed mode), while runs and replay evidence remain project-scoped. Do not reintroduce `evaluationRunStore`, write definitions into project YAML/sidecars, or remove the explicit Evaluation-library flush before hosted project saves. The IndexedDB `LocalEvaluationRunStore` import in `hostedRivetProviders.ts` is an idempotent one-time compatibility bridge for browsers used with older wrapper releases. [Evaluation execution-event accounting](../EVALUATIONS.md#execution-event-accounting) documents the shared provider/tool evidence collector used by hosted execution and the other evaluation adapters. `evaluation-metrics.spec.ts` verifies persisted Browser evidence and a failed real Node-executor call through `host.docker.internal`; keep that hostname mapped by the Docker development stack rather than replacing the executor run with a mocked socket.
- the executor image builds `core`, `node`, Evaluations, bootstrap, and the Studio Server executor from the root workspace graph. It deliberately does not run upstream `build:executor-runtime`, because that target also compiles the native desktop sidecar and requires Rust; the hosted container uses the Studio Server's JavaScript-only esbuild bundle.
- Docker dev source-mounts the repository into the combined backend and runs the executor-specific esbuild watcher alongside the API watcher. The executor watcher bundles Core and Node directly from their workspace source entrypoints, watches the complete transitive bundle graph, and replaces only the child executor process after each successful rebuild. It sends not-ready before replacement and ready only after the new WebSocket listener and code workers initialize; a failed rebuild keeps the last running executor. Core, Node, app-executor, studio-server-executor, and shared-contract edits therefore reach subsequent hosted Node runs without restarting `yarn studio-server:dev`, rebuilding host package outputs, or recreating the container. Both watchers share the backend's named `node_modules` and Yarn-unplugged volumes; web has separate dependency volumes, so installation cannot overwrite the host's PnP state or race the web dependencies. Lockfile changes still require the launcher's normal whole-stack dependency reconciliation.
- local and image API entrypoints resolve Rivet packages through Yarn workspaces. Do not add direct imports from another package's `src` tree merely to bypass its declared exports.
- API `tsc` builds include `src/tests`, but the private service does not emit declaration files. This keeps test-helper inference portable under both PnP and the node-modules linker used by Docker. Both API Dockerfiles include the monorepo source modules that tests import statically; keep those imports inside the root image context.
- Playwright helpers that load browser assets owned by another workspace must anchor `createRequire` to that workspace's real `package.json` through `import.meta.url`. Do not derive the anchor from `process.cwd()`, because `yarn workspace ... exec` intentionally changes the working directory.
- Sidebar wrapping checks treat an adjacent count, status, or icon as first-line aligned when its center remains inside the first rendered label line. Do not use a fixed pixel distance from the line center: glyph metrics and fractional layout differ across Chromium hosts even when the marker is visibly attached to the correct line.
- the Docker dev API mounts the deployment scripts required by package tests and launchers at their monorepo-relative paths, so the same workspace commands run locally and inside Compose
- `yarn studio-server:dev:docker` maps Docker's supported `host-gateway` address to `host.docker.internal` in the combined backend container, so Node-mode editor runs and headless endpoint runs can call a service on the developer machine at `http://host.docker.internal:<port>` without editing the launch command or `.env`; it also bypasses any configured Node executor proxy for that hostname. The target service must still listen on `0.0.0.0` (or another non-loopback interface), because a process bound only to `127.0.0.1` or `[::1]` cannot accept a Docker connection. This mapping is dev-only and is not used by production Compose or Kubernetes.
- Docker image builds use the monorepo root context. The root `.dockerignore` excludes local dependency materializations, Rust/Tauri targets, desktop sidecars, test artifacts, and prior build output while retaining the checked-in Yarn cache/releases and all workspace source required by the hosted images. Runtime `.env` and `.env.*` files are excluded recursively from the build context and builder cache; only `.env.example` and `.env.*.example` templates are retained. Keep runtime credentials in the selected Compose runtime `env_file`, not an image layer. `yarn studio-server:dev:docker:build` builds those images without starting the stack.
- Docker development sets `HOME=/home/rivet` and keeps npm/Yarn caches on its named development volumes. Production Compose instead directs npm/XDG caches and hosted plugin-install pnpm storage into bounded backend `/tmp` scratch; the static web server does not install packages at runtime
- the launcher waits for ready services; App Settings -> `Docker` -> `Startup wait timeout` controls the overall wait window when a previous API/proxy container can provide the saved settings file, otherwise the first-run launcher default is `1200s`. Docker API healthchecks use `/readyz` and keep a long startup grace because cold starts may reconcile runtime libraries, initialize workflow storage, refresh npm dependencies, copy Rivet package sources, or relink local package overlays. `/livez` and legacy `/healthz` are liveness-only. Startup does not become complete until the HTTP listener has bound, and shutdown cleanup is serialized so late startup completion cannot leave a backend worker or pool alive. Managed readiness checks propagate cancellation into PostgreSQL and S3, cap PostgreSQL/S3 connection waits at 10 seconds, and cap idle S3 socket waits at 60 seconds; these transport bounds also protect normal managed requests from waiting forever. Compose grants the API `150s` to stop so the default `120s` application drain still leaves time for recording flush and resource cleanup before Docker kills the container
- on Windows/Docker Desktop, if Compose fails before containers start with `error while creating mount source path '/run/desktop/mnt/host/<drive>/...'` and `file exists`, first verify the host folder exists, then run `wsl --shutdown` from PowerShell to reset Docker Desktop's WSL file-sharing bridge before retrying `yarn studio-server:dev:docker`
- in Storage-tab `Object storage` mode, both workflow state and runtime-library releases come from managed services, while `/data/runtime-libraries` remains only an extracted local cache/workspace inside each container
- in Storage-tab `Object storage` mode, published/latest endpoint execution also keeps API-local warm caches for endpoint pointers and immutable revision contents; the first hit after startup or after a workflow mutation can still be slower, but repeated hits for the same unchanged trivial workflow should settle onto the warm local path
- a later cleanup pass did not change that behavior; it extracted the managed execution invalidation/service code, replaced brittle source assertions with behavioral tests, added a measurement tool, and hardened listener startup/shutdown plus same-process self-notify handling without changing the public execution contract
- if the Storage tab uses `Managed Postgres`, runtime-library replica-status rows also live in the shared Postgres database, so stale rows from older containers can survive a Docker recreate until retention cleanup runs or you clear them explicitly
- when the Runtime Libraries modal shows stale rows that are only historical dev noise, use the `Clear stale replicas` action or call `POST /api/runtime-libraries/replicas/cleanup`
- set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` when you want additive execution timing headers for local diagnosis of endpoint resolve/materialize/execute stages
- set `RIVET_CODE_RUNNER_TELEMETRY=true` alongside workflow debug headers when you also want ManagedCodeRunner call counts, prepare/compile/execute timing, and cache hit/miss headers
- use `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true` to disable only the API-side compiled Code/Expression function cache
- use `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true` to restore the previous per-code runtime-library preparation behavior without disabling telemetry or the compiled-function cache
- local Docker still does not prove multi-backend latest-debugger support; the supported Kubernetes contract is a singleton control-plane backend plus independently scalable execution replicas

## Recording-storage notes

Workflow recordings use two persistence locations:

- in `filesystem` mode:
  - compressed replay artifacts under `RIVET_WORKFLOW_RECORDINGS_ROOT`
  - a SQLite index under `RIVET_APP_DATA_ROOT`: `recordings.sqlite`; it uses rollback journaling instead of WAL so Docker volumes and Kubernetes PVCs do not need SQLite shared-memory support
  - queue and retention limits under `RIVET_APP_DATA_ROOT`: `settings/run-recordings.json`
- in `managed` mode:
  - recording metadata rows in Postgres
  - recording and replay artifacts in managed object storage
  - queue and retention limits under `RIVET_APP_DATA_ROOT`: `settings/run-recordings.json`

Filesystem-mode Docker topology now splits the hot paths intentionally:

- `RIVET_WORKFLOWS_HOST_PATH` backs `/workflows` for live projects and `.published/`
- `RIVET_WORKFLOW_RECORDINGS_HOST_PATH` backs `/workflow-recordings` for replay bundles
- `rivet_data` is shared by the backend and proxy for settings and installed package plugins. Both production and development mount it at the API and executor app-data paths inside one backend container. Every runtime mount is no-copy; the root-only `filesystem-artifacts-init` service is its sole initializer, preventing Docker from racing to populate a fresh volume from multiple image paths.
- this keeps high-churn recording writes off the workflow-source bind mount on Windows/Docker Desktop
- the official API and executor images run as uid/gid `10001:10001`. Before either service starts, each Docker topology runs the root-only `filesystem-artifacts-init` service against the configured workflow, recording, runtime-library, and app-data mounts. It creates missing roots and repairs their ownership to that uid/gid, preserving existing files while letting an upgraded deployment reuse mounts previously created by root. It scans a mount tree only when that mount root still has legacy ownership, so ordinary restarts do not repeatedly walk runtime-library contents. Non-Compose deployments must grant the same uid/gid access themselves.
- if `/workflows` is not writable, hosted editor saves fail and the API now returns an explicit workflow-storage permission error instead of a generic hidden 500
- if `/data/runtime-libraries` is not writable, `/api/runtime-libraries` now returns an explicit runtime-library storage permission error instead of a generic hidden 500

Migration note for existing local Docker setups:

1. stop the stack
2. move `D:\Programming\workflows\.recordings` to `D:\Programming\workflow-recordings`
3. keep `RIVET_ARTIFACTS_HOST_PATH=../` so the launcher derives `D:\Programming\workflow-recordings` automatically
4. recreate the stack

For host-based API execution, filesystem-mode recording persistence still requires `node:sqlite` (Node 24+). If your host Node version is older, use the Docker dev stack instead of `yarn studio-server:dev:local`.

Filesystem-mode recording startup reconciliation is intentionally non-fatal for stale-bundle cleanup. If an old bundle directory cannot be removed because of host-side permissions, the API logs the cleanup error and still starts; the undeleted bundle simply remains on disk until permissions are corrected.

The SQLite file is only a rebuildable metadata index. If a deployment from an older image cannot open a stale `recordings.sqlite-wal` or `recordings.sqlite-shm` sidecar, stop the API, move the three `recordings.sqlite*` files out of app data as a backup, and restart. The API rebuilds the index from the recording bundles; do not remove `/workflow-recordings` or the workflow/Postgres volumes.

Filesystem-mode startup reconciliation validates `recordings.sqlite` against completed bundle metadata under `RIVET_WORKFLOW_RECORDINGS_ROOT`. The workflow-summary route may schedule the same check in the background, at most once per five minutes, but list and artifact requests do not wait for a filesystem-wide scan. A repair reads bundle metadata before opening its short SQLite replacement transaction, so concurrent requests cannot observe a cleared or partially rebuilt index. If a normal recording write or delete changes the index while that scan is running, the repair's revision guard skips the stale replacement:

- empty workflow-level recording directories do not count as completed bundles
- bundle-key signatures detect equal-count swaps between disk and SQLite
- if repair cannot converge, such as when a corrupt `metadata.json` exists, the API logs the mismatch once
- repeated repair is skipped until the completed-bundle signature or indexed counts change

The background filesystem scan stats recording metadata in bounded batches rather than opening every bundle concurrently. This avoids descriptor and I/O spikes on histories with thousands of runs.

During a rebuild, workflow display metadata is selected from the newest completed bundle for that workflow. Filesystem directory order must not let an older recording overwrite a newer project name or path in the rebuilt index.

`GET /api/workflows/recordings/workflows` and ordinary run pages read indexed metadata only; they do not decompress recording/replay bundles. The workflow list also skips graph/node project statistics and aggregate web-app publication comparisons because the Run recordings UI does not use them. If this endpoint approaches an outer-proxy timeout, inspect SQLite health and API logs first: the number or compressed size of recording payloads should no longer be part of its synchronous request cost.

For the filesystem workflow list, project IDs come from the existing recording-index path mapping or the validated project metadata already returned by `getWorkflowProject`. Never re-deserialize every project without recordings solely to retrieve its cached ID; that includes unpublished projects later excluded from the picker. A cold/stale project cache can still require one source parse, and endpoint publication-status checks still hash source files. Diagnose those stages separately from the recording-count SQL and from main-thread contention; timing a separate SQLite or filesystem probe does not measure in-process deserialization or API event-loop delay. This catalog route does not currently attach the optional `x-duration-ms` middleware.

Apply that discovery boundary to filesystem published-project references too: fallback ID search uses validated project-index metadata, then materializes and checks the selected live/published project. `filesystem-execution-cache.test.ts` covers unrelated-source read avoidance, missing-ID fallback, stale-cache refresh without executing an unpublished draft, and rejection of a cache claiming the wrong identity. Do not reuse this shortcut for authoritative save reconciliation. Single-recording deletion uses `hasWorkflowRecordingRuns` as an indexed existence probe including failed and child runs, not a complete row-list read; `filesystem-recordings-root.test.ts` verifies final-recording cleanup and bounded deletion reads after draining fixture-triggered background retention.

Deployment compatibility regressions deny filesystem cache writes with `EROFS` and `EACCES` and resolve again through an independent reference loader, proving that the cache is optional rather than correctness-critical. The managed execution-service tests check stale/reused hints, embedded identity mismatches, and identity preservation on resolve/materialization invalidation retries; operational blob errors must not become false reference misses. Run these alongside managed execution cache/invalidation, managed recordings, and local SQLite backend tests when changing discovery. Kubernetes render/contract checks verify deployment configuration, not live PostgreSQL/S3 throughput or a provider rollout; use the protected staging gates separately for those claims.

Recording persistence is intentionally backgrounded after an HTTP or WebSocket action result is ready. On `SIGTERM`/`SIGINT`, the API first marks readiness as draining, stops accepting new web-app actions, and closes HTTP acceptance. Existing HTTP connections and accepted web-app runs may finish within `RIVET_SHUTDOWN_GRACE_SECONDS` (default `120s`). At the deadline, Rivet aborts tracked HTTP graph processors before forcing their client connections closed; it closes upgraded WebSocket clients without interrupting their accepted durable action processors, which can reconnect to another execution replica. Terminal WebSocket hooks can therefore enqueue their final recorders before the recording queue is flushed and managed Postgres connections are disposed. A hard kill, host failure, exhausted drain deadline, or exhausted recording queue can still prevent a recording from being stored; workflow execution results remain independent and queue drops/errors are logged under `[workflow-recordings]`.

Managed Postgres/S3 deployments apply the same `Run recordings` age and per-endpoint limits as filesystem deployments. The per-endpoint limit groups by workflow id plus historical endpoint name, so a slug reused by another project gets an independent history allowance. The control-plane API performs a global retention pass during startup and then on the chart-owned managed-maintenance timer (five minutes by default); each pass selects candidates in PostgreSQL and deletes at most the configured maintenance batch while holding its fence, so a backlog converges without loading all history into Node or using one unbounded metadata transaction. Normal endpoint writes do not initiate a global cleanup scan. The execution Deployment has that scheduler disabled and does not construct the reconciliation task or its secondary runtime-library S3 client, which keeps published `/workflows/...` traffic from multiplying retention I/O or allocating audit-only storage resources. The worker validates a PostgreSQL fencing lease inside the row-deletion transaction, enqueues the affected recording/replay object keys durably, rechecks metadata ownership before deletion, and retries transient object-store failures with bounded exponential backoff. A still-referenced object is marked `blocked` for operator investigation, never deleted by that pass; a later deletion intent reopens it after its final metadata reference has gone away. Managed byte counts use UTF-8 bytes rather than JavaScript character counts. This covers endpoint recording retention, explicit managed recording/project deletion, and blobs successfully uploaded by a request that later fails to attach them to metadata. That last path queues the known keys first and deliberately leaves them untouched if the outbox cannot be persisted, because safety beats an unchecked delete. The same owner now performs a checkpointed, audit-only reconciliation pass: it finds missing workflow references, Evaluation recordings without a parent run, and old unreferenced workflow/runtime-library object candidates, but it never deletes or queues unknown prefix objects. Object-list prefix markers are ignored; object scans persist the last prefix-relative key rather than an expiring provider continuation token; and a malformed persisted Evaluation checkpoint restarts that bounded scan rather than leaving it stuck. Findings remain provisional until their full generation commits under the maintenance fence, so their completed-scan count cannot advance after an interrupted page. A process crash between object upload and queueing is therefore detected only after the object passes the 24-hour minimum-age gate; converting a durable candidate into deletion requires a separate, reviewed retention policy.

For slow `GET /api/workflows/recordings/workflows` diagnosis in Docker, compare:

- completed bundle files under `/workflow-recordings`:
  `find /workflow-recordings -mindepth 3 -maxdepth 3 -name metadata.json -type f | wc -l`
- indexed run rows in `/data/rivet-app/recordings.sqlite`:
  `node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync('/data/rivet-app/recordings.sqlite'); console.log(db.prepare('select count(*) n from recording_runs').get())"`

The `Run recordings` modal can also filter a workflow's runs by recorded request input. It includes both workflow endpoint runs and Rivet web-app button action graph runs. The workflow dropdown shows each workflow's saved recording count as a neutral badge so developers can pick busy histories quickly without implying publish status. Use the `Input JSON path` control with a path such as `$.foo`, an operator such as `==`, and a value such as `bar`. The API evaluates `$` against the root graph input value stored in the recording's `inputs.input.value` event. For workflow endpoint runs, that value is the HTTP request body. For web-app action runs with an `input` graph port, that value is the UI state mapped to that port; if the action target graph uses other input port names instead, `$` falls back to an object of all captured graph input values keyed by port name. Each run row shows the stored `endpointNameAtExecution` value, which is historical metadata from the time the route ran rather than the workflow's current endpoint name. Workflow endpoint runs store the endpoint slug; web-app action runs store the app route path, such as `/apps/my-tool` or `/apps-latest/my-tool`. For `contains`, when the filter value parses as a string, the resolved left operand is treated as full text too; strings are searched as-is, and objects/arrays are searched recursively across object keys and primitive values without JSON escaping, so `$ contains 'request_id'` searches the whole recorded input object and `$.foo contains 'foobar'` can match text nested inside an object at `foo`. Missing paths match `not_exists`, do not match `exists`, and resolve to actual `undefined` for the other operators; the filter value literal `undefined` also parses as `undefined`. Ordering comparisons with `undefined` do not match.

Input filtering never changes recording storage or creates a durable second index. Both backends use `filterRecordingInputWindows`: a response can consume several newest-first keyset windows under one 150 ms budget, including metadata I/O. Windows grow from at least 24 to at most 256 candidates, with a roughly 4,096-candidate response safety cap and an event-loop yield between windows. Only the first request probes the newest artifact by itself; a nearby match returns promptly with already-ready ordered results. Continuations fill their page instead of returning one matching recording or one sparse metadata window per HTTP request. After the budget expires, no additional speculative reads start, but already-ready ordered decisions can be consumed. If metadata I/O or scheduling exhausts the budget before any admission, one candidate must still finish to advance the cursor. A slow candidate is never skipped.

Normal page completion carries an internal cancellation reason distinct from errors/client cancellation. The extracted-input cache cancels queued work immediately, but already-admitted work gets at most 250 ms to finish or acquire a consumer from the next request. These abandoned loads still occupy the original cold-load slots; the grace period cannot increase concurrency. Explicit cancellation/error paths receive no grace. New consumers cancel the expiration timer, shared loads retain independent interests, and every consumer receives its own extracted-input object. Invalidation/reset detaches the current load identity: existing consumers may finish their captured read, but later consumers start a fresh read and old completion cannot repopulate or overwrite the cache. Detached reads still cancel when their last consumer leaves; no per-key generation registry is needed.

Cold-load admission also uses a 256 MiB aggregate **estimate** derived from stored compressed/uncompressed sizes and a conservative allocation multiplier, before reading bytes. The eight-operation cap remains in force and FIFO waiters cannot be overtaken. One artifact larger than the estimate budget runs alone rather than starving. This is not an absolute RSS limit: inaccurate metadata, decompression expansion, and the size of one recording can exceed it. Worker input copies are deferred until dispatch. Unexpected worker failures reject the active job and replace workers with bounded backoff; repeated startup failures briefly reject searches with a retryable error instead of permanently parsing on the API thread. Source-mode tests retain their explicit inline path; compiled-worker tests exercise actual production worker recovery, gzip failures, and cancellation.

The filter extracts only the captured start input. That CPU-intensive JSON work happens in a bounded worker pool in compiled API builds, and each process caps the complete cold read-and-extract operation at eight at a time. A cancelled active parse keeps its worker slot reserved until termination completes, so a cancellation burst cannot temporarily over-provision parsing workers. The process-local cache retains only the serialized extracted input—not the source artifact—so a large trace does not disqualify a small request body from caching. Completed entries use bounded least-recently-used retention and expire lazily on access; cache insertion never walks the full retained history. The cache is populated only by actual input searches, so ordinary recording persistence never schedules full-recording JSON parsing. Request cancellation reaches filesystem and S3 reads, pending cache loads, and queued extraction work; malformed artifacts are not cached and unexpected storage failures fail the request rather than becoming false non-matches.

For filesystem recordings, the API now reads only the stored bytes and transfers an owned buffer to that bounded worker. The worker performs gzip decompression, UTF-8 decoding, JSON parsing, and input extraction; managed S3 stores use the same byte path. This preserves the format and all JSONPath behavior while preventing a large recording from expanding into a decoded JavaScript string on the API event loop. A third-party managed blob store may still implement the older text-only interface during a rolling upgrade; its compatibility fallback remains correct but cannot avoid that text allocation. Do not add a regex or substring “streaming JSON” extractor: strings, escaped Unicode, and late recording string tables make it unsafe. A tokenizing extractor would need independent behavioral and memory benchmarks before replacing the simpler complete-artifact worker path.

Input-filtered pagination uses an opaque `nextInputAfter` continuation bound to the workflow, status filter, input predicate, timestamp, and recording ID. Filesystem SQLite and managed PostgreSQL both seek with the composite `(created_at, recording_id)` cursor boundary, so concurrent inserts/deletes and deep histories do not make a continuation scan an ever-growing `OFFSET`. In managed storage, the token retains PostgreSQL's exact UTC timestamp text rather than a JavaScript `Date`, so microsecond `NOW()` values remain safe keyset boundaries. `nextInputCursor` remains a legacy fallback for older clients; if a request includes both cursors, the opaque keyset cursor wins so the request cannot skip a page. A response can be non-exhaustive, including a scan window with no matches: `totalRunsExact: false` and `hasMore: true` tell the dashboard to continue in the background and append later matches. The visible list is virtualized, preserves measurements for already-rendered rows when older matches append, and does not create a DOM card for every matched recording. The dashboard shows searching/completed/stopped status and exposes `Stop search`. Opening a recording hides the modal without resetting it, and the left panel shows a compact `Found: N` badge on the `Run recordings` row until the user explicitly clicks the modal close button. The explicit close path, filter clear/hide path, and stop button abort in-flight recordings requests; simple hide-for-replay keeps the current modal state available for reopening.

The opaque continuation also carries the already-consumed numeric cursor solely for an older client that loses its opaque token mid-search; the opaque composite boundary remains authoritative whenever both are present. Do not derive a numeric cursor from the count of matching rows or from reads merely started: it must advance only through candidates consumed in newest-first order.

To evaluate a recording-input performance change, build the API and run `recording-input:benchmark` with `recent`, `dense`, `sparse`, and `absent` scenarios. It uses a temporary production SQLite schema/query, loopback HTTP pagination, real gzip files with alternating compressibility, production deadlines, and compiled workers. Reports compare single-window and multi-window pagination, async parent-decode and worker-decode paths, cold/warm caches, and two simultaneous cold searches. `--read-latency-ms` delays storage, while `--http-latency-ms` models per-request client latency; neither changes production configuration. First-full-page timing counts accumulated visible results, not the size of one response. Worker queue timing includes waiting before dispatch. Search RSS is sampled, not an exact allocation bound. Independently spawned extraction trials compare full parsing with a benchmark-only tokenizing candidate and report OS peak RSS. The measured tokenizer saves some large-artifact memory but is substantially slower, so production retains native full parsing. Late string tables require reading the whole document, not necessarily retaining it all; they are not by themselves a reason to reject tokenization. See [recording search performance](recording-search-performance.md) for measurements and remaining limitations. PostgreSQL execution plans still require `EXPLAIN (ANALYZE, BUFFERS)` on a representative managed instance; the SQLite regression invokes the actual production query and schema, including failed-only filtering.

The separate `Run statistics` modal uses the SQLite/Postgres index only, so large replay bundles do not delay timing analysis. It defaults to successful published runs for the preceding seven days and can switch endpoint/web-app action targets with the left-aligned header control, set a 24-hour/7-day/30-day/90-day/custom period, and choose Published, Latest, or Both. A full-width target dropdown sits before the period and version filters and becomes searchable for longer endpoint or web-app action lists; there is no separate target sidebar. It shows the all-run `Run outcomes` counts and percentages first; those outcome rates are independent of duration analysis. A full-width divider and dedicated top spacing separate the following `Statistics` section, which defaults to successful runs and offers explicit include-failed/include-warning controls for median, P95, average, fastest, slowest, and the duration chart. `Chart grouping` keeps the compatible adaptive behavior in `Auto`, or groups non-empty chart buckets by UTC calendar day or Monday-starting ISO week. Metric cards are compact two-line value summaries for the selected period; the query and response intentionally contain no previous-period comparison payload, because period-wide change is inspected through the duration chart and a wider selected period. This avoids reading an unused second time window from the recording index. Chart series deliberately use blue for Median and violet for P95, reserving green/yellow/red for run outcomes. The modal uses the same dark overlay, surface, margins, header spacing, and body spacing contract as `Run recordings`. Duration means processor execution time, not HTTP transport, queueing, or background recording persistence. New rows retain the executed endpoint graph or web-app UI graph/component identity so renames do not merge action histories. Older path-only web-app rows, and malformed historical web-app rows without both stable UI graph and component IDs, are listed under `Legacy action`; historical rows without a leading-slash route remain endpoint runs. Target keys are opaque shared values, never delimiter-joined IDs. The API routes are `GET /api/workflows/run-statistics/targets` and `POST /api/workflows/run-statistics/query`; both are metadata-only reads.

The statistics UI keys the retained-target catalog only to the active surface, and keys timing responses to the active target, period, version, outcome, and chart-grouping controls. A slower or aborted earlier request must never render stale metrics, outcomes, or an old error under newer filters.

The target selector is a portaled modal control. Its menu must use the shared modal-menu stacking level so mouse activation remains visible above the modal surface as well as keyboard selection.

Recording playback state is project-scoped in upstream Rivet. The hosted editor bridge must attach a loaded recorder to the exact replay project id returned by the workspace open operation; writing the older `{ recorder, path }` shape loads the project but intentionally leaves `Play Recording` hidden. Switching to another project must not globally clear that owner-scoped state, and closing a replay tab prunes its cached recorder payload. Replay datasets are optional. A `404` from the replay-dataset artifact endpoint means that run has no captured dataset snapshot, and `HostedIOProvider` must continue opening the replay project with an empty dataset rather than treating that response as a project-load failure.

Keep Studio Server recording cleanup on the stable shared `loadedRecordingState` export and perform the project ownership comparison in the hosted application. Do not import an internal convenience atom such as `clearLoadedRecordingForProjectState` merely because it exists in the same monorepo: use the public host seam so Rivet editor refactors and Studio Server changes remain independently reviewable in one commit.

Cross-project Subgraph runs are attributed to the called project. Unlike a root recording, a child recorder begins with `graphStart` rather than `start`; `graphStart.inputs` contains the values mapped from caller ports to the target graph's Graph Input names. The shared extraction helper understands both formats for artifact tools and tests: a `prompt` input resolves at `$.prompt.requestId`, while an `input` port uses the root path `$.requestId`. This does not make child recordings input-search candidates: the modal filters roots only and unfolds their children without input predicates. Hosted editor child recordings depend on **Record local graph executions**; server endpoint child recordings depend on the server recording setting. Keep extraction covered with a real child processor recording, and browse ownership covered through the root-search and sub-run HTTP regressions.

The local recording setting also persists the parent editor run in both Browser and internal Node modes, including successful graphs with no LLM-profile events. Do not gate parent uploads on health evidence: that strands child recordings outside the initiating workflow's related-run scope. Preserve the parent/child correlation, disabled-recording behavior, and terminal socket capture checks. `local-editor-recordings.spec.ts` checks real Browser cross-project execution and the real internal Node executor while intercepting recording uploads so fixtures cannot mutate working data.

Recording finalization snapshots project/replay text and elapsed execution time before asynchronous dataset export; serialization errors also take the unavailable-evidence path rather than being silently swallowed. Browser and internal Node share abort-status policy: a successful Abort Graph remains succeeded, an unsuccessful abort marks an otherwise successful run suspicious, and cleanup never demotes an existing failure. Node parent status follows root terminal events, not a child's `graphError`: a Subgraph Error output can handle that child failure and complete the parent successfully. The recording bridge bounds capability/outcome requests to 10 seconds and uploads to 60 seconds. Cache only a confirmed capability or a definitive 404; authentication, throttling, malformed responses and timeouts retry on the next run. Do not automatically retry recording uploads, because a timed-out request may already have committed a recording. The browser regression covers successful early termination, handled child errors, and rejected uploads in both executors, including unchanged successful execution state after a persistence failure.

## Source of truth

- authored Studio Server source lives under `packages/studio-server-*`, `deploy/studio-server/`, `developer-docs/studio-server/`, and the namespaced GitHub workflows
- runtime/bootstrap code belongs under `packages/studio-server-bootstrap/`, not under deployment topology directories
- hosted editor patches that must survive production image builds should live under `packages/studio-server-web/overrides/`, `packages/studio-server-web/dashboard/`, or other tracked wrapper files
- the hosted web image builds upstream `packages/app` through `packages/studio-server-web/vite.config.ts`, not through upstream Rivet's app Vite config. When upstream app/core code imports browser-only virtual modules or browser runtime dependencies such as `nspell`, `dictionary-en`, `rivet-cspell-words`, or Zod's V4 API surface, mirror the required Vite plugin/dependency seam in the wrapper config and cover it in `packages/studio-server-web/tests/vite-aliases.test.ts`. The hosted bundle explicitly resolves bare `zod` imports to `zod/v4`, so upstream core schemas do not accidentally receive Zod's legacy default surface.
- Legacy Google Chat shares its API-key catalogs, types, and Generative AI stream through Core's `plugins/google/googleGenerativeAi.ts`. The importer-scoped hosted override still applies only to Core's legacy `ChatGoogleNode`: it overlays the two retained Gemini 1.5 models with their historical zero-cost entries and rejects Vertex credentials with the hosted-only error. LLM Chat V2 continues importing Core's facade and therefore keeps those models explicitly unpriced. The hosted Vite build runs `check:google-hosted-override`, verifies that the legacy node imports that adapter, verifies the wrapper's GenAI browser entry, and writes `artifacts/studio-server-web/google-browser-dependency-audit.json`; the leaf's reachable graph must not contain Vertex, Google-auth, or Node built-in modules, including Vite's browser-externalized virtual IDs. The redirect runs before Vite aliases so the legacy node cannot be resolved back to Core's Vertex-capable facade. Run `google-generative-ai.spec.ts` headlessly after changing this path; it covers real SDK-parsed partial/final text, function calls, a non-retryable error, retryable 429 recovery, and cancellation without provider egress.
- shared Rivet source lives in the owning `packages/app`, `packages/core`, `packages/node`, `packages/app-executor`, and `packages/evaluations` workspaces. Studio Server consumes those workspaces directly; hosted-only behavior belongs in the explicit host/provider/override seams, while behavior shared by every Rivet host belongs in the owning Rivet package
- generated build output should not be treated as authored source

## Internal ownership boundaries

When adding new code, keep the post-refactor ownership seams explicit instead of rebuilding large mixed-responsibility files:

- workflow-managed backend code goes under `packages/studio-server-api/src/routes/workflows/managed/`
  - `backend.ts` is the facade/composition root
  - DB retry/query helpers stay in `db.ts`
  - transaction sequencing stays in `transactions.ts`
  - row mapping stays in `mappers.ts`
- filesystem recording compatibility code stays under `packages/studio-server-api/src/routes/workflows/`
  - keep `recordings.ts` as the public orchestrator
  - keep artifact IO in `recordings-artifacts.ts`
  - keep metadata normalization in `recordings-metadata.ts`
  - keep index/cleanup/delete maintenance in `recordings-maintenance.ts`
  - keep queue/readiness state in `recordings-store.ts`
- managed runtime-library orchestration goes under `packages/studio-server-api/src/runtime-libraries/managed/`
  - keep `backend.ts` as the facade
  - keep job persistence, SSE streaming, worker flow, process tracking, and replica cleanup in their focused modules
- workflow/filesystem compatibility code should stay obvious in `packages/studio-server-api/src/routes/workflows/storage-backend.ts`
  - do not hide `filesystem` versus `managed` behavior behind a generic abstraction layer
- wrapper-owned app settings use `packages/studio-server-api/src/app-settings/settings-repository.ts`
  - add a domain descriptor for defaults, parsing, schema version/migrations, serialization, and any deliberate fail-closed recovery; do not add another request-path `readFileSync` cache
  - keep reusable primitive validation in `packages/studio-server-api/src/app-settings/schema.ts`; it is a Zod-backed helper layer, not a replacement for domain policy. Domain modules still own their exact fallback, partial-update, stored-file, secret-retention, and fail-closed behavior. Numeric helpers intentionally accept only numbers and numeric strings, never JavaScript-coercible booleans or objects.
  - initialize repositories before API startup and read runtime values through the domain's cached synchronous accessor
  - `captureAppSettingsSnapshot` captures all registered settings domains at request entry, so request code must not bypass the repository and reread settings files midway through a request
  - async refreshes, external-file polling, and writes are serialized per settings path; keep writes and poller refreshes on the repository operation queue so an older disk read cannot replace a newly saved cache entry
  - App Settings HTTP resources use `ETag` and `If-Match`; domain writers must merge scoped PATCH drafts into the repository's current value so independent tabs and concurrent browser sessions do not lose unrelated fields
  - missing files mean first-run defaults, schema upgrades require explicit migrations, writes remain atomic owner-only JSON files, and the repository poller is the compatibility path for external proxy/bootstrap writers
- dashboard controllers belong in `packages/studio-server-web/dashboard/`
  - editor startup/loading feedback belongs in the editor area, not the project tree. Keep the tree's own folder-loading/error states and editor-readiness interaction guards, but do not duplicate "Loading editor" above the rows or in their filename tooltips. `hosted-dashboard-contracts.spec.ts` holds editor startup to check this boundary before and after readiness.
  - `useWorkflowLibraryController.ts`, `useRunRecordingsController.ts`, `useProjectSettingsActions.ts`, `useDashboardSidebar.ts`, and `useEditorBridgeEvents.ts` are composition/orchestration seams; tree fetching, selection/preview debounce, drag/drop, project/folder mutations, version actions, and retained recording-modal state stay in their focused hooks instead of returning to the workflow controller
  - `AppSettingsModal.tsx` stays a tab-composition shell; each settings domain owns its form hook under `packages/studio-server-web/dashboard/app-settings/`, and all forms use `useSettingsFormResource.ts` for revision-aware load/save/conflict handling. A tab save must send only its scoped draft and must not reset unsaved fields in another tab
  - keep the workflow-library header block at `37px` high without a bottom divider; the whole open-state header row is the collapse control with square hover corners and the sidebar icon before the `Rivet Studio Server` title; collapsed mode should be a persistent full-height `30px` rail button with a centered `>` chevron rather than a small header button, show the opened project's larger status dot in the former header slot only when its aggregate endpoint/web-app publication status is `Published` or `Unpublished changes`, keep the active project card grey/green/yellow tinted from that same aggregate status where any `Unpublished changes` wins over `Published`, keep the workflow tree mounted while folded, reveal the contents only after the reopen width animation completes, and keep resize behavior pointer-captured with a forgiving splitter hit target, no width transition while dragging, and fold/unfold thresholding at half the minimum sidebar width
  - single-clicking a project row should open it through the bridge as a preview tab; double-clicking, editing, running, saving, activating Remote Debugger on the active preview, or any unsafe replacement condition promotes that tab to persistent. For a not-yet-open workflow project, the dashboard should send the tree display title with `open-project`, and the iframe should call `RivetWorkspaceHost.startOpeningProjectTab(...)` before loading the file so Rivet owns the immediate tab/preloader UI. Finish that same tab with `finishOpeningProjectTab(...)` after `HostedIOProvider` returns the real snapshot, or cancel it on load/duplicate-id failure; never fake a temporary project snapshot or write upstream tab state directly. Preview replacement belongs in `usePreviewProjectLifecycle.ts` plus the serialized open handler in `useEditorCommandBridge.ts`, where the bridge can read Rivet's dirty/run/session state and close only clean known preview tabs through `RivetWorkspaceHost.closeProject(...)`. A single-click on an already-open persistent project should only activate that tab and should not close the current preview slot; the slot is replaced only when another not-yet-open project opens as preview. Keep the single-click preview debounce in `useWorkflowLibrarySelection.ts`, not per project row, so clicking a different row cancels any older pending preview open before it can reselect the previous project. When the active editor tab is the clean preview being replaced, use `replaceCurrent` through `RivetWorkspaceHost` instead of closing it first, so the dashboard does not blink back to a persistent tab while the next preview loads. When replacing an inactive preview, keep `DashboardPage.tsx`'s pending-open guard intact so intermediate active-project callbacks from closing the old preview do not briefly select the persistent project before the new preview opens. Pass `tabUi: { preview: true }` for preview opens/replaces and clear it with `setProjectTabUiState(..., { preview: false })` when promoting, so upstream Rivet owns the italic editor-tab rendering. Remote Debugger promotion should observe only Rivet's `external-debugger` executor-session target, not hosted internal executor reconnects. The active project card should not reintroduce a separate `Edit` button; row click/double-click owns open intent, empty workflow-library body clicks clear only the selected card, and the 166px minimum-height card keeps the project name above endpoint/web-app status lines, then the graph/node/web-app count line. Long project, graph, and folder names wrap in their respective left-panel rows instead of being ellipsized, including unbroken strings; the active project card instead clips its name to one line and retains the full name in its hover title. The endpoint line and web-app line should always render for selected projects with the same status-row height whether the row contains a pill or plain text; projects with no current web apps show `Web app: none`, while projects with web apps load status from the existing project web-app summary endpoint only for the selected project. The tree project dots and collapsed rail dot should use the same aggregate status as the summary card: grey means no dot, green means green dot, and yellow means yellow dot. The card keeps a clear vertical gap before the visibly button-like `Settings` action and conditional `Save` button, and must reserve at least its default height when no project is selected so the project tree below it does not jump. `Save` is shown only when the selected workflow is the active editor project and Rivet reports unsaved changes through the editor bridge.
  - keep bottom panel actions in the mounted workflow-library panel, ordered as `Run recordings`, `Run statistics`, and `Settings`; the app-level `Settings` modal uses a left vertical tab rail, shows general runtime config, owns the Run recordings retention form and Runtime libraries administration, and owns the Node executor proxy form plus websocket URL override fields
  - keep project-settings validation and labels in `projectSettingsForm.ts`
  - keep run-recordings modal shell logic in `RunRecordingsModal.tsx` and its focused UI slices in `RecordingWorkflowSelect.tsx` and `RecordingRunsTable.tsx`
  - Run statistics targets are a catalog of every retained endpoint or web-app action for the selected surface. Period, published/latest version, and outcome checkboxes apply only to the selected target's query; when they match no runs, preserve the target selection and state that result directly below the filters.
  - portal run-recordings dropdown menus that can open inside the scrollable modal body, such as the input-filter operator select, so option lists are not clipped by modal overflow
  - keep `RuntimeLibrariesSettingsTab.tsx` as the Settings composition surface, `useRuntimeLibrariesState.ts` as the public controller, and `runtimeLibrariesJobStream.ts` as the SSE/log-state helper layer
  - page/components should stay mostly render wiring
- dashboard/editor bridge wiring should stay explicit
  - `DashboardPage.tsx` is the composition root
  - `HostedEditorApp.tsx` mounts `RivetAppHost`, passes the hosted provider overrides from `hostedRivetProviders.ts`, captures the upstream `RivetWorkspaceHost` through `onWorkspaceHostReady`, and forwards upstream host callbacks for active project, open-project count, and save completion
  - `HostedEditorApp.tsx` also passes hosted UI policy through `RivetAppHost.ui`: `fileMenu.visibleItems` keeps the iframe File menu to `import_graph`, `export_graph`, `settings`, and `get_help`; `webApps.desktopPreview: false` hides the desktop-only `Run web app` preview action; and `keyboardShortcuts.saveProject: true` makes Rivet own iframe-focused `Ctrl+S` / `Cmd+S`. Keep these on upstream host policy seams instead of hiding DOM or aliasing command hooks
  - `useEditorCommandQueue.ts` validates and structured-clones commands before pre-ready buffering, while the shared `postMessageToEditor` helper does the same for every direct or flushed send. The clone snapshots queued data against later mutation and proves the payload is transferable before it reaches the browser boundary; validation errors should identify the command type without serializing the payload.
  - `useEditorBridgeEvents.ts` owns dashboard-side message listeners and cross-iframe save shortcut capture
  - `EditorMessageBridge.tsx` is the editor-side composition root after the workspace host handle is ready. `useEditorCommandBridge.ts` owns command origin checks, FIFO dispatch, and acknowledgements; implementations stay split across `editorProjectOpenCommands.ts`, `editorDetachedProjectCommands.ts`, and `editorProjectLifecycleCommands.ts`. Preview state belongs in `usePreviewProjectLifecycle.ts`, replay restoration in `useWorkflowRecordingBridge.ts`, and find/duplicate/pointer focus behavior in `useEditorBridgeInteractions.ts`; do not rebuild one effect that owns all four domains or move every command implementation back into the queue hook
  - preview bookkeeping may read upstream dirty/run atoms to decide whether a tab is replaceable, but it should not mutate dirty-state atoms; clean promotion/replacement and transient preview-tab UI state still go through `RivetWorkspaceHost` methods. Path-move commands must acknowledge completion back to the dashboard after open tabs, preview state, session caches, hosted revision paths, and externally persisted title/path metadata are retargeted, so a user cannot immediately reactivate an already-open moved project through a stale path and force an unnecessary reload. Use `RivetWorkspaceHost.updateProjectMetadata(...)` for path-only folder moves too, not only file-name/title renames.
  - project-tree compare should stay a bridge command: the dashboard may send `compare-open-project-with` for another workflow project, or for the active/open project's current published-version preview when the row is in `Unpublished changes`. If the right-click reference project itself is in `Unpublished changes`, the dashboard should ask whether to compare against its saved live file or current published snapshot before sending the bridge command. `EditorMessageBridge.tsx` should load only the reference `.rivet-project` contents before calling `RivetWorkspaceHost.startProjectCompare(...)` with optional side labels. Do not persist compare state, open a detached preview tab for the published-reference path, import the reference project's datasets into the active hosted dataset provider, or write upstream compare atoms directly.
  - comparison UI stays upstream: the canvas compare notice is below the node settings panel. Node config diffs start unwrapped with horizontal scrollbars in both panes; the modal-wide **Wrap lines** toggle updates existing read-only Monaco editors and recalculates their height. Closing and reopening the modal resets wrapping to off. `project-compare-mode.spec.ts` verifies panel overlap with hit testing and both wrap states against long field values.
- hosted provider wiring should stay explicit
  - import the app shell and CSS through `packages/app/src/host.tsx` and `packages/app/src/host.css`
  - pass `HostedIOProvider`, an injected `HostedDatasetProvider`, the hosted environment provider, and the hosted path-policy provider through `RivetAppHost.providers`
  - keep hosted environment lookup cached and deduplicated in `packages/studio-server-web/overrides/utils/tauri.ts`; warm node settings panel opens should not issue repeated `/api/config/env/*` requests, including for empty or disallowed env values
  - keep `HostedIOProvider` and Rivet's active dataset provider on the same import/export-capable dataset-provider instance so project file IO, dataset UI, and runtime hooks observe the same imported datasets
  - keep `HostedDatasetProvider` pruning old per-project IndexedDB dataset rows before importing a project payload, otherwise datasets removed from a project can reappear from stale browser app storage
  - declare packages imported by the hosted Rivet import graph directly in `packages/studio-server-web/package.json`; the workspace declares `idb` because hosted dataset/storage modules import it. Do not rely on a coincidental transitive dependency.
- hosted project context values are editor-owned app state, not `.rivet-project` file contents
  - Rivet stores them under `projectContext__"<projectId>"`, so hosted open/reopen persistence depends on stable `project.metadata.id` values
  - keep `packages/studio-server-web/overrides/state/savedGraphs.ts` exporting the hosted `clearProjectContextState` compatibility helper by delegating normal tab cleanup to upstream `releaseProjectContextState`, so `RivetWorkspaceHost.closeProject()` and `replaceCurrent()` can close tabs without deleting those stored values
  - actual dashboard workflow deletion should forward the project id returned by `DELETE /api/workflows/projects`, then call `deleteHostedProjectContextState` and `clearHostedDatasetsForProject` from the iframe delete handler so stale editor-owned browser state does not remain even when the tab was already closed; the delete helper removes `projectContext__"<projectId>"` through the shared `project` storage group
  - `HostedDatasetProvider` inherits project-scoped cleanup from `BrowserDatasetProvider`; its only specialization is atomic replacement on import. Do not reintroduce clear-then-import or require duplicated cleanup code in source-contract tests. `hosted-dataset-provider.test.ts` exercises the actual hosted adapter with IndexedDB, including shared dataset IDs across projects, inactive imports, stale selections, quota failure rollback, and cancellation after replacement deletes. The app's `BrowserDatasetProvider.test.ts` covers the shared implementation and schema migration.
- editor executor transport should prefer Rivet's upstream host/session seam
  - mount the editor through `RivetAppHost`
  - pass the hosted executor websocket through `executor.internalExecutorUrl`; it must come from runtime `/api/config`, defaulting to the current host's `/ws/executor/internal` unless App Settings has a saved websocket override
  - use `RivetAppHost.ui.fileMenu.visibleItems` for hosted File menu visibility and `RivetAppHost.ui.webApps.desktopPreview` for the hosted web-app preview capability; leave command execution in upstream Rivet
  - keep graph execution, upload, abort, pause/resume, and websocket message ownership in upstream Rivet hooks
  - do not alias `useExecutorSession`, `useRemoteDebugger`, `useGraphExecutor`, or `useRemoteExecutor`; upstream Rivet owns internal executor UI classification and debugger handoff for `executor.internalExecutorUrl`
  - stale wrapper transport override files were removed; do not reintroduce them unless the upstream seam no longer covers hosted behavior
- hosted opened-project hooks should preserve Rivet 2.0's split tab state
  - keep `projectsState.openedProjects` as lightweight tab metadata: project id, title, path, and opened graph
  - keep full in-memory project content in `openedProjectSnapshotsState`
  - prefer `RivetWorkspaceHost.openProjectSnapshot`, `replaceCurrent`, `closeProject`, `moveProjectPaths`, and `updateProjectMetadata` for the actual workspace transition or externally persisted title/path reconciliation
  - closing a tab must retain its `projectEditorStateByProjectIdState` navigation/viewport entry, finish tab/snapshot/context cleanup, and then await one grouped `project` storage flush; this keeps close -> immediate page reload -> reopen from losing the latest canvas position without durably resurrecting stale open-tab metadata, including when an inactive tab still has a pending debounced snapshot
  - close fallbacks read current tab metadata from the atom store. Compare the activation revision around a fallback load: if another selection superseded it, wait for that pending selection and finish only the requested tab's cleanup without trying additional replacements or clearing the new selection's execution state. If the closing tab remains active (reselected, or a newer selection failed), cancel the close and leave its live edits intact. A genuine IO failure still tries the next recoverable tab. Queued activation also rereads the requested tab's metadata before IO, so a move while queued cannot restore a stale save path; these cases are covered in `useLoadProject.test.tsx`
  - the last loaded project and graph remain cached after the final tab closes, but viewport snapshots and reload checkpoints require an open graph tab; reopening uses the retained editor entry instead of snapshotting an empty workspace's default canvas
  - wrapper atom reads are acceptable for hosted path lookup, duplicate-project-id checks, and stale-empty-tab cleanup, but do not reimplement tab close fallback, path rewrite transitions, or live project metadata patching in wrapper code when the workspace host exposes them
  - normalize persisted opened-project metadata by dropping missing entries, orphan metadata, duplicate project ids, and legacy full-project payloads before the tab strip reads it; when damaged duplicate entries share an id, prefer the entry that still has a file path
  - resolve tab titles through the wrapper helper so old projects or legacy persisted tab entries fall back to the project filename instead of rendering missing, `undefined`, or `null` labels
  - when the visible tab strip is empty, the next workflow open must reset opened-project metadata and snapshots instead of merging hidden stale entries from older sessions
  - run that stale-empty-tab cleanup after `RivetWorkspaceHost` opens the requested snapshot, not before async project loading, so upstream sync effects cannot re-add the previous hidden project while loading is in flight
  - after the tab strip remounts, do not let the previous pathless `projectState` re-add itself; the sync hook may register the current project only when its project id is already present in the visible opened-project id list or the current project is still file-backed by `loadedProject.path`
  - prune pathless opened-project metadata when there is neither an active current project nor an `openedProjectSnapshotsState` entry that can activate that tab
  - project loading must read the latest atom store at call time, and direct workflow opens should pass their freshly loaded snapshot into the workspace host instead of depending on a just-written atom value to be visible immediately
  - change the loaded path, tab registry and Evaluation owner synchronously with the target project; derived static-data hydration must not block or own activation. Otherwise the editor can temporarily pair the new project with the previous tab's path, and hydration completion can overwrite a path move that arrived during its await. The hook regression suite gates hydration to verify both the intermediate path and move preservation
  - for an already-open workflow, use `RivetWorkspaceHost.activateProject(projectId, { preferredGraphId })`: ordinary tree single/double clicks must not reload content, mark it clean, reset its viewport/resource target, or clear replay state. The active tab is a no-op unless an explicit graph target changes; inactive activation uses the same load path as editor-tab selection and preserves the saved baseline. Reserve `openProjectSnapshot`/`replaceCurrent` for newly loaded content and explicit `reloadFromDisk`. Preview promotion must update only tab UI state, never dirty flags
  - `project-tree-activation.spec.ts` uses mocked tree/load/save IO to check active double-click, A -> B -> A activation, dirty dots, unchanged node positions, no redundant server loads, save completion, and same-tab Node library preservation. It is included in `studio-server:ui:ci`; each tree activation waits for the editor's public `project-opened` acknowledgement, not just already-present CSS classes. Run it alongside `project-preview-mode.spec.ts` and `dashboard-save-button.spec.ts` when changing this boundary; never use production workflows as writable regression fixtures
  - recovery coverage also exercises same-origin windows, an opener-created duplicate inheriting session storage, independent reloads, quota errors, an IndexedDB transaction aborted after its `put` succeeds, malformed project content, and saved-server/recovery-revision mismatches. The duplicate must get its own writer and must ignore independent legacy navigation fragments. Use one browser context for window-collision checks; separate contexts cannot prove isolation
  - `workspaceRecovery.test.ts` and `hybridStorage.test.ts` cover exact read-back acknowledgement, interrupted legacy imports with retained originals, malformed authorities, unavailable session storage, edits during flush, retry and backend reconfiguration. Injected storage test doubles must actually implement read-after-write; a no-op `setItem` is intentionally not a successful recovery. `deserialize-worker.test.ts` covers worker cancellation/replacement and the configurable hosted overall deadline, including expiration before deferred dataset import
  - Hydration guards are checked before replacing a group and after every asynchronous startup boundary. Storage regression tests delay an old backend read past replacement, cancel a failing read, and verify corrupt primitive records do not erase the current authority. The browser suite also forces only the session reload-reference write to fail: Retry must stay enabled without another edit, the unload warning must remain truthful, and a successful retry/reload must restore the unsaved workspace
  - Recovery regression tests also cover retryable checkpoint/reference reads, a late read failing after a new checkpoint commits, overlapping recovery choices, provider replacement during selection, frozen selection of active writers, and memory-only fallback. Durable test providers must explicitly model persistence across document recreation instead of assuming `MemoryAsyncStorage` survives reload. The browser suite disables IndexedDB to verify the memory-only warning, unload protection and truthful server-save result; blocked session-reference reads and session-storage access must expose recovery controls without mounting a clean empty editor. Checkpoint keys use the existing cryptographic Nano ID generator rather than requiring the browser's optional `crypto.randomUUID` helper; the browser regression disables that helper and verifies bootstrap, edits and reload. Finish edits before browser verification or use a fixed production preview: changing React provider modules mid-run can split context identities through Vite hot reload and invalidate the test
  - `useInitializeWorkspace.test.tsx` tests the actual bootstrap hook without mounting the whole editor. It covers callback-only host rerenders (no rehydration), current error delivery, backend replacement, unmount during IO, and synchronous/asynchronous notification failures. Changes to error callbacks must not restart storage initialization or overwrite live edits with an older checkpoint
  - The default dataset adapter still requires IndexedDB; memory-only recovery is not a promise that every editor subsystem works without browser storage. Missing IndexedDB must reject opening with an actionable enable-storage/retry message, leave the prior project selected, and allow retry when storage becomes available. For a failed first open, assert the dashboard's error notice: the empty editor iframe may be hidden. The browser memory-only test verifies that rejection, restores dataset storage, and then checks that the already-selected volatile recovery adapter still cannot claim reload protection even after a successful server save
  - no synchronous navigation-only session checkpoint may override recovered content. Persist project-scoped view state with the complete workspace envelope, checkpoint on hidden visibility while the page remains alive, and treat unload-time asynchronous writes as best effort. Native/custom IO providers retain optional signal/deferred-commit interfaces; a non-abortable provider's late result must be rejected by the activation guard
  - custom download-only IO providers may declare `projectSaveConfirmation: 'download-only'`. Returning a download filename must not clear the dirty baseline or emit `onProjectSaved`; the browser cannot certify the actual downloaded file. Ordinary providers keep the successful-storage-write contract. The public save hook regression suite covers both paths
  - `TauriIOProvider.test.ts` runs the real native API adapter through an in-memory IPC stub (no OS dialogs or production files), covering deferred/guarded dataset import, cancelled reads and rejected native writes. Combined with custom-provider activation tests, this protects interface compatibility; it is not an interactive packaged-desktop smoke test
  - if direct workflow activation fails, rely on the workspace host's boolean result and avoid posting `project-opened` to the dashboard
  - `useLoadProject` in both app and hosted mode uses the store-scoped `runLatestProjectActivation` coordinator: preparation is cancellable and deadline-bound, never a lock that blocks a newer selection. Serialize only derived cache operations per provider; do not acknowledge superseded selections or bypass the coordinator for an active editor-tab click. After IO, recheck tab/path and immutable project identity, reread its current snapshot, and preserve deliberately absent static data. `useLoadProject.test.tsx` covers delayed cancellation, close/move races, picker reopens, reused paths, latest snapshots and live-graph preservation; `projectActivationCoordinator.test.ts` covers nonblocking supersession, deadlines and failed-operation recovery. The tree activation browser test also exercises slow tab recovery after reload, identity rejection and successful retry
  - when fixing tab close/switch behavior, update the wrapper overrides rather than storing full project objects back into `projectsState.openedProjects`
  - if `useSyncCurrentStateIntoOpenedProjects` is overridden for hosted tab cleanup, call the shared `useSyncProjectDirtyState` observer; do not duplicate its saved-baseline logic in the wrapper. It must preserve dirty recovered tabs when their saved baseline is absent
  - carry forward upstream's per-project executor metadata in hosted opened-project overrides: the active tab must write `OpenedProjectInfo.executorMode`, and `useLoadProject` must pass `projectInfo.executorMode` back into `workspaceTransitions.loadProject(...)` so Browser, Node, and Remote Debugger choices are restored when switching tabs
- wrapper module overrides should stay scoped to upstream app importers
  - `packages/studio-server-web/vite.config.ts` resolves override files only when the importer is under `packages/app/src`
  - keep the `savedGraphs` override narrow: it re-exports upstream state, maps the hosted `clearProjectContextState` compatibility helper to upstream `releaseProjectContextState` for normal tab close/reopen, and exposes an explicit storage-removing delete helper for actual workflow deletion
  - keep the `state/settings` override narrow: delegate upstream settings exports and override only hosted executor/debugger defaults plus the wrapper update-check modal atom, so upstream UI settings such as canvas background preferences and custom theme color helpers are not copied into the wrapper
  - do not put wrapper-owned transport overrides back into `packages/studio-server-web/vite-aliases.ts`
  - do not alias `useSaveProject`, `useMenuCommands`, or `useWindowsHotkeysFix`; upstream `RivetAppHost.ui.keyboardShortcuts.saveProject`, `RivetWorkspaceHost.saveCurrentProject()`, `RivetAppHost.onProjectSaved`, and `RivetAppHost.ui.fileMenu.visibleItems` own the save/menu seam. The wrapper sends `save-project` only when focus is outside the iframe and reconciles saved title/path metadata through `RivetWorkspaceHost.updateProjectMetadata()` after successful saves
  - keep dashboard-focused `Ctrl+S` / `Cmd+S` narrow: prevent browser Save Page behavior, consume repeat keydowns without sending another bridge command, and let `useEditorCommandBridge` call `RivetWorkspaceHost.saveCurrentProject()`. Keep shortcut-originated saves and explicit dashboard-button saves as separate zero-argument callbacks: only the shortcut callback adds `source: "shortcut"`, and the button's DOM handler must consume its event before invoking the source-free callback. Do not pass a semantic callback with optional payload arguments directly to a React event prop, because the runtime event can otherwise leak into `postMessage`. Preview promotion must be driven by `RivetAppHost.onProjectSaved`, not by save invocation, so cancelled or failed saves stay previews
  - do not mutate `projectState`, `graphState`, `projectDataState`, or `openedProjectSnapshotsState` from save-completion callbacks. Upstream Rivet marks the saved snapshot clean inside its save transition, and post-save wrapper mutations to active project content can make the editor-owned unsaved-changes dot compare against the wrong digest.
  - if a future wrapper-owned save path bypasses Rivet's save command, call `RivetWorkspaceHost.updateProjectMetadata(..., { persistedExternally: true })` for externally persisted title/description updates, or `markCurrentProjectClean()` / `markProjectClean()` for clean-baseline-only reconciliation after the backend save succeeds; never import or mutate `savedProjectContentDigestsState`, `projectUnsavedChangesState`, or `projectDataUnsavedChangesState` from wrapper code
  - do not reintroduce wrapper copies of `TauriProjectReferenceLoader`, `io/datasets`, `io/TauriIOProvider`, or `utils/globals/ioProvider`; hosted relative-project reads belong in the path policy provider, and hosted project/dataset persistence belongs in `RivetAppHost.providers` plus `HostedIOProvider`
  - keep `deploy/studio-server/scripts/update-check.sh` aligned with that boundary: it should check the upstream provider seams, not treat provider-backed upstream modules as wrapper aliases
  - keep bare-package shims such as `@tauri-apps/api/*` separate from relative Rivet module overrides
  - do not keep stale component copies such as `OverlayTabs` in the wrapper; the current Rivet 2 workspace tab row is upstream-owned, and observer coverage should follow its accessible `Workspace navigation` buttons
- API workflow execution should resolve `@valerypopoff/rivet2-node` through its declared workspace dependency
  - keep the package-name import as the stable seam
  - build owning Rivet workspaces before API checks when their exports are generated
  - do not add direct API imports from another package's `src` tree
- API-local warm caches are derived accelerators only
  - use `lru-cache` for generic access-order and byte-budget eviction in managed execution and managed Code/Expression compilation/require caches
  - keep domain ownership of workflow-to-key reverse indexes, byte measurements, oversized-entry rejection, cross-replica invalidation, release-snapshot invalidation, and Node `require.cache` clearing; do not spread the library into filesystem freshness caches
- Kubernetes template reuse should stay shallow
  - use `_env.tpl` and `_pod.tpl` for genuinely repeated backend/execution blocks
  - keep `proxy` and `web` explicit unless extraction clearly improves readability

## Safe verification workflow

For node-settings changes, preserve project/graph/node/field ownership rather
than using a node ID as global identity. Workspace replacement paths must
advance `nodeEditorSessionRevisionState` before replacing content; authoritative
file reloads also advance `nodeEditorContentRevisionState` for the project.
Do not put ordinary node edits in either generation counter. New asynchronous
node-editor controls should use `NodeEditorSessionContext` and check the session
after awaits, before mutations, notifications or markers. Retired work cannot
become current again when the user returns to the same tab. Code/string/metadata
field commits are synchronous; debounce expensive derived work, not canonical data.
Generic non-node string controls may still explicitly request debouncing.
`NodeChanged` accepts an optional third comparison baseline. Field helpers that
patch a live node must pass that live baseline, so an immediate edit back to a
rendered value is not mistaken for an unchanged stale field.

Regression coverage:

- `NodeEditorSessionContext.test.tsx` exercises real Jotai/React ownership,
  StrictMode cleanup, batched A → B → A, replacement/deletion/read-only guards,
  variants/library sources and consecutive edits/commands without a render.
  A round trip or close/reopen must create a fresh writable lifetime without
  reviving retained callbacks; StrictMode must not retire a still-mounted owner.
  A real Subgraph editor holds its version request across renewal: fresh controls
  release loading, the retired request cannot publish reference/node changes,
  and a fresh version selection still succeeds.
- `nodeLibrary.test.ts` checks atomic library commits, consecutive source edits,
  preservation of live graph overlays and project metadata, and rejection of
  retired/read-only owners. It also checks failure before commit and ensures
  stale graph snapshots cannot resurrect explicitly deleted wires. Use
  `updateNodeLibraryState` for library mutations;
  do not reconstruct a project from a component render snapshot. Source edits
  must target a prefab ID, and canvas patches must merge against their rendered
  baseline instead of overwriting a newer source wholesale.
- `nodeEditorSession.test.ts` checks irrevocable retirement, sibling patches and
  cancellation that clears optional metadata explicitly. The partial edit-node
  command treats an omitted field as "keep", so clearing must pass `undefined`.
- `codeEditorModelCache.test.ts` checks scoped models, source acknowledgement,
  partial drafts and attached-model eviction protection.
- `node-editor-ownership.spec.ts` uses isolated mocked API fixtures with cloned
  graph/node IDs for Object, current/legacy Code and Prompt nodes, both focused
  and unfocused within each of four project scenarios, rather than repeating the
  entire workspace setup for each focus state. Distinct edit markers keep both
  paths independently observable. Fixtures use Rivet's canonical serializer, not
  hand-built version-specific YAML. It checks the visible settings, underlying node bodies, dirty
  indicators, immediate Save bytes, read-only variants and same-project activation.
  Object/Code library fixtures also exercise multiple sources, graph/library
  sources sharing IDs, cloned-project tab switching and exact saved source data.
  It includes immediate title/description commits and Escape-to-cancel metadata,
  with no false dirty flag when restoring a previously absent description.
  It also checks incomplete JSON-object drafts and formatting-equivalent source
  acknowledgements, including restored validation errors. Monaco draft assertions
  wait for both rendered text and validation before capturing the expected draft;
  an immediate DOM read after typing can capture the transient empty render on CI.
  Prompt coverage delays dictionary loading and overlaps spellchecks to prove a
  cancelled check cannot clear the newest markers; editing then clears both
  markers and status.
  Metadata uses canonical controlled values: do not recommit an internal form
  buffer on blur/confirmation. Keep global node controls non-shrinking in the
  scrolling panel so tall Code editors cannot overlap the variant selector. Run it with
  `PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe
node-editor-ownership.spec.ts` against a candidate app URL. The CI browser
  configuration includes it. Also run `project-tree-activation.spec.ts` and the
  affected recovery/save suites. Use a fixed build/preview for final browser
  checks so HMR cannot split the editor's session context during a test.
- `node-editor-lifecycle.spec.ts` adds held-save/newer-keystroke races, sibling
  toggles, immediate panel close, exact checkpoint/reload recovery, reused IDs
  across graphs, focused Monaco Undo/Redo, and an explicit same-ID disk reload.
  Its synthetic AI provider intentionally ignores abort. It checks late results
  after switching/deleting/editing, successful current-owner output, and cancel
  followed by retry while the old request is still pending. No provider egress
  or real credentials are used. The warm-cache eviction case reopens canonical
  node data after visiting more than twelve fields.
  A held Subgraph preview crosses a project switch, then recreates the control
  to verify that shared reference state was not contaminated; a normal version
  selection and exact Save are the positive control. Guard every referenced-
  project write, including menu refresh, before calling the node-change handler.
  Run `PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe
node-editor-ownership.spec.ts node-editor-lifecycle.spec.ts
project-tree-activation.spec.ts project-preview-mode.spec.ts dashboard-save-button.spec.ts`.
  Both node-editor suites are included in the CI browser configuration.
  The lifecycle suite also records input-to-next-frame p95/high-water and exact
  saved text on a 350-node synthetic graph, attaching `typing-frame-latency.json`
  to the Playwright report. These timings are measurements, not a brittle shared-CI
  performance threshold or a promise about production graphs/hardware. Inspect
  them when changing synchronous commits; never delay canonical text to optimize
  expensive derived validation/port analysis.

For Studio Server API changes:

1. `yarn workspace @valerypopoff/rivet-studio-server-api run test`
2. `yarn workspace @valerypopoff/rivet-studio-server-api run build`

Current repo-local baseline:

- `hosted-dashboard-contracts.spec.ts` replaces the retired font and modal-theme source-reading suites and the profile-health TSX wiring assertion. One isolated browser fixture renders all seven dashboard dialogs, checks computed shared theme/padding, editor font registration, health tab order/states/refresh, and metadata-ID routing. Pure profile-health presentation tests remain in the web suite. Its API matcher uses `url.pathname.startsWith('/api/')`: a broad `**/api/**` glob also captures Vite's Core source-module URLs and breaks editor bootstrap. Font CDN responses are stubbed; registration, not external network availability, is the contract.
- See [CI test ownership and reliability](../BUILD-AND-CI.md#ci-test-ownership-and-reliability) for the test cleanup boundaries. Browser consolidation must retain distinct input/output assertions; fixture-only filesystem reads remain active tests, not source-reading migration debt. Fault injection, rollback, image and platform release gates retain their unique coverage.

- `yarn studio-server:test` is the one-command root test gate for non-browser automation. Its `pretest` hook runs the same dependency bootstrap as the dev launchers, then the test command builds every Studio Server dependency/workspace, runs default API tests and pure web helper tests, executes the hosted-editor compatibility scanner, and finishes with test-style, repo-structure, and Kubernetes launcher/chart contracts. It intentionally does not run Playwright because those specs require a live browser/app target and, for some managed flows, deliberate mutation opt-in.
- The image-build workflow calls the reusable Studio Server verification workflow while immutable candidate images build in parallel. Promotion still requires the verification aggregator, all four image builds, and the authenticated candidate-image Compose smoke. The smoke starts the exact candidate API, web, executor, and proxy tags, verifies the UI key gate, proxy routing, the executor WebSocket, the direct API-only pull metrics endpoint (enabled only for that smoke), and a published workflow execution. It supplies the string Graph Input as a direct JSON string rather than an object wrapper, matching the published-workflow input contract. It exercises the same Compose ownership initializer used by development and production, so its disposable bind mounts model an upgrade from host-owned directories without a CI-only permission bypass. On failure it reports the causal assertion before container diagnostics and bounds Compose teardown, so a cleanup delay cannot hide the actual cause. Deployment-sensitive changes, tags, schedules, and manual releases additionally require the disposable Kind gate; ordinary application commits use the faster Compose gate. Public aliases are applied only after every applicable gate succeeds.
- `.github/workflows/studio-server-verify.yml` is both the direct `develop` verifier and the reusable same-commit image verifier. It builds once, verifies the compiled Core, Node, Evaluations, and App Executor export surface, uploads compiled dependencies, and runs four isolated API shards plus web tests, host compatibility, repository contracts, and Kubernetes/deployment contracts in parallel. Every artifact consumer verifies that same export surface immediately after restore, so a misplaced or incomplete archive fails at the handoff rather than later as unrelated module-load test failures. The artifact paths share `packages/` as their common ancestor, so every dependent job restores them beneath `packages/`; extracting to the repository root would relocate workspace exports and cause false `ERR_MODULE_NOT_FOUND` failures. The one stable-named producer uses `overwrite: true` because Actions artifacts are immutable: retrying only a failing consumer still downloads the original artifact, while retrying the producer replaces it cleanly. The API manifest discovers test files recursively, so a newly nested API test fails validation until it is assigned to exactly one shard. The final `verify` job preserves the existing status identity. A lightweight changed-path classifier may skip heavy jobs on unrelated commits without omitting the final status check. Stale branch and pull-request verification is canceled; tag, schedule, and manual release verification is not.
- Job timing summaries are the current performance evidence. Both the generic Build and the Studio Server verification aggregators report their complete critical paths, while substantive jobs report their own wall time. Treat the former five-minute image note as historical; compare current Build, verification, candidate smoke, and optional Kind timings independently.
- For image-release predecessor failures, follow [One-time release-lineage cutover](./kubernetes.md#one-time-release-lineage-cutover). Run `node --test deploy/studio-server/scripts/studio-server-release-manifest.test.mjs` and `yarn node scripts/checks/check-ci-workflows.mjs` after changing recovery. Recovery fixtures must prove that the real manifest CLI accepts the staged path, and registry failures must not masquerade as an empty image set. These checks do not require registry writes or a Kubernetes rehearsal.
- If the full API suite fails with `ERR_MODULE_NOT_FOUND`, distinguish missing dependencies from missing compiled workspace exports. For missing packages, run `yarn install --immutable` and confirm the importing workspace declares the package directly. For missing `packages/{core,node,evaluations}/dist` exports or the executor bundle, run `yarn studio-server:build:dependencies`, then `yarn check:compiled-workspace-exports` before rerunning. Source-level tests can pass without these artifacts, while API subprocess tests require them. Do not run local API suites concurrently with workspace builds (including the Core rebuild inside `yarn test:style`): cleaning `dist` during a test can produce false module-load failures. CI uses isolated jobs and restores/verifies the artifacts before each consumer starts; do not rebuild silently or weaken checks to hide a broken artifact handoff.
- Core and Node share `packages/core/bundle.esbuild.cjs`, executed from each workspace's directory. Optional Core-only entrypoints (including `serialization`) must be included only when their source exists in that workspace. `packages/core/test/build/cjs.test.ts` runs the real builder against isolated workspaces with and without serialization and loads the generated CJS exports. Verify changes with both `yarn studio-server:build:dependencies` and `yarn check:compiled-workspace-exports`; a Core-only build does not exercise Node's invocation.
- The test-suite cleanup plan previously lived in the root `tests-refactor.md` working document; after final prune, keep the lasting outcomes in `docs/refactor-history.md` and keep the public verification commands stable for future cleanup.
- API workflow tests should reuse the shared helpers under `packages/studio-server-api/src/tests/helpers/` before adding local harness code. Workflow HTTP harnesses, JSON response handling, recording waiters, filesystem execution cache invalidation probes, temp workflow roots, root-level published-project fixtures, and the filesystem workflow suite bootstrap/cleanup live there.
- Multi-process fixtures use `allocateDistinctTestPorts` from `http-server-harness.ts` to reserve their complete loopback port set before releasing any socket. Independently binding and closing three ephemeral listeners can return the same port more than once; the supervisor correctly rejects such configurations. Bind failures reject promptly and release earlier reservations. This prevents reuse within one set, not an atomic socket handoff to child processes; an unrelated process can still claim a released port. Keep the supervisor's distinct-port and startup checks intact rather than hiding collisions with unbounded retries. `local-upgrade-runtime.test.ts` covers immediate reuse, real bindings and partial-allocation cleanup; both supervised and UI-driven migration helpers share this allocator.
- Filesystem hosted-save changes must exercise `filesystem-project-transactions.test.ts`. Its injected checkpoints cover each durable stage before and after the committed marker, complete project/dataset rollback or roll-forward, first saves, dataset addition/replacement/removal, validation, Unicode paths, corrupt evidence, and read/write exclusion. `workflow-filesystem-tree.test.ts` separately proves that rejected saves do not advance the tree token and that a committed save removes a stale dataset before emitting exactly one invalidation. Concurrent-create coverage must assert the storage invariant—exactly one complete project/dataset pair commits and the other request conflicts—without assuming that JavaScript call order determines which request reaches the filesystem write coordinator first. The storage capability probe runs before the API listens; a probe or recovery failure is an expected startup/readiness failure, not a warning to ignore.
- The canonical default API file list lives in `deploy/studio-server/scripts/api-test-files.mjs`. `yarn workspace @valerypopoff/rivet-studio-server-api run test` executes that complete manifest serially. CI uses `run-api-tests.mjs --shard-index N --shard-count 4` to divide the same sorted list across isolated runners while preserving `--test-concurrency=1` inside each shard. To run only specific files, use `yarn workspace @valerypopoff/rivet-studio-server-api run test:files -- src/tests/example.test.ts`.
- The API runner invokes the checked-in Yarn release through the current Node executable, without a shell or global/Corepack shim. App and API CLIs share the strict parser/selection in `scripts/ci/test-shard-options.mjs`; both reject unknown/repeated options, missing or non-integer values, invalid shard coordinates and empty selections, including in `--check` mode. Discovery covers nested `.test`/`.spec` files with `.ts`, `.mts`, `.cts` and `.tsx` suffixes: newly added tests must enter the manifest rather than silently escaping CI. `node --test scripts/ci/api-test-shards.test.mjs scripts/ci/app-test-shards.test.mjs` verifies exact-once coverage, discovery, both real Yarn CLI entrypoints, and a behavioral API shard invocation with a deliberately broken global Yarn on PATH.
- Use root `yarn test:app` for the complete local App suite: the runner explicitly discovers every supported test suffix and executes batches of at most 32 files, just like CI shards. `scripts/ci/app-test-shards.test.mjs` checks exact-once selection and bounded invocation for both modes. Calling the App workspace's bare `test` script relies on Node/tsx implicit discovery instead and does not guarantee the complete React hook/component and spec coverage.
- Persistence concurrency tests must keep real-time leases long enough to survive normal runner scheduling and SQLite commits. Test short lease expiry in the clock-controlled health-state tests instead; a short wall-clock lease makes a two-call concurrency assertion nondeterministic without exercising a different production invariant.
- The old mixed `workflow-services.test.ts` suite has been split by behavior domain. Put new filesystem tree/import/export coverage in `workflow-filesystem-tree.test.ts`, publication-state, endpoint-reservation, and published project-reference coverage in `workflow-publication-filesystem.test.ts`, published-version-history coverage in `workflow-published-history-filesystem.test.ts`, endpoint execution/cache coverage in `workflow-execution-filesystem.test.ts`, and recording route coverage in `workflow-recordings-http.test.ts`. Project move coverage must use `moveWorkflowItemWithBackend(...)`, the same cache-invalidating boundary used by the production route.
- The old mixed `managed-backend-sql.test.ts` suite has been split. Put managed schema, folder-move SQL, and execution lookup query contracts in `managed-workflow-schema.test.ts`; put managed publication history, restore, star persistence, and save-target behavior in `managed-publication-history.test.ts`. Schema tests should import the exported SQL string, not read `schema.ts` as source text, so escaping regressions are tested against what the app actually sends to Postgres.
- The old broad `phase4-static-contract.test.ts` suite has been split. Put proxy, Docker image, CI image, and production launcher contracts in `proxy-image-contract.test.ts`; hosted editor wrapper/upstream seam guardrails in `hosted-editor-seams.test.ts`; and Helm/chart topology assertions in `kubernetes-contract.test.ts`.
- Keep `hosted-editor-seams.test.ts` focused on wrapper ownership. Recording activation, executor preservation, and tab-path cleanup are exercised by the web recording/command behavior tests. Save-shortcut classification and evaluation suppression are exercised by `editor-bridge-focus.test.ts` and `editor-bridge-contract.test.ts`; app hotkey tests cover editor repeat suppression, and `evaluation-save-shortcut.spec.ts` verifies dashboard and iframe ownership in the browser. The separate dashboard save listener retains a narrow source guard for repeat suppression and its required `shortcut` argument until hook-level coverage replaces it. That source is intentional: Evaluations uses it to suppress project saves.
- The hosted seam guard follows wrapper-owned integration points rather than obsolete implementation locations: dependency-light `entry.tsx` awaits `bootstrapApp.tsx`, which loads hosted CSS and React; `useOpenWorkflowProject` activates existing tabs through `RivetWorkspaceHost` instead of reading snapshots itself; the hosted `useLoadProject` adapter delegates to App's `useActivateOpenedProject`; and hosted tab synchronization delegates dirty-state observation to App's `useSyncProjectDirtyState`. It must not read the shared App hooks' implementation files or expand the upstream-source allowlist. App's `useLoadProject.test.tsx` owns behavioral coverage for cancellation, snapshot activation, saved baselines and conservative dirty state. Run the focused hosted seam test plus `yarn workspace @valerypopoff/rivet-app run test:files -- src/hooks/useLoadProject.test.tsx` after ownership refactors, then API shard 3/4 (`--shard-index 2 --shard-count 4`) before handoff. Root `yarn test:style` also executes the actual Studio Server style-policy CLI through `scripts/ci/studio-server-test-style.test.mjs`; use `yarn studio-server:verify:test-style` for the focused check and the independent Studio Server CI gate. Architectural guards supplement, rather than replace, behavioral editor and browser regressions.
- `yarn workspace @valerypopoff/rivet-studio-server-api run test` intentionally does not run Helm. Use `yarn studio-server:verify:kubernetes` for Kubernetes launcher tests, Helm-rendered chart contracts, and production overlay lint/template checks. The API suite runs with `--test-concurrency=1` because many API tests intentionally set process-wide `RIVET_*` roots before importing route modules; keep that serialization unless the affected tests are refactored to avoid global env mutation.
- Wrapper regressions built from upstream Rivet fixtures must derive fixture project and graph IDs from the parsed fixture instead of copying generated IDs into the test. For filesystem project-reference moves, cover a reused former hint path as well as the moved target: the wrapper must verify a hinted project's immutable ID before accepting it, then resolve the moved project by ID. When a fixture needs `Project.references`, set that field on the parsed project and serialize it with Rivet; do not rely on a version-specific YAML placeholder such as `references: []`.
- Keep full-screen node-output paging compact and in the header's top-left pager group. LLM Chat round history keeps its full truthful label there (for example, `Round 2 · Requested tools`) instead of becoming a second full-width control row. An ordinary multi-round LLM invocation uses its selected historical round directly; only nodes configured with `Run per item` use the split-output renderer. The `latest` terminal output and the newest retained round that led into a failure both show its process-level error, while the retained round keeps its own snapshot content. Never repeat that error or its red output surface on earlier historical rounds; the node can retain its overall failed execution status while the selected earlier snapshot is presented neutrally.
- A selected errored nested run owns the same red output surface even when its parent node remains in a different aggregate state—this includes Delegate Tool Call pages. For every inline multi-run node, the shared pager owns the sole thin neutral divider below its row; the selected body must not add a second, status-colored top border.
- Disabled-node dependency warnings are editor-only diagnostics. Derive them from effective nodes and definition-valid current-graph connections, following Core's first-valid-wire-per-input rule and its exported `canConsumeControlFlowExcludedInput` policy. A disabled node remains connected at runtime and produces control-flow exclusion rather than a missing wire; show the existing header warning on each enabled node that Core will therefore mark Not Ran. Do this for connected optional fallback ports too: a Graph Input's Default Value can fall back only when unconnected, not when its source is excluded. Do not alter graph execution, persistence, or automatic wiring.
- `yarn studio-server:verify:test-style` owns the test-suite style guardrails: root `yarn studio-server:test` must keep composing the non-browser repo-local gate, the canonical API manifest and `packages/studio-server-web` test command must each list every assigned test exactly once in sorted order, `verify:web-pure` must list every pure web test exactly once, retired or merged-away suites must not come back, `.only` tests are blocked, and wrapper tests/helpers must not assert upstream `packages/app/src` implementation paths beyond the approved `host.css` seam. The API runner and policy share recursive discovery of `.test`/`.spec` files with `.ts`, `.mts`, `.cts` and `.tsx` suffixes; all are scanned, and any API test whose basename starts with `kubernetes-` belongs to `verify:kubernetes`, including nested tests. Pure web `.test.ts` files and observable Playwright `.spec.ts` files remain top-level because their suite commands enumerate them explicitly. The API workspace must not add a separate `pretest` bootstrap. Run this guard immediately after adding a pure web test; the web package's explicit test list is not automatically sorted. `node --test scripts/ci/studio-server-test-style.test.mjs scripts/ci/api-test-shards.test.mjs` covers supported paths, upstream-source boundary rejection, the real policy CLI, discovery and shard invocation. Run root `test:style` before, not concurrently with, App/API runtime suites: its Graph Builder asset check rebuilds Core and temporarily replaces `dist`.
- Observable Playwright specs validate whichever app is currently running at `PLAYWRIGHT_BASE_URL`; that target can be an older rebuilt container or a published image. Do not read local `package.json` metadata from Playwright specs to assert deployed UI text. If version display is the behavior under test, assert that the live modal renders a version-shaped value, or explicitly run the spec against a freshly rebuilt local target.
- Tests that intentionally exercise negative paths should capture and assert expected `console.error` or `console.warn` output. A passing `yarn studio-server:test` should not print scary stack traces for failures that the test deliberately caused.
- Final-prune cleanup should not reintroduce a broad suite just to keep a helper alive. If a helper has no call sites after a split, delete the helper and let `yarn workspace @valerypopoff/rivet-studio-server-api run build` plus `yarn studio-server:verify:test-style` prove the manifest and type boundaries.
- `deploy/studio-server/scripts/update-check.sh` must list every active `createModuleOverrideAliases(...)` target. `yarn studio-server:verify:web-pure` checks that the scanner and Vite aliases stay aligned, and `yarn studio-server:verify:host-compatibility` executes the scanner from the monorepo root, so update both when adding or removing hosted overrides.
- Spellcheck build contracts execute the dictionary plugins from the real loaded Vite configuration, importing their generated browser modules and checking dictionary contents and optimizer exclusions. Keep those checks behavioral; implementation-text matches cannot prove emitted assets work. Provider subpaths use the effective aliases, not a regex over `vite.config.ts`.
- The API WebSocket test waiter rejects malformed frames, early close/error and deadline expiry with listener cleanup. `websocket-harness.test.ts` covers those failure paths and exact mock-timer deadlines without sockets or wall-clock sleeps. A parser error must reject the pending test, never escape its event callback or leave a waiter hanging.
  - Teardown must not remove unrelated listeners from a connecting socket: pending waiters still need to settle. The helper consumes expected termination errors even without a remaining caller error handler and removes its temporary listeners on close; regression fixtures cover both connecting and open sockets.
- Policy lookup/recheck and Evaluation metrics scheduler tests use controlled timers, with exact boundary assertions and asynchronous cycle completion. Check that claims continue during a held metrics read and that departed subscribers stop while remaining ones continue; a fixed sleep followed by a positive count can pass without proving those invariants. Keep real clocks for genuine filesystem/concurrent SQLite lease integration tests.
- App test shards use the same-commit compiled artifact via `RIVET_APP_TEST_DEPENDENCIES=prebuilt` in CI, with export validation before any test starts. Local `yarn test:app` still builds Core by default; invalid dependency modes fail rather than silently skipping prerequisites. Do not enable prebuilt mode merely to reuse unchecked local output.
  - Full local runs and CI shards execute explicitly discovered files in batches of at most 32, covering every supported TS/TSX/spec suffix exactly once. Do not mix implicit Node discovery with an additional React-only pass: the implicit suffix policy varies by runtime, and both full runs and growing shards need bounded Windows-safe invocations.
- `yarn studio-server:verify:kubernetes` lint-renders the Helm chart with real image repository overrides, including the restore-drill contract tests, and verifies the key negative cases:
  - placeholder image repositories are rejected
  - published-route-prefix overrides are rejected
  - the managed-only chart shape is enforced
- `yarn studio-server:verify:kubernetes:managed-restore` is a protected, mutation-capable operator drill—not an ordinary CI or development command. Run it only from the clean promoted checkout named by its backup manifest, with a provider-owned disposable target and explicit confirmation; the runner enforces that clean-checkout requirement. It requires a non-local HTTPS DNS host and rejects production identity reuse without trusting letter case or a DNS trailing dot (including a reused host on a different port), reads each driver YAML once before validating and applying that exact content, forbids HTTP redirect-following during target probes, requires provider restore/integrity/cleanup Jobs with positive object recovery/reference evidence, atomically labels and re-verifies its disposable namespace before teardown, confirms disposable-target deletion before reporting success, and leaves a sanitized local report; scheduling or a secret-bearing GitHub workflow requires an explicit operations approval.
- VM migration has unit coverage for strict comparison, maintenance, authorization and durable progress, plus a PostgreSQL/MinIO copy-retry-verify fixture that exercises publication history, web-app policy, recordings, Evaluations, settings and runtime libraries. A real cutover still requires an isolated rehearsal using the exact production image, provider services and representative VM snapshot; the fixture is not deployment approval.

For hosted editor shell changes, keep `packages/studio-server-web/index.html` loading the same font families that Rivet styles reference. Rivet uses both `Roboto` and `Roboto Mono`; loading only the monospace family leaves several upstream panels on browser fallbacks.

For packages/studio-server-web changes:

1. `yarn workspace @valerypopoff/rivet-studio-server-web run build`
2. if the change adds or changes pure helper logic under `packages/studio-server-web/dashboard/` or `packages/studio-server-web/overrides/hooks/`, run `yarn studio-server:verify:web-pure`
3. if the change affects browser-visible behavior, run `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, then `yarn studio-server:ui:observe`
4. if the Playwright coverage needs real workflow mutations in Storage-tab `Object storage` mode, set `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1` deliberately and keep cleanup explicit; prefer mocked API/browser tests for modal and controller coverage when storage mutation is not the point
5. if the change lives under `packages/studio-server-web/overrides/` or affects hosted editor save/hotkey behavior, also verify with `yarn studio-server:prod:custom`; `yarn studio-server:prod` deliberately pulls already-published images instead of using your local workspace changes

For workflow-library mutations that change on-disk project state:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Duplicate`
4. for `unpublished`, confirm the new project appears in the same folder as `Name [unpublished] Copy.rivet-project` and that the current selection/editor tab did not change
5. for `published`, confirm duplication uses the published snapshot and names the duplicate `Name [published] Copy.rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions duplicate correctly, including the expected `Name [published] Copy.rivet-project` vs `Name [unpublished changes] Copy.rivet-project` naming
7. confirm duplication still leaves the current selection/editor tab unchanged

For workflow-library project creation behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `New project`
4. enter a new project name when prompted
5. confirm the folder expands and the new project opens in the editor
6. confirm there is no inline `+` create-project button on folder rows anymore
7. try an existing name in the same folder and confirm the UI shows the API conflict instead of silently overwriting the file

For workflow-library folder creation behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. click `+ New folder` at the bottom of the workflow library
4. enter a folder name when prompted
5. confirm the new folder appears at the root level of the tree
6. try an existing root-level name and confirm the UI shows the API conflict instead of silently overwriting anything

For workflow-library folder rename behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Rename folder`
4. confirm the folder row turns into an inline edit field with the current name selected
5. press `Esc`, then repeat and click elsewhere, and confirm both paths cancel without renaming
6. enter a new folder name and press `Enter`
7. confirm the edit field closes immediately and the old folder name shows a preloader while the rename is saving
8. confirm the folder remains in the tree under the new name
9. if the folder was collapsed before pressing `Enter`, confirm it stays collapsed after the renamed row appears
10. if the folder contained projects that are open in the editor, confirm those tabs still point at the renamed paths and save correctly afterward
11. try renaming to an existing sibling folder name and confirm the preloader clears and the UI shows the API conflict without leaving a stale edit field open

For workflow-library folder deletion behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click an empty folder in the left panel and run `Delete folder`
4. confirm the UI asks for confirmation before deletion
5. confirm the folder disappears only after confirming
6. right-click a non-empty folder and confirm the `Delete folder` action is disabled
7. if you call the API directly for a non-empty folder, confirm it still rejects with `Only empty folders can be deleted`

For workflow-library drag/drop move behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. drag a project from one folder to another and confirm the tree updates after the drop
4. if that project is open in the editor, confirm saves still target the new path after the move
5. drag a folder into another folder and confirm all nested projects move with it
6. drag a project or folder back to the root area and confirm it is reparented to the root
7. try to drag a folder into itself or one of its descendants and confirm the move is rejected cleanly

For workflow-library upload behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a folder in the left panel and run `Upload project`
4. choose a local `.rivet-project` file in the browser picker
5. note that some browsers may still show a generic picker instead of pre-filtering `.rivet-project`; selecting the wrong file type should fail cleanly without uploading anything
6. confirm the project appears in that folder
7. if the folder already contained that name, confirm the new file is saved as `Name 1`, `Name 2`, and so on
8. confirm the upload does not change the current selection, open a different tab, or expand folders automatically

For workflow-library download behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Download`
4. for `unpublished`, confirm the browser downloads `Name [unpublished].rivet-project`
5. for `published`, confirm the browser downloads `Name [published].rivet-project`
6. for `unpublished_changes`, confirm the chooser appears and both saved versions download correctly
7. make unsaved editor changes and confirm downloads still reflect only the saved server-side versions
8. confirm the download flow does not change selection, open a different tab, or expand folders

For workflow-library project deletion behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project with no workflow endpoint publication and no published web apps in the left panel and run `Delete project`
4. confirm the context-menu action only opens Project Settings and does not delete immediately
5. confirm the project is deleted only after clicking `Delete project` again inside Project Settings
6. right-click a project that has a published workflow endpoint, unpublished workflow changes, or published web apps and run `Delete project`
7. confirm the UI shows `To delete a project, unpublish its workflow endpoint and web apps first`
8. confirm the guarded delete action does not change selection, open a different tab, or delete anything directly from the context menu

For workflow-library project rename entry behavior:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. right-click a project in the left panel and run `Rename project`
4. confirm the project row turns into an inline edit field with the current name selected
5. select the same project row again, press `F2`, and confirm it starts the same inline edit field
6. single-click an unopened project, immediately press `F2`, then wait longer than the preview-open delay; confirm the inline field remains focused rather than closing when the editor finishes opening
7. with an already-open selected project and focus on a non-editable editor-canvas surface, press `F2`; confirm the selected tree project enters the same inline rename mode
8. put focus in an editor text field and press `F2`; confirm the shortcut stays with that field and does not begin a tree rename
9. press `Esc`, then repeat and click elsewhere, and confirm both paths cancel without renaming
10. enter a new project name and press `Enter`
11. confirm the edit field closes immediately and the old project name shows a preloader while the rename is saving
12. for a published project, confirm the project remains `Published` and the saved `.rivet-project` still has its pre-rename `project.metadata.title`
13. if the project is already open, confirm the Rivet tab label, graph-list project header, Project Settings title, and other editor title surfaces change to the new tree name without closing or reloading the project
14. confirm the renamed row keeps the previous selection/open editor tab by following the returned `movedProjectPaths`
15. without clicking the renamed row again, press `F2` and confirm the still-selected project starts a second inline rename
16. with a menu or modal open, press plain `F2` in the sidebar and on the non-editable editor canvas; confirm neither begins a background project rename
17. press a modified or held/repeating `F2` and confirm it does not begin a rename
18. try renaming to an existing sibling project name and confirm the preloader clears and the UI shows the API conflict without leaving a stale edit field open
19. open Project Settings separately and confirm there is no modal-level rename button or title edit field
20. save the renamed project and confirm the saved `.rivet-project` title now aligns with the tree name; for a previously published project, confirm this real content edit becomes `Unpublished changes`

For hosted editor canvas restoration:

1. open a workflow project and pan or zoom its graph canvas to an unmistakable position
2. immediately reload the Rivet Studio Server page, without waiting for background persistence
3. confirm the same project and graph reopen at the exact saved canvas transform instead of recentering
4. switch to another graph, move its canvas, reload again, and confirm the last-open graph and its own project-scoped viewport are restored
5. open another project and confirm graph IDs or canvas positions from the first project do not leak into it
6. open Node library or a web app, reload while that resource editor remains open, and confirm the last graph reopens at its prior viewport rather than at the resource editor's canvas position
7. pan a graph, close its project tab, immediately reload the Studio Server page, reopen that project from the tree, and confirm the graph returns to the transform captured before Close

For hosted editor keyboard-node behavior:

1. `yarn studio-server:dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. open a workflow in the editor iframe and confirm the workflow-library row that opened it does not keep the visible browser focus outline
4. confirm the editor iframe receives keyboard focus after open without showing a visible white perimeter
5. click a node normally and confirm `Ctrl+C`, `Ctrl+X`, `Ctrl+V`, and `Ctrl+D` use the internal node clipboard/duplicate behavior
6. deliberately return focus to the workflow library, then confirm `Shift+click` multi-selection inside the editor reclaims iframe focus and still copies multiple nodes
7. deliberately return focus to the workflow library, then click blank canvas background and confirm `Ctrl+C` / `Ctrl+X` / `Ctrl+V` work again without an extra recovery click on a node
8. open and close an editor context menu or search UI, then confirm `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` still work after returning to the canvas
9. deliberately return focus to the workflow library with a node still selected, then confirm `Ctrl+D` duplicates that node instead of opening the browser bookmark UI
10. deliberately return focus to the workflow library, then confirm `Ctrl+F` opens Rivet graph search instead of the browser find UI
11. focus the editor iframe/canvas, then confirm `Ctrl+F` still opens Rivet graph search and a physical `KeyF` find shortcut is also prevented from reaching browser find even when `event.key` is not `f`; with a Rivet search field already mounted, confirm the same shortcut focuses that field instead of closing overlays
12. confirm `Ctrl+S` works while focus is inside the workflow iframe on Windows/Linux, `Cmd+S` works on macOS, and dashboard-focused save produces one persistence request without browser Save Page UI
13. confirm `Ctrl+Shift+I` remains browser-owned for DevTools and does not open Rivet's graph import picker
14. confirm the browser can still type normally inside real text inputs and that copy/paste/duplicate/save/search shortcuts do not hijack active editor form fields

For hosted editor production-image regressions:

1. remember that `yarn studio-server:prod` and `yarn studio-server:prod:prebuilt` use pulled images, `yarn studio-server:prod:restart` keeps already-local images, and `yarn studio-server:prod:custom` builds the current monorepo workspace
2. if dev works but prod does not, compare the exact published image revision with the current monorepo commit and keep any hosted-only adaptation in the tracked Studio Server host/override seam rather than modifying shared editor behavior solely for the hosted application
3. for clipboard or graph-tree context-menu regressions specifically, check the tracked hosted overrides for `useCopyNodesHotkeys`, `useContextMenu`, and the canvas focus handoff in `EditorMessageBridge.tsx`; the context-menu override must keep upstream's virtual pointer anchor plus `setFloatingMenu` return and should not depend on removed graph-list positioning classes such as `graph-item-context-menu-pos` or `graph-list-context-menu-pos`

For slow hosted node settings panels:

1. open DevTools Network and filter for `/api/config/env/`
2. open the same node settings panel twice
3. a cold page may make one concurrent burst of env requests, but the warm open should not repeat them
4. repeated warm env requests usually mean `packages/studio-server-web/overrides/utils/tauri.ts` stopped caching empty env responses or stopped deduplicating pending requests
5. panel latency that is the same in small and large projects usually points to fixed hosted provider work, not `.rivet-project` YAML parsing or opened-project snapshot caching
6. after changing server env values, restart or recreate the app and reload the browser page because hosted env values are cached for the browser page session

For published-project save status behavior:

1. `yarn studio-server:dev`
2. validate through `http://localhost:8080` by default, or your configured `RIVET_PORT`
3. publish a workflow project
4. save it with no actual changes and confirm the sidebar stays `Published` without a brief `Unpublished changes` flicker
5. if you are in `managed` mode, also confirm the saved revision id does not change on that no-op save
6. then make a real saved change, save again, and confirm the sidebar updates to `Unpublished changes`

For workflow-tree stats performance:

1. `GET /api/workflows/tree` should not parse every managed project blob just to show graph/node counts; managed stats come from `workflow_revisions.stats_*`, with a one-time lazy blob read only for legacy revisions that have null stats
2. in filesystem mode, `*.wrapper-stats.json` is generated and can be deleted safely; the next tree read or hosted save rebuilds it
3. project rename, move, and delete flows must move/remove the stats sidecar with the project, but generated stats sidecars should not block user operations the way publication settings or dataset sidecars do
4. after save, keep status validation separate from stats caching: a no-op save on a published project must stay `Published`, while a real saved change must become `Unpublished changes`

For routing/auth/deployment changes:

1. `yarn studio-server:dev`
2. validate the browser flow through `http://localhost:8080` by default, or your configured `RIVET_PORT`

For the current Helm chart and images:

1. set all `images.*.repository` values to the GHCR repositories documented in [kubernetes.md](./kubernetes.md), and pin all four tags to the same published image tag for production
2. keep `replicaCount.proxy>=2` and let proxy autoscaling absorb ingress pressure from public endpoint traffic
3. keep `replicaCount.web=1` unless real dashboard/editor traffic becomes significant
4. keep `replicaCount.backend=1`
5. keep `autoscaling.backend.enabled=false`
6. keep `workflowStorage.backend=managed` and `runtimeLibraries.backend=managed`
7. keep `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows`, `RIVET_PUBLISHED_APPS_BASE_PATH=/apps`, `RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`, and `RIVET_LATEST_APPS_BASE_PATH=/apps-latest` unless you intentionally want different first-run route defaults before a saved `public-routes` value exists in the active settings repository
8. set `env.RIVET_PROXY_RESOLVER` for in-cluster nginx DNS resolution
9. provide `RIVET_KEY` through `auth.keySecretName` or Vault, even if server UI auth and public workflow bearer checks are disabled
10. keep the control-plane API on `RIVET_API_PROFILE=control` and the execution Deployment on `RIVET_API_PROFILE=execution`
11. keep control-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none`
12. keep execution-plane runtime-library reporting at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
13. if Vault is enabled, make sure the injected `/vault/dotenv` carries the required managed Postgres/object-storage env vars before relying on it instead of Kubernetes secret refs
14. do not scale `proxy` and `execution` as if they were a fixed pair; they are separate deployments with separate pressure profiles
15. define concrete CPU and memory requests for at least `resources.proxy` and `resources.execution` before treating the CPU-based HPAs as production-ready
16. keep `lifecycle.terminationGracePeriodSeconds` greater than `lifecycle.shutdownGraceSeconds + lifecycle.preStopDelaySeconds`; chart validation also reserves a final 25-second margin
17. tune `lifecycle.health` from measured managed PostgreSQL/object-storage latency; `/readyz` uses the cached result while `/livez` and legacy `/healthz` remain shallow liveness
18. keep disruption budgets and preferred topology placement enabled for replicated proxy/execution tiers unless cluster capacity or maintenance policy requires an explicit override; the singleton backend intentionally receives no PDB

For managed endpoint latency and cache behavior:

1. run with Settings -> `Storage` set to `Object storage`
2. call the same trivial published or latest endpoint twice
3. expect the first request after startup or after a publish/save/rename/move to be the cold path
4. expect the second request for the same unchanged workflow to drop onto the warm local path
5. if you enabled `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, confirm `x-workflow-cache` moves from `miss` to `hit` and inspect `x-workflow-resolve-ms` / `x-workflow-materialize-ms`

For endpoint measurement with the dedicated script:

1. run the app with either `Local folders` or `Object storage` selected in Settings -> `Storage`
2. optionally set `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` so the route emits stage timings; also set `RIVET_CODE_RUNNER_TELEMETRY=true` when diagnosing Code/Expression overhead
3. run `yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint hello-world --kind published --runs 5 --warmups 1`
4. expect one output line per request with HTTP status, client duration, `x-duration-ms`, `x-workflow-resolve-ms`, `x-workflow-materialize-ms`, `x-workflow-execute-ms`, `x-workflow-cache`, and any enabled `x-code-runner-*` headers
5. compare Postman or browser total time against `x-duration-ms`; the difference is network, proxy, TLS, client, and response-transfer overhead
6. compare `x-duration-ms` against `x-workflow-execute-ms` and the Run recordings duration; recordings and `x-workflow-execute-ms` show the measured processor execution window, while `x-duration-ms` includes request handling, endpoint resolution/materialization, processor setup, and response shaping
7. recording persistence is intentionally deferred after the response turn, so recorder serialization, replay-project serialization, compression, and object/file writes should not explain a large `x-duration-ms` gap
8. if debug headers are disabled, expect those per-stage fields to print as `n/a` rather than failing
9. in `managed` mode, use the transition from `x-workflow-cache=miss` to `x-workflow-cache=hit` to verify cold-first-hit then warm-hit behavior
10. in `filesystem` mode, the startup-warmed path should normally report `x-workflow-cache=hit`; after a project-affecting mutation or other tracked filesystem-tree change, expect one rebuild `miss` and then a return to `hit`
11. in `filesystem` mode, `x-workflow-resolve-ms` covers endpoint-index freshness validation plus endpoint lookup, while `x-workflow-materialize-ms` covers materialization-cache validation plus any needed project/dataset reload, one-time project reparsing, and per-request dataset-provider reconstruction
12. in `filesystem` mode, `x-workflow-cache=bypass` means the cache deliberately fell back to uncached filesystem resolution because cached routing/materialization state was uncertain; that slower degraded path is the guardrail against stale cache execution
13. in local Docker on Windows, filesystem mode still reads `/workflows` through a host bind mount, so fixed filesystem overhead can remain materially higher than a direct local-process run even when the endpoint index and materialization path are warm
14. when CodeRunner telemetry is enabled, use `x-code-runner-prepare-ms` to find managed runtime-library sync cost, `x-code-runner-compile-ms` to find repeated function compilation cost, `x-code-runner-execute-ms` for actual user-code time, and cache hit/miss headers to confirm repeated Code/Expression nodes are reusing compiled functions

For the optional local graph fixture, use the local benchmark runner when you need a
repeatable before/after sanity check without importing into a real workspace:

```bash
yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10
```

The runner creates a temporary filesystem workflow root, writes
`.fixtures/graph-fixture.rivet-project`, publishes it as
`graph-fixture-speed`, runs the real published endpoint path, and writes JSON
reports under `artifacts/benchmarks/`. By default it sends no request body,
which lets the fixture's Main Graph `Graph Input` default payload run. Passing
`--body '{}'` intentionally measures the explicit-empty-object request path and
will bypass most of the fixture's Code/Expression-heavy branch. It compares:

- `legacy-compatible`: `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true` and
  `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true`
- `optimized`: the default optimized ManagedCodeRunner path

The default no-body fixture run is a representative CodeRunner-heavy endpoint
check for this app. It should execute dozens of CodeRunner calls, including many
Expression and Code New nodes, with no managed `require(...)` and no external
service call. If the report shows only one CodeRunner call, check whether the
command accidentally passed `--body '{}'` or another body that bypasses the
fixture's default test payload.

The fixture is intentionally optional in a clean checkout. The API test suite
skips the fixture safety checks when `.fixtures/graph-fixture.rivet-project` is
absent and runs them automatically when the benchmark fixture is present.

For the current execution-plane split specifically:

1. keep the control plane conservative and scale the execution Deployment instead of the backend StatefulSet
2. keep the proxy Deployment redundant because every published endpoint call still crosses it
3. treat `execution` as the primary endpoint-throughput scale boundary and `proxy` as a separate ingress tier rather than a one-for-one partner
4. confirm `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_PUBLISHED_APPS_BASE_PATH}` reach the execution-plane API while `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` and `${RIVET_LATEST_APPS_BASE_PATH}` still reach the control-plane API
5. confirm `/api/*` and `POST /__rivet_auth` still reach the control-plane API
6. confirm `/internal/workflows/:endpointName` is not exposed through nginx and is only reachable inside the cluster
7. confirm runtime-library `Endpoint execution` readiness reflects execution-plane API replicas, not control-plane API replicas

## Validation boundaries

Before pushing server changes, complete `yarn studio-server:build` as well as
the affected runtime tests. The API build type-checks its tests, including
imports of deployment `.mjs` helpers; each such static import needs a matching
`.d.mts` declaration. The test runner transpiles TypeScript without checking
that contract. For proxy changes also run
`node deploy/studio-server/scripts/verify-proxy-dns.mjs` and
`node deploy/studio-server/scripts/verify-trusted-client-proxy.mjs` with Docker
available, matching the CI deployment job. See
[Build, CI, and Release](../BUILD-AND-CI.md) for the broader push checks.

Test known oversized uploads with an oversized `Content-Length` and no body:
the API deliberately rejects and closes these connections before consumption.
Uploading a full 48 MiB fixture with `fetch` races that close and can report a
transport error instead of the intended `413`. Keep separate small, real HTTP
tests for chunked and compressed body-limit enforcement.

Use the three validation layers intentionally:

- repo-local:
  - proves API correctness, cache/invalidation behavior, config parsing, proxy/image static contracts, hosted-editor seam contracts, and most workflow/runtime-library backend logic
  - this is where `yarn workspace @valerypopoff/rivet-studio-server-api run build`, `yarn workspace @valerypopoff/rivet-studio-server-api run test`, `yarn studio-server:verify:web-pure`, `yarn studio-server:verify:test-style`, and `yarn studio-server:verify:repo-structure` belong
- Kubernetes render:
  - proves Helm chart syntax, local launcher values rendering, chart validation, and rendered control-plane versus execution-plane env/routing contracts
  - this is where `yarn studio-server:verify:kubernetes` and Helm lint/template checks belong
- managed Docker rehearsal:
  - proves managed-state behavior against disposable Postgres plus object storage
  - use this for workflow-storage migration rehearsal, `workflow-storage:verify`, managed endpoint and published web-app measurement, hosted browser flows, and runtime-library install/remove/readiness checks
  - the current Docker stacks still run the API in the `combined` profile, so they do not prove the real control-plane versus execution-plane split by themselves even though the route families are still exposed at their normal published/latest and web-app paths
- live Kubernetes validation:
  - proves the real split topology, ingress/proxy behavior, control-plane versus execution-plane routing, restart boundaries, and execution scaling
  - do not treat chart render success or Docker rehearsal as a substitute for this layer when the question is about real in-cluster behavior

Current follow-up expectations:

- if a change touches migration, cutover, or recording durability, run the managed Docker rehearsal instead of trusting repo-local proof alone
- if a change touches runtime-library readiness UI, prefer adding direct UI coverage and still validate the modal against the managed stack because backend aggregation tests do not fully prove the rendered browser state
- if a change touches the control-plane versus execution-plane boundary, finish with live Kubernetes validation in an isolated namespace

## Compatibility verification commands

Use the current compatibility commands intentionally:

- the repo-local test portions scrub ambient runtime-root, retired storage/database, execution-route, runtime-library, recording, trusted-host, and legacy web-app OAuth env such as `RIVET_WORKFLOWS_ROOT`, `RIVET_ARTIFACTS_HOST_PATH`, old storage/database runtime names, `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, `RIVET_PUBLISHED_APPS_BASE_PATH`, `RIVET_LATEST_APPS_BASE_PATH`, `RIVET_WEB_APPS_BASE_PATH`, `RIVET_LATEST_WEB_APPS_BASE_PATH`, `RIVET_CORS_ALLOWED_ORIGINS`, `RIVET_TRUST_INCOMING_FORWARDED_HEADERS`, `RIVET_UI_TOKEN_FREE_HOSTS`, `RIVET_WEB_APPS_AUTH_MODE`, `OAUTH_PROVIDER`, `OAUTH_DUMMY_EMAIL`, `OAUTH_DUMMY_ALLOW_NON_LOCALHOST`, `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`, `OAUTH_USER_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`, `OAUTH_SCOPES`, `OAUTH_EMAIL_CLAIM`, `OAUTH_SESSION_SECRET`, `OAUTH_SESSION_TTL_SECONDS`, `OAUTH_CLIENT_AUTH_METHOD`, `OAUTH_DEBUG_LOG_PROFILE`, and `RIVET_ENV_FILE` before spawning API tests, so local `.env` or shell state cannot redirect those tests into a real workflow folder, route prefix, auth provider, CORS policy, trusted-host bypass, forwarded-header trust policy, runtime-library role, recording policy, or prove the wrong web-app auth source
- `yarn studio-server:verify:filesystem`
  - runs the repo-local baseline for filesystem compatibility:
    - `packages/studio-server-api` build
    - `packages/studio-server-api` tests
    - filesystem launcher/profile contract assertions
- `yarn studio-server:verify:filesystem:docker`
  - creates a disposable filesystem fixture root and explicit env file
  - verifies the Docker launchers can render `config` for filesystem mode without managed-service activation
- `yarn studio-server:verify:local-docker`
  - creates a disposable managed rehearsal env file
  - verifies `managed + local-docker` activates the `workflow-managed` launcher profile
  - verifies the Docker launchers can render `config` for that rehearsal shape
- `yarn studio-server:verify:local-docker:split`
  - reruns the split-topology repo-local assertions for API profiles, proxy/chart contracts, runtime-library tier ownership, and storage config
  - then verifies the local-Docker launcher contract for the managed rehearsal path

These commands do not replace full browser-level or live-cluster validation:

- use the managed Docker rehearsal for migration/import, hosted editor parity, runtime-library install/remove/readiness checks, endpoint measurement, and published web-app route checks
- use Kubernetes for real split-topology routing, restart, and scaling proof
