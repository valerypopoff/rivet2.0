# Evaluator graphs

Evaluator graphs are ordinary Rivet graphs. They are useful for domain checks, retrieval quality, and LLM judges without introducing a second provider or tool configuration system.

An evaluator graph receives these reserved object inputs:

```text
case, inputs, expected, outputs, run
```

`case` is the complete portable case snapshot: its `id`, `name`, enabled
state, optional tags and note, and `values`. `inputs` contains only the values
bound to the target graph; `expected` contains expected-role dataset values.
Those expected values are reference data: they affect quality only when an
assertion or evaluator actually uses them.

It must return a Graph Output named `result` with this shape:

```json
{
  "passed": true,
  "score": 0.93,
  "message": "All required fields are present.",
  "evidence": { "missing": [] },
  "metrics": { "groundedness": 0.93 }
}
```

`passed` is required. `score` ranges from 0 to 1. `metrics` contains finite numeric values. Use a custom threshold named `custom:<metric name>` in the suite to evaluate one of those metrics, for example `custom:groundedness`. Rivet averages each custom metric across the evaluator observations that supplied it. Mark an evaluator required when its pass/fail result should affect the suite; a required evaluator error makes quality unable to evaluate rather than passing or failing the target by accident.

By default evaluators skip when the target graph errors. Enable the evaluator’s target-error option only when it can meaningfully inspect that failure.
