# Evaluations workspace

The **Evaluations** workspace brings datasets, deterministic quality checks, evaluator graphs, live runs, retained recordings, and baseline comparisons into one surface. It replaces the older isolated graph-test workspace.

Evaluations belongs to the currently open project, so its workspace tab appears only after a project is open. Its left sidebar has peer lists for **Evaluation suites** and **Datasets**. A suite chooses a target graph and references one dataset; multiple suites can share that dataset. Select a suite to work with its **Definition**, **Runs**, and **Compare** sections. Select a dataset to edit its reusable fields and cases and see which suites use it. With no resource selected, the workspace does not expose resource-specific editors.

Use **Definition** for graph bindings, quality checks, evaluator graphs, execution settings, and thresholds. Use the selected **Dataset** resource for its reusable cases, field roles, tags, and import/export. Use **Runs** to inspect each trial's inputs, outputs, deterministic-check reference values, checks, metrics, and recordings. **Compare** becomes available after the suite has a baseline or at least two completed runs.

## Importing and exporting resources

Select a dataset to export its complete JSON definition or its cases as CSV. Choose **Import** beside **Datasets** to add a JSON dataset as a new resource in the current project; **Import (replace)** in a selected dataset replaces that dataset's definition. CSV imports replace cases only and must use the field columns from that selected dataset's CSV export.

Choose **Export suite + dataset** in a suite to download its complete suite definition and the dataset it uses. **Import** beside **Evaluation suites** adds both resources with new identities, so it cannot overwrite an existing suite or dataset. The bundle does not include target or evaluator graphs, run history, recordings, or baselines. If the destination project does not contain the referenced graph IDs, select the imported suite and repair those graph references before running it.

Creating a suite asks you to choose its target graph and either create or select an evaluation dataset. Rivet never silently substitutes the first graph or dataset. If a referenced graph or dataset is later deleted, the suite stays visible with a warning so you can repair the reference in Definition.

Dataset roles are explicit: **Graph input** fields can bind case values to Graph Inputs, **Deterministic check reference** fields supply values to visible quality checks, and **Evaluator metadata** fields are supplied only to evaluator graphs. A deterministic check reference field does not compare itself with a same-named graph output. A check must select the target graph output and reference field, or an evaluator graph must interpret the reference values. Rivet refuses to start a normal evaluation with no effective quality criterion. Choose an execution benchmark when the goal is measurement and output inspection without quality judgment.
