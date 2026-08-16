---
title: 08 - Testing Graphs
---

# Testing Graphs

As your graphs get more complicated, it becomes important to test whether they improving without regressing previous functionality.

Open **Evaluations** from the top menu. Create an evaluation suite, choose **Graph to Test** as its target, and bind the `statement` graph input to an input field in an evaluation dataset. Add cases, then click **Run evaluation**. The Runs tab shows the outcome of every case and trial.

What just happened?

- We evaluated the graph `8. Testing Graphs/Graph to Test`, which takes an input (`statement`) and returns `has_mission` and `mission_statement`.
- Each dataset case supplies a structured input and, where useful, expected values for assertions or evaluator graphs.
- An evaluator graph receives `case`, `inputs`, `expected`, `outputs`, and `run`, then returns one `result` object with `passed` and optional score, evidence, and metrics.

If you click on the test cases, you can see what the latest actual output was. This can be helpful for seeing what went wrong. For example, in the screenshot below, we can see that `has_mission` was expected to be "YES" or "NO," but the result was much more verbose.

## Experiments

- Try fixing any failing tests, by updating `8. Testing Graphs/Graph to Test` so that they pass.
- Add another evaluation case with a different statement and expected outputs.
- Add an assertion or evaluator graph for the `mission_statement` property, then promote a successful run as a baseline to compare later changes.
