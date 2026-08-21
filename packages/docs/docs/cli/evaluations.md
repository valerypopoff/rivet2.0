---
id: evaluations
sidebar_label: evaluations run
---

# `rivet evaluations run`

Run an exported Evaluation suite against the target and evaluator graphs in a Rivet project.

## Current workflow

The CLI cannot read the desktop/browser application's local Evaluations library. In Rivet, open the suite and choose **Export suite + dataset**, then pass that JSON bundle with `--suite-file`:

```bash
npx @valerypopoff/rivet2-cli evaluations run \
  --project ./assistant.rivet-project \
  --suite-file ./support-evaluation.json
```

The project supplies graphs, plugins, project data, references, MCP configuration, and other runtime configuration. The bundle supplies exactly one suite and its dataset. It does not include graphs, baselines, run history, recordings, or historical dataset snapshots.

## Options

- `--project <path>`: required project containing the target and evaluator graphs.
- `--suite-file <path>`: exported suite-plus-dataset JSON bundle. This is the normal current workflow.
- `--suite <id-or-name>`: select a suite from a legacy project attachment instead of a bundle.
- `--trials <count>`: override trials per enabled case.
- `--concurrency <count>`: override bounded graph concurrency from 1 through 32.
- `--benchmark`: run the target cases for execution measurement without applying checks, evaluator graphs, or thresholds.
- `--json`: write the complete `EvaluationRun` v2 JSON record.
- `--junit`: write a JUnit XML report.
- `--baseline <id>`: compare with a baseline from a legacy project attachment. Exported bundles do not contain baselines.

The command also accepts the CLI's normal provider and graph-dataset options. Graph datasets used by graph nodes are distinct from the evaluation dataset already contained in the suite bundle.

## Results and exit codes

Human-readable scoring output uses the same 100-point scale as the workspace and includes score coverage. JSON retains normalized internal scores where the `EvaluationRun` contract specifies them.

- Exit `0`: completed quality success, completed fully covered score, or a benchmark with no errored/canceled trials.
- Exit `2`: completed pass/fail quality failure or failed aggregate requirement.
- Exit `3`: invalid configuration, missing project/bundle/graph/dataset, canceled or errored execution, or required quality evidence that could not be produced.

JUnit reports completed quality failures as failures, infrastructure/evaluator problems as errors, and benchmark trials as skipped instead of falsely reporting them as quality passes. Aggregate-only failures receive an `Evaluation aggregate requirements` testcase.

## CI examples

Write JUnit:

```bash
npx @valerypopoff/rivet2-cli evaluations run \
  --project ./assistant.rivet-project \
  --suite-file ./support-evaluation.json \
  --junit > evaluation-results.xml
```

Measure execution without quality checks:

```bash
npx @valerypopoff/rivet2-cli evaluations run \
  --project ./assistant.rivet-project \
  --suite-file ./support-evaluation.json \
  --benchmark --json > benchmark-run.json
```
