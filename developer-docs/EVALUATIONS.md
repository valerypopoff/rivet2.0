# Evaluations

`@valerypopoff/rivet2-evaluations` is the single evaluation engine for the Rivet app, CLI, and host integrations. It replaces the retired Trivet package; there is deliberately no compatibility reader, migration, or fallback execution path.

## Ownership boundaries

- `.rivet-project` `attachedData.evaluations` contains suite definitions, selected UI metadata, and compact baseline snapshots only.
- The adjacent `.rivet-data` envelope owns `evaluationDatasets` alongside ordinary Data Studio datasets. At execution start the adapter writes an immutable, project-scoped `EvaluationDatasetSnapshot`, keyed by the stable dataset ID plus canonical fields and cases. Distinct dataset resources therefore cannot alias the same historical snapshot even when their content is identical. Stores verify the key and keep the first value for it, so a later live-dataset edit cannot rewrite historical evidence; cosmetic names and descriptions do not invalidate the snapshot.
- `EvaluationRunStore` owns full runs, observations, content-addressed dataset snapshots, and recording references. The browser app uses its local store; a host can inject a durable store through `ProvidersContext`. Live run snapshots carry a monotonically increasing revision, so a delayed progress write cannot replace the newer completed snapshot. Every progress callback receives a fully detached snapshot; consumers may retain it without later runner mutations rewriting nested provenance, warnings, trials, observations, or metrics in place.
- A graph executor is supplied through `EvaluationGraphRunner`. The engine never assumes Browser, Node, remote, or hosted execution.
- The package stays dependency-light: the portable engine uses Rivet Core for graph contracts and YAML only for project-data serialization; collection and scheduling logic remains local and inspectable.

Do not put raw model output, prompts, credentials, recordings, or complete historical runs in the project attachment. Baselines store compact aggregate/per-case metrics and provenance so changing a baseline does not change the executable graph fingerprint.

## Resource transfer

Evaluation datasets use a versioned JSON export for lossless interchange; importing from the **Datasets** sidebar creates a new destination-scoped dataset, while importing from an existing dataset replaces only that resource's fields and cases. CSV remains a case-row format and therefore requires the destination dataset's field contract to already exist.

An evaluation-suite export is a versioned JSON bundle containing exactly one suite and the dataset named by that suite's `datasetId`. Import creates fresh suite and dataset IDs in the active project, retains field and case IDs so suite bindings and expected-value references remain connected, and never overwrites a resource already in the project. Target and evaluator graph IDs remain references: a bundle does not copy graphs, so a destination project that does not contain those IDs shows the normal repairable missing-graph state. Bundles intentionally exclude baselines, run history, recordings, and dataset snapshots because those artifacts are project/run-store evidence rather than reusable suite configuration.

Project attachment deserialization is a trust boundary. It validates the nested suite and baseline structure before returning typed data, then normalizes legacy baseline accounting and quality metadata. Malformed array entries or missing structural fields must fail with a path-specific error rather than reaching editor or comparison code as a falsely typed value.

## Runner contract

`runEvaluationSuite()` validates the dataset's project ownership and graph-input bindings before any work starts. Every required Graph Input must have a bound input-role dataset field or a static graph default. Values must be portable JSON and compatible with the declared Graph Input type; no `inferType` fallback is allowed.

The runner uses a bounded worker pool (default 4, maximum 32). Ordering remains case order then trial number even when work finishes in another order. It passes an `AbortSignal` to queued and active target/evaluator work and preserves completed trials after cancellation. Graph and LLM retry policies remain the only retry behavior.

Every run explicitly declares its purpose:

- `evaluation` requires at least one required assertion, required evaluator graph, or threshold. The runner rejects a definition that could not judge output quality before it starts any target graph.
- `execution-benchmark` measures execution, latency, usage, cost, tools, and outputs without assigning a quality pass or failure. It is the explicit way to inspect a graph with no quality criteria.

Run and trial records keep execution and quality independent. `executionStatus` says whether work completed, errored, or was canceled. `qualityStatus` is `passed`, `failed`, `not-evaluated`, or `unable-to-evaluate`, with a structured `qualityReason`. A target graph error is **Error / Failed** in a normal evaluation because the target did not satisfy the suite; the same execution is **Error / Not evaluated** in an execution benchmark because no quality judgment was requested. A required evaluator error makes quality **unable to evaluate**; it must never become either a false pass or a claimed regression.

Evaluator graphs receive `case`, `inputs`, `expected`, `outputs`, and `run`, and must return a `result` object with boolean `passed` plus optional `score`, `message`, portable `evidence`, and finite numeric `metrics`. A suite threshold addresses one of those metrics as `custom:<metric name>`; the UI keeps the metric name separate so the persisted contract remains explicit. Evaluation aggregates a custom metric as the arithmetic mean of the observations that supplied it, so a `0..1` judge metric retains the same scale as trial count changes. `case` is a portable snapshot with the case `id`, `name`, `enabled` state, optional `tags`/`note`, and `values`; it is not a mutable Data Studio record.

## Metrics, provenance, and retention

Execution adapters derive model/tool counts, token usage, known/unknown cost, and timing from physical process events. They do not depend on special Graph Outputs. A completed trial with no priced operation is a known zero-cost trial and participates as zero in total and average cost. Unknown provider pricing makes `accountingStatus` partial, but it does **not** change an otherwise valid quality result. It makes quality unable to evaluate only when a configured cost threshold needs the missing value. Every run records suite, dataset, target/evaluator, and execution-mode provenance. Target/evaluator provenance follows static Subgraph, Loop, Cron, and Delegate Tool Call handler references so changing a handler graph makes a baseline stale. It also includes runtime-relevant project configuration: plugins, node prefabs, project data, project references, MCP configuration, and Knowledge Store definitions. Cosmetic project metadata and UI graphs are deliberately excluded. Fully dynamic graph references remain represented by their owning graph configuration because their eventual target is not knowable before a trial runs. The editor's Browser and hosted/remote adapters persist privacy-bounded provider/profile-attempt provenance with each target or evaluator observation; the Node and CLI adapters expose the same data to their caller and reporters, while their host decides whether to attach an `EvaluationRunStore`.

Every target and evaluator invocation also carries `evaluationRunId`, `suiteId`, `caseId`, `trialIndex`, and a `target`/`evaluator` phase through `GraphExecutionMetadata`. This is host-owned execution metadata, not a Graph Input: it reaches local, Node/CLI, remote-executor event streams, Run Activity, and recordings without changing the graph contract. Browser evaluations route their concurrent process events directly to Run Activity without routing them through the single-run canvas lifecycle, so one completed trial cannot clear another trial's activity.

Hosts decide recording storage. The product policy is to retain failed and baseline recordings, temporarily retain successful candidate recordings for promotion, and always keep compact observations/metrics. Final retention is applied per target or evaluator artifact rather than per trial: a failed evaluator recording remains retained even when the target recording from the same trial is only a temporary successful candidate. Duplicate artifact writes preserve the existing retention decision, so a delayed retry cannot demote a failure, baseline, or manual-retention pin; explicit retention updates own those transitions, and a recording ID is immutable to its original run/trial scope. `EvaluationRunStore` implementations must enforce project/tenant isolation and delete all project-owned runs, dataset snapshots, and recording references with the project. The standalone browser store measures its recording cap in serialized UTF-8 bytes, not JavaScript character count, so non-ASCII replay data cannot exceed the intended storage budget invisibly.

Snapshot persistence is intentionally non-blocking for a target run: an unavailable browser quota or host store does not prevent an evaluation from measuring the graph. The final `EvaluationRun.warnings` must state that the exact historical cases were not retained, so replay and comparison UI never imply that the missing snapshot is available.

Dataset snapshots follow retained run history and currently have no independent age cap. A snapshot is persisted immediately before the runner's first asynchronous run write, so a store cannot safely infer that a snapshot is orphaned merely because no run currently references its fingerprint; concurrent cleanup could delete the cases for a run that is starting. Project-wide deletion is the safe host ownership boundary and must remove every snapshot. The standalone browser cannot observe a project file deleted outside Rivet, so local snapshots may remain until browser-origin data is cleared. Hosted stores likewise still need an explicit evaluation run-age/per-suite/total-byte policy and an atomic run/snapshot lease before ordinary summaries, failure artifacts, and snapshots can be reclaimed without evicting baseline/manual-retention evidence. Do not silently reuse an endpoint-keyed recording limit as a suite limit.

Graph evaluator scores are combined as a weighted mean. A missing `scoreWeight` means `1`; configured weights must be finite and greater than zero. The applied weight is copied to the observation so stored runs and baselines remain interpretable if a suite is edited later. Custom evaluator metrics are averaged both globally and per case, preserving the evidence required by compact baseline comparisons. The runner clones portable inputs, evaluator case envelopes, outputs, evidence, and metrics across adapter boundaries, so concurrent Code/evaluator graphs cannot mutate a live dataset or another trial's evidence.

## Editor and integrations

The app state is `state/evaluations.ts`; the workspace renderer is rooted in `components/evaluations/Evaluations.tsx`. File providers load/save `EvaluationProjectFileData`. Existing `attachedData.trivet` is intentionally ignored and omitted from the next save.

Evaluations is a project-scoped workspace. Workspace visibility must be derived from an actually opened project tab, never from `projectState` alone: Rivet intentionally keeps an empty placeholder project in that atom while the Welcome screen is visible. Project-scoped workspace tabs are hidden without a project and are closed when the active project is replaced by an opening tab, preventing stale graphs from a previous project from appearing in an evaluation definition.

Live evaluation state is scoped to that same active project. Switching to a
different project cancels its evaluation from the first asynchronous setup
step (dataset retention and remote preparation included), and every late
progress or completion update is fenced by project ID so it cannot populate
the newly active project's workspace. Already persisted history remains owned
by the original project and is available when that project is reopened.

An unsaved Prompt Designer candidate is additionally scoped to the exact source
project ID and graph ID. It can never be substituted into an Evaluation merely
because a different project happens to have a graph with the same ID.

The workspace applies the runner's dataset-ownership rule before enabling
editing or execution: an evaluation dataset must match both the suite's
`datasetId` and the active project ID. A stale same-ID dataset from another
project remains a repairable missing reference instead of becoming a late
execution failure.

The editor hierarchy is project → resource → section:

- `EvaluationSuiteSidebar.tsx` owns explicit suite and dataset selection. It uses flat resource rows rather than action-button styling.
- `suiteTransfer.ts` owns the versioned suite-plus-dataset bundle format. Validate the source before assigning destination IDs; the dependency relationship must be checked before a suite is retargeted to its newly imported dataset.
- `EvaluationSectionTabs.tsx` owns the horizontal Definition, Runs, and Compare tab strip. It is rendered only for an explicitly selected suite; a directly selected dataset opens its own editor rather than becoming a suite tab.
- `CreateEvaluationSuiteModal.tsx` creates a suite atomically after the author explicitly chooses a name, target graph, and existing/new dataset. The editor must not silently use the first graph or dataset.
- `EvaluationFormField.tsx` owns the label, help-text, and control spacing used by Evaluation dialogs and definition editors. Repeated assertions, evaluator graphs, and thresholds use labeled editor cards rather than anonymous wrapping control rows.
- `EvaluationSelect.tsx` owns Evaluation dropdown placement. It renders menus through Rivet's top-level portal with fixed positioning so workspace and modal scroll regions cannot clip them.
- `EvaluationConfirmModal.tsx` owns confirmations for reference-clearing changes and unusually large runs. Evaluation workflows must not fall back to browser-native confirmation dialogs, whose layout and theme differ across hosts.
- `evaluationWorkspaceModel.ts` contains pure selection, reference-status, comparison-availability, and authoring-preflight derivation. Before a run is enabled, the editor checks bindings and enabled-case input values, deterministic-check output/operator/expected-value compatibility, evaluator graph contracts, threshold context, and worker/seed settings. The package runner remains authoritative and repeats the complete validation before allocating workers. Large-run confirmation uses the selected purpose: a quality evaluation includes evaluator-graph executions, while an execution benchmark counts only target executions because it never invokes evaluators.

The active section is transient workspace state in `state/evaluations.ts`, not project attachment data. It survives leaving Evaluations for the graph editor or another workspace during the current project session, but resets when a different project is loaded. Opening a retained recording closes the Evaluations overlay and shows recording mode only around the graph canvas; the recording border must not leak over Evaluations or other project workspaces.

Evaluation modals follow the same `AppModalHeader` / `ModalBody` / `ModalFooter` structure as the rest of Rivet. Modal introductions, forms, form fields, field help, and previews are separate vertical groups; reset their native margins and use explicit layout gaps rather than browser or global element margins. The recorded-input dialog also disables its action until a recorded Graph Input execution and a suite with an active-project dataset are available.

Dataset case cells are type-aware authoring controls. String fields accept ordinary unquoted text and persist it on change; booleans use an explicit selector. Numbers, objects, arrays, and `any` values use JSON syntax, with type-specific examples for structured fields. The editor and runner share `isEvaluationValueCompatibleWithDataType()` so they cannot disagree about a saved value. An invalid structured draft remains visibly marked and disables the suite's Run action until it is fixed; it must never look like a value that was saved successfully. Dataset name and description are stacked metadata fields rather than columns whose help text can misalign their controls.

Evaluation suites and evaluation datasets are peer project resources. A suite's `datasetId` is an explicit reference to one dataset; any number of suites may reference that same dataset. Dataset IDs are unique only within a project, so selection and mutation paths must always match both `projectId` and dataset ID. The Evaluations sidebar therefore has independent **Evaluation suites** and **Datasets** lists. `selectedSuiteId` and `selectedDatasetId` identify the active resource rather than implying ownership: selecting a dataset opens its reusable case editor and lists every suite that uses it, while selecting a suite opens its Definition, Runs, and Compare sections. Editing a shared dataset affects every suite that references it. Data Studio opens any evaluation dataset directly in Evaluations, without choosing an arbitrary owning suite.

The Runs section is an evidence browser, not only an aggregate table. It presents overall Quality, Execution, and Accounting states separately, then exposes each trial's resolved Graph Inputs, target outputs, deterministic-check reference values, checks, metrics, provider-attempt diagnostics, errors, and retained recordings. The first trial opens by default; subsequent trials use Rivet's shared collapsible-panel component.

The serialized `expected` dataset-field role is presented as **Deterministic check reference**. It is reference data, not an implicit assertion. A deterministic check selects a target graph output and compares it with a literal or reference field, or an evaluator graph interprets the `expected` object. Merely naming a reference field like an output never compares them automatically. Unused reference fields remain visible with an explicit create-check action; the editor may suggest an output only when the match is unambiguous. **Graph input** fields bind dataset values to target Graph Inputs; **Evaluator metadata** travels only to evaluator graphs. Editor preflight also rejects deterministic comparisons whose known output and reference-field types cannot meaningfully compare, instead of allowing an impossible equality check or a trivially passing inequality check to reach execution. Custom output paths are checked with the package's canonical JSON-path parser, so authoring accepts exactly the root, identifier-property, quoted-property, and numeric-index selectors that execution understands.

Quality-check configuration fails closed. A missing output path cannot satisfy `not-equals`, and JSON paths traverse only own JSON properties rather than inherited prototype values. Operators reject malformed expected values as configuration errors instead of presenting them as ordinary quality failures. The deterministic JSON Schema operator supports `type` (including `integer`), `enum`, `const`, string length/pattern, numeric minimum/maximum, array length/items, object required/properties, and boolean `additionalProperties`; malformed shapes and every unsupported keyword are rejected explicitly so an ignored constraint can never create a false pass. Evaluation dataset compatibility likewise accepts only defined portable JSON representations and rejects unknown, function, binary/media, or other non-portable Rivet data types until an exact portable contract exists.

Assertion output-path authoring must call the package-exported `isEvaluationOutputPathSyntaxValid()` helper. It shares the runtime parser for root `$`, identifier property segments, quoted bracket keys, and numeric array indexes; app code must not maintain a second JSON-path grammar that can drift from execution.

Normalized quality reasons are constrained by purpose, execution status, and quality status. For example, a benchmark can never retain a legacy `checks-passed` reason after its quality is normalized to **Not evaluated**, and a canceled run can never retain a pass/fail explanation. Incompatible stored reasons are replaced with the canonical explanation for the normalized state.

The UI must never label successful execution as passed quality. A normal evaluation without an effective quality criterion is invalid and cannot start. An explicit benchmark shows **Not evaluated** for quality while still presenting inputs, outputs, latency, accounting, and recordings. **Unable to evaluate** is reserved for a configured required criterion that could not produce trustworthy evidence, and its exact `qualityReason.message` must be visible.

Missing target graphs and datasets are preserved as broken references. Definition provides selectors to repair them, while Dataset and Run actions stay unavailable. Loading run history is also suite-scoped: no run-store request occurs without an explicit suite, and delayed responses from a previously selected suite must be ignored. The Compare view chooses only a completed run with aggregate metrics; failed or canceled history cannot make a valid comparison surface appear blank.

The editor also detects missing evaluator graphs before it starts a suite. It disables Run evaluation and identifies the missing evaluator in the suite subtitle and Definition row. Evaluator contract preflight requires exactly one `case`, `inputs`, `expected`, `outputs`, and `run` Graph Input, each typed as `object` or `any`, plus one `result` Graph Output typed as `object` or `any`. The package runner repeats these checks before allocating workers.

The CLI command is:

```text
rivet evaluations run --project <file> --suite <id-or-name>
```

The command defaults to quality evaluation and therefore rejects suites with no effective criteria. `--benchmark` explicitly runs the same cases for execution measurement with quality reported as **Not evaluated**. A normal completed run that is still **Not evaluated** is a configuration/infrastructure outcome rather than a successful evaluation; a completed benchmark succeeds only when none of its trials errored or were canceled. Normal success, quality failure, and infrastructure/configuration outcomes use distinct exit codes.

JUnit reports completed quality failures as failures, target/evaluator execution problems as errors, and benchmark trials as skipped rather than falsely passed tests. Aggregate threshold failure or unavailable aggregate evidence is emitted as a synthetic `Evaluation aggregate requirements` testcase when no individual trial row represents it. This keeps CI reports consistent with the run-level exit result instead of allowing an all-green testcase list beside a failed aggregate requirement.

Reporter adapters consume normalized `EvaluationRun` v2 records; Gentrace exports completed runs rather than executing a second suite. The Graph Builder harness shares `runEvaluationWorkPool()` for bounded scheduling, cancellation, and stable result ordering, while retaining its intentionally domain-specific fixture materialization, redaction audit, and scoring contracts. It is not a second general-purpose graph-evaluation runner.

## Change checklist

When changing evaluation behavior:

1. Keep project data, datasets, and retained run artifacts separated.
2. Preserve the execution-status versus quality-status distinction.
3. Test binding validation and complete GraphProcessor scheduling, not only node ports.
4. Preserve bounded concurrency, cancellation, deterministic result ordering, and no hidden retries.
5. Add Browser, Node, remote, recording, and hosted-store coverage for new execution semantics.
6. Regenerate the Graph Builder node help if a changed evaluation-facing node contract affects it.
