---
id: doctor
sidebar_label: doctor
---

# Rivet CLI - `doctor` Command

Check a `.rivet-project` file for common CLI/runtime problems without running any graph.

## Quick Start

```bash
# Human-readable checks
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project

# Machine-readable checks
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project --json

# Treat a missing dataset file as an error
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project --require-dataset-file
```

## What It Checks

`doctor` validates the project file can be loaded and reports:

- project title and ID
- graph count
- whether the configured main graph exists
- Rivet web app count
- Node Library item count
- declared plugins
- project references with or without hint paths
- adjacent or explicit `.rivet-data` file presence

The command does not create processors, run graphs, load dataset contents, or mutate the project.

## Dataset Files

By default, missing dataset files are informational because Rivet CLI runs can start without datasets:

```bash
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project
```

Use `--require-dataset-file` when your deployment expects the dataset file to exist:

```bash
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project --require-dataset-file
```

You can also check an explicit dataset file:

```bash
npx @valerypopoff/rivet2-cli doctor my-project.rivet-project --dataset-file ./prod.rivet-data --require-dataset-file
```

## Exit Status

The command exits successfully when there are no error-level checks. Warnings are printed but do not fail the command.

When error-level checks are present, such as a stale main graph ID or a required missing dataset file, the command sets a non-zero exit status.
