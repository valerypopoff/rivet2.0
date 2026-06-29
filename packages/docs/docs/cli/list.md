---
id: list
sidebar_label: list / inspect
---

# Rivet CLI - `list` and `inspect` Commands

Inspect a `.rivet-project` file without running it.

## Quick Start

```bash
# Human-readable project summary
npx @valerypopoff/rivet2-cli list my-project.rivet-project

# Machine-readable project summary
npx @valerypopoff/rivet2-cli list my-project.rivet-project --json
npx @valerypopoff/rivet2-cli inspect my-project.rivet-project
```

## Description

`list` prints a concise project inventory:

- project title, ID, path, and main graph
- workflow graphs with node counts
- Rivet web apps with component counts
- Node library items
- declared plugins

`inspect` prints the same information as formatted JSON. It is useful in scripts that need to discover graph IDs, web app IDs, or project contents before calling `run`, `serve`, or `serve-app`.

Neither command creates a processor, runs a graph, opens dataset files, or mutates the project.

Use [`rivet doctor`](./doctor.md) when you want readiness checks and a non-zero exit status for error-level project issues.

## Options

- `--json`: for `list`, print the same machine-readable JSON shape as `inspect`.
