# Evaluations: getting started

Choose **Evaluations** from the workspace tabs at any time. Rivet saves suites and datasets in its local Evaluations library, independently from project files. Open a project before creating or running a suite so Rivet can resolve its target and evaluator graphs.

## Create the dataset and target

1. Choose **+** beside **Evaluation suites**. Give the suite a name, choose the target graph, and create or select its dataset. Rivet does not silently choose the first graph or dataset.
2. Select the dataset in the sidebar. Add the fields that each case needs:
   - mark values sent to the target graph as **Graph input**;
   - mark expected/reference values used by visible checks as **Deterministic check reference**;
   - use **Evaluator metadata** for evaluator-only context.
3. Add cases. Give each case a name, enter values that match the field types, and leave **Enabled** on for cases that should run. Objects, arrays, numbers, and `any` values use JSON syntax.
4. Return to the suite. In **Dataset and target**, confirm the dataset and target graph, then bind every required target Graph Input to a compatible dataset **Graph input** field. An input can remain unbound only when its Graph Input node has a static default.

## Choose how results are judged

Under **Quality check**, choose a **Check type**:

- For **Pass/fail**, use the counted tabs to add a deterministic check, threshold, or custom evaluator graph. At least one criterion must be required or aggregate quality cannot be decided.
- For **Scoring**, add at least one custom evaluator graph. Its Graph Output named `result` must contain `{ "score": 85 }` for a score of `85/100`. Every scoring evaluator must produce a valid score for every requested trial.

Map each evaluator's ordinary Graph Inputs from target outputs, dataset fields, or optional evaluation context. For a glossary judge, bind `candidateGlossary` from the target glossary output and `referenceGlossary` from the dataset reference field. No reserved input names are required for a newly authored evaluator.

## Configure and run

Set **Trials per enabled case** and **Parallel graph runs concurrency**. Open **Additional settings** only when you need a timeout, a different recording policy, or deterministic target seeds.

The pinned run block shows enabled cases × trials as the number of target executions and keeps suite-wide warnings visible while you scroll. Choose:

- **Run evaluation** to apply the selected quality contract;
- **Run execution benchmark** to run the target only and inspect outputs and performance without a quality decision.

In Scoring mode, Rivet combines evaluator scores within each trial using their relative weights, averages the trials for each case, and then gives each case equal weight in the overall score. A weight of `2` gives one evaluator twice the influence of weight `1`; changing the only evaluator's weight has no effect. Canceling preserves work that already completed.

Use **Add run inputs to evaluation dataset** in Run Activity to turn a real root-graph invocation into a new dataset case. It copies inputs only; expected behavior remains an explicit authoring decision.

Selecting a dataset edits the reusable local resource directly, even when no suite uses it yet. Changes affect every suite that references it. Data Studio manages separate mutable graph datasets rather than evaluation cases.

## Runs and baselines

Runs show quality, latency, cost, tool behavior, provider attempts, and evaluator results. Expand a trial to inspect the exact Graph Inputs, target outputs, deterministic-check reference values, checks, metrics, errors, and retained recordings.

The run's **Quality**, **Execution**, and **Accounting** states are separate. **Passed** or **Failed** describes configured pass/fail checks, while **Scored** means every requested scoring trial returned a valid score. **Completed**, **Canceled**, or **Error** describes whether the graph machinery finished. **Complete** or **Partial** describes whether all requested provider accounting was available. **Unable to evaluate** means a configured required criterion could not produce trustworthy evidence, such as a required evaluator error, a missing score, or a missing price needed by a cost threshold. The Runs tab shows the exact reason and, for scoring suites, the overall and per-case averages with coverage.

Unknown provider pricing alone does not make quality unable to evaluate. It marks cost accounting as partial, while deterministic checks and non-cost thresholds can still pass or fail normally.

A **Deterministic check reference** field does not compare itself with a graph output. Add a deterministic check that selects a target graph output and that reference field, or add an evaluator graph that uses it. A normal evaluation cannot start with no effective quality criterion.

To run the cases only to inspect outputs, latency, usage, tools, and cost, choose **Run execution benchmark**. A benchmark can complete successfully, but its quality result is **Not evaluated** because no output check was requested.

Failed trials and baseline trials retain replayable recordings by default; successful candidate recordings are temporary. Promote a valid completed run to the suite baseline when it represents the behavior you want to protect. A scoring run can become a baseline only when every requested trial produced a score.

Comparisons are marked stale when the target graph, suite, evaluator graphs, bindings, or dataset snapshot changed. Stale comparisons remain inspectable but do not silently decide regression thresholds.
