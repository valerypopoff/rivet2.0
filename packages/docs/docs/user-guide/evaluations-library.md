# Evaluations library and CLI

Install the public package:

```bash
yarn add -D @valerypopoff/rivet2-evaluations
```

`runEvaluationSuite()` runs one project-defined suite with your own graph runner. `runEvaluationCases()` runs a supplied case set. Both require an explicit `purpose` and return an `EvaluationRun` with separate execution status, quality status and reason, accounting completeness, observations, metrics, provenance, and threshold results.

The Rivet CLI runs a saved suite directly:

```bash
rivet evaluations run --project assistant.rivet-project --suite "Support answers"
```

Use `--trials`, `--concurrency`, `--json`, or `--junit` to tailor automated execution and reporting. Add `--benchmark` to measure execution without requiring or applying output-quality checks. A completed quality pass or a completed benchmark with no errored or canceled trials exits with `0`; a quality failure uses a dedicated nonzero exit code; canceled/error execution, a normal evaluation that could not make a quality judgment, and invalid configuration use the infrastructure/configuration exit code.

JUnit keeps those meanings visible to CI: completed quality failures are failures, execution or evaluator problems are errors, and benchmark-only trials are skipped rather than reported as quality passes. Run-level threshold failures or unavailable aggregate evidence receive their own aggregate testcase when no individual trial represents the outcome.
