# Evaluations workspace

The **Evaluations** workspace brings reusable datasets, target-graph bindings, quality checks, evaluator graphs, repeated trials, run history, recordings, and baseline comparisons into one surface.

## Where Evaluations are stored

Rivet saves evaluation suites, datasets, compact baselines, run history, historical dataset snapshots, and retained recordings in one application-local Evaluations database. They are not saved in `.rivet-project` or `.rivet-data` files, and they remain visible when projects close or change. Desktop Rivet stores this database in its native app-data directory. Browser Rivet stores it in that browser profile. These are separate Rivet instances, so opening the same project in desktop and browser does not synchronize their Evaluations data.

Copying or sharing a project file does not copy this local library. Use the resource export actions when you want a backup, source-controlled artifact, CLI input, or a suite that can be imported into another Rivet installation.

An open project supplies the graphs and execution context for a suite. Without a project you can still inspect, edit, import, export, or delete local resources, but graph references are unresolved and running is disabled. Run history, historical dataset snapshots, and recordings remain scoped to the project that produced them inside that instance database.

Older project-attached Evaluations data is imported into the local database once when that project opens. On the first upgraded desktop launch, Rivet also moves Evaluations data previously stored by its embedded browser into the native database; if that migration cannot be verified, Rivet keeps using the old browser store for the whole session instead of splitting data. Later project saves do not write migrated resources back into the project or sidecar file.

### Working with a shared Rivet Server

On Rivet Server, the Evaluation library is shared by everyone using that server. You can work on different suites and datasets at the same time: a save to one resource does not overwrite an unrelated resource changed by someone else. If another person changes the same suite or dataset after you began editing it, Rivet keeps both values safe and opens a resolution dialog.

Choose **Use server version** to discard your pending change for that resource, or **Keep mine as copy** to retain your pending suite or dataset with a new identity alongside the server version. A pending deletion has no local content to copy, so it offers only the server-version choice. Temporary network or server failures are shown separately and offer **Retry save**; they do not mean that another person edited the resource. Project opening itself does not save the shared library.

## Suites and datasets

The resizable left sidebar contains peer lists for **Evaluation suites** and **Datasets**. A suite references one dataset, while one dataset can be reused by multiple suites. Select a suite to open **Definition**, **Runs**, and **Compare**. Select a dataset to edit its fields and cases; the clickable **Used by … evaluation suites** text under its title reveals or hides its dependent suites.

Rename a suite, evaluator, deterministic check, or dataset with the pencil icon beside its title. Evaluation datasets intentionally have no description field.

Dataset field roles are explicit:

- **Graph input** fields can bind case values to target Graph Inputs.
- **Deterministic check reference** fields provide expected values to deterministic checks and can also feed evaluator graphs.
- **Evaluator metadata** fields are available to evaluator graphs but are not target inputs or implicit checks.

A reference field never compares itself automatically with a same-named Graph Output. Add a deterministic check that selects both values, or bind the field into an evaluator graph.

Every field has a portable Rivet type and every supplied case value must match it. Strings use compact text inputs, booleans use selectors, and objects, arrays, or `any` values use wider multiline JSON editors. Invalid structured JSON or a value with the wrong declared type is highlighted and blocks both run actions until it is fixed. Disabled cases are not executed.

## Defining a suite

In **Dataset and target**, choose the evaluation dataset, choose the target graph from the open project, and bind each required target Graph Input to a compatible **Graph input** field. An input can remain unbound only when its Graph Input node has a static default.

Under **Quality check**, choose the suite's **Check type**:

- **Pass/fail** shows tabs for **Deterministic checks**, **Thresholds**, and **Custom evaluator graphs**. A normal evaluation needs at least one required deterministic check, required evaluator graph, or threshold.
- **Scoring** shows only **Custom evaluator graphs**. Every evaluator must return a usable score for every requested trial, so the non-actionable Required switches are hidden in this mode.

Switching modes preserves the hidden pass/fail checks and thresholds so switching back restores them, but those controls are not applied while Scoring is selected.

A deterministic check selects a target Graph Output, optionally inspects a nested JSON path, and compares it with either a literal JSON value or one case's reference field. Available comparisons cover exact equality/inequality, containment, regular expressions, type checks, supported JSON Schema constraints, numeric bounds, array membership, set overlap, and contains-any/contains-all. Invalid paths, expressions, schemas, or incompatible known types are configuration problems and block execution rather than becoming ordinary failed checks.

Evaluator Graph Inputs can be mapped from a target Graph Output, any dataset field, or an evaluation-context object. The target graph has already run when an evaluator starts; evaluators judge its result and do not rerun it. See [Evaluator graphs](../evaluator-graphs.md) for the full input and output contract.

Pass/fail thresholds can evaluate pass rate, mean score, target/evaluator/tool error rates, latency, cost, custom evaluator metrics, or regression against a compatible baseline. Rate, mean-score, and maximum-regression values are entered as percentages: enter `95` for 95% or `10` for a permitted 10% regression. Latency is entered and reported in seconds; cost and custom metrics retain their own units.

## Execution settings and run actions

**Trials per enabled case** controls repeated target executions. **Parallel graph runs concurrency** controls the bounded worker pool from 1 through 32. The target-execution count is enabled cases × trials; evaluator executions are additional graph work and are not included in that count.

Open **Additional settings** for the per-graph timeout, recording retention, target seed, and numeric target Graph Input that receives each derived seed. These controls are collapsed by default unless one needs attention.

The pinned status block keeps the run actions and every suite-wide warning visible while you scroll:

- **Run evaluation** applies the selected Pass/fail or Scoring contract.
- **Run execution benchmark** runs the enabled cases and captures outputs, latency, usage, cost, tools, and recordings without assertions, evaluator graphs, thresholds, or a quality claim.

A benchmark reports quality as **Not evaluated**. It is not a shortcut around invalid dataset values, missing target bindings, or an unavailable target graph.

## Runs, recordings, and baselines

**Runs** separates **Quality**, **Execution**, and **Accounting**. Latencies and trial durations are displayed in seconds with decimal precision. In scoring suites, **Sort by score** orders both run history and the visible trial list by highest or lowest score without changing the recorded execution order. Expand a trial to inspect its exact target inputs and outputs, expected/reference values, evaluator observations, errors, metrics, provider attempts, and retained target or evaluator recordings.

Pass/fail runs can be **Passed**, **Failed**, or **Unable to evaluate**. A fully covered scoring run is **Scored** and shows overall and per-case scores out of 100 plus score coverage. Missing required evidence produces **Unable to evaluate** instead of a false pass or complete score. Unknown provider pricing by itself makes accounting **Partial**; it affects quality only when a cost threshold requires the missing value.

Failed recordings and recordings belonging to a promoted baseline are retained by default. Successful candidate recordings are temporary unless the retention setting keeps every recording. Opening a recording switches the Canvas to the graph recorded in that artifact before replay.

Promote a completed, trustworthy run when it represents the baseline behavior you want to protect. A scoring baseline requires complete score coverage. **Compare** becomes available when a baseline or enough completed runs exist. A changed target, dataset snapshot, evaluator graph, binding, execution mode, or other result-affecting configuration marks an old comparison stale rather than silently applying it.

## Import, export, and deletion

Dataset JSON is lossless and contains the complete field and case definition. **Import** beside **Datasets** creates a new local resource. **Import (replace)** on a selected dataset replaces that resource. Dataset CSV replaces case rows only and must exactly match the selected dataset's exported field columns; field values are encoded as JSON cells and are validated against their declared types.

**Export suite + dataset** creates a versioned JSON bundle containing one suite and its referenced dataset. Importing from **Evaluation suites** creates both resources with new identities. Bundles intentionally exclude graphs, baselines, run history, recordings, and historical dataset snapshots. Repair graph references after import when the open project does not contain the referenced graph IDs.

The CLI cannot read the application-local library. Export a suite bundle and run it with `rivet evaluations run --project <project> --suite-file <bundle>`.

Right-click a suite or dataset in the sidebar to delete it. Deleting a suite removes its local definition and compact baselines but not project-scoped historical runs. Deleting a dataset that is used by suites confirms and cascades to those suites and their baselines so no dangling dataset reference remains. Resources involved in a live run cannot be deleted.
