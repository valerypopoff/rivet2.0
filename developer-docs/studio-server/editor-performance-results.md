# Editor performance implementation and verification

This is the implementation record for the
[bounded performance plan](editor-performance-implementation-plan.md). The
[original baseline](editor-performance-baseline.md) remains historical evidence;
candidate results must not replace its artifacts.

## Architecture and extension rules

### Presentation is not execution storage

`RunActivityRenderer` subscribes only to drawer visibility while closed. Opening
mounts the detailed presentation against the existing execution snapshot; closing
unmounts its output inspector, timer and detailed subscriptions. Execution event
collection, retention, root accounting and the compact status indicator continue
independently. No journal events are delayed, batched or discarded for performance.
The lightweight renderer retains only committed filters/search, filter-panel and
follow-live preferences and expanded activity keys. Reopening the same root keeps
those choices; a different root clears expansion through the original root-change
policy. This small UI snapshot contains no execution outputs, derived rows or
definition indexes, and does not subscribe to closed-view execution updates.

The open renderer owns one definition resolver and one row projector. They are
recreated when the project, unsaved graph or registry identity changes. Graph/node
indexes and definition metadata are weakly keyed by actual definition objects.
Invocation resolution includes exact process history, graph-run ancestry and
root labels. Foreign-project graph IDs cannot resolve against a local definition.
An unsaved current graph continues to override its saved version.

Derived rows are reused only while invocation, resolved output/definition and
ancestry references are unchanged. Switching roots resets the row cache; closing
the drawer releases the entire presentation. These are view-local caches, not a
second event store or a project-ID-only global cache. New projection fields must
include their dependencies in invalidation tests. The uncached view-model builder
remains the behavioral reference for lifecycle/accounting parity.

Ordinary rows use a cheap exact-identity response-inspector availability check.
The full model trace is constructed only when opening the existing inspector.
Memoized rows receive stable callbacks, so unrelated invocations do not rerender
completed expanded rows. Full-output actions still resolve retained values through
the original output owner; the resolver does not dereference output refs.

Core intentionally emits a fresh caller-metadata object on each event. The
journal compares its complete scalar field set before replacing the retained
executor descriptor. Otherwise Immer interprets every child-node event as an
ancestry change and invalidates all completed rows. Real changes to caller node,
parent graph, process or split index still replace the descriptor; unknown future
fields also participate in comparison rather than being silently ignored. No
event publication, journal ordering or execution ownership is changed.

### Heavy editors load at their feature boundary

The shared Code Editor and folding-code renderer use a small Suspense/error
boundary. Pending text and ownership stay in their existing parent. A failure
offers an explicit retry of the import, never a retry of a save, execution or
other application command. Existing Monaco models, workers, themes, languages,
search and diagnostics remain under their original owners.
Successful explicit recovery also becomes the loader for subsequent mounts;
closing and reopening must not resurrect React.lazy's original cached rejection.
Browsers can also cache the failed module fetch itself. Explicit retry recognizes
only network-import errors naming an asset in the current module's same-origin,
same-build directory. It keeps that exact pathname and adds a request key; it never
imports a different release or cache-busts module-evaluation errors. Pending retries
and successful modules are shared. Errors without a safe module URL retry the
original loader and remain visible if recovery is unavailable.
The shared promise is assigned before either loader callback is invoked, using
the promise chain itself as the exception boundary. Synchronous throws therefore
reject the same shared attempt rather than escaping or leaving retry stuck in a
pending state. Promise presence plus one failure flag cover pending/success/failure;
there is no separate four-state enum to keep synchronized.

Hosted editor startup opts out of eager Code Editor warming; standalone behavior
is preserved. Syntax-colorized text dynamically requests Monaco when actually
rendered. Opening a graph with visible prompt bodies can therefore legitimately
load Monaco even before opening a code-edit modal. The empty, fully bootstrapped
dashboard plus iframe must not request it.

Vite's preload helper has its own tiny chunk. Without that explicit assignment,
the helper was placed in Monaco's chunk and ordinary dynamic imports eagerly
pulled Monaco into startup. Do not globally disable module preloads or infer
module ownership from a generated shared-chunk name. Use emitted attribution and
whole-navigation requests, including iframe and workers.

### Direct labels, live authorization

Node display labels come directly from the registry's existing registration map;
there is no rebuilt all-types label map or new label cache. Late registration,
empty/missing names and duplicate-registration behavior are regression-tested.

Subgraph snapshots and access approvals have different lifetimes. The measured
chain's nine snapshot loads and 36 live access checks are retained. A deterministic
regression revokes a descendant's permission after discovery but before child
startup, and asserts no denied child work occurs. Reusing the processor restores
normal fresh loading and validation on the next run. Removing those checks safely
would require a broader admission-contract change; this implementation does not
silently replace them with cached approvals.

## Reproducing verification

See the repository-owned
[benchmark runner](../../scripts/benchmarks/editor-performance/README.md). It uses
production-built immutable assets, synthetic projects, real Browser/Node execution
and generated recordings. It records build identity separately from harness
identity and the compiled fixture runtime hash. Existing applications and ports
are never stopped or replaced.

Finish all commands that rebuild Core before running fixtures importing compiled
Core. For already verified compiled artifacts, `RIVET_APP_TEST_DEPENDENCIES=prebuilt`
uses the App runner's explicit export validation instead of rebuilding them.
Do not compare timings while builds or other suites compete for CPU. Keep raw
samples, cold versus cached resources and first-use costs separate; seven samples
support median/range comparison, not a production percentile or availability SLO.

## Final evidence

The completed regression runs are:

| Check                                                                       | Result       |
| --------------------------------------------------------------------------- | ------------ |
| Core source suite                                                           | 2,111 passed |
| App suite, including real renderer/loader/ancestry regressions              | 2,798 passed |
| Node suite with local HTTP/WebSocket permission                             | 326 passed   |
| Hosted-web source and production-asset suites                               | 254 passed   |
| Managed Subgraph access boundary                                            | 1 passed     |
| Benchmark support/ownership/aggregation                                     | 5 passed     |
| Project lifecycle, editor ownership, bundle debugging and playback UI       | 38 passed    |
| Fullscreen output resize and paged JSON search UI                           | 2 passed     |
| Core package, hosted production and standalone editor builds; App typecheck | Passed       |
| Full structural/style lane, import/editor boundaries, documentation links   | Passed       |

Detailed logs are under ignored `artifacts/benchmarks/editor-performance-*.log`.
The real production-build smoke verifies 999 completed nodes across ten graphs,
actual source/member outputs, activity full-output inspection, command-free
steady/burst Node observation, restored tabs and repeated 100-row project-scoped
recording playback. A real HTTP 503 for the Code Editor module is recovered by
explicit retry; closing/reopening preserves the editor's current content.
The untimed bootstrap gate verifies that project rows remain disabled while the
iframe is not ready, then open normally after release. This corrects the plan's
assumption that the UI admits a queued double-click before readiness: it does not.
The existing bridge contract tests own internal pre-ready command delivery.

Verification setup failures were kept distinct from product failures: concurrent
Core rebuilds initially removed files beneath another suite, and restricted local
network access stalled a socket test. Serial preparation and loopback-enabled
reruns passed. An asset-only server cannot run the additional `code-object-outputs`
scenario that requires an API-backed workspace; its missing restored node is not
reported as a passing check. The self-contained editing/ownership scenarios and
fullscreen search checks above use their own API fixtures. An activity-inspection
harness error also initially waited for the drawer's close control after Escape
had already closed it; the corrected harness preserves that keyboard behavior.

Final paired measurements follow below. Local correctness and hosted measurements
do not imply native desktop startup gains, production network performance or GKE
qualification. No publication or production change is included.

The first uncontended candidate comparison is preserved at
`artifacts/benchmarks/editor-performance/paired-candidate-final/`. It passed all
behavioral controls and improved closed-drawer execution by 34%, but open-drawer
execution improved only 2.5%. Its profile and the new failing-then-passing journal
regression exposed the equal executor-metadata replacement described above. That
artifact is intermediate evidence, not the final candidate reported below.

### Final paired comparison

The preserved baseline is `artifacts/benchmarks/editor-performance/paired-baseline-final/`;
the final candidate is `artifacts/benchmarks/editor-performance/paired-final-complete/`.
Both passed. Builds and regression suites finished before timed sampling. The
same machine, Chromium 151.0.7922.34, Node 22.22.3, fixtures, zoom, cache policy and
timed workload were used. Principal conditions have seven samples; tab switching
has twenty. Values below are milliseconds, median (minimum–maximum).

| Checkpoint                                   | Baseline                     | Candidate                 | Disposition                                             |
| -------------------------------------------- | ---------------------------- | ------------------------- | ------------------------------------------------------- |
| Dashboard panel visible                      | 578.5 (558.1–644.8)          | 444.1 (429.5–486.3)       | 23% faster                                              |
| Empty dashboard + iframe ready               | 863.9 (843.6–964.8)          | 709.3 (684.6–774.5)       | 18% faster                                              |
| First project usable, from navigation        | 1,156.3 (1,124.7–1,284.1)    | 1,006.5 (985.2–1,067.9)   | 13% faster                                              |
| First Code Editor usable, from click         | 91.0 (84.7–117.5)            | 104.6 (91.4–117.9)        | +13.6 ms; below the 50 ms material-regression threshold |
| Cached reload ready                          | 151.5 (135.5–180.0)          | 119.1 (115.5–149.0)       | 21% faster                                              |
| Tab switch                                   | 136.0 (124.8–174.0)          | 140.1 (124.3–155.9)       | +4.1 ms; no material regression                         |
| Browser terminal presentation, drawer closed | 3,238.4 (3,216.8–3,270.4)    | 2,146.5 (2,123.2–2,222.0) | 34% faster                                              |
| Browser terminal presentation, drawer open   | 12,121.7 (10,970.8–13,531.6) | 3,948.7 (3,691.7–5,162.6) | 67% faster                                              |
| Debugger changed root output                 | 649.5 (530.5–766.2)          | 563.5 (437.9–653.3)       | Overlapping ranges; no speedup claimed                  |
| Debugger steady terminal/drain control       | 3,005.2 (2,669.8–3,387.3)    | 2,901.4 (2,615.8–3,519.8) | All members settled; no speedup claimed                 |
| Repeated recording playback                  | 128.1 (112.2–133.3)          | 125.4 (112.4–129.9)       | No material regression                                  |

At empty-editor readiness, unique decoded JavaScript and actual uncompressed
local JS bodies fell from **17,120,029 to 12,633,932 bytes (26.2% less)**.
Summed per-frame/worker decoded cost fell from **29,098,371 to 20,128,987 bytes
(30.8% less)**. These are distinct measurements, not gzip estimates or production
bandwidth claims. No Monaco asset was requested before the feature boundary.

The separate untimed open-drawer CPU profile attributes approximately 5,066 ms of
sampled self-time to activity-row construction before, versus 584 ms after. This
supports the measured wall-time change; profiles are not included in timed samples.
No event buffering, shorter retention or lower fixture complexity was used.

All fourteen Browser runs per build retained exactly nine execution-snapshot
loads and 36 live access checks; the runner asserts these counts. Ten graphs and
999 nodes actually completed, source/member output values matched, the debugger
sent no execution commands, and the three-run burst drained before disposal.
The generated root recording retained 1,213 events and exactly 100 successful
activity rows; live activity also supplied a real inspected output. Readiness
admission, HTTP-import retry, reopening and drawer-preference persistence passed.

Both frontend builds identify Git revision
`cdd837a08d320235868682d7e204d7bea0592085`, with distinct dirty-build SHA-256 digests:

- Baseline: `1c587b0fae3fb6e2c25a07f96fde7d601c8106a9fcac9454f361f6f2accefa3f`.
- Candidate: `fac9d73c4ab9b970fb3098e6d0d101c8fff6330374f1bd027c81445501b69ef8`.

The common compiled fixture-runtime hash is
`f07ce1759899f037c79989c6552dc352a5d0c7a1bd011f68e9d6c4cb336cc6a0`.
Build identity is read from each immutable dist, not relabelled with the current
harness checkout. Raw samples, resource inventories, CPU profiles, screenshots
and source/environment metadata remain in the two operation directories.

P0–P3 and P5 are complete. P4 has the explicit safe disposition above: required
authorization checks were not removed. The startup-byte and both Browser timing
targets were met without a material first-editor, tab or playback regression.
Remaining large shared runtime/provider chunks and chunk-size warnings are not
claimed fixed. Browser timing here means terminal presentation, not a separately
timed outputs-ready/background interval; those lifecycle semantics remain covered
by the existing regression suites. Single restore/open controls and small sample
sets do not establish a production percentile, memory-leak bound or availability
guarantee. No broader refactor or paid environment was started.

## Solidification review (2026-10-25)

The follow-up reviewed cache dependencies, graph-ancestry identity, exact output
resolution, closed-view preference retention, lazy component ownership and module
retry admission. One additional defect was reproduced: a loader that threw before
returning its promise left the previous implementation's state marked pending.
Initial loading could escape synchronously; a subsequent explicit retry could
return undefined or an old rejected attempt indefinitely.

The loader now starts both original and retry callbacks inside its assigned shared
promise. Its state was simplified to that promise and one failure flag. A regression
first failed against the original implementation, then passed for synchronous
initial failure, synchronous retry failure, concurrent callers, explicit recovery
and successful-module reuse. Existing URL pinning, no-background-retry and
evaluation-error safeguards remain unchanged.

Fresh verification after this fix:

- Full App suite: **2,799 passed**.
- Focused loading/drawer/projection/trace suite: **46 passed** (overlaps the App suite).
- Focused Core registration/async-branch suite: **154 passed**.
- Benchmark support/ownership: **5 passed**; App typecheck and changed-file lint passed.
- Rebuilt production UI: the isolated 999-node Browser/Node/bundle/playback workload
  passed, including actual HTTP import failure/retry, reopening, successful activity
  rows, drawer preference retention and zero observer execution commands.
- Nine further headless checks passed for object/Code/prompt editing ownership,
  cloned IDs, JSON formatting, fullscreen resizing and paged JSON search.

Logs use the `artifacts/benchmarks/editor-performance-review-*` prefix. The rebuilt
UI and its sanitized evidence are in
`artifacts/benchmarks/editor-performance/review-20261025/`, build diff digest
`acbadf39137cff2e20431251d4a41e2b101eb52e9fd60db35106228c2a17e8d9`.
The seven-sample measurements above remain tied to their recorded earlier build;
this review adds fresh functional verification, not a new paired performance claim.
Only test-owned local servers were used and stopped afterward. No GCP, publication,
production deployment or commit was performed.

## Adjacent lifetime review (2026-10-25)

A real-renderer regression reproduced another stale presentation boundary:
Run Activity's fullscreen-output click selected an exact invocation immediately,
but its next-frame callback wrote only the node ID. Switching to another project
with cloned graph/node IDs before that frame opened output in the wrong tab.

The lightweight renderer now owns one cancellable pending output intent, outside
the open-only drawer. At delivery it rechecks existing workspace/binding identity,
active graph/caller view, selected graph execution, exact retained process page and
stored output availability; tool results additionally require the exact port.
Later clicks supersede earlier intents; renderer disposal cancels pending work.
Normal narrow-screen drawer closure does not cancel a valid action. Process/page
and port-resolution helpers are shared with the existing click-time checks rather
than copied. No execution command is issued or retried by this code.

Regression coverage includes the mounted real renderer, cloned and same-ID
replacement bindings, close/reopen, workspace release, graph/caller changes,
retention/page shifts, cleared evidence, stale tool ports, split output and
disposal. The local browser suite also checks actual fullscreen content after
narrow-screen Run Activity navigation.

Fresh local verification:

- Full App suite: **2,814 passed**, no failures or skips.
- Focused renderer/navigation/inspector/module-loading suite: **24 passed**
  (overlaps the App suite).
- Architecture and benchmark-support regressions: **10 passed**.
- App typecheck, changed-file lint/formatting, test-style, documentation links
  and diff hygiene passed.
- Rebuilt production assets: the isolated Browser/Node/bundle/playback workload
  passed with actual output inspection, large activity history, explicit import
  recovery and zero observer execution commands.
- Two fullscreen Playwright scenarios passed, including narrow-screen drawer
  disposal, actual output text, resizing and paged-JSON search/colorization.

Logs: `artifacts/benchmarks/editor-performance-adjacent-*.log`. Rebuilt UI evidence:
`artifacts/benchmarks/editor-performance/adjacent-20261025/`, build diff digest
`9bc8f67f12b0b496c91e31b7457721c3e24b0813f29527340946185adbc2f9c7`.
The earlier paired performance measurements remain unchanged; this single-sample
smoke verifies behavior, not a fresh speed comparison. Only isolated local test
servers were used, and they were stopped afterward. No cloud, production,
publication, commit or push action was performed.

## Plan completion audit (2026-10-25)

The source optimizations and paired acceptance targets above were already
implemented. Two final verification details were completed during the explicit
plan-to-code audit:

- The no-eager-Monaco guard now resolves exact emitted asset paths from module
  attribution. It no longer strips an assumed eight-character hash or tests a
  filename prefix, and it fails if no expected module is attributed. Its unit
  regression includes unhashed/long-hash chunks, Windows module IDs, request
  query strings, unrelated prefix matches and missing attribution.
- One lean cached-versus-reference projection test now feeds the real journal
  reducer through streaming and split output, clearing, outputs-ready with a
  still-active child, late child completion, bounded retention, failure, abort
  and two journal-replacing replays of the same IDs. Every event checks complete
  view-model parity; additional assertions protect unchanged-row reuse, terminal
  semantics, retention, historical timing and no accumulated/reused replay rows.

The phase-by-phase final disposition is recorded in the implementation plan.
Required live authorization remains deliberately unchanged under P4's allowed
safe exit; removing those checks is not pending implementation. Further runtime
machinery is not justified merely to expand an already met local performance goal.

Verification for these final test/harness-only changes: **28 projection tests**,
**6 benchmark-support tests**, App typecheck and changed-test lint/formatting,
test-style, documentation links and diff hygiene all passed. The headless
production-assets workload passed again with the strengthened startup guard,
999-node execution, output inspection, settled steady/burst debugging and
populated repeated-playback activity. Its isolated receipt is
`artifacts/benchmarks/editor-performance/completion-audit-20261025/`; focused logs
use `artifacts/benchmarks/editor-performance-completion-*`.

This smoke deliberately reused the preceding immutable build (digest
`9bc8f67f12b0b496c91e31b7457721c3e24b0813f29527340946185adbc2f9c7`), because
application runtime source did not change in this audit. The earlier complete
2,814-test App result remains separate from the new focused test result; no fresh
full-suite count, paired speed claim, publication or deployment is implied.

### Final verification-code review

The benchmark's sequential `finally` block could skip socket/server cleanup if
writing diagnostics or closing a browser context failed. Finalization now attempts
every retained resource independently, including synchronous callback failures,
and reports all cleanup failures without losing the original workload failure.
Build-metadata reads also finish before the HTTP fixture acquires its listener,
so an early metadata-read failure cannot strand that fixture outside `finally`.
No resource discovery, unrelated-process termination or automatic test retry was
added. One compact fault-injection regression covers failed evidence export,
failed context cleanup, successful remaining finalizers and error preservation.

The repeated-replay parity test no longer artificially projects an empty journal
between plays. It preserves the projector through direct same-ID replacement,
matching React's ability to batch journal replacement with the first replay event.
This strengthens coverage without adding another scenario/test harness or changing
application behavior. No additional application-runtime defect was confirmed in
this review.

Fresh checks passed: **7 benchmark-support tests**, **28 projection tests**, App
typecheck, changed-test lint, formatting, test-style, documentation links and diff
hygiene. The final headless workload also passed its startup/import-recovery,
999-node Browser execution, exact output inspection, steady/burst debugger and
recording-playback checks, then completed the revised resource finalization.
Its receipt is `artifacts/benchmarks/editor-performance/solid-final-20261025/`;
review logs use `artifacts/benchmarks/editor-performance-solid-*`. This reused
the same preceding immutable application build; no application runtime, release,
production or GCP change was made. These are focused review results, not a new
full-suite count or paired performance measurement.
