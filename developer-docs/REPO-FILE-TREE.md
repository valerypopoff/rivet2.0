# Repo File Tree

This document records the current source-tree contract and the results of the
repo file-tree refactor audit. The audit intentionally avoided broad file moves:
most package boundaries are already clear enough, and moving files only to match
an idealized shape would add review churn without improving runtime behavior.

## Layout Contract

The repo is a Yarn workspace monorepo:

```text
packages/
  app/            Tauri and React desktop IDE plus hosted app entrypoints
  app-executor/   Node sidecar used by the app for Node-mode execution
  cli/            CLI commands layered over rivet-node
  core/           Graph model, execution engine, nodes, plugins, serialization
  docs/           Docusaurus user documentation site
  node/           Node runtime adapter, debugger transport, benchmarks
  trivet/         Graph-oriented test utilities
developer-docs/   Maintainer architecture and contract docs
scripts/          Root build, release, and timing scripts
  checks/         Repo hygiene checks
```

`packages/native-runtime` is not part of the tracked workspace set today. If it
returns as a real package later, it needs a package manifest, docs, and explicit
build/test ownership.

## Public Boundary Rules

Treat these paths as compatibility contracts:

- package entrypoints and exports in each package `package.json`
- app hosted exports from `packages/app/package.json`: `.`, `./host`, `./styles`
- CLI bin name and command flags
- app-executor sidecar bundle path and Tauri sidecar naming
- wrapper build scripts: `build:runtime`, `build:hosted-web-deps`,
  `build:executor-runtime`, `build:npm-public`, `build:packages:local`
- developer docs and public Docusaurus routes

Short `index.ts`, `api.ts`, and type-only files are not automatically cleanup
candidates. Many of them are public entrypoints, package seams, or test-facing
contracts.

## Entrypoint And Shim Audit Snapshot

Keep these thin files unless a future change provides a compatibility path:

| Path                                        | Classification                                                       |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/index.ts`                | public core package source entrypoint                                |
| `packages/core/src/exports.ts`              | public core export surface used by ESM/CJS builds                    |
| `packages/core/src/utils/index.ts`          | utility barrel exported through the public core surface              |
| `packages/core/src/model/chat-v2/index.ts`  | chat-v2 type/runtime barrel exported by core                         |
| `packages/core/src/plugins/*/index.ts`      | provider plugin assembly entrypoints                                 |
| `packages/node/src/index.ts`                | public node package source entrypoint                                |
| `packages/node/src/api.ts`                  | public Node runtime API implementation behind the package entrypoint |
| `packages/trivet/src/index.ts`              | public Trivet package source entrypoint                              |
| `packages/trivet/src/api.ts`                | public Trivet helper API implementation                              |
| `packages/app/src/index.tsx`                | standalone app mount entrypoint                                      |
| `packages/app/src/components/trivet/api.ts` | app-side Trivet bridge used by app components                        |

Short app hooks, state modules, and type-only files should stay local when they
name a real editor concept. Only inline one when the import graph proves it is
an obsolete pass-through and the replacement makes call sites clearer.

## Source Ownership

`packages/core` owns graph semantics and runtime contracts. Built-in node
implementations stay under `packages/core/src/model/nodes`, plugin-owned nodes
stay under `packages/core/src/plugins/<provider>/nodes`, and public exports stay
centralized through the existing core entrypoints.

`packages/app` owns editor UI and editor-only state. React components stay under
`packages/app/src/components`. Pure graph-editing rules may live under
`packages/app/src/domain/graphEditing` when they are shared across UI surfaces
or have focused non-React tests. Do not create new app domain folders until
multiple pure helpers naturally belong together.

`packages/node` keeps Node runtime APIs, debugger transport, Node-native
providers, and runtime benchmarks. Benchmarks stay discoverable under
`packages/node/bench`.

`packages/app-executor/bin` currently contains executable entrypoints and
sidecar implementation files because the packaging flow expects that shape. Do
not move those files without checking `pkg`, Tauri sidecar output names, and the
app-executor build script in the same change.

`scripts/checks/` owns repo hygiene checks that are not wrapper-facing build or
release contracts. The remaining root scripts stay flat for now because those
paths may be used by humans, CI, and wrapper automation. Grouping build/release
scripts into subfolders should wait until the ownership benefit outweighs the
compatibility cost.

The root `.pnp.cjs` and `.pnp.loader.mjs` files are tracked Yarn zero-install
loaders. They are intentionally an exception to the usual generated-file rule:
deleting either one breaks Yarn before any workspace command can run. The
`check:pnp` repository check verifies that both files exist in the working tree,
Git index, and `HEAD`.

## Local Noise Hygiene

Generated and local-only paths must stay untracked. Important ignored paths
include:

- `dist`, `build`, and `*.tsbuildinfo`
- `node_modules`
- `.rivet-built-packages`
- `.local-node`
- `.node-runtime`
- `.fixtures`
- desktop build/signing scratch folders such as `tmp-macos-signing-test`,
  `tmp-rivet-icon-test`, and `packages/app/tmp-icon-test`

`.fixtures/` is intentionally local-only because benchmark fixtures can contain
production-shaped workflow data. If a fixture becomes part of a reproducible
benchmark contract, move it to a tracked package-owned fixture folder instead of
committing it from `.fixtures/`.

## Tree Health Check

Run this when preparing source-layout changes:

```powershell
yarn check:file-tree
```

The check prints repository file counts by top-level area and package, including
tracked files plus unignored untracked files. It fails if known generated/local
output paths are unignored, and reports import-boundary review candidates. The
import-boundary section is report-only: long relative imports and source deep
imports need human review before any enforcement rule is added.

For install-state problems, run the direct check first. It does not require
Yarn's PnP loader, so it still works when the loader files are missing:

```powershell
node scripts/checks/check-pnp-install-state.mjs
```

If it fails, run the immutable install and stage the restored loaders before
continuing. Once Yarn can start, `yarn check:pnp` runs the same check. Do not fix
this by ignoring or deleting the root PnP files.

## Refactor Guidance

For file-tree cleanup, prefer these changes:

- add docs or a small check when it prevents future ambiguity;
- inline or delete a shim only after proving it is not a public or test-facing
  contract;
- move one small feature helper at a time when ownership becomes clearer;
- stop when the next move is mostly aesthetic.

Avoid these changes:

- empty folders that only express an aspirational architecture;
- broad app/core reshuffles;
- compatibility shims with no removal condition;
- import-boundary lint rules before the boundary is already stable.
