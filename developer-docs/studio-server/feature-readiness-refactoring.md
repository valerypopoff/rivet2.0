# Feature-readiness consolidation

## Purpose and boundary

Make features use one policy and one lifecycle owner, with explicit adapters for
intentional platform differences. Preserve project/recording formats, execution
semantics, saved data, and Browser/desktop/hosted behavior. This is local code
work, not release publication, GKE qualification or production deployment.

## Implemented first slice

- Removed hosted `useLoadProject` and `useContextMenu` source replacements and
  their two Vite aliases. Nine legacy module overrides remained after that slice.
- `providers.projectActivation` supplies Evaluation-cache and executor-mode
  callbacks. The editor's existing activation coordinator retains cancellation,
  binding validation, live snapshots and saved-baseline ownership.
- `ui.contextMenu` supplies cross-surface dismissal/focus cleanup only. The
  shared editor hook retains menu state, target lookup, positioning and local
  dismissal. Existing dashboard/iframe subscription cleanup remains authoritative.
- Evaluation trials use shared result orchestration and write-once recording
  persistence. Browser owns its processor/listeners; Node owns request dispatch,
  socket recording settlement and cleanup. Both retain the common outer suite
  lifecycle and existing prepared-editor-run policies.
- Replaced obsolete copied-hook source assertions with alias-retirement guards,
  provider wiring checks and behavioral activation/recording tests. Browser
  checks cover cross-frame menus/focus, project activation and a real Browser
  evaluation with successful/failed recording storage. Trial orchestration tests
  cover Browser/Node success, errors, abort identity and evidence settlement.

## Opened-tab synchronization follow-on

The editor now owns one synchronizer for standalone and hosted tabs. The hosted
`useSyncCurrentStateIntoOpenedProjects` override and alias are removed (eight
module overrides remain). Its host policy contains only explicit-tab mode, title
resolution and open-ID notifications; executor URL normalization reuses the
existing activation policy. Shared recovery reconciles metadata and legacy
snapshots in one pass, before discarding legacy payloads, and keeps stable object
identities on no-op updates. React effects read current store state so transition
frames cannot assign another tab's path or graph. Standalone scratch behavior
and the separate dirty-state owner are unchanged.

Regression coverage includes default/explicit policy differences, disabled
effects, repeated no-op renders, closure/reopen, dirty baselines, executor
selection, bundle identity, duplicate records, legacy/damaged snapshots and
path/graph isolation. Real-browser recovery, preview, tab and bundle scenarios
remain mandatory; pure reconciliation tests do not replace them.

Local follow-on verification passed: 80 tab/provider/workspace tests, 42 adjacent
execution/debugger tests, 250 web tests, three hosted seam checks, and all 43
headless bundle/tab/recovery journeys. App TypeScript, focused lint/formatting,
host compatibility, migration/structure/boundary/doc/test-style checks and the
hosted production frontend build passed. The compatibility scanner and build
retain existing non-fatal native-API/chunking warnings. No deployment, publication
or provider rehearsal was performed.

Follow-on reassessment reproduced and fixed two synchronization gaps. A layout
transition between render and effect could persist the previous tab's executor
mode into the newly active tab; mode now comes from the same live store/session
as the active project, without a render-time memo. A legacy loaded file without
tab metadata could be registered and simultaneously lose its loaded path;
registration and closed-workspace path release are now mutually exclusive.
Regressions assert every intermediate executor write, coherent recovered paths
and the existing no-resurrection behavior after genuine tab closure.
Both regressions failed before their fixes. Verification passed 104 focused App
tests, 18 headless executor/routing/tab/recovery cases, App TypeScript, focused
lint/formatting, documentation links, execution boundaries and test-style checks.

Adjacent lifecycle checks reproduced early/disabled observer closures being
mistaken for legacy recovery. The observer now starts with the rendered IDs,
preserving genuine closure before its first effect and across disabled periods.
Opaque IDs matching Object prototype properties also exposed two concrete bugs:
recovery dropped their tabs/snapshots and binding reconciliation failed to retire
their old tokens. Recovery now uses a Map for membership/order and safe own
properties for legacy snapshot writes; the binding registry checks own keys.
Regression cases cover `constructor`, `__proto__` and `toString`, including
close/reopen token invalidation and browser hydration/reload.
The browser cases exposed the same inherited-key assumption in observation and
workspace selection. Observation lookups now use one owned-entry reader;
snapshot selection/admission rejects inherited values; and invalid stored
workspace targets fall back to graph policy instead of dereferencing a missing
graph view. These fixes preserve opaque project IDs rather than restricting the
project format or renaming existing IDs.
Verification passed 158 focused App regressions and nine headless cases covering
normal/prototype-named hydration and reload, cross-platform tab switching,
recovery safety and bundle-debugger shared stop. App TypeScript, focused lint,
App-source formatting, execution boundaries, documentation and test-style checks
passed. The first browser attempts exposed real observation/target failures;
those were fixed before the final successful run, not skipped or relabeled.

## Clipboard integration follow-on

The hosted clipboard hook and alias are removed (seven module overrides remain).
The shared App hook owns keyboard matching, text/modal/overlay admission and
command dispatch. `ui.nodeClipboard` contains only the intentional hosted
differences: hovered-node fallback for copy/duplicate and capture-phase native
clipboard events. Cut still requires selected nodes; ordinary editor defaults
remain selection-only and keyboard-driven. Listeners are scoped to the editor
window, installed once per event type and released on policy change/unmount.

Copy, paste and deletion read the current provider store at invocation, not a
render snapshot or global default store. This fixes a reproduced cut race where
the previous pasted selection could be merged into the new selection and delete
extra nodes. Paste now shares Data Bus offset/pan/zoom conversion with canvas
positioning, avoiding the old hosted-only offset omission. Commands still own
Undo/Redo, wire bends, graph-input confirmation and mutation history.

Mounted regressions exercise standalone/hosted policy, event-time state,
provider-store isolation, one command per native event, copy-cut-paste Undo/Redo,
current coordinates, text/select/content-editable/dialog controls, overlays,
IME/AltGr, graph/empty clipboards and listener teardown. Browser verification
uses existing clipboard/bend, cross-project and cross-surface focus journeys;
there is no provider qualification or production change in this phase.

Local verification passed: 54 focused App tests, 250 hosted web tests, three
hosted seam checks and 28 headless clipboard/bend/focus/tab scenarios. The
extended cross-project browser scenario checks native cut/copy/paste through the
editor document, exactly one mutation per event and Undo, before graph/folder
copy, save and reopen. App TypeScript, changed-source lint/formatting, host
compatibility, structure/migration/test-style/boundary/doc checks and the hosted
production frontend build passed. Existing build chunking/annotation warnings
and non-critical native-API scanner warnings remain. Verification used owned
local fixtures only; no source publication or cloud operation was performed.

Clipboard reassessment reproduced two additional failures before patching them:
immediate duplicate after cutting a hovered node threw on the removed ID, and
native dialog buttons without explicit ARIA roles let clipboard keys mutate the
background graph. Admission now checks current graph membership and native
dialog ancestry. Copy itself ignores missing targets without clearing the old
clipboard, preserving context-menu behavior as well as hotkeys; connection
filtering uses a Set of the actual copied node IDs. Mounted regressions cover
both sequences and the native-dialog case also runs through real browser keys.
Reassessment verification passed 56 focused App tests and 26 headless
clipboard/bend/focus journeys, including the native-dialog regression and normal
duplicate/Undo after dialog closure. App TypeScript, focused App lint,
changed-file formatting, documentation links, migration ledger, execution
boundaries and test-style checks passed. This review did not publish code,
change GCP or repeat provider qualification.

Adjacent checks reproduced clipboard mutations behind unfocused ARIA modals and
host inert locks. Clipboard and tab shortcuts now share the global input-lock
reader while retaining their intentional native-dialog policies. A delayed
graph-input confirmation could also delete matching node IDs after a graph
switch. Confirmations now carry project/graph identity plus existing binding and
workspace tokens, rechecked at command ingress; no new lifetime counter or
persisted format was introduced. Regressions exercise graph/project switches,
same-project rebinding, workspace retirement, current confirmation with a changed
selection, normal Undo and lock release. The browser scenario uses the actual
autoFocus-disabled graph-input modal, switches graphs while it is open, verifies
the other graph is preserved, then checks a current deletion and Undo.
The fixture must marquee-select its graph input before Cut (hover is not a cut
target), and a programmatic graph switch must activate `.graph-item-select`,
not its non-action wrapper. Initial new UI attempts exposed those fixture
mistakes; fixing them retained the real modal, deletion and Undo assertions.
Final adjacent verification passed 67 focused App tests and the complete
30-scenario headless clipboard/bend/focus/tab run, including all three platform
tab shortcuts. App TypeScript, focused lint/formatting, the hosted production
frontend build and documentation/boundary/migration/structure/test-style checks
passed. Existing build chunking warnings remain non-fatal. No source was
published and no cloud resources or production applications were changed.

## Extension rules and activation hardening

The activation guard uses the existing binding registry, not a second generation
counter. Reassessment reproduced stale Evaluation-cache publication after a
same-path snapshot replacement and after hosted bundle rebinding during a saved
read. Both stale results and stale read errors are now ignored; the refreshed
snapshot and current selection are preserved. A table-driven regression exercises
both outcomes at both boundaries.
This reassessment passed 107 focused App tests, five headless activation/window
and evaluation journeys, App TypeScript, changed-file lint/formatting and the
documentation, execution-boundary and test-style checks. The four new race cases
include successful and rejected delayed reads; normal current read failures
retain their existing error behavior.

Add a narrow provider/UI callback when the host needs a platform difference.
Do not add another module-name alias or make a host mutate activation state.
Before centralizing executor code, separate product policy from transport
settlement: cancellation, recorder cleanup and accepted request accounting must
not become generic side effects of tab selection. Never replay an execution or
write to mask a connection/storage failure.

## Hosted settings and project-context follow-on

Removed hosted `state/settings`, `state/savedGraphs` and `useCheckForUpdate`
replacements and aliases. Four platform/loader adapters remain: `utils/tauri`,
`utils/deserializeProject`, `useLoadPackagePlugin` and `TauriNativeApi`.

`ui.debuggerConnection` supplies only a live default and URL-normalization policy.
The shared editor owns preference storage under the unchanged legacy key, input
hydration/draft ownership and connection submission. Missing preferences do not
freeze a runtime default in storage; existing custom strings remain authoritative
and invalid legacy values fall back safely. Empty submissions use the host
default. Hosted update checks are explicitly disabled, while standalone desktop
continues through its existing shared updater. No new updater modal state exists.

The public workspace API owns explicit context deletion, including closed tabs:
reset live values, release cache, remove the exact project's context key and await
the recovery flush. Ordinary close retains context. The wrapper delegates to
this API and continues owning its separate dataset/session cleanup. Project,
recording and database formats are unchanged; context values stay out of project
files. Tests cover store-isolated defaults, late runtime configuration, saved
preferences, normalization, update opt-out, close/reopen retention and exact
durable deletion without affecting another project.

Local verification passed 86 App tests, 250 hosted web tests, three hosted seam
checks and 32 browser journeys: 25 source-harness checks on Vite plus seven
compiled-frontend public-origin checks on a local preview. Two earlier attempts
to proxy Vite's many source assets through fake HTTPS origins hit local fetch
resets before application assertions; the same complete origin group passed
against its intended compiled frontend. No assertion or product transport retry
was added. Source checks include real settings-panel hydration/reload and the
public context-deletion API through an already-mounted context view, reopen and
another project's retained context. Bundle debugger completion, failure, abort,
shared stop, mixed versions, source reopen, scope/deletion and HA replay passed.

App TypeScript, focused lint/formatting, the hosted frontend production build,
host compatibility and documentation/boundary/migration/structure/test-style
checks passed. Existing non-critical build/native-scanner warnings remain. No
source was published and no provider rehearsal or production/cloud change was
performed. These local browser checks are not GKE qualification.

## Ordinary run preparation and recording follow-on

Browser and Node now capture settings and project context through the existing
`captureEditorRun` snapshot alongside authored data and inputs. Runtime callbacks
remain un-cloned. Shared `editorRunRecording` owns capability checks, a typed
destination/correlation, serialization, one persistence attempt and unavailable
reporting. It replaces the duplicate ordinary-run artifact writers, not the
transport controllers. Browser retains in-memory playback when hosted storage is
absent; Node retains its request-owned terminal/nonempty capture gate. Existing
session disposal and capture-map removal remain the exactly-once authorities.
No generic run coordinator, retry loop, new format or additional lifetime owner
was added. Environment/bundle loading and transport-specific admission/cancel
rules remain in their adapters.

Behavioral regressions cover detached settings/context snapshots, eligibility and
capability faults, Browser/Node outcome parity, real project/dataset serialization,
in-memory-only replay, serialization/dataset/uncertain-write failures, unavailable
report failures and single-flight session disposal. The mounted Node hook now
also records its accepted run: early outputs cannot persist, tab replacement
cannot lose the artifact, and the later root failure must appear in one recording
without stale canvas updates or duplicate trace delivery. Its synthetic events
include the real protocol's graph/node fields required by the recorder.

Verification passed 117 focused App tests and 24 headless browser journeys:
eight Browser artifact cases and 16 settings/HA-handshake/reconnect, playback and
Evaluation cases. The Node reconnect UI uses an isolated protocol peer, not a
live provider; the mounted Node-hook regression also uses its explicit socket
fixture. The initial recording-enabled hook fixture exposed missing node/graph
fields in its formerly display-only events; correcting the fixture retained the
actual recorder and terminal-artifact assertions. App TypeScript, focused lint,
formatting, documentation links, execution boundaries, test-style guards and the
hosted production build passed. Existing annotation/chunking warnings remain
non-fatal. No cloud resources, provider rehearsal, publication or deployment
were used. Server storage narrowing is the next substantive architectural slice.

Run-policy reassessment reproduced a display observer exception being mistaken
for an artifact failure: serialization succeeded but storage was skipped. The
notification now has its own failure boundary so accepted evidence still
persists once. Context capture also used ordinary indexed assignment, which
turned `__proto__` into a prototype change and dropped that valid ID from JSON.
Extraction now uses `Object.fromEntries`, preserving own-key semantics and deep
copies with less code. The matching context editor used an Immer assignment
that rejects the same ID; immutable object-map updates preserve its existing
save/rename/delete semantics without that dependency. Existing tests now cover
observer faults, opaque context IDs, actual Node request payloads, recorded
Browser start context and the settings dialog, without extra test harnesses.
Both initial unit regressions failed before their fixes; the actual settings
dialog also reproduced the Immer rejection before the map-update change.
Final local verification passed 118 focused tests and 18 headless browser
journeys (14 recording/reconnect/playback and four settings/tab cases), App
TypeScript, focused lint, formatting and documentation/boundary/test-style
checks. No provider rehearsal, cloud changes or publication were performed.

Adjacent run-policy review traced the own-key issue through execution output
normalization, history storage/restoration and partial-run preload construction.
An output port named `__proto__` could disappear before history, hiding **Run from
here**, or be lost when a preload was serialized for Node. These maps now use
own-key construction; partial-reset partitions retain opaque node IDs as well.
Missing-ref handling, binary normalization, frozen outputs and payload identity
are unchanged. The new isolated `partial-run-preload.spec.ts` browser check is
included in CI shards (its initial duration weight is an estimate). It checks
actual whole-run/partial-run results and recorder events, not just menu presence.
Preloaded start/finish evidence must be asserted through `resultOrigin`, not
mistaken for physical source execution. Existing unit cases cover inline/ref
port round trips, best-effort missing-ref behavior and normal/frozen dependency
preloads with prototype-named IDs. No new map framework, execution controller,
retry or persisted format was introduced.
Verification passed 119 focused App tests, ten CI-planning checks and 14 distinct
headless Browser recording/preload/playback journeys. One combined browser run
stalled after six completed cases and was stopped; the remaining eight cases
passed separately with bounded test timeouts, including both child failures and
the new partial run. Initial sandbox restrictions on local HTTP/temp-Git fixtures
were rerun outside that sandbox; no CI assertions were removed. App TypeScript,
focused lint/formatting and documentation/boundary/test-style checks passed.
No source was published and no production or GCP resources were changed.

## Completed follow-on consolidation (2026-10-24)

The five scoped readiness objectives are now implemented locally. This is not a
claim that all repository debt is gone or that a new release has been deployed.

### Hosted boundary

`Providers.packagePluginLoader` supplies package installation/loading transport.
The shared `useLoadPackagePlugin` owns React logs and callbacks; desktop retains
its native installer and hosted mode supplies the existing two-step HTTP loader.
Failed writes are not retried. Both use the existing initializer normalizer.
The old hosted hook path is a compatibility re-export, not an active Vite alias.

Project worker lifetimes are owned by `app/src/utils/workerRequests.ts`: lazy
construction, correlated responses, cancellation, bounded parsing, fatal-worker
retirement and no replay. Desktop and hosted workers retain different payload
parsers. The desktop revision parser now actually posts its request; previously
it returned a permanently pending promise. Hosted payload decoding stays an
explicit IO dependency, not a replacement for every editor deserializer.

Only the native API and environment/path transport module aliases remain.
Environment-to-runtime-settings policy is shared in `resolveEnvironmentSettings`.
Hosted mode now uses the same modern provider key fallbacks and endpoint policy
as desktop: environment variables must not silently select an OpenAI endpoint.
Keep these two native transport shims; do not recreate policy in them.

### Execution preparation and engine ownership

Ordinary-run capture/artifact persistence and selection/Evaluation policies are
shared as documented above. Browser and Node retain their different physical
completion, reconnect and cancellation protocols. More hook extraction needs
demonstrated shared policy, not a line-count target.

`ChildInvocationOwnership` is the discriminated engine policy for same-graph
branches. A continuation shares node/input state and uses its output overlay;
an async branch shares node/input state but keeps boundary outputs private; a
watch snapshot gets isolated node state, copied inputs and private outputs.
Identity, parent/abort ownership and lifecycle suppression are selected together
and applied once at construction. Existing planners, schedulers, event bridges
and per-mode terminal commits remain authoritative; this is not a scheduler
rewrite or a new event bus. Ordinary subgraph ownership is unchanged.

The public Core entrypoint installs the authored-code namespace into a leaf
provider. `CodeRunner` resolves it only when requested and no longer imports the
public runtime barrel. Authored `Rivet.*` APIs are preserved. Internal consumers
that bypass the public entrypoint must supply their own code runner/namespace;
do not bring the barrel import back into an engine implementation.

### Storage and resource composition

`storage-backend.ts` selects `projects`, `publications`, `execution` or
`recordings` explicitly for each delegation. `WorkflowRepositories` exposes the
existing narrow interfaces; selection returns the same installation-owned
adapter, not a new pool, store or authorization boundary. The combined backend
is retained for concrete adapters, migration and cross-domain workload fixtures.
Legacy backup conversion remains supported.

`managed/operations.ts` composes operational health/Evaluation stores and the
optional coordinator using narrow execution-source callbacks. The serving
composition root injects it into the managed adapter. Offline adapters do not
construct these serving resources. Existing retirement/drain ordering still
stops the coordinator before persistence/pool disposal, and ordinary storage
initialization does not start graph execution. No database schema changed.

Managed context shutdown first settles maintenance and invalidation producers,
then releases the pool before disposing both object-store clients. One client
throwing cannot skip the other client or mask a pool-close failure. A single
failure retains its original identity; multiple failures are reported together.
Repeated disposal observes the same settled outcome without retrying resources.
An unconfirmed producer stop still blocks later cleanup rather than closing
resources underneath work which might remain active.

### Build/dependency boundary

Core's `package.json.rivetSourceEntrypoints` is the source declaration consumed
by both Vite aliases and the CommonJS builder. Public runtime exports still
resolve to built files; there is no new source-resolution condition pointing
published consumers at unpublished files. Core builds verify source/ESM/types
mapping, every ESM/CommonJS export surface and authored-code namespace execution.

The file-tree gate parses real TypeScript imports (including multiline/dynamic
forms), rejects package source deep imports and ratchets exact existing
source/specifier debt in `scripts/checks/import-boundary-debt.json`. New edges,
stale allowances and duplicates fail; removing one edge cannot conceal another.
Line movement does not invalidate allowances. It also follows indirect runtime
dependencies to prevent the CodeRunner/public-barrel cycle from returning.
The inventory is explicit historical debt, not evidence of architectural quality.
The gate and its regressions participate in `test:style`.

### Follow-on local evidence

Passed 318 engine tests (real branch execution, cancellation, lifecycle/identity,
streaming watches and authored-code API), 86 focused API/storage tests, 16 focused
App tests and 23 hosted adapter/Vite tests. The final storage lifecycle rerun
also checks that offline operational getters reject before attempting a DB
connection. Architecture/dependency regressions, both actual Vite configurations
and ten CI-planning tests passed. Core ESM/CommonJS build/API smoke, the reused
Node CommonJS builder, App/API TypeScript, focused Core/App lint, documentation
links, editor boundaries, test-style and migration-ledger checks passed.

Eleven distinct headless journeys passed: hosted package installation and a
non-replayed failed install, desktop bundle IO with a real Unicode worker parse,
partial-run preloading and all eight Browser parent-recording outcomes. An
initial mixed run was interrupted while source formatting was occurring; the
remaining cases were rerun separately. Two stale desktop expectations assumed
filename titles instead of the fixture's saved Unicode title and were corrected;
the complete desktop journey then passed. No assertions were removed.

The local production frontend build passed. It reports circular-chunk and large
chunk warnings; bundle splitting is not part of this consolidation. Existing
deep-relative dependency debt is recorded explicitly, not claimed eliminated.
No full-suite/live-provider/GKE qualification, commit, push or deployment was
performed for this follow-on work.

### Consolidation lifecycle review

Two concrete gaps were reproduced and fixed:

- Cancelling a queued parse while another request still owned its worker left
  the cancelled synchronous parsing alive after the accepted request settled.
  The broker now retires that worker generation when accepted work reaches zero.
  Accepted requests finish once, and future selections do not queue behind
  cancelled work. This adds one generation-local cancellation flag, not retries
  or another worker pool.
- The injected operational factory could throw inside the managed-backend
  constructor, after a pool lease was acquired but before the backend was
  reachable by the storage owner. It now constructs during owned initialization,
  before any backend is exposed as ready. Concurrent getters share
  one result; retirement is forwarded before coordinator startup, and a getter
  waiting on initialization cannot construct resources after drain. Offline
  getters still reject without connecting to a database. Factories only wrap
  the supplied pool; producers start explicitly through serving startup.

Regression coverage includes failure/disposal pool metrics and real browser
workers with blocked obsolete parsing, alongside existing bundle IO, worker
failure/cancellation and managed shutdown cases. These are local checks only.
The broader review run passed 88 API/storage and 18 hosted adapter tests; the
headless desktop bundle journey passed with the new real-worker case. Existing
operational stores remain usable during accepted shutdown flushes; only creating
new resources after drain is prohibited. No engine behavior, schema or public
format was changed in this review.

### Adjacent ownership audit

Following the constructor/cleanup failures above, fault-injection checks exposed
three related defects, now fixed:

1. Invalid maintenance, retention or object-storage settings could still throw
   while constructing the persistence context, after acquiring an unreachable
   pool lease. Relevant configuration is now evaluated before leasing. A fenced
   acquisition cleans only new object clients; injected stores remain untouched,
   and one cleanup failure does not hide the original error or skip other clients.
2. The shared pool registry removed an entry before the driver's close completed.
   This understated live/uncertain resources and allowed replacement acquisition.
   Closing entries now remain visible and fenced until confirmed closure; a
   failed or synchronous-throwing close remains failed without a driver retry.
3. Shared-settings cleanup swallowed close errors and concurrent disposal could
   acknowledge completion early. It now shares one disposal promise, reports
   failures from both resources, and keeps the repository backend selected on
   failed cleanup. A failed startup with unconfirmed cleanup also retains its
   failed initialization, so later readiness checks cannot report success or
   quietly fall back to files.

Existing reference counting, independent database identities, paused/offline
retention behavior and normal settings revision recovery are preserved. No
generic resource manager, automatic write retry or cloud operation was added.

Verification passed 83 focused pool/context/retention/settings tests, API
TypeScript, repository boundary/test-style/migration guards and two headless
desktop-bundle/hosted-settings smoke journeys. Initial filesystem cases hit
Windows sandbox temp-file rename restrictions; they passed outside that sandbox
without weakening assertions. All new failure scenarios were reproduced before
their fixes. This is local evidence, not a live database or provider qualification.

## Local verification

Focused App checks:

```sh
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useLoadProject.test.tsx src/hooks/useContextMenu.test.ts src/hooks/preparedEditorRun.test.ts src/utils/evaluationGraphExecution.test.ts src/utils/evaluationRecordingPersistence.test.ts src/utils/evaluationExecutionLifecycle.test.ts
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useSyncCurrentStateIntoOpenedProjects.test.tsx src/utils/openedProjectSynchronization.test.ts src/utils/openedProjects.test.ts
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useCopyNodesHotkeys.test.ts src/hooks/nodeClipboardHotkeys.test.tsx src/hooks/useCanvasPositioning.test.ts src/domain/graphEditing/nodeActions.test.ts src/domain/graphEditing/graphInputUsage.test.ts
yarn workspace @valerypopoff/rivet-app test:files src/hooks/useDebuggerConnectionSettings.test.tsx src/state/settings.test.ts src/state/savedGraphs.test.ts src/utils/platform/updater.test.ts

yarn workspace @valerypopoff/rivet-app test:files src/hooks/preparedEditorRun.test.ts src/utils/editorRunRecording.test.ts src/hooks/editorRunSession.test.ts src/hooks/useRemoteExecutor.test.tsx src/hooks/remoteExecutorRunRequest.test.ts src/hooks/remoteExecutorUploadCache.test.ts src/hooks/remoteExecutorHelpers.test.ts src/hooks/useBundleExecutionRouting.test.tsx src/utils/recordingCapturePolicy.test.ts src/utils/evaluationRecordingPersistence.test.ts src/utils/evaluationGraphExecution.test.ts src/utils/evaluationExecutionLifecycle.test.ts
yarn workspace @valerypopoff/rivet-studio-server-web exec tsx --test tests/vite-aliases.test.ts tests/editor-bridge-focus.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/hosted-editor-seams.test.ts
```

Run `yarn studio-server:ui:observe hosted-modal-focus.spec.ts
project-tree-activation.spec.ts evaluation-trial-orchestration.spec.ts` against an owned local
Vite instance with `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`. These use
isolated local browser fixtures, not production traffic or paid environments.
For tab synchronization, also run `explicit-bundles.spec.ts` and
`project-tab-shortcuts.spec.ts` alongside the complete project-tree activation
suite: they exercise closure/reopen, bundle membership, standalone editor hosts
and independent-window recovery through the real UI.
The separate `evaluation-metrics.spec.ts` scenarios require the full local
Compose API/executor stack and a local provider fixture; they are not qualified
by running a Vite-only server. Do not misreport their setup failures as UI
regressions or mark them passed without that backend.
See [host contracts](../HOSTED-WEB-APP-CONTRACTS.md),
[execution coordination](../EXECUTION-COORDINATION.md), and
[Evaluations](../EVALUATIONS.md) for the owning invariants.

For settings/context verification, use Vite for `project-tab-shortcuts.spec.ts`
and the source fixtures in `hosted-executor-origin.spec.ts` (filter out
`hosted Node executor origin`). That standalone host harness deliberately imports
source modules. Run the seven `hosted Node executor origin` cases separately
against a freshly built local preview, selecting them with `-g`; these fixtures
proxy the frontend through fake public HTTPS origins and are intended for
compiled assets. Both runs still use `studio-server:ui:observe` in headless mode.

For ordinary-run recording changes, `local-editor-recordings.spec.ts -g 'browser
parent recording'` runs eight fully routed Browser fixtures on Vite. Its Node
cases require the real local server transport and must not be counted as passing
against a frontend-only server. The isolated Node reconnect/dataset/artifact
journey in `hosted-executor-origin.spec.ts` does run on Vite, alongside
`recording-playback-history.spec.ts` and `evaluation-trial-orchestration.spec.ts`.

### Evidence for this slice

Settings-panel follow-up review reproduced two UI gaps: a saved URL arriving
after mount lost its selection, and Enter during IME composition connected and
saved an unfinished draft. The shared panel now owns initial focus once, selects
hydrated defaults without overriding user drafts/focus, and excludes composition
Enter from submission. The existing three preference browser journeys cover long
saved URLs, selection, composition, Cancel/reload and one ordinary Enter
connection with explicit persistence. No additional settings/cache abstraction
or storage schema was introduced.
Follow-up verification: 80 focused settings/context/updater tests and six
headless hosted/standalone browser journeys passed, alongside App TypeScript,
focused lint, formatting, documentation links and execution-boundary checks.
The persistence assertion reads the current IndexedDB backend rather than the
legacy localStorage seed. These are local checks, not provider qualification.

Adjacent context review reproduced IME confirmation saving unfinished values in
both fields and an existing-value edit dialog surviving public context deletion.
One composition-aware form handler replaces the duplicated field handlers;
removed edit targets hide and close their dialog instead of leaving a stale
draft available. Existing hosted settings and standalone-tab browser journeys
cover these cases, ordinary Enter, Cancel, Delete and project-switch isolation.
The public context-cleanup regression also injects a failed checkpoint write:
it must reject, retain the old durable checkpoint, clear the live value and
allow explicit retry without affecting another project's context. No new
storage abstraction, deletion protocol or automatic retry was introduced.
Adjacent verification passed 96 focused settings/context/storage/updater tests
and seven headless hosted/standalone UI journeys. App TypeScript, focused lint,
formatting, documentation links and execution-boundary checks passed. The
project-switch check confirmed the existing settings dismissal is sufficient;
no second project-lifetime mechanism was added. All verification stayed local.

- 111 focused App checks passed (activation, preparation, trial/recording
  orchestration, execution lifetime, Node requests and bundle observation).
- 251 web tests, three hosted seam checks and ten CI planning/shard checks passed.
- 35 headless menu/focus/activation journeys and two new real Browser-evaluation
  journeys passed. The latter verify a single recording write, actual output and
  rendered trial rows, including preservation of a successful verdict when
  recording storage returns 503. The new fixture is included in the balanced CI
  browser suite; its initial duration hint is an estimate, not a provider result.
- App TypeScript, changed-App lint, documentation links, execution boundaries,
  migration ledger, test-style guards, formatting and the hosted production
  frontend build passed. Build output retains existing mixed static/dynamic
  import chunking warnings; these are not compilation failures.
- Chromium and temporary loopback/filesystem fixtures required running outside
  the Windows sandbox. Earlier launch/connection/rename failures were environment
  restrictions; the same suites were rerun successfully. No production or paid
  environment was used. The Compose-dependent metrics scenarios remain separate.

## Integrated qualification follow-up (2026-10-24)

The architectural slices above are implemented. Final qualification exposed stale
test assumptions rather than requiring another coordination abstraction:

- CJS builder fixtures now supply an actual package manifest. The two cases
  exercise the single-root fallback and the declared serialization entrypoint,
  including the nested Node `require` mapping used by published exports.
- Decision AI timeout regressions use an enabled, host-backed profile and a real
  project identity. Inline run nodes no longer own timeout settings; testing a
  removed inline field silently bypassed the intended deadline path.
- The loaded-recording preview test creates a live run in the second project's
  own execution view. It no longer depends on execution state leaking across
  project switches.
- The evaluation-metrics UI fixture uploads a real temporary local project,
  loads its authoritative path/metadata ID and deletes that exact project after
  the test. PostgreSQL history references require a saved project, unlike the
  old browser-only seed. These modifying fixtures explicitly refuse remote
  hosts. The suite selector is scoped to Evaluation resources, not a same-named
  project tab; opening the panel is idempotent rather than toggling it closed.

Receipts are ignored local files in `artifacts/refactor-qualification/`:

- `core-tests-final.log`: 2,109 Core tests passed with no skips/cancellations.
- `app-tests-final.log`: 2,785 App tests passed in 12 bounded batches.
- `web-tests.log`: 253 hosted-web checks passed; `api-tests.log`: 58 focused
  storage/composition/settings/ownership checks passed.
- `compose-ui-qualified.log`: all four real-backend UI checks passed, including
  successful Browser accounting/reopen, failed hosted-Node accounting/reopen,
  real-executor pruning and prompt cancellation. This is local Compose evidence,
  not GKE qualification. Select the same explicit `RIVET_ENV_FILE` for the
  launcher and Playwright runner; the runner deliberately loads file values
  over ambient shell variables. For this isolated modern-launcher fixture,
  an ignored Compose override supplied `host.docker.internal:host-gateway` and
  the existing provider-proxy bypass, matching the legacy development fixture.
- `style-final.log`, `app-typecheck.log`, `api-typecheck-final.log`: repository
  policy/style/docs gates and both typechecks passed. Run typechecks after
  build prerequisites settle: concurrent Core output cleanup can produce false
  missing-export errors in consumers.
- `desktop-build.log` and `desktop-isolated-build.log`: unsigned Windows debug
  NSIS packages built. A separate qualification application identifier and
  disabled updater kept the installed Rivet profile/workspace untouched. Its
  real native file picker loaded the exported fixture bundle; Browser execution
  produced `child-result` in both the root and open dependency tabs. The test
  override's generated Cargo feature/lockfile edits were removed afterward;
  normal updater behavior is unchanged.

The initial native Node check remained in its starting state; the delivery gate
was kept open until the cause was established. The follow-up below closes that
local gate. Mac/signing/installation/provider qualification is not implied by
this Windows debug package. No production or GCP resources were used.

Cleanup verified: the six isolated Compose containers, 14 operation-owned volumes
and the operation network are gone; the pre-existing `rivet-dev-local` services
remain running. The test desktop app, standalone sidecar and connectivity probe
were closed. Ignored local packages, fixtures and evidence remain available for
diagnosis. No commit or push was made during this qualification follow-up.

The extra root-level ESLint invocation is not a passing qualification receipt:
the existing Core `node:test` registrations trigger `no-floating-promises`, and
Playwright specs are outside that typed lint project's inputs. Their owning
test/style runners, formatting, typechecks and real-browser checks above passed;
this follow-up did not suppress rules or relabel the lint attempt as success.

## Shutdown reassessment (2026-10-24)

A failure-injection regression reproduced a normal-shutdown counterpart to the
earlier constructor cleanup gap: the first object-client close could throw in a
`finally` block, skipping the second client and replacing a pool-close error.
The shutdown owner now attempts both client disposals after pool release, retains
every failure and keeps its existing write-once disposal promise. No new resource
owner, cleanup framework or automatic retry was introduced. Producer-stop order
and the rule against closing persistence before producers settle are unchanged.
The regressions cover simultaneous and single client failures, original-error
identity, acknowledged pool release and repeated disposal without extra closes.
A lost pool-close acknowledgement is retained alongside the client failure,
and the existing registry fence prevents reacquiring that unconfirmed pool.

Local review receipts are `artifacts/refactor-qualification/reassessment-*`.
The first adjacent settings test run hit sandbox `EPERM` rename restrictions;
the final 57 resource/settings/ownership tests passed outside that sandbox. Two
headless Evaluation journeys also passed against an isolated frontend with mocked
successful/failed recording storage; they do not contact a real backend. API
TypeScript, formatting, migration-ledger/test-style checks and doc links passed.
The temporary source frontend was stopped afterward. Native desktop Node qualification
remains unresolved as described above; this shutdown fix does not claim to solve
or qualify that separate connection path. No commit, publication or cloud change
is included in this review.

## Adjacent listener-ownership review (2026-10-24)

Following the failed-close cases into the invalidation listener reproduced two
related faults: disposal could acknowledge completion while connection startup
was still pending, and swallowed `end()` failures allowed an overlapping listener
or a false successful shutdown. The controller now owns connecting clients as
well as healthy ones and shares their original close/disposal promises. Failed
cleanup keeps that owner fenced; it does not allocate a replacement or replay
an uncertain close. Degraded serving still bypasses pointer caches and uses SQL
reads, preserving the existing fallback rather than requiring the listener to be
healthy for every request. Ordinary successfully closed sessions still reconnect.

Regression cases cover startup/disposal races; failed closes during startup,
normal operation and shutdown; repeated disposal; normal reconnect; and concurrent
initializers waiting for one replacement after an acknowledged close. Lifecycle
diagnostics are guarded so a logging error cannot prevent retirement. The
existing architecture remains intact: there is no generic connection manager,
new schema or new background worker. These checks do not resolve the separately
blocked packaged desktop Node startup qualification.

Receipts are `artifacts/refactor-qualification/listener-*`. Four failure cases
failed against the prior code before the fix. The adjacent API regression run
passed 84 tests; API TypeScript, formatting, migration-ledger/test-style guards,
documentation links and diff checks passed. Two headless tree-refresh/document
preservation journeys passed with a test-owned API and simulated notification
delivery. Those browser checks cover UI behavior, not a live PostgreSQL LISTEN
qualification; driver lifecycle coverage uses injected listeners. The temporary
frontend was stopped afterward. Verification stays local, without source
publication, GCP changes or another paid rehearsal.

## Native qualification closure and delivery review (2026-10-24)

The desktop startup failure was reproduced as `EADDRINUSE` on `127.0.0.1:21889`.
An elevated read-only listener lookup identified the already running installed
Rivet executor as its owner. The qualification app had a separate application
identifier/profile but still shared the normal executor port; there was no
demonstrated refactor defect in sidecar startup. The installed app and its
projects were not stopped or changed.

An ignored Vite qualification adapter changed only the internal executor URL and
sidecar argument to port `21891`; the separate Tauri test configuration allowed
that exact argument. Production source defaults, normal updater support and
normal shell permissions are unchanged. The rebuilt unsigned Windows debug app
opened the real exported bundle through its native file picker, connected its
own internal Node executor and ran Root successfully. Root displayed
`child-result`; switching to the open dependency tab displayed the same value
and completed Text/Graph Output Run Activity rows. The existing partial-activity
notice for events without exact run identity remains truthful, not suppressed.
Browser-mode bundle execution had already passed in the same isolated profile.
This verifies local Windows debug execution, not a signed installer or macOS/GKE.

Receipts: `desktop-isolated-port-build.log`, `desktop-isolated-port-native.log`
and the native UI observations in this review. `precommit-style.log` records a
fresh passing repository policy/architecture/docs/workflow gate. Earlier full
Core/App/web and real Compose receipts above remain applicable: no application
runtime code changed during this closure. The test app was closed afterward;
the original installed app was preserved. Test-only config, packages and fixtures
remain ignored and must not be committed. The stale four-Compose-check status in
the execution-routing plan was corrected to reference its passing receipts.

### CI observation-retirement correction

The first published CI run exposed synchronous reentrancy during Remote Debugger
observation retirement. Publishing execution-state settlement synchronously
notifies ownership subscribers; settling before recording the blocked/removed
state could recursively settle the same member, exhaust the stack and blank the
editor. Bundle-member removal also retained stale observation provenance.

The router now commits its blocked state, member removal or source detachment
before invoking external store callbacks. There is no deferred cleanup, retry or
second coordinator. A callback-reentrancy regression covers conflict, explicit
membership detachment and shared disconnect, requiring exactly one settlement.
The real-browser bundle scenarios retain their controls, provenance and no-command
assertions and additionally reject uncaught page errors, so a blank editor is
reported directly instead of only as a missing button. CI artifacts and red/green
local receipts are kept under `artifacts/refactor-qualification/ci-remote-*`.
All 47 focused observation/registry tests and all 12 headless bundle-debugger
scenarios passed after the fix. App TypeScript, focused lint, formatting,
test-style and documentation-link checks passed. The three original browser
failures are also rerun with the explicit uncaught-page-error assertion.
