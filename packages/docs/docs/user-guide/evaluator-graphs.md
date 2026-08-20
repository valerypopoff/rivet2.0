# Evaluator graphs

Evaluator graphs are ordinary Rivet graphs that judge an already-computed target result. They are useful for domain checks, retrieval quality, and LLM judges without introducing a second provider or tool configuration system. Rivet executes the target once per trial and then runs the configured evaluators; an evaluator does not rerun the target.

Each evaluator graph receives the inputs mapped for it in the suite. New evaluators can use ordinary Graph Input names and map each one directly from a target Graph Output, a dataset field, or an evaluation-context object. This lets a candidate/reference judge receive, for example, a candidate from the target graph and a reference from the dataset.

Each binding must be type-compatible with its evaluator Graph Input. Dataset-field bindings require a value in every enabled case. An otherwise-unbound evaluator input is allowed only when its Graph Input node has a static default.

Available evaluation-context objects are:

- `case`: case ID, name, enabled state, tags, note, and all field values;
- `inputs`: values supplied to the target graph, keyed by target Graph Input ID;
- `expected`: deterministic-reference values, keyed by dataset field ID;
- `outputs`: target values, keyed by Graph Output ID;
- `run`: trial metadata.

For compatibility, an older evaluator that declares all of these reserved object inputs receives the automatic context envelope:

```text
case, inputs, expected, outputs, run
```

This fallback is used only when the older evaluator has no `inputBindings` property and declares all five inputs. A newly authored evaluator should use explicit bindings. An explicit empty binding list means the graph needs no mapped inputs and does not activate the legacy envelope.

Every evaluator must declare exactly one Graph Output named `result`, typed as `object` or `any`. It returns an object with this shape:

```json
{
  "passed": true,
  "score": 93,
  "message": "All required fields are present.",
  "evidence": { "missing": [] },
  "metrics": { "groundedness": 0.93 }
}
```

`message` is optional display text. `evidence` can contain any portable JSON value. Every custom metric must be a finite number.

In a **Pass/fail** suite, `passed` is required and `score` is optional. Turn on **Required** when the evaluator verdict must affect overall quality. A required evaluator error makes quality **Unable to evaluate** instead of accidentally passing or failing the target. An optional evaluator can still provide observations and metrics without directly deciding the verdict.

In a **Scoring** suite, `score` is required on the same `0` to `100` scale shown in evaluation results (`93` means `93/100`); `passed` is optional and ignored. Every scoring evaluator is required, so the Required switch is not shown. **Relative score weight** controls the evaluator's influence when more than one evaluator scores the same trial.

Use a custom threshold named `custom:<metric name>` in a pass/fail suite to evaluate an evaluator metric such as `custom:groundedness`. Rivet averages each custom metric across the evaluator observations that supplied it.

The built-in Autoeval node's own score output remains normalized from `0` to `1`; multiply it by `100` before exposing it as an evaluator graph's `result.score`.

By default evaluators skip when the target graph errors. Enable **Run after target error** only when the evaluator can meaningfully inspect that failure. Evaluators still must obey their declared result contract; a successful graph execution with a missing or malformed `result` is an evaluator error.
