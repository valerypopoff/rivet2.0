---
sidebar_label: Gentrace
---

# Gentrace Plugin

[Gentrace](https://gentrace.ai) is an optional reporting destination for a completed Rivet Evaluation. Rivet executes the suite first—using its own evaluation dataset, assertions, evaluator graphs, cost accounting, retries, and recordings—then exports the completed observations to Gentrace.

The plugin does **not** fetch Gentrace test cases and does **not** run a second, parallel graph-testing loop.

## Getting started

Install the Gentrace plugin, create an API key in [Gentrace](https://gentrace.ai/settings/api-keys), and enter it in the plugin settings.

From the graph action bar, choose **Add Gentrace pipeline** and associate the graph with a pipeline. Run an [Evaluation](../../../evaluations.md) targeting that graph. Once it completes, choose **Export latest evaluation**.

The export creates a Gentrace pipeline run containing one step per Rivet case/trial, including its inputs, expected values, outputs, evaluator observations, status, error, and metrics. The source project, dataset, and recordings remain owned by Rivet.

## When to use it

Use the Evaluations workspace to define and judge quality. Use this plugin when your team also wants the completed result in Gentrace's reporting surface. The evaluation still has one source of truth in Rivet.
