# @valerypopoff/rivet2-evaluations

Portable, executor-agnostic evaluation engine for Rivet 2.

The package owns the shared contracts used by the Rivet Evaluations workspace, CLI, and host integrations:

- reusable suites, typed datasets, cases, checks, evaluator bindings, thresholds, and execution settings;
- pass/fail and 0–100 graph-facing scoring modes;
- `runEvaluationSuite(...)`, selected-case execution, bounded concurrency, cancellation, and progress snapshots;
- separate execution, quality, and accounting outcomes;
- canonical provenance, compact baselines, run normalization, and `EvaluationRunStore` contracts;
- strict portable-JSON validation and versioned dataset or suite-plus-dataset transfer.

The package does not choose a graph runtime or persistence backend. Callers supply a Rivet `Project` and `EvaluationGraphRunner`, and can receive detached progress through `onUpdate`. Hosts use the separate `EvaluationRunStore` contract around the runner when they need terminal history, immutable dataset snapshots, or recordings. Rivet's application-local suite/dataset library is app state rather than package-global state.

Evaluator graphs judge an already-executed target. Their Graph Output named `result` returns `passed` in pass/fail mode or a user-facing `score` from 0 through 100 in scoring mode. Stored observations use normalized scores internally.

See the [Evaluations developer documentation](../../developer-docs/EVALUATIONS.md) and [public user guide](../docs/docs/evaluations.md).

## Development

```bash
yarn workspace @valerypopoff/rivet2-evaluations run build
yarn workspace @valerypopoff/rivet2-evaluations run lint
```

See the root [README](../../README.md) and [package docs](../../developer-docs/PACKAGES.md) for the current workspace contract.
