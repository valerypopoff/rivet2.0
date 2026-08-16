# Evaluations: getting started

Open a project, choose **Evaluations** from the workspace tabs, then create a suite or dataset. The left sidebar keeps suites and datasets as peer resources. The creation dialog asks a suite for a target graph and lets you create or reuse an evaluation dataset; multiple suites can reuse one dataset.

1. In **Definition**, confirm the target graph and assigned dataset.
2. Select the dataset in the sidebar and add fields. Mark target inputs as **Graph input**, check reference values as **Deterministic check reference**, and evaluator-only information as **Evaluator metadata**.
3. Add cases with portable JSON values, names, tags, and an enabled state.
4. Return to **Definition** and bind every required Graph Input to an input field. An unbound input is allowed only when the graph has a static default.
5. Add at least one required deterministic quality check, required evaluator graph, or threshold, then choose **Run evaluation** in the suite header.

The green run buttons in the suite header show the projected number of target executions. The default is one trial per enabled case and four concurrent workers. Canceling an evaluation preserves completed observations.

Use **Add run inputs to evaluation dataset** in Run Activity to turn a real root-graph invocation into a new dataset case. It copies inputs only; expected behavior remains an explicit authoring decision.

Selecting a dataset in Evaluations edits that reusable dataset directly, even when no suite uses it yet. Changes affect every suite that references it. Data Studio also opens any evaluation dataset directly in Evaluations.

## Runs and baselines

Runs show quality, latency, cost, tool behavior, provider attempts, and evaluator results. Expand a trial to inspect the exact Graph Inputs, target outputs, deterministic-check reference values, checks, metrics, errors, and retained recordings.

The run's **Quality**, **Execution**, and **Accounting** states are separate. **Passed** or **Failed** describes configured quality checks; **Completed**, **Canceled**, or **Error** describes whether the graph machinery finished. **Complete** or **Partial** describes whether all requested provider accounting was available. **Unable to evaluate** means a configured required criterion could not produce trustworthy evidence, such as a required evaluator error or a missing price needed by a cost threshold. The Runs tab shows the exact reason.

Unknown provider pricing alone does not make quality unable to evaluate. It marks cost accounting as partial, while deterministic checks and non-cost thresholds can still pass or fail normally.

A **Deterministic check reference** field does not compare itself with a graph output. Add a deterministic check that selects a target graph output and that reference field, or add an evaluator graph that uses it. A normal evaluation cannot start with no effective quality criterion.

To run the cases only to inspect outputs, latency, usage, tools, and cost, choose **Run execution benchmark**. A benchmark can complete successfully, but its quality result is **Not evaluated** because no output check was requested.

Failed trials and baseline trials retain replayable recordings by default; successful candidate recordings are temporary. Promote a valid completed run to the suite baseline when it represents the behavior you want to protect.

Comparisons are marked stale when the target graph, suite, evaluator graphs, bindings, or dataset snapshot changed. Stale comparisons remain inspectable but do not silently decide regression thresholds.
