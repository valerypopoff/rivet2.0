---
sidebar_position: 1
---

# Evaluations

Evaluations measure complete Rivet graphs against a versioned dataset. A suite binds dataset inputs to graph inputs, runs each case (and optional repeated trials), then combines deterministic quality checks and ordinary Rivet evaluator graphs into a quality decision.

Definitions and compact baselines live with the project. Dataset cases live in the adjacent `.rivet-data` file, while complete run history and replayable recordings live in the execution host. This keeps projects reviewable without embedding prompts, model outputs, or secrets in YAML.

Rivet reports execution and quality separately. Execution can complete, error, or be canceled. Quality can **pass**, **fail**, be **not evaluated**, or be **unable to evaluate**. The last state means a configured required check could not produce trustworthy evidence; it is never used merely because a provider's price is unknown.

A normal evaluation must have a required deterministic check, required evaluator graph, or threshold. If you only want to inspect outputs, latency, usage, and cost, run an explicit execution benchmark instead. A benchmark reports quality as **Not evaluated** rather than calling successful execution a quality pass.

See [Getting started](user-guide/evaluations-getting-started.md), [evaluator graphs](user-guide/evaluator-graphs.md), and the [library and CLI](user-guide/evaluations-library.md).
