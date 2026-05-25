# Wrapper ManagedCodeRunner Speed Plan

Status: HANDOFF PLAN FOR WRAPPER IMPLEMENTATION

## Purpose

This document explains why recent Rivet-side CodeRunner optimizations did not
materially speed up production workflow endpoint runs, and what the wrapper
developer should implement next.

The target runtime is the usual headless backend path:

- plain Node.js API container;
- workflow endpoint execution through `createProcessor(...)`;
- no Remote Debugger;
- no opt-in runtime mode;
- no project YAML change;
- no change to workflow outputs, recordings, or public endpoint behavior.

The implementation belongs in the wrapper repo, primarily under:

```text
F:\Programming\Self-hosted-rivet\wrapper\api\src\routes\workflows\execution.ts
F:\Programming\Self-hosted-rivet\wrapper\api\src\runtime-libraries\managed-code-runner.ts
F:\Programming\Self-hosted-rivet\wrapper\api\src\runtime-libraries\backend.ts
F:\Programming\Self-hosted-rivet\wrapper\api\src\runtime-libraries\managed\backend.ts
```

## Handoff Deliverables

The wrapper implementation should produce these concrete outputs:

1. A baseline benchmark report before code changes.
2. Request-scoped CodeRunner telemetry proving where time is spent.
3. A fast path for code-like nodes that do not request `require(...)`.
4. Lazy once-per-request runtime-library preparation for nodes that do request
   `require(...)`.
5. A bounded compiled-function cache with tests proving fresh request data is
   still passed on every call.
6. A before/after benchmark report using the same fixture, same machine, same
   Node version, same API mode, and same endpoint route.
7. Wrapper developer docs describing the new telemetry and runtime-library
   snapshot behavior.
8. A fixture sanity check proving the benchmark does not depend on live
   external HTTP, LLM, or secret-bearing services.

Do not treat direct Rivet package benchmarks as acceptance for this plan. They
are useful diagnostics, but the production path being optimized is the wrapper
endpoint path that calls `createProcessor(...)` with `ManagedCodeRunner`.

## Root Cause

The wrapper uses `createProcessor(...)`, which is the right high-level API for
endpoint workflow execution because it needs `processor.processor` before
`run()` so `ExecutionRecorder.record(...)` can attach before execution starts.

However, endpoint execution always passes a custom CodeRunner:

```ts
const processor = createProcessor(project, {
  codeRunner: new ManagedCodeRunner(getRootPath()) as any,
  projectPath: projectVirtualPath,
  datasetProvider,
  projectReferenceLoader,
  remoteDebugger,
  context: getWorkflowExecutionContext(req),
  inputs: {
    input: {
      type: 'any',
      value: getWorkflowRequestInput(req),
    },
  },
});
```

That is necessary for Code nodes that use wrapper-managed runtime libraries via
`require(...)`, but it also means Rivet's default cached Node CodeRunner is not
used. Rivet-side optimizations in the default CodeRunner therefore do not help
this production wrapper path.

The current `ManagedCodeRunner` also does conservative per-node work:

```ts
async runCode(...) {
  await prepareRuntimeLibrariesForExecution();
  ...
  const AsyncFunction = async function () {}.constructor as new (...args: string[]) => Function;
  const codeFunction = new AsyncFunction(...argNames);
  const outputs = await codeFunction(...args);
  return outputs;
}
```

This means every Expression, Code New, and Code node currently pays for:

- runtime-library preparation, even when `includeRequire=false`;
- argument-list construction;
- fresh `AsyncFunction` compilation;
- execution in the API Node process.

In managed runtime-library mode, `prepareRuntimeLibrariesForExecution()` reaches:

```text
ManagedRuntimeLibrariesBackend.prepareForExecution()
  -> initialize()
  -> syncForLocalUse(true)
```

The `force=true` sync bypasses the local cache poll-interval shortcut. For plain
Expression or Code New nodes that do not use `require(...)`, this is unnecessary
hot-path work.

In filesystem runtime-library mode, preparation may already be cheap or a no-op.
The same plan still matters there because fresh `AsyncFunction` compilation can
remain expensive, but benchmark managed and filesystem modes separately when
comparing results.

## Constraints

- Keep `createProcessor(...)`; do not switch to `runGraph(...)` because
  recording must attach before execution starts.
- Keep support for wrapper-managed runtime libraries.
- Keep endpoint output shapes, errors, recordings, and debugger compatibility
  stable.
- Keep one workflow run bound to a stable runtime-library snapshot.
- Package installs/removals may affect the next workflow request after refresh;
  they do not need to affect an already-running workflow.
- Do not introduce an opt-in mode. The default endpoint path should become
  faster.
- Do not rely on security through the compiled-function cache. The existing
  runner already executes user code in-process via `AsyncFunction`.
- Do not cache request values, provider objects, inputs, context, graph inputs,
  `require`, `Rivet`, or other mutable per-run objects. Cache compiled functions
  only.
- Do not let benchmark fixtures or committed test data contain real tokens,
  real proxy-auth headers, or production-only service endpoints.

## Intended Design

Keep `ManagedCodeRunner`, but split its behavior internally:

1. Fast plain-JS path
   - Used when `includeRequire=false`.
   - Does not call `prepareRuntimeLibrariesForExecution()`.
   - Can still expose `console`, `fetch`, `process`, `Rivet`, `graphInputs`, and
     `context` according to Rivet's CodeRunner options.
   - Uses a bounded compiled-function cache.

2. Managed package path
   - Used when `includeRequire=true`.
   - Prepares runtime libraries lazily.
   - Prepares at most once per workflow request.
   - Uses a managed `require` function tied to the active runtime-library
     snapshot.
   - Also uses the compiled-function cache, passing fresh `require`, `inputs`,
     `graphInputs`, and `context` on every invocation.

3. Future release-aware require optimization
   - Cache `createRequire(...)` by active runtime-library release when release
     identity is available.
   - Invalidate cached require state when the active release changes.
   - Either clear relevant `require.cache` entries on release switch or use
     release-specific physical paths so Node naturally resolves different
     package versions to different filenames.

Implement and validate phases P1-P3 before doing the release-aware `require`
optimization. P4 touches package activation semantics and should not block the
plain-JS speedup.

## Fixture Benchmark Setup

Use the fixture:

```text
.\.fixtures\graph-fixture.rivet-project
```

The user will pass this file to the wrapper developer. It is a large
representative workflow with external HTTP calls mocked out. It requires no
request inputs; run it with an empty JSON body:

```json
{}
```

Recommended wrapper setup:

1. Import or copy `graph-fixture.rivet-project` into the wrapper workflow
   storage using the same path a normal project uses.
2. Publish it through the existing wrapper UI/API as a normal workflow endpoint.
   Use a stable endpoint name such as `graph-fixture-speed`.
3. Prefer the published endpoint route for the benchmark:
   `POST /workflows/graph-fixture-speed`.
4. If latest/live mode is also measured, keep Remote Debugger disabled. This
   plan is for ordinary headless endpoint execution.
5. Confirm one manual request returns HTTP 200 and a stable output before
   collecting timings.

Before committing or sharing the fixture, inspect it for static credentials,
proxy-auth headers, bearer tokens, production hostnames, and other sensitive
values. Replace them with harmless placeholders unless they are intentionally
fake. A speed fixture should be safe to keep in the repo.

Before using the fixture as a benchmark, confirm the run does not perform real
external HTTP or LLM calls. If it does, the benchmark is measuring network and
provider latency instead of wrapper CodeRunner overhead. Either mock those
paths, disable them in the fixture, or use a smaller synthetic fixture for the
CodeRunner-specific benchmark.

In filesystem storage mode, the workflow root is controlled by
`RIVET_WORKFLOWS_ROOT`, and the storage mode by `RIVET_STORAGE_MODE=filesystem`.
In managed storage mode, import/publish the fixture through the managed project
path used in production. Do not edit the fixture itself just to add endpoint
metadata; use the wrapper's normal publication metadata.

Run the measurement script from the wrapper checkout:

```bash
npm --prefix wrapper/api run workflow-execution:measure -- \
  --base-url http://localhost:8080 \
  --endpoint graph-fixture-speed \
  --kind published \
  --runs 50 \
  --warmups 10 \
  --body '{}'
```

If the endpoint requires a workflow bearer token, add:

```bash
--bearer <token>
```

Run the API process with:

```text
RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true
RIVET_CODE_RUNNER_TELEMETRY=true
```

`RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true` already exposes:

```text
x-duration-ms
x-workflow-resolve-ms
x-workflow-materialize-ms
x-workflow-execute-ms
x-workflow-cache
```

The implementation in this plan should add CodeRunner telemetry as headers
and/or structured logs behind `RIVET_CODE_RUNNER_TELEMETRY=true`.

For this fixture, use `x-workflow-execute-ms` as the primary runtime metric. It
measures `processor.run()` and excludes HTTP response JSON serialization. Also
keep total client duration so regressions outside `processor.run()` are visible.

If the measurement script is not updated to print the new CodeRunner telemetry
headers, capture them manually or extend the script before taking the final
before/after report. Otherwise the benchmark will show that execution changed
without proving which CodeRunner stage changed.

## Implementation Phases

### P0: Add Baseline Wrapper Telemetry

Before changing behavior, add request-scoped timing around `ManagedCodeRunner`.

Capture at least:

- `runCode` calls;
- calls by permission:
  - `includeRequire`;
  - `includeRivet`;
  - `includeFetch`;
  - `includeProcess`;
  - `includeConsole`;
- runtime-library prepare count and time;
- compile count and time;
- execution time;
- compiled-function cache hit/miss once the cache exists.

Recommended implementation shape:

- Keep `ManagedCodeRunner` request-scoped at first.
- Add an optional request-scoped stats object or callback to its constructor.
- Expose aggregate metrics only behind an env flag, for example
  `RIVET_CODE_RUNNER_TELEMETRY=true`.
- Prefer structured logs for detailed stats.
- Optional debug headers can expose small aggregates when
  `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`.
- Emit the aggregate telemetry on both successful and failed endpoint runs when
  debug headers/logging are enabled. Failures are part of the endpoint contract,
  and compile/runtime errors are especially useful for validating cache safety.

Suggested debug headers:

```text
x-code-runner-calls
x-code-runner-require-calls
x-code-runner-compile-ms
x-code-runner-execute-ms
x-code-runner-prepare-ms
x-code-runner-cache-hits
x-code-runner-cache-misses
x-code-runner-cache
```

Keep headers coarse; detailed per-node data belongs in logs.

Baseline artifact to save before changing behavior:

```text
wrapper commit:
vendored Rivet commit:
Node version:
storage mode:
API CPU/RAM limits:
endpoint:
runs/warmups:
mean x-workflow-execute-ms:
p95 x-workflow-execute-ms:
mean x-duration-ms:
p95 x-duration-ms:
mean x-code-runner-prepare-ms:
mean x-code-runner-compile-ms:
mean x-code-runner-execute-ms:
code-runner calls per request:
includeRequire calls per request:
```

If telemetry shows this fixture spends little time in `ManagedCodeRunner`, stop
and reassess. Do not add caching complexity unless the timing data points here.

### P1: Skip Runtime-Library Prepare For Plain JS

Change `ManagedCodeRunner.runCode(...)` so it only prepares runtime libraries
when `options.includeRequire === true`.

Trust the Rivet CodeRunner options as the boundary. The wrapper should not infer
managed package needs from node type or source text. If upstream maps a node's
permissions into `includeRequire=false`, that node cannot use managed
`require(...)` and should stay on the plain-JS path.

Expected behavior:

- `includeRequire=true`: prepare runtime libraries before running the code.
- `includeRequire=false`: do not prepare runtime libraries.
- `includeRivet=true`: no runtime-library prepare by itself. It imports the
  wrapper-linked `@valerypopoff/rivet2-node`, not managed user packages.
- `includeFetch`, `includeProcess`, and `includeConsole`: no runtime-library
  prepare by themselves.

This is the lowest-risk and most likely immediate win because Expression nodes
and many Code New nodes are plain JS.

Suggested implementation shape:

```ts
const needsManagedRuntimeLibraries = options.includeRequire === true;
if (needsManagedRuntimeLibraries) {
  await this.prepareRuntimeLibrariesForRequire();
}
```

Keep the rest of the invocation semantics unchanged. The only behavior change
should be skipping managed package preparation when the node cannot use managed
packages anyway.

### P2: Make Require Preparation Lazy Once Per Request

Keep `ManagedCodeRunner` request-scoped and store a private prepare promise:

```ts
private prepareForRequirePromise: Promise<void> | null = null;
```

When `includeRequire=true`, use:

```ts
this.prepareForRequirePromise ??= prepareRuntimeLibrariesForExecution();
await this.prepareForRequirePromise;
```

This preserves compatibility while avoiding repeated forced sync work inside one
workflow run.

If the runtime-library backend can safely expose a non-forced hot-path check,
consider adding:

```ts
prepareRuntimeLibrariesForExecution({ force?: boolean })
```

Then use forced preparation for startup, activation, and explicit refresh, but
use non-forced preparation on endpoint hot paths.

Do this only with tests that prove package activation still becomes visible on
the next workflow execution.

Add an independent temporary rollback flag for this phase, for example:

```text
RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true
```

This is separate from disabling the compiled-function cache. It allows
production rollback of lazy preparation without throwing away cache telemetry.

### P3: Add A Bounded Compiled-Function Cache

Add a process-level or module-level LRU cache for successful `AsyncFunction`
compilations.

Cache key:

- exact generated code string;
- argument-name shape and order:
  - `inputs`;
  - `console`;
  - `require`;
  - `process`;
  - `fetch`;
  - `Rivet`;
  - `graphInputs`;
  - `context`.

The key must represent the exact function-constructor shape. Include the
presence and order of optional arguments rather than only broad permission
booleans.

Do not include request values in the key. Fresh `inputs`, `graphInputs`, and
`context` must be passed to the cached function every invocation.

Prefer not to cache syntax errors at first. Cache successful compilations only.

The compiled function cache does not need to include active runtime-library
release id if managed `require` is passed as an argument. Add release id only if
future wrapper-generated source or helper injection starts depending on release
state.

Use a bounded size, for example 1,000 entries, and expose a test-only reset
helper.

Minimum cache entry shape:

```ts
type CompiledCodeCacheEntry = {
  fn: Function;
  lastUsedAt: number;
};
```

Minimum cache key shape:

```ts
const key = JSON.stringify({
  code,
  args: argNames,
});
```

This is intentionally conservative. The generated code string and ordered
argument names fully describe the compiled function body. Request values,
`inputs`, `graphInputs`, `context`, and `require` must stay outside the cache
and be supplied as invocation arguments.

Use deterministic LRU behavior, preferably a monotonic usage counter instead of
wall-clock time. Avoid mutating cache entries across `await` boundaries; cache
lookup, insert, and eviction should be synchronous bookkeeping around function
compilation.

### P4: Defer Cache Managed Require By Runtime-Library Snapshot

For `includeRequire=true`, `createManagedRequire()` currently does filesystem
work and constructs a new require function:

```ts
const nodeModulesPath = currentNodeModulesPath();
if (nodeModulesPath && fs.existsSync(nodeModulesPath)) {
  const virtualEntry = path.join(nodeModulesPath, '__virtual.cjs');
  return createRequire(virtualEntry);
}
return createRequire(import.meta.url);
```

After P1-P3 are stable, make this release-aware:

- expose active runtime-library release id or active path from the runtime
  library backend;
- bind each workflow run to that snapshot;
- cache the require function for that snapshot;
- invalidate the cache when active release changes.

Be careful with Node's CommonJS `require.cache`. If package versions can change
behind a stable `current/node_modules/...` path, Node may keep old modules in
memory. Prefer release-specific physical paths or explicitly clear relevant
cache entries on release activation.

Do not implement this phase in the first pass unless P0 proves require creation
is a meaningful remaining bottleneck. It is more invasive than the plain-JS
fast path because it touches active package release semantics.

### P5: Benchmark Through The Wrapper Endpoint

The source of truth is wrapper endpoint timing, not direct Rivet package
benchmarks.

Use the existing measurement command:

```bash
npm --prefix wrapper/api run workflow-execution:measure -- --base-url <url> --endpoint <endpoint> --kind published --runs 50 --warmups 10 --body '<json>'
```

Run with:

```text
RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true
RIVET_CODE_RUNNER_TELEMETRY=true
```

Benchmark at least:

- the fixture published as `graph-fixture-speed`;
- a real representative published workflow endpoint, if one is available;
- the same endpoint in latest/live mode if relevant;
- a synthetic plain-Expression-heavy workflow;
- a synthetic Code New workflow without `require`;
- a synthetic Code workflow with `require`;
- a no-Code control workflow.

For the fixture and representative workflows, record whether any external HTTP,
LLM, database, or provider calls were executed. Runs that include real external
services are useful end-to-end checks, but they are not clean CodeRunner
microbenchmarks.

For each scenario, capture:

- mean and p95 `x-workflow-execute-ms`;
- mean and p95 total request duration;
- `x-workflow-resolve-ms`;
- `x-workflow-materialize-ms`;
- CodeRunner telemetry summary;
- Node version and CPU/RAM/container limits;
- commit SHAs for wrapper and vendored Rivet.

Use enough runs to avoid noise:

- at least 3 independent sessions;
- at least 30 measured requests per session;
- at least 10 warmups per session;
- rerun rows with coefficient of variation above 8 percent.

A change counts as a real win only if:

- mean or p95 `x-workflow-execute-ms` improves by at least 10 percent in the
  fixture or representative workflow, or the telemetry proves a targeted win in
  a specific Code-heavy workflow class;
- the direction is consistent across sessions;
- no no-Code control workflow regresses meaningfully;
- existing endpoint tests and recording tests remain green.

Output equivalence check:

- Save one successful response body before the change and one after the change.
- Compare the meaningful workflow output, ignoring timing fields such as
  `durationMs`.
- If output differs, treat the optimization as behavior-changing and fix or
  revert before trusting speed numbers.

Recording equivalence check:

- Confirm a successful optimized run is still persisted in Run recordings.
- Confirm failed Code/Expression runs still record the visible error state.
- Confirm the recording duration continues to describe the processor execution
  window, not post-response persistence or telemetry logging.

## Required Tests

Add or update wrapper API tests for `ManagedCodeRunner`:

- plain JS with `includeRequire=false` does not call runtime-library prepare;
- `includeRequire=true` prepares runtime libraries;
- multiple `includeRequire=true` calls in one request prepare only once;
- `includeRivet=true` without `includeRequire` does not prepare managed
  runtime libraries;
- compiled cache hit uses fresh `inputs`;
- compiled cache hit uses fresh `graphInputs`;
- compiled cache hit uses fresh `context`;
- different permission shapes do not share compiled functions incorrectly;
- syntax errors are not cached unless explicitly intended;
- cache reset works for tests;
- cache eviction is deterministic and bounded;
- cache disable and force-prepare rollback flags work independently;
- managed require still resolves packages from active runtime libraries;
- package activation invalidates release-sensitive require state, or package
  changes are clearly observed on the next request through release-specific
  paths.

Also run the existing workflow endpoint tests and recording tests.

Recommended commands from the `F:\Programming\Self-hosted-rivet` checkout:

```bash
npm --prefix wrapper/api run build
npm --prefix wrapper/api test
npm --prefix wrapper/api run workflow-execution:measure -- --base-url http://localhost:8080 --endpoint graph-fixture-speed --kind published --runs 50 --warmups 10 --body '{}'
npm run test
npm run verify:repo-structure
```

## Documentation Updates

Update wrapper developer docs to explain:

- endpoint execution uses `createProcessor(...)` so recordings can attach before
  run start;
- `ManagedCodeRunner` exists for wrapper-managed runtime-library `require(...)`
  support;
- plain JS Code/Expression nodes use a fast path and do not sync runtime
  libraries;
- runtime-library snapshots are stable per workflow run;
- package changes take effect on a later workflow execution after active-release
  refresh;
- how to enable CodeRunner telemetry and interpret the benchmark headers/logs.

Likely docs to update:

- `docs/runtime-libraries.md` for the `ManagedCodeRunner` fast path, stable
  per-run snapshot behavior, and rollback flags.
- `docs/workflow-publication.md` for endpoint timing, debug headers, and the
  relationship between Run recordings duration and endpoint duration.
- `docs/development.md` for the benchmark command and how to read telemetry.

If Rivet-side docs mention the default cached Node CodeRunner, add a note that
custom wrapper `codeRunner` implementations are responsible for their own
caching and runtime-library preparation behavior.

## Rollback And Safety

The changes should be easy to disable if production telemetry shows a problem:

- keep cache behavior behind a temporary disable flag such as
  `RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE=true`;
- keep lazy-prepare behavior behind an independent temporary disable flag
  such as `RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE=true`;
- when the force-prepare flag is enabled, restore the old per-code preparation
  behavior without disabling telemetry;
- keep cache sizes bounded;
- expose cache reset in tests only;
- never cache request objects or mutable `inputs`/`context` values.

Good rollback behavior matters because endpoint execution runs user workflows
inside long-lived API processes and can execute concurrently.

## Expected Outcome

The biggest expected win is not from changing graph scheduling or subgraph
semantics. It is from removing repeated per-node wrapper overhead:

- no runtime-library sync for plain Expression and Code New nodes;
- one lazy runtime-library prepare per request when `require(...)` is actually
  needed;
- compiled function reuse across repeated endpoint requests and repeated nodes
  with identical generated source.

If telemetry shows most production time is not in `ManagedCodeRunner`, stop and
reassess before adding complexity. The benchmark must decide whether this path
is worth keeping.
