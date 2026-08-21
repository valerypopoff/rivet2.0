---
title: 08 - Testing Graphs
---

# Testing Graphs

As your graphs get more complicated, it becomes important to measure whether they are improving without regressing previous functionality.

Open the project, then open **Evaluations** from the top bar. Create an evaluation suite, choose **Graph to Test** as its target, and create or select an evaluation dataset. Add a **Graph input** field for `statement`, add enabled cases, and bind that field to the target's `statement` Graph Input in **Dataset and target**.

Choose **Pass/fail** and add a deterministic check or custom evaluator graph, then click **Run evaluation**. The **Runs** tab shows the execution, quality, and accounting outcome of every case and trial.

What just happened?

- We evaluated the graph `8. Testing Graphs/Graph to Test`, which takes an input (`statement`) and returns `has_mission` and `mission_statement`.
- Each dataset case supplies a structured input and, where useful, reference values for deterministic checks or evaluator graphs.
- A newly authored evaluator maps ordinary Graph Inputs explicitly from target outputs, dataset fields, or evaluation context, then returns one `result` object with `passed` and optional message, evidence, score, and metrics.

Expand a trial in **Runs** to inspect the exact target inputs and outputs, reference values, checks, evaluator observations, metrics, errors, and retained recordings. This makes it clear why a result failed—for example, when `has_mission` was expected to be `YES` or `NO` but the graph returned a much more verbose value.

## Experiments

- Try fixing a failed evaluation by updating `8. Testing Graphs/Graph to Test` so that it passes.
- Add another evaluation case with a different statement and expected outputs.
- Add a deterministic check or evaluator graph for the `mission_statement` property, then promote a trustworthy completed run as a baseline to compare later changes.
