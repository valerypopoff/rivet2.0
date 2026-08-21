# Evaluations library and CLI

The desktop/browser workspace and the public package share the same portable evaluation model, but they do not share a storage backend automatically.

Rivet's application-local library owns reusable suites, datasets, and compact baselines. An `EvaluationRunStore` owns project-scoped run history, immutable dataset snapshots, recording references, and recording artifacts. The public package does not assume a browser, filesystem, executor, or hosted store.

## Programmatic API

Install the public package:

```bash
yarn add -D @valerypopoff/rivet2-evaluations
```

`runEvaluationSuite()` runs one suite and its supplied dataset against a supplied Rivet project and `EvaluationGraphRunner`. `runEvaluationCases()` runs selected case IDs through the same engine. Both require an explicit `purpose`—`evaluation` or `execution-benchmark`—and return an `EvaluationRun` v2 record.

The result keeps these concerns separate:

- `executionStatus`: queued, running, completed, canceled, or error;
- `qualityStatus` and `qualityReason`: pass/fail/scored/not-evaluated/unable-to-evaluate semantics;
- `accountingStatus`: whether requested usage and cost evidence is complete;
- trials, observations, aggregates, thresholds, provenance, warnings, and recording references.

Use `onUpdate` when a UI needs detached in-memory progress snapshots. Persistence stays outside the runner: a host uses the separate `EvaluationRunStore` contract to save terminal runs, immutable dataset snapshots, and replay artifacts. The engine validates bindings, enabled-case values, evaluator contracts, assertions, thresholds, and execution settings before allocating workers.

See the package exports for transfer helpers, normalization, baseline creation, assertion evaluation, bounded work-pool scheduling, and store implementations.

```ts
import { runEvaluationSuite } from '@valerypopoff/rivet2-evaluations';

const run = await runEvaluationSuite({
  project,
  evaluationData: { version: 1, suites: [suite], baselines: [] },
  dataset,
  suiteId: suite.id,
  purpose: 'evaluation',
  executionMode: 'my-host',
  runGraph: async ({ graphId, inputs, signal, metadata }) => {
    const result = await executeGraph({ project, graphId, inputs, signal, metadata });
    return {
      outputs: result.outputs,
      metrics: result.metrics,
      recording: result.recording,
    };
  },
  onUpdate: (progress) => showEvaluationProgress(progress),
});

await evaluationRunStore.put(run);
```

The adapter must return portable outputs and valid non-negative finite metrics. `metadata` identifies the evaluation run, suite, case, trial, and target/evaluator phase without adding reserved Graph Inputs to the graph. Hosts that persist historical datasets or recordings write those artifacts through `EvaluationRunStore` at their own lifecycle boundaries; `runEvaluationSuite()` does not do that implicitly.

## CLI

The CLI cannot read Rivet's application-local library. Export **suite + dataset** from the workspace, then run that bundle against the project that contains its target and evaluator graphs:

```bash
rivet evaluations run \
  --project assistant.rivet-project \
  --suite-file support-evaluation.json
```

Use `--trials` and `--concurrency` to override the bundle's execution settings. Use `--json` for the complete `EvaluationRun`, or `--junit` for CI-oriented XML. Add `--benchmark` to execute the target cases without applying output-quality checks. `--baseline` is unavailable for exported bundles because bundles intentionally exclude baselines.

`--suite <id-or-name>` remains only for old project files that still contain a legacy attached suite and use a legacy `.rivet-data` evaluation dataset. New workflows should use `--suite-file`.

Exit codes are stable: `0` is a successful evaluation or clean benchmark, `2` is a completed quality failure, and `3` is invalid configuration, execution/cancellation failure, or inability to produce the required quality evidence.

JUnit keeps those meanings visible to CI: completed quality failures are failures, execution or evaluator problems are errors, and benchmark-only trials are skipped rather than reported as quality passes. Run-level threshold failures or unavailable aggregate evidence receive their own aggregate testcase when no individual trial represents the outcome.

See [`rivet evaluations run`](../cli/evaluations.md) for every option and example.
