---
sidebar_position: 1
---

# Evaluations

Evaluations run complete Rivet graphs against reusable, typed datasets. A suite maps dataset fields to a target graph, runs every enabled case for one or more trials, and then judges the resulting outputs with deterministic checks or ordinary Rivet evaluator graphs.

Suites, datasets, compact baselines, run history, historical dataset snapshots, and replayable recordings live in Rivet's application-local Evaluations database. They remain available when projects close or change and are not written into `.rivet-project` or `.rivet-data` files. Desktop Rivet uses its native local database; browser Rivet uses browser storage. Those are separate Rivet installations and do not synchronize automatically. Open a project when you need to select or execute its target and evaluator graphs; historical evidence stays scoped to the project that produced it.

A suite has one of two quality modes:

- **Pass/fail** combines required deterministic checks, required evaluator verdicts, and aggregate thresholds.
- **Scoring** combines evaluator scores on a user-facing `0` to `100` scale, averages repeated trials per case, and gives each case equal weight in the overall score.

Rivet reports execution, quality, and accounting separately. Execution can complete, error, or be canceled. Quality can **Pass**, **Fail**, be **Scored**, be **Not evaluated**, or be **Unable to evaluate**. Accounting is **Complete** or **Partial** depending on whether all requested provider usage and cost information was available.

Use **Run evaluation** when the suite has an effective quality criterion. Use **Run execution benchmark** to inspect outputs, latency, usage, tools, cost, and recordings without making a quality claim. A benchmark deliberately reports quality as **Not evaluated**.

See the [Evaluations workspace](user-guide/features/evaluations.md), [Getting started](user-guide/evaluations-getting-started.md), [evaluator graphs](user-guide/evaluator-graphs.md), and the [library and CLI](user-guide/evaluations-library.md).
