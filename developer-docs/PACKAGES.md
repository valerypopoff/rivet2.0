# Package Reference

> Detailed package-by-package reference for the current monorepo.

## Build Order

The root `yarn build` script currently builds packages in this order:

1. `@valerypopoff/rivet2-core`
2. `@valerypopoff/rivet2-node`
3. `@valerypopoff/rivet-app-executor`
4. `@valerypopoff/trivet`
5. `@valerypopoff/rivet-app`
6. `@valerypopoff/rivet2-cli`

That order is encoded directly in the root `package.json` and reflects actual runtime dependencies.

Hosted wrappers should prefer the narrower root build targets when they do not
need the full desktop/app/CLI surface:

- `yarn build:runtime`: core + node for API endpoint runtime images.
- `yarn build:hosted-web-deps`: core + Trivet for hosted web/editor images.
- `yarn build:executor-runtime`: core + node + app-executor artifacts.
- `yarn build:npm-public`: core + node + Trivet + CLI for npm publishing.

Those targets are implemented by
[`scripts/build-wrapper-target.mjs`](../scripts/build-wrapper-target.mjs) so
downstream wrappers do not need to duplicate workspace build order.

## `@valerypopoff/rivet2-core` (`packages/core/`)

### Role

Shared runtime foundation for the entire repo.

### Package metadata

- Version: `2.0.11`
- Main: `dist/cjs/bundle.cjs`
- Module: `dist/esm/index.js`
- Types: `dist/types/index.d.ts`

### What it contains

- graph/project/node/data types
- `GraphProcessor` and extracted helpers (`NodeExecutionPlanner`, `NodeExclusionPolicy`, `SubprocessorBridge`, `SplitRunProcessor`)
- built-in nodes
- built-in plugins
- `RegistryAssembly` - centralized registry creation and plugin assembly
- serialization with shared V3/V4 helpers (`serializationHelpers.ts`)
- recording/playback support
- runtime integration contracts
- Vercel AI SDK provider adapters used by the user-facing `LLM Chat` node, including the OpenAI-compatible provider factory for Custom provider mode
- `emitDetached` - explicit fire-and-forget event emission helper
- `pQueueCompat` - CJS/ESM interop for p-queue
- shared runtime settings normalization through `resolveProcessSettings(...)`
- public execution helpers and streaming APIs
- project comparison helpers such as `compareProjects(...)`, `getProjectConnectionComparisonKey(...)`, and `getProjectNodeFieldComparisons(...)`, which compare two project snapshots without mutating either side and expose stable graph/node/connection diagnostics for app and wrapper UIs. Node field comparisons recurse into nested node config, including `data`, so compare UIs can show only changed attributes instead of whole settings objects. Comment nodes are ignored entirely, including connections attached to comments, because they are canvas annotations rather than graph behavior. Node placement and z-order fields (`visualData.x`, `visualData.y`, and `visualData.zIndex`) are ignored for changed-node detection because they are canvas layout state, while visual size and color remain comparable node appearance fields. Subgraph per-instance port order fields (`data.inputPortOrder` and `data.outputPortOrder`) are also ignored because they only change the canvas order of existing ports, not the subgraph target or dataflow ids.

### Important downstream consumers

- app
- node
- app-executor
- trivet

## `@valerypopoff/rivet2-node` (`packages/node/`)

### Role

Node runtime wrapper around core.

### Package metadata

- Version: `2.0.11`
- Main: `dist/cjs/bundle.cjs`
- Module: `dist/esm/index.js`
- Types: `dist/types/index.d.ts`

### Main exports

From `src/index.ts` and related files:

- re-exports of all core exports
- Node native API types and helpers
- `loadProjectFromFile(...)`
- `loadProjectAndAttachedDataFromFile(...)`
- `runGraphInFile(...)`
- `runGraph(...)`
- `createProcessor(...)`
- `createGraphRunner(...)`
- debugger server APIs
- dataset/debugger/project-reference helpers

### Architectural role

This package is the shared Node runtime used by:

- external consumers
- the CLI
- parts of the app-executor stack

It is not just a convenience wrapper. It sets Node-default providers, debugger integration, env-based plugin config fallback, and Node-specific reference loading. Runtime settings still flow through core's shared `resolveProcessSettings(...)` helper instead of being rebuilt independently in the Node package.
It also supplies a default tokenizer for Node-side runs when the caller does not provide one explicitly.

### Runtime-speed characterization

Runtime-speed work for programmatic Node execution is guarded from the Node
package first. [`packages/node/test/runtimeSpeedEquivalence.test.ts`](../packages/node/test/runtimeSpeedEquivalence.test.ts)
pins result and error compatibility across `runGraph(...)`,
`createProcessor(...).run()`, `createGraphRunner(...).run(...)`, and direct
`GraphProcessor.processGraph(...)` execution for provider-free headless
fixtures. It covers per-run inputs/context, branching DAGs, async Delay nodes,
missing-required-input exclusion, control-flow exclusion, Code, Expression,
repeated and changing-input subgraphs, nested subgraphs, dynamic `Call Graph`
dispatch, `Referenced Graph Alias` dispatch through a custom
`projectReferenceLoader`, thrown Code errors, and abort signals.

[`packages/node/bench/runtimeSpeed.bench.ts`](../packages/node/bench/runtimeSpeed.bench.ts)
is the repeatable benchmark harness. Run it with `yarn bench:runtime-speed`, or
tune it with `RIVET_RUNTIME_BENCH_ITERATIONS`,
`RIVET_RUNTIME_BENCH_WARMUP_ITERATIONS`, `RIVET_RUNTIME_BENCH_SAMPLES`,
`RIVET_RUNTIME_BENCH_SESSIONS`, `RIVET_RUNTIME_BENCH_FILTER`,
`RIVET_RUNTIME_BENCH_OUTPUT`, and `RIVET_RUNTIME_BENCH_JSON`. The JSON payload
records command, commit, date, OS, CPU, Node version, warmups, iterations,
samples, sessions, filter, output path, JSON mode, dirty working-tree status,
raw timings, mean, median, p75, p95, min/max, standard deviation, coefficient
of variation, and 95% confidence bounds.
When the output path is relative and starts with `packages/`, the benchmark
resolves it from the repo root so repo-relative commands such as
`packages/node/bench-results/example.json` do not create nested package
directories when run through `yarn workspace`.

The benchmark matrix measures one-shot `runGraphInFile(...)`, loaded-project
`runGraph(...)`, reused and fresh `createProcessor(...)`, `createGraphRunner(...)`,
direct processor execution, cheap text chains, wide fan-in DAGs, Subgraph and
nested-Subgraph calls, repeated same-input and changing-input subgraph calls,
dynamic graph dispatch, referenced-graph dispatch, Expression and Code chains,
lazy preprocessing, project loading, and CodeRunner compile/run paths. The
benchmark script rebuilds the core ESM package first because the Node workspace
imports `@valerypopoff/rivet2-core` through its package export surface.
Benchmarks are diagnostic only; correctness remains pinned by the equivalence
tests.

For production-shaped local analysis, the benchmark also looks for an ignored
`.fixtures/graph-fixture.rivet-project` file. When present, it adds `local real
workflow fixture` rows that run the fixture's `metadata.mainGraphId` with no
explicit inputs, relying on the graph's own mocked/default Graph Input values.
Keep that fixture local and ignored because it can contain production-shaped
payload data. Use `RIVET_RUNTIME_BENCH_FILTER='local real workflow fixture'` to
run only these rows.

The default Subgraph runtime speed pass is closed. The final local
real-workflow fixture run measured explicit compatible rollback
`createProcessor(...)` at about 33.7 ms mean, default fresh
`createProcessor(...)` at about 29.5 ms mean, and reused default
`createProcessor(...)` at about 29.2 ms mean. The cleanup did not keep the
experimental opt-in profiles or native prototype because the default TypeScript
runtime met the target for the production-shaped fixture.

[`packages/node/bench/runtimeAttribution.bench.ts`](../packages/node/bench/runtimeAttribution.bench.ts)
is the diagnostic attribution harness for that local fixture. Run it with
`yarn bench:runtime-attribution` and optionally set
`RIVET_RUNTIME_ATTRIBUTION_OUTPUT` to write a JSON artifact. It intentionally
uses `captureNodeTimings` and a profiling cached CodeRunner, so its numbers are
for attribution only rather than clean before/after speed claims. It reports
fixture load/run wall time, node-type duration totals, graph summaries, top
nodes, fixture CodeRunner cache/compile/invocation/execution buckets, coarse
`GraphProcessor` runtime phase buckets, `createProcessor(...)` construction
time, and small synthetic CodeRunner scenarios. Runtime phase buckets are
diagnostic and can be inclusive across nested graph/subgraph calls; use them to
choose the next optimization target, not as standalone proof that the
unprofiled runtime got faster. Like the speed benchmark, relative attribution
output paths that start with `packages/` resolve from the repo root.

A later fixture-focused speed pass kept only one low-risk runtime optimization:
default `CachedNodeCodeRunner` instances cache immutable invocation plans by
permission shape plus graph-input/context argument presence, while still
rebuilding the actual argument values for every invocation. The representative
fixture benchmark used 3 sessions, 15 samples per session, 20 measured runs per
sample, and 5 warmup runs per sample. Against the stable baseline artifact
`fixture-speedup-baseline2-f7d72213-20260525-182552.json`, the after artifact
`fixture-speedup-after-invocation-plan-f7d72213-20260525-183526.json` measured:

| Fixture row                   | Baseline mean | After mean | Mean delta | Baseline p95 | After p95 | P95 delta |
| ----------------------------- | ------------: | ---------: | ---------: | -----------: | --------: | --------: |
| `loadProjectFromFile(...)`    |     20.034 ms |  19.686 ms |     -1.74% |    20.619 ms | 20.287 ms |    -1.61% |
| `runGraphInFile(...)`         |     49.333 ms |  49.015 ms |     -0.64% |    52.186 ms | 53.051 ms |    +1.66% |
| loaded `runGraph(...)`        |     28.066 ms |  27.468 ms |     -2.13% |    29.334 ms | 28.392 ms |    -3.21% |
| fresh `createProcessor(...)`  |     27.636 ms |  26.921 ms |     -2.59% |    29.365 ms | 28.451 ms |    -3.11% |
| reused `createProcessor(...)` |     27.776 ms |  26.971 ms |     -2.90% |    29.397 ms | 27.884 ms |    -5.15% |

Treat this as a modest cleanup win, not a significant runtime breakthrough. The
result is below the 10% threshold used for fixture-speed claims. Further large
gains likely need a higher-cost compiled-code reuse strategy with strict
invalidation and state-isolation rules, or workflow-level consolidation of many
tiny helper nodes.

The same fixture was also used to check how Node heap limits affect fresh
`createProcessor(...).run()` latency. This was measured against the built Node
package on Windows with Node `v22.22.3`; each heap cap used 15 samples, 20
measured runs per sample, and 5 warmup runs per sample. The benchmark varied
only `--max-old-space-size` and loaded the fixture once before measuring fresh
processors:

| Node heap cap |      Mean |    Median |       p95 | Takeaway                                      |
| ------------: | --------: | --------: | --------: | --------------------------------------------- |
|         64 MB | 59.812 ms | 59.809 ms | 63.841 ms | Too low; GC pressure roughly doubles runtime. |
|         80 MB | 33.007 ms | 32.820 ms | 37.510 ms | Usable but still measurably slower.           |
|         96 MB | 31.358 ms | 31.230 ms | 35.149 ms | Near the normal plateau.                      |
|        128 MB | 30.751 ms | 30.253 ms | 35.815 ms | Safe practical floor for this fixture.        |
|        256 MB | 30.875 ms | 30.769 ms | 34.042 ms | No material speedup over 128 MB.              |
|        512 MB | 30.734 ms | 30.567 ms | 33.775 ms | No material speedup over 128 MB.              |
|       1024 MB | 30.806 ms | 30.498 ms | 34.601 ms | No material speedup over 128 MB.              |
|       2048 MB | 29.883 ms | 29.672 ms | 33.298 ms | Slight best run, within normal noise.         |
|       4096 MB | 30.756 ms | 30.631 ms | 33.277 ms | Baseline large heap.                          |

Treat Node heap size as a floor, not a latency tuning knob: this workload gets
hurt by very tight heaps, but it does not get meaningfully faster once the
process has roughly 96-128 MB of V8 heap. More physical RAM still matters when
the host would otherwise page, when many workflow processes run concurrently,
or when real workflows allocate much larger values than this fixture.

The fixture was also measured under Docker CPU quotas to approximate slower or
throttled compute. This run used `node:20-alpine`, fixed the Node heap at
512 MB, and used 15 samples with 10 measured runs per sample. Docker Desktop on
the measuring machine exposed only 3 CPUs to containers, so `--cpus=4` was not
available and the `unlimited` row means "up to Docker's configured 3 CPU
ceiling":

| Docker CPU quota |       Mean |     Median |        p95 | Takeaway                                                |
| ---------------: | ---------: | ---------: | ---------: | ------------------------------------------------------- |
|         0.25 CPU | 226.911 ms | 210.018 ms | 358.600 ms | Too throttled; latency is about 5.7x the unlimited row. |
|          0.5 CPU |  97.938 ms |  91.349 ms | 159.430 ms | Still heavily throttled; about 2.45x the unlimited row. |
|            1 CPU |  48.234 ms |  46.360 ms |  79.378 ms | Usable but still about 21% slower than unlimited.       |
|           2 CPUs |  44.555 ms |  43.570 ms |  52.182 ms | Near the local Docker ceiling, about 12% slower.        |
|           3 CPUs |  39.616 ms |  38.714 ms |  47.663 ms | Equivalent to the Docker ceiling within noise.          |
|        Unlimited |  39.922 ms |  38.680 ms |  49.116 ms | Baseline for this Docker setup.                         |

Treat CPU quota as a real latency knob for backend/container sizing. Unlike the
heap benchmark, the sub-1-CPU rows degrade sharply. Docker absolute timings are
not directly comparable to host timings because they include container,
filesystem, VM, and Node-version differences, but the relative shape is useful:
very small CPU shares hurt this workflow much more than modest heap changes.

`createGraphRunner(...)` is the production-facing reuse path for Node
integrations that load a stable project graph once and run it many times. It
resolves graph selection, registry/plugin setup, Node defaults, settings,
plugin env, tokenizer, code runner, and project-reference loading at creation.
Each `runner.run(...)` converts loose `inputs` and `context` values separately,
owns its own `abortSignal`, and uses a fresh run-scoped `GraphProcessor` so
Global node values and mutable node state do not leak between backend requests.
The runner does not expose an execution-mode selector; it stays on the standard
TypeScript runtime.

`createProcessor(...)` keeps the endpoint-style default policy for callers
that create a fresh processor, run it once, and discard it.
[`createProcessorRuntimePolicy.ts`](../packages/node/src/createProcessorRuntimePolicy.ts)
owns this internal split. Omitted `runtimeProfile` enables a run-scoped runtime
cache for root and subprocessor execution plans, the default cached Node
CodeRunner when no custom `codeRunner` is supplied, and the internal
`fast-acyclic` scheduler for eligible graphs. Unsupported graphs fall back
inside `GraphProcessor` to compatible scheduling for that graph. Remote Debugger
and trace-sensitive runs still force the compatible policy. The only documented
rollback profile is `runtimeProfile: 'compatible'`, which forces the fully
compatible path. Unknown profile strings from untyped JavaScript callers are
also treated as compatible. The fast scheduler follows the compatible path's
reverse-reachable start-node set with an iterative walk and ignores
stale/invalid target-port connections when unlocking downstream nodes, so deep
eligible graphs and stale graph-shape edge cases do not become observable just
because a faster scheduler is active.

There are two intentional runtime-observability paths:

| Path                                                                                                                       | Default policy                                                                                                                                                          | Why                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary headless endpoint-style execution (`createProcessor(...)` with no `runtimeProfile`, and eligible `runGraph(...)`) | Uses run-scoped execution-plan caching, the cached default CodeRunner when no custom runner is supplied, and the internal `fast-acyclic` scheduler for eligible graphs. | The public contract is final outputs, errors, callbacks, and normal processor events; this path has compatibility tests and fixture benchmarks.                                                              |
| Remote Debugger, trace-sensitive runs, CLI `serve --stream` / `--stream-node`, and explicit `runtimeProfile: 'compatible'` | Forces the compatible scheduler/policy.                                                                                                                                 | The execution order itself is user-visible: node start/finish/excluded ordering, trace text/SSE payload order, live running state, nested graph lifecycle ordering, and debugger timing can all be observed. |

Do not "simplify" this into one always-fast policy unless Remote Debugger,
trace, and CLI streaming runs first get their own golden lifecycle tests,
nested-subgraph coverage, abort/race coverage, manual debugger/manual SSE
validation, and benchmark evidence. Custom
`codeRunner` instances always win; the Node cached CodeRunner is only used when
no custom runner was supplied. Recording remains supported because the default
path still emits normal processor events. `runGraph(...)` intentionally ignores
any untyped `runtimeProfile` property and uses only the default-safe internal
policy selected by its own observable-run guards.

The fixture speedup pass made that scheduler/cache policy the default omitted
`createProcessor(...)` path only after compatibility characterization and
repeated benchmark runs. The saved artifacts were:

- `packages/node/bench-results/fixture-speedup-runtime-attribution-20260525.json`
- `packages/node/bench-results/fixture-speedup-direct-scheduler-20260525.json`
- `packages/node/bench-results/fixture-speedup-createprocessor-default-fast-20260525.json`

The full `createProcessor(...)` benchmark used 3 sessions, 15 samples per
session, 20 measured runs per sample, and 5 warmup runs per sample:

| Fixture row                                      |      Mean |    Median |       p95 | Note                                                                               |
| ------------------------------------------------ | --------: | --------: | --------: | ---------------------------------------------------------------------------------- |
| Fresh compatible rollback `createProcessor(...)` | 33.728 ms | 33.817 ms | 35.962 ms | Explicit `runtimeProfile: 'compatible'`.                                           |
| Fresh default `createProcessor(...)`             | 29.543 ms | 29.671 ms | 32.403 ms | Omitted profile; about 12.4% faster mean than compatible rollback.                 |
| Reused default `createProcessor(...)`            | 29.321 ms | 29.383 ms | 32.433 ms | Reuse is faster for this run, but backend endpoints usually construct per request. |

The default and compatible paths stayed equivalent in the compatibility
characterization suite, including callbacks and recorder events for covered
eligible graphs. Keep Remote Debugger and trace-sensitive runs on compatible
policy unless their observable ordering has separate coverage.

The omitted-default `createProcessor(...)` policy uses a graph boundary cache
for direct nested-graph callers. The core `GraphBoundaryCache` helper is used by
Subgraph, Referenced Graph Alias, and Loop Until definition paths plus
Subgraph/Referenced Graph Alias runtime input/output map construction. The cache
is keyed by graph object and cleared with the rest of the processor runtime
cache; it never stores final outputs. Processors with project references and
disabled loaded-project caching reset the boundary cache at run start, because
referenced project boundaries can be reloaded dynamically. Manually constructed
internal contexts can omit the resolver and nested-graph nodes will fall back to
uncached boundary derivation. Ordinary graphs without boundary-driven
nested-graph nodes keep the direct definition-loading path so simple workflows
do not pay a boundary-cache branch.

`captureNodeTimings` is an optional execution-metadata flag shared with core. It
adds `durationMs` and split-run `splitRunDurationMs` to `nodeFinish` / `nodeError` events without changing output
DataValues or project files. Headless `runGraph(...)` and ordinary
`createProcessor(...)` calls do not capture timings unless the caller passes the
flag. When `remoteDebugger` is supplied to Node `createProcessor(...)` or
`runGraph(...)`, the Node package defaults timing capture on so externally
triggered debugger runs can carry duration metadata to the app; passing
`captureNodeTimings: false` explicitly still wins. The app-executor overrides
missing internal run messages back to `false` so the editor's Node executor only
captures timings when the `Show node run durations` app setting asks for them.
Debugger processor attachments must forward this metadata on both successful
`nodeFinish` events and normalized `nodeError` payloads; do not rebuild error
messages in the debugger layer in a way that drops `durationMs` or split-run `splitRunDurationMs`.

Remote Debugger transport uses a display-safe serializer before writing websocket messages. The serializer prepares a structural-sharing display payload: JSON-safe branches are reused instead of cloned, while branches with explicit `undefined`, circular references, `BigInt`, functions, symbols, `NaN`, infinities, debugger sentinel-shaped user values, boxed primitive objects, throwing getters, or other unsafe values are replaced with display placeholders or cloned to preserve legacy display shape. Lifecycle events are still sent instead of being dropped. Runtime outputs, project YAML, and debugger wire message shape stay unchanged.

The transport benchmark lives at
[`packages/node/bench/debuggerTransport.bench.ts`](../packages/node/bench/debuggerTransport.bench.ts)
and runs with `yarn workspace @valerypopoff/rivet2-node run bench:debugger-transport`.
It asserts the new serializer's parsed websocket payload matches the old sanitize-then-stringify shape before timing either path. On the local Windows/Node 22.22.3 run that introduced the structural-sharing path:

| Case                            | Old ms/event | New ms/event | Speedup | Bytes/event |
| ------------------------------- | -----------: | -----------: | ------: | ----------: |
| nodeFinish nested object output |       0.1291 |       0.1308 |   0.99x |       31827 |
| graphFinish subgraph outputs    |       0.0604 |       0.0599 |   1.01x |       15161 |
| nodeStart fan-in inputs         |       0.1220 |       0.1139 |   1.07x |       27734 |
| non-json-safe expression output |       0.0051 |       0.0058 |   0.88x |         856 |

Large debugger outputs can still make Subgraph node `duration` exceed the sum of child node `durationMs`: the debugger must inspect and serialize values that it displays. The optimization trims clone allocation for common JSON-safe branches, but the measured serialization win is modest and it does not make Remote Debugger transport free.

Omitted-default promotion is guarded by
[`packages/node/test/defaultSafeCompatibility.test.ts`](../packages/node/test/defaultSafeCompatibility.test.ts).
That suite compares omitted default and explicit compatible one-shot
`createProcessor(...)` runs for final outputs, callback-visible events,
recorder events after serialization, partial-output callbacks, user-input
callbacks, global-set events, raised user events, Code/Expression errors,
aborts, trace fallback, Remote Debugger fallback, custom CodeRunner ownership,
custom `projectReferenceLoader` behavior, and concurrent runs over the same
project object. Dynamic graph-dispatch fixtures such as `Call Graph` and
`Referenced Graph Alias` also have output-equivalence guards that intentionally
do not pin independent root-node event order. Recorder parity is checked
against the serialized replay shape because JSON cannot preserve `undefined`
object properties. Subgraph node `duration` outputs are treated as
timing-dependent values, not exact compatibility values. Loaded-project
reference caching is deliberately not part of the default policy when a custom
`projectReferenceLoader` is present because it can reduce observable loader
call counts inside one run.

## `@valerypopoff/rivet-app` (`packages/app/`)

### Role

Desktop IDE frontend plus Tauri app packaging layer.

### Package metadata

- Version: `2.6.4`
- Private: yes

### Runtime shape

- React/Vite frontend under `src/`
- Tauri/Rust backend under `src-tauri/`

### Important responsibilities

- graph editor
- project workspace UX
- local and sidecar execution
- plugin loading/install UI
- prompt designer
- Trivet UI
- debugger/data/update overlays

### Important current boundaries

- downstream package source imports core through `@valerypopoff/rivet2-core`, not by reaching into `packages/core/src/...`; the shared root ESLint config enforces that boundary with `no-restricted-imports`
- app-only convenience helpers, such as type-safe object iteration, live in the app package; shared behavior that must match core runtime semantics is exported intentionally by core first
- hosted/wrapper applications that mount Rivet's editor from a vendored `rivet/` folder should import directly from local source paths such as `../rivet/packages/app/src/host` and `../rivet/packages/app/src/host.css`, then render `RivetAppHost` instead of rendering `RivetApp` directly; that host shell owns QueryClient, provider context, executor-session context, async storage bootstrap, optional post-app bridge children, lifecycle callbacks, host UI policy such as browser top-bar Menu visibility, a stable imperative workspace-host handle through `onWorkspaceHostReady` / `RivetWorkspaceHostBridge` / `useRivetWorkspaceHost`, optional hosted executor websocket configuration through `executor.internalExecutorUrl`, project-comparison helper re-exports for wrapper-owned compare UIs including node field diffs, and the shared host style entrypoint, including the Atlaskit reset that keeps canvas Markdown spacing consistent with standalone Rivet. The workspace-host handle also exposes `setProjectTabUiState(...)` and the `tabUi` open/replace option for transient wrapper-owned project-tab presentation such as preview tabs, `startOpeningProjectTab(...)` / `finishOpeningProjectTab(...)` / `cancelOpeningProjectTab(...)` for transient loading project tabs before a full snapshot is available, `updateProjectMetadata(...)` for externally owned project title/description changes on an already-open project, `markCurrentProjectClean(...)` / `markProjectClean(...)` for wrapper-owned save flows that need to re-seed Rivet's unsaved-changes baseline without reaching into app-internal dirty-state atoms or reloading the project, plus `startProjectCompare(...)` / `stopProjectCompare(...)` for wrapper-owned compare flows that need optional reference/current side labels such as `Published` / `Unpublished`. `setProjectTabUiState(projectId, { preview: true })` makes the upstream project tab render as a preview tab for the current editor session only; `{ preview: false }` clears it, closing the tab clears it automatically, and the state is never written to project YAML, project data, workspace storage, or wrapper metadata. `startOpeningProjectTab({ title, path }, { tabUi: { preview: true }, replaceCurrent: true })` creates only a loading tab and canvas placeholder; it does not create a project, dirty baseline, context state, or runnable/savable editor target. The tab itself shows only the title/preview/close affordances; the visible preloader belongs in the editor area and uses the same canvas background color setting plus Rivet's text-colored node-running circular indicator. `finishOpeningProjectTab(openingTabId, snapshot)` swaps in a real clean snapshot through the normal open path and returns `false` if the placeholder was already closed; `cancelOpeningProjectTab(openingTabId)` removes the placeholder without unsaved-change confirmation. Opening tabs count for hosted open-tab count callbacks, while callback `projectIds` still contains only real project ids. `updateProjectMetadata(..., { title }, { path, persistedExternally: true })` updates the active project metadata or inactive opened-project snapshot plus the tab title/path; when the project was already dirty, the external-persisted flag does not clear unrelated unsaved graph edits. Compare labels are transient UI state for the active compare session and are not project YAML or wrapper metadata. The style entrypoint also locks the document and Rivet app shell to the iframe viewport so modal scroll restoration cannot shift or clip the editor after fullscreen output modals close. Hosted shells must make both `Roboto` and `Roboto Mono` available, because Rivet's shared typography tokens default ordinary UI text to Roboto and explicit code/monospace surfaces to Roboto Mono.
- `RivetAppHost` provider overrides are the supported hosted integration layer for IO, datasets, env vars, storage, and path policy behavior; wrappers should inject those providers instead of aliasing private globals or Tauri modules
- `RivetAppHost` UI config is the supported wrapper layer for hiding top-level browser Menu items. Pass `ui={{ fileMenu: { visibleItems: [...] } }}` with stable `FileMenuItemId` values to filter the canonical dropdown order and labels, including the browser-only `Rivet settings` label for the stable `settings` command id and the `Help` item for the stable `get_help` command id. The public config key and item-id type retain the `fileMenu` name for compatibility even though the visible top-bar trigger is labeled `Menu`. This does not disable commands globally, and it does not rewrite the desktop/Tauri native application menu; `useMenuCommands` remains the command-behavior owner.
- execution transport/session ownership is centralized under `src/hooks/executorSession.ts`, `src/providers/ExecutorSessionContext.tsx`, and `src/hooks/useExecutorSessionCoordinator.ts`; `src/hooks/useExecutorSession.ts` is now only a compatibility/read-only state hook that exposes `useExecutorSessionState()` plus coordinator exports
- project/graph load-save-switch sequencing is centralized under `src/hooks/useWorkspaceTransitions.ts` and `src/utils/workspaceTransitions.ts`; per-open-project executor mode restoration is part of that transition layer and uses editor tab metadata rather than project serialization
- Remote Debugger endpoints used by hosted wrappers must allow multiple simultaneous websocket clients for the same URL/port. Rivet's editor keeps one executor-session runtime per open project tab and will open independent browser WebSocket objects for different projects even when the URL is identical; if the hosted endpoint enforces a single active client and closes the previous socket when a new tab connects, the older project tab will appear to detach even though the app-side registry is correctly project-scoped.
- remembered editor-view persistence is handled app-side through `src/state/projectEditor.ts`, `src/hooks/useSyncCurrentProjectEditorState.ts`, and `src/hooks/useRestorePersistedWorkspace.ts` rather than through project-file serialization
- platform-specific capabilities are split under `src/utils/platform/*`; the old `nativeApp.ts` barrel has been removed so desktop integrations import only the capability they actually use
- because the app's Vite dev/build path resolves `@valerypopoff/rivet2-core` to core source, browser-reachable provider dependencies that are imported by core Chat v2 code may also need visibility in `packages/app/package.json`; `@ai-sdk/openai-compatible` is intentionally listed in both core and app for that PnP/Vite source-resolution boundary
- the Tauri backend under `src-tauri/` also vendors the two small Tauri v1 plugin crates it depends on under `src-tauri/vendor/` to avoid current Cargo/git-workspace metadata breakage from the upstream plugins workspace template

### Branding assets

- The source UI mark is [`packages/app/src-tauri/icons/rivet-2-logo-no-background.svg`](../packages/app/src-tauri/icons/rivet-2-logo-no-background.svg). It is the Rivet shape with no underlay, and consumers should color the paths for their background. The app's dark welcome screen imports a white copy at [`packages/app/src/rivet-2-logo-no-background.svg`](../packages/app/src/rivet-2-logo-no-background.svg), the plugin catalog uses a white copy at [`packages/app/src/assets/vendor_logos/rivet-logo.svg`](../packages/app/src/assets/vendor_logos/rivet-logo.svg), and the docs navbar uses a black copy at [`packages/docs/static/img/logo.svg`](../packages/docs/static/img/logo.svg).
- The source icon mark is [`packages/app/src-tauri/icons/rivet-2-logo-background.svg`](../packages/app/src-tauri/icons/rivet-2-logo-background.svg). It includes the black square background and is the source for app icons, favicons, and other fixed icon surfaces.
- Desktop app and installer icons are generated assets under [`packages/app/src-tauri/icons/`](../packages/app/src-tauri/icons/) and are referenced from `tauri.conf.json` through the `tauri.bundle.icon` list. Keep the existing filenames when replacing them, including the Windows `Square*Logo.png` and `StoreLogo.png` assets. Generate them from a 1024x1024 PNG rendered from `rivet-2-logo-background.svg` with `yarn workspace @valerypopoff/rivet-app exec tauri icon <source-png> -o src-tauri/icons`.
- The web app public icons mirror the generated desktop icon set: [`packages/app/public/favicon.png`](../packages/app/public/favicon.png), [`packages/app/public/favicon.ico`](../packages/app/public/favicon.ico), [`packages/app/public/Square284x284Logo.png`](../packages/app/public/Square284x284Logo.png), [`packages/app/public/Square310x310Logo.png`](../packages/app/public/Square310x310Logo.png), and [`packages/app/public/rivet-icon-macos.png`](../packages/app/public/rivet-icon-macos.png). `packages/app/index.html` and `packages/app/public/manifest.json` read these by their checked-in filenames.
- The documentation site uses [`packages/docs/static/img/logo.svg`](../packages/docs/static/img/logo.svg), [`packages/docs/static/img/favicon.png`](../packages/docs/static/img/favicon.png), [`packages/docs/static/img/social-card.png`](../packages/docs/static/img/social-card.png), and [`packages/docs/static/img/logo-banner-wide.png`](../packages/docs/static/img/logo-banner-wide.png). Docusaurus reads these through `packages/docs/docusaurus.config.js`; the checked-in static images are the source of truth for social cards and banner images.
- Documentation logo assets use the black no-background mark by default. [`packages/docs/src/css/custom.css`](../packages/docs/src/css/custom.css) inverts `img/logo.svg` in dark mode so the logo is white on dark backgrounds without adding an underlay. The docs social-card and wide-banner PNGs use the white no-background mark on a black background.
- There is no single checked-in logo generator yet. When the Rivet 2 logo changes, update the colored SVG copies, regenerate the Tauri icon set from the background SVG, refresh the app public icons, and update the docs static images together so the desktop shell, installer, web app, and documentation site stay visually aligned.

### Desktop version metadata

The desktop app package version is the version developers should bump first.
Tauri still reads `packages/app/src-tauri/tauri.conf.json` `package.version`
when naming installer bundles, and the Rust package version is tracked in
`packages/app/src-tauri/Cargo.toml` / `Cargo.lock`. Those secondary files are
generated from `packages/app/package.json` by
[`scripts/sync-desktop-version.mjs`](../scripts/sync-desktop-version.mjs).
Run `yarn sync:desktop-version` after bumping the app package version if you
want the generated metadata checked in. The release workflows and Tauri
`prepare:tauri` path also run the sync automatically before building, so stale
Tauri metadata cannot publish mis-versioned Windows filenames.

## `@valerypopoff/rivet-app-executor` (`packages/app-executor/`)

### Role

Node sidecar process used by the desktop app for Node-capable execution.

### Package metadata

- Version: `2.0.4`
- Bin: `./bin/executor-bundle.cjs`

### Main behavior

The sidecar:

- starts a debugger/WebSocket server
- binds to `127.0.0.1:21889` by default for the desktop internal sidecar, but accepts `--host <host>` / `RIVET_EXECUTOR_HOST` and `--port` / `RIVET_EXECUTOR_PORT` for hosted wrappers that need to expose the executor server from a container; custom ports must be valid TCP ports from `1` to `65535`
- accepts uploaded project/settings/static-data state
- uses `assembleRegistry()` from core's `RegistryAssembly.ts` to build a fresh registry for each graph run
- dynamically imports plugins through `importPluginInitializer()`, which handles CJS/ESM default-export interop
- runs graphs dynamically using `rivet-node` APIs
- injects a sidecar-only worker-backed `CodeRunner` so most Code-family JavaScript runs in a fresh Node worker thread instead of blocking unrelated node completion events on the sidecar's main event loop
- bridges permitted Code-family `console.*` calls from the worker/current-thread fallback into `codeConsole` WebSocket messages so the app can replay them in the renderer console for the active editor run
- supports preload, pause, resume, abort, and user-input messages
- supports editor run-from execution by accepting startup `preloadData` in the same `run` message as explicit `runToNodeIds`; the sidecar applies that preload after creating the processor and before calling `run()`

When several app tabs connect to the same sidecar, the sidecar tracks which
websocket client created each `GraphProcessor`. Processor lifecycle broadcasts
and `codeConsole` messages are sent only back to that originating client, and
client control messages such as abort, pause, resume, and user input are routed
only to processors started by that same client. Control messages also carry the
active remote run request id when the app knows it, and `startDebuggerServer`
filters the client's processors to that matching request before invoking the
control method. This protects overlapping runs that share one client or URL,
while preserving legacy unscoped controls for clients/processors without request
ids. This lets multiple Node-mode project tabs share one sidecar URL/port
without one tab stealing another tab's terminal events or controls. Uploaded
project/settings/static-data state and dataset proxying follow the same client
boundary: the app-executor sidecar keeps debugger state and a
`DebuggerDatasetProvider` per websocket client, so one open project tab cannot
overwrite another tab's uploaded project or consume another tab's dataset
request/response ids. Editor execution caches are scoped by websocket client and
project id for the same reason: two tabs with the same project id but different
unsaved editor state must not share cached node execution helpers through the
process-wide sidecar. The sidecar passes `createProcessor(...)` a client-scoped
debugger wrapper, so processor ownership is registered at debugger attach time
rather than after processor construction; controls sent during run startup must
still see the processor as owned by the originating websocket.

The worker-backed runner is scoped to the app executor. `@valerypopoff/rivet2-node`
compatible-profile `createProcessor(...)` callers still use `NodeCodeRunner` by
default unless they pass a custom `codeRunner`; omitted-default
`createProcessor(...)` and eligible `runGraph(...)` calls can use the run-scoped
cached Node CodeRunner when no custom runner is supplied. Code-family nodes that
request the `Rivet` capability fall back to current-thread execution inside the
sidecar for compatibility.

For ordinary Code (legacy), Code, and Expression node execution, the app executor
keeps a small pool of prewarmed single-use workers. Each run still consumes a
fresh worker and terminates it after the result so `globalThis` state and
`require()` module cache do not leak between runs, but worker startup is moved
out of the hot path for the next run. The default pool size is `2`;
hosted/runtime environments can set `RIVET_CODE_RUNNER_WORKER_POOL_SIZE` to tune
it or set it to `0` to disable prewarming.

The shared pool is created lazily by the code runner module, while the
app-executor sidecar explicitly prewarms it during startup before announcing the
executor websocket. Idle workers are unrefed and guarded with error/exit cleanup
so an unexpected idle-worker failure is removed from the pool and replenished
without turning into a top-level sidecar error.

The worker runner has three ownership layers. [`AppExecutorWorkerCodeRunner.mts`](../packages/app-executor/bin/AppExecutorWorkerCodeRunner.mts)
is the `CodeRunner` orchestration layer: it prepares hosted runtime libraries,
chooses worker execution versus the `includeRivet` current-thread fallback, and
keeps the sidecar console bridge for fallback runs. [`codeRunnerWorkerPool.mts`](../packages/app-executor/bin/codeRunnerWorkerPool.mts)
owns pool size configuration, shared prewarm/shutdown lifecycle, idle-worker
checkout, replenishment, stats, and cleanup. [`codeRunnerWorkerHost.mts`](../packages/app-executor/bin/codeRunnerWorkerHost.mts)
owns the string-evaluated worker source, worker creation, ready/result message
handling, worker-exit errors, worker-side console forwarding, and error
deserialization. Keep the worker source string close to worker creation unless
the desktop package pipeline is verified on every supported platform; ordinary
Code-family runs still consume one fresh worker and terminate it after the
result.

Code-family `require()` resolution is intentionally configurable for hosted runtimes.
Both public `NodeCodeRunner` and the app-executor worker runner honor
`RIVET_CODE_RUNNER_REQUIRE_ROOT` and `RIVET_CODE_RUNNER_REQUIRE_ANCHOR`. By
default they resolve modules from the process working directory through the
synthetic `__rivet_node_code_runner__.cjs` anchor. Hosted wrappers can point the
root at a runtime-library directory instead of patching Rivet source.
Before a require-enabled or Rivet-capable Code-family node runs, the app-executor
worker runner also calls an optional global
`__RIVET_PREPARE_RUNTIME_LIBRARIES__(true)` hook when a hosted bootstrap layer
provides one. That keeps managed runtime-library sync outside Rivet core while
still giving hosted executors a stable "prepare, then resolve" seam.

### Build model

The executor source is ESM (`.mts`) but is bundled to CJS (`executor-bundle.cjs`) by esbuild so that `pkg` can statically analyze it for native binary compilation. A custom esbuild plugin inlines `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` from their workspace source entrypoints instead of going through built package exports. That source mapping is part of the desktop Node-executor contract: rebuilding the sidecar during `yarn dev` must pick up current core/node execution changes even when package `dist` folders are stale.

### Architectural significance

This package is effectively the app's Node execution backend. It shares the same `assembleRegistry()` helper as the app for registry construction, keeping plugin/runtime assembly logic in one place.
It is paired with the app-side shared executor session rather than being managed independently by each remote execution hook consumer.

## `@valerypopoff/rivet2-cli` (`packages/cli/`)

### Role

Operational CLI for running or serving Rivet graphs.

### Package metadata

- Version: `2.0.11`
- Source entry: `src/cli.ts`
- Published bin mapping: `rivet -> bin/cli.js`
- Types: `dist/types/cli.d.ts`
- TypeScript build input: `src/` only; `bin/` is generated output

### Commands

Current command families:

- `run <projectFile> [graphName]`
- `serve [projectFile]`

### `run` command behavior

Implemented in `src/commands/run.ts`.

Supports:

- graph selection by name/ID
- stdin JSON object inputs through `--inputs-stdin`
- repeated `--input key=value`
- repeated `--context key=value`
- optional cost suppression

Internally:

- resolves the project file
- loads the project through `rivet-node`
- parses command input through `src/commandInputs.ts`, which rejects non-object JSON, allows empty string values, and preserves `=` characters inside values
- builds a processor
- runs it
- prints JSON outputs

### `serve` command behavior

Implemented in `src/commands/serve.ts`.

Supports:

- Hono-based HTTP serving
- optional dev reload mode
- optional graph selection
- optional graph-by-path routing
- optional SSE streaming
- optional single-node streaming
- OpenAI-related option overrides

Architecturally, it is a thin HTTP wrapper around `rivet-node` processor creation and streaming helpers. Request bodies are parsed through the same object-input helper as `run`, so empty bodies become `{}` and arrays/primitives are rejected before execution. Project-file lookup resolves relative paths to absolute paths, handles directory inputs, and uses platform path helpers for suggestions so Windows paths do not get split with POSIX-only separators. Graph validation also checks that a stored main graph ID actually exists before the server starts. Non-streaming `run` and `serve` requests use the default omitted-profile Node runtime policy, so eligible headless runs get the automatic fast scheduler/cache path. `serve --stream` and `serve --stream-node` explicitly pass `runtimeProfile: 'compatible'` because those modes expose node lifecycle events over SSE, making scheduler ordering part of the client-visible contract.

### Docker image behavior

The CLI Docker image entrypoint runs the globally installed `rivet` binary as `rivet serve /project`, so project files should be mounted at `/project` and the container does not need `npx` or package resolution at runtime. `docker-publish.sh` reads the package version from `packages/cli/package.json`, passes it into the Dockerfile as `RIVET_CLI_VERSION`, and tags both amd64 and arm64 images with that same version. Do not hardcode a separate package version in the Dockerfile.

## `@valerypopoff/trivet` (`packages/trivet/`)

### Role

Graph-oriented testing package.

### Package metadata

- Version: `2.0.11`
- Main: `dist/cjs/bundle.cjs`
- Module: `dist/esm/index.js`
- Types: `dist/types/index.d.ts`

### What it contains

- test-suite/test-case/result types
- Trivet serialization
- `runTrivet(...)`
- `createTestGraphRunner(...)`
- validation helpers

### Runtime model

Trivet runs:

1. a test graph with case inputs
2. a validation graph against input/expected/output objects
3. boolean/truthy validation outputs to determine pass/fail

The app integrates this package directly for test UI and persistence.

`createTestGraphRunner(...)` also resolves runtime settings through core's shared `resolveProcessSettings(...)` helper, so Trivet inherits the same minimal runtime defaults as app and Node execution rather than carrying a separate settings shape.

## `packages/docs/`

### Role

Docusaurus documentation site package.

### Package metadata

- Version: `2.0.0`
- Private: yes

### Script surface

- `yarn start`
- `yarn build`
- `yarn serve`
- `yarn typecheck`
- standard Docusaurus maintenance commands

### Publish model

Docs publishing is handled by the GitHub Pages release workflows. The docs
package owns local Docusaurus commands such as `yarn build`, `yarn serve`, and
`yarn deploy`, but normal release publishing does not use a root publishing
script.

### Current content contract

The docs package is not an archival copy of the pre-fork Rivet docs. It should
describe the current Rivet 2 surface:

- User Guide pages, especially `docs/introduction.md`, are for normal desktop-app users first; the introduction should position Rivet as a visual low-code tool for AI and non-AI workflows, quick experiments, production workflows, and the optional self-hosted web-app form through Rivet Studio Server, while runtime package, CLI, source-checkout, and wrapper embedding details belong in API Reference pages instead of the User Guide introduction
- Tutorial pages must use current app-facing labels rather than old internal names. In particular, the old `Splitting` tutorial URL is kept for link stability, but the visible tutorial is `Running Many Items` and should describe the current node run-mode control: `Run once`, `Many parallel runs`, and `Many sequential runs`
- Tutorial pages for YAML and Subgraphs should stay as practical desktop-app walkthroughs, not placeholders. They should explain the current Extract YAML / To YAML and Graph Input / Graph Output / Subgraph node flows before sending readers to the node reference
- API Reference pages under both core and node are source-backed reference pages, not empty stubs. Keep `GraphProcessor`, `DataValue`, `NodeGraph`, `Project`, `Settings`, `DebuggerEvents`, `LooseDataValue`, `RivetDebuggerServer`, and `RunGraphOptions` aligned with the current TypeScript definitions
- public packages under `@valerypopoff`: `rivet2-core`, `rivet2-node`, `trivet`, and `rivet2-cli`
- app package names and root workspace scripts from the current manifests
- LLM Chat as the recommended chat node for new graphs, with legacy Chat called out as legacy
- Getting Started, User Guide, and Node Reference pages should teach `LLM Chat` as the default chat node for new workflows. Legacy `Chat` examples are acceptable only when the page is explicitly documenting old project/tutorial content or the legacy node itself
- Node Reference must keep one checked-in page for every built-in node type exposed by `createBuiltInRegistry()`. The app's node-settings footer links use [`packages/app/src/utils/nodeDocumentation.ts`](../packages/app/src/utils/nodeDocumentation.ts), so when adding, renaming, or removing a built-in node, update that mapping, the corresponding `packages/docs/docs/node-reference/*.mdx` page, `all-nodes.mdx`, and `sidebars.js` together.
- User-facing docs should use `Running Many Items`, `Run once`, `Many parallel runs`, and `Many sequential runs` for node run modes. The old `Splitting` URL may remain for link stability, but new prose should avoid presenting "Split node" as the current UI label
- User-facing docs should say `workflow` / `Executing Workflows` for current graph execution concepts. The old `executing-ai-chains` URL may remain for link stability, but visible labels and prose should not present "AI chains" as the current product language
- Browser, Node, and remote executor behavior, including hosted/internal executor URL seams
- app-level plugin installation, derived project plugin YAML, missing-plugin install prompts, and read-only project-used plugin settings
- Code-family runtime permissions, Node-only `require` / `process`, and configurable require-root behavior
- HTTP Call and LLM Chat retry/status/error output contracts
- keep provider-neutral Chat v2 output assembly in `chatV2Outputs.ts` and pipeline orchestration in `chatV2Pipeline.ts` instead of adding output-shape policy back to node classes or provider adapters
- wrapper/source-checkout guidance pointing to app host seams and generated built-package artifacts rather than stale npm names
- GitHub Pages docs deployment at `/rivet2.0/`, with Docusaurus docs at the site root and a top-right `/download` page that reads stable Windows/macOS release metadata generated by the main-branch workflow plus developer Windows/macOS release metadata generated by the develop-branch workflow
- `packages/docs/docusaurus.config.js` intentionally disables the Docusaurus pages plugin (`pages: false`). The published site root is the docs plugin's introduction page, not a custom `src/pages/index.tsx` landing page. Do not add a second landing shell unless the pages plugin is intentionally re-enabled and this contract is updated.
- Docusaurus footer and header links should stay limited to current Rivet 2 surfaces; do not re-add the old Community/Discord section, legacy YouTube link, or old embedded demo/testimonial sections unless those destinations become current Rivet 2 support surfaces
- Release-download actions should route to the site's `/download` page rather than direct GitHub release asset URLs, because the docs page owns the current stable/developer release channel presentation
- article typography is tuned globally in `packages/docs/src/css/custom.css`; keep body text that follows a heading visually close to that heading while preserving the larger default gap between adjacent headings

When those implementation contracts change, update `packages/docs/docs/` and
this developer-doc package reference together.

## `scripts/publish-npm-packages.mjs`

Although not itself a package, this root script is part of the operational package story.

Current behavior:

- refuses to run on a dirty git tree unless `--skip-clean-check` is passed
- verifies the public package names and lockstep package versions
- rejects non-semver versions and versions outside major `2`
- validates built outputs for `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, `@valerypopoff/trivet`, and `@valerypopoff/rivet2-cli`
- stages clean npm package directories from built artifacts
- rewrites internal `workspace:^` dependencies to the same public `^2.x` package version
- skips package versions that already exist on npm
- publishes only core, node, Trivet, and cli under the `@valerypopoff` scope

The lockstep version check reads the package manifests directly. For a
main-branch npm release, update all four public package versions together:
`packages/core/package.json`, `packages/node/package.json`,
`packages/trivet/package.json`, and `packages/cli/package.json`. The desktop
app version in `packages/app/package.json` is separate and drives Windows
installer filenames, not npm package publishing.

It does not publish the app, the app executor, or Docker images. The main-branch
npm workflow is the canonical automation path for this script. That workflow
verifies a clean checkout before installing dependencies, then verifies after
the build that only Yarn install artifacts and generated publish artifacts
changed. It then verifies the repository `NPM_TOKEN` secret with `npm whoami`
before publishing. It calls this script with `--skip-clean-check` so ignored
`.pnp.cjs`, `.pnp.loader.mjs`, `.yarn/cache`, `packages/core/dist`,
`packages/node/dist`, `packages/trivet/dist`, `packages/cli/dist`,
`packages/cli/bin`, and `packages/cli/tsconfig.tsbuildinfo` outputs do not
block publishing.

## `scripts/create-built-package-artifacts.mjs`

Although not itself a package, this script is the wrapper-facing artifact
contract for exact-checkout builds. It validates already-built outputs and
stages package-manager-neutral artifacts under `.rivet-built-packages` by
default.

Supported targets:

- `--target runtime`: `rivet2-core` + `rivet2-node`; this is the default.
- `--target hosted-web-deps`: `rivet2-core` + Trivet.
- `--target executor-runtime`: `rivet2-core` + `rivet2-node` + app-executor.
- `--target wrapper`: all wrapper-facing artifacts.
- `--include core,node,trivet,app-executor`: custom artifact set.

For package artifacts, workspace dependencies are rewritten to local `file:`
dependencies inside the staged artifact set. Custom `--include` sets
automatically add required local artifacts, so selecting `node` or `trivet`
also stages `core`. For app-executor, the script copies
`bin/executor-bundle.cjs` and the generated `dist/` sidecar artifacts, but not
build metadata such as TypeScript build-info files.

Every run writes `rivet-build-artifacts.json` with schema version, generation
time, target, resolved Rivet revision, source ref, and artifact paths. CI jobs
that bootstrap Rivet without `.git` should set `RIVET_SOURCE_REVISION=<sha>` or
pass `--revision <sha>` so artifact caches are keyed to the exact upstream
commit. Set `RIVET_SOURCE_REF=<branch-or-tag>` when the manifest should also
record the configured source ref.

The script intentionally does not build workspaces itself; callers should run
the matching root build target first. This keeps Dockerfiles explicit about
which build layers are expensive and cacheable.

## Package-Level Refactor Guidance

- Treat `core` as the compatibility center of gravity.
- Treat `node` as the Node-default runtime adapter, not just a re-export package.
- Treat `app-executor` as a runtime package, not a build artifact.
- Treat `cli` as an operational wrapper around `rivet-node` rather than an independent execution engine.
- Treat `trivet` as both a test runner and a persistence format owner for test data.
