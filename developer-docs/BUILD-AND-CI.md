# Build, CI, and Release

> Detailed reference for the current build and release workflows.

## Toolchain

### Node and Yarn

Repo-level toolchain expectations:

- Node `22.21.1` via Volta
- root `packageManager`: `yarn@4.17.1`
- Plug'n'Play enabled

Workspace manifests, Volta metadata, shared CI setup, and Tauri commands all use
the same Node `22.21.1` / Yarn `4.17.1` toolchain. Keep those declarations
aligned so a package-local command cannot silently select a different Yarn
runtime. Node `22.22.3` currently regresses synchronous CommonJS loading under
Yarn Plug'n'Play's ESM loader on Linux, which breaks both `tsx` tests and the
Docusaurus build; do not advance this pin without rerunning those CI gates.

### Rust

Required for:

- Tauri desktop builds
- release pipelines that package the app

On Windows, Tauri's Rust build also needs Visual Studio Build Tools with the
Windows SDK resource compiler (`RC.EXE`) on `PATH`. If `yarn dev` reaches
`failed to run custom build command` and `Are you sure you have RC.EXE in your
$PATH?`, install the Desktop development with C++ workload/Windows SDK or run
the command from Developer PowerShell for Visual Studio.

## Root Scripts

Current root scripts from `package.json`:

```bash
yarn dev
yarn build
yarn build:all
yarn build:runtime
yarn build:hosted-web-deps
yarn build:executor-runtime
yarn build:npm-public
yarn build:packages:local
yarn sync:desktop-version
yarn verify:desktop-version
yarn test
yarn test:all
yarn test:core
yarn test:node
yarn test:app
yarn test:app-executor
yarn test:cli
yarn test:docs
yarn test:style
yarn security:audit
yarn bench:build-timing
yarn lint
yarn prettier:fix
yarn publish
```

### `yarn dev`

Runs:

1. `yarn workspace @valerypopoff/rivet-app run dev`

That app dev script performs a Windows-only cleanup of stale copied `app-executor.exe` sidecars, then launches `tauri dev`. The Tauri dev command itself runs the pinned root Yarn 4 binary through `beforeDevCommand` to execute `prepare:tauri` and `start`, so the Node sidecar is rebuilt before the desktop app starts without depending on a global/corepack Yarn version. The app-executor bundle resolves `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` directly to their local source entrypoints, so `yarn dev` picks up current execution-engine changes without requiring a separate core/node package build first.

### `yarn build`

Runs builds in fixed order:

1. core
2. node
3. app-executor
4. evaluations
5. app
6. cli

### `yarn build:all`

Alias for `yarn build`.

### Wrapper-facing minimal build scripts

Hosted wrappers and Docker image builds should use these stable root scripts
instead of knowing Rivet's internal workspace order:

- `yarn build:runtime`: builds `@valerypopoff/rivet2-core` and
  `@valerypopoff/rivet2-node`. This is the API endpoint runtime set.
- `yarn build:hosted-web-deps`: builds `@valerypopoff/rivet2-core` and
  `@valerypopoff/rivet2-evaluations`. This is the hosted web/editor dependency set; the
  app source is still consumed from `packages/app/src`.
- `yarn build:executor-runtime`: builds `@valerypopoff/rivet2-core`,
  `@valerypopoff/rivet2-node`, and `@valerypopoff/rivet-app-executor`.
- `yarn build:npm-public`: builds the public npm publish set: core, node,
  Evaluations, and CLI.

These scripts intentionally do not build docs, tests, the desktop app, or the
CLI unless that package is part of the named target.

### `yarn bench:build-timing`

Runs `node scripts/measure-build-phases.mjs`, which measures Yarn install,
core build, node build, Evaluations build, app-executor build, and app build. Use
`--skip-install` to measure build-only phases and `--skip-app` when a hosted
wrapper does not need the browser app build. This is a build-time diagnostic,
not a graph-runtime benchmark.

### `yarn sync:desktop-version`

Runs:

- `node scripts/sync-desktop-version.mjs`

This reads `packages/app/package.json` and writes the matching desktop version
to Tauri and Cargo metadata:

- `packages/app/src-tauri/tauri.conf.json` `package.version`
- `packages/app/src-tauri/Cargo.toml` `[package].version`
- the app package entry in `packages/app/src-tauri/Cargo.lock`

The app package manifest is the source of truth. Tauri uses
`tauri.conf.json` `package.version` for installer filenames, so this sync is
what makes Windows bundle names follow `packages/app/package.json`. On Windows,
the sync retries a small set of transient write errors because Tauri or Rust
tooling can briefly hold `Cargo.toml` open during a development restart. A
persistent failure still surfaces normally; close the process holding the file
and rerun the command rather than manually editing generated metadata.

### `yarn verify:desktop-version`

Runs:

- `node scripts/sync-desktop-version.mjs --check`

This verifies the same metadata without writing files.

### `yarn test`

Runs the default runtime/package test matrix:

- `yarn workspace @valerypopoff/rivet2-core run test`
- `yarn workspace @valerypopoff/rivet2-node run test`
- `yarn workspace @valerypopoff/rivet-app run test`
- `yarn workspace @valerypopoff/rivet-app-executor run test`
- `yarn workspace @valerypopoff/rivet2-cli run test`

This intentionally includes app-executor tests because the Node executor sidecar
owns worker/code-runner behavior used by the desktop and hosted app runtime.
Packages without a `test` script are not included.

#### Test Guardrails

When adding or cleaning tests, prefer behavior-level tests at the owning helper, domain model, runtime API, or render-data-value seam. Avoid tests that read production `.ts` or `.tsx` files and assert exact source text unless the contract is a static entrypoint/CSS relationship that cannot be observed through a focused helper yet. Any retained source-shape guard should say what product contract it protects and should avoid duplicating behavior already covered by owner tests.
When a retained source-shape guard covers a formatted expression or call, match the required semantic arguments while allowing normal whitespace and multiline formatting; do not make Prettier-compatible layout changes fail the suite.
`packages/app-executor/bin/executorHost.test.mts` is an approved static-entrypoint guard: importing its startup path would bind the executor socket server, so it verifies the host/standalone bootstrap boundary from source. Keep that one exception listed in `scripts/checks/source-reading-test-allowlist.mjs`; migrate any other test to an observable helper instead.

Graph Builder evaluation manifest hashes canonicalize text asset line endings to LF before hashing. This keeps the checked manifest identical across Windows CRLF and Linux LF checkouts; do not replace the canonical digest with a raw-byte digest.

Use table-driven cases when many inputs share the same setup. Keep fixtures local unless at least three nearby tests need the same builder. Keep characterization tests broad but few, and avoid asserting entire large objects when a minimal observable subset proves the same behavior. Test names should describe behavior rather than implementation details.

Avoid `as any` unless the test intentionally models malformed caller input or a boundary that TypeScript normally protects. Do not commit `.only`. Skipped tests need a nearby comment explaining why they are skipped and what condition lets the skip be removed.

For app graph-editing tests, prefer the shared builders in [`packages/app/src/domain/graphEditing/testGraphBuilders.ts`](../packages/app/src/domain/graphEditing/testGraphBuilders.ts) for common minimal `ChartNode`, `NodeGraph`, `Project`, and connection fixtures. Keep scenario-specific wrappers local when they clarify the port defaults or graph names being asserted.

When splitting large mixed-owner test files, keep the split mechanical first: move assertions unchanged, put shared fake runtime or fixture setup in a nearby `*.testUtils.ts` file, and keep existing focused owner tests under their current filenames. Do not reuse a filename that already owns a narrower helper contract. Shared test utilities should expose setup hooks explicitly instead of registering `beforeEach` / `afterEach` as an import side effect.

When de-duplicating overlap between owner tests and composed-path tests, keep the detailed edge cases at the owner module and retain one broad wiring smoke for the composed path. Do not delete compatibility or characterization coverage just because another test reaches the same final value; public API, recorder, debugger, and app-visible surfaces are separate contracts.

### `yarn test:all`

Alias for `yarn test`.

### Focused Test And Validation Scripts

Focused root scripts cover workspace test suites plus repository-level checks:

- `yarn test:core`: `@valerypopoff/rivet2-core`
- `yarn test:node`: `@valerypopoff/rivet2-node`
- `yarn test:app`: `@valerypopoff/rivet-app`
- `yarn test:app-executor`: `@valerypopoff/rivet-app-executor`
- `yarn test:cli`: `@valerypopoff/rivet2-cli`
- `yarn test:docs`: docs workspace typecheck (`tsc --noEmit`)
- `yarn test:style`: repository-level test and documentation-link guardrails

Docs typecheck is not part of `yarn test`; CI runs `yarn test:docs` as a
separate step so runtime/package tests and documentation validation stay
visibly distinct. The docs typecheck is non-emitting so it cannot leave
generated JavaScript beside Docusaurus source files during CI or local cleanup.

The app test script lets the Node/tsx test runner discover `*.test.ts` files
instead of expanding `src/**/*.test.ts` in the shell. Keep discovery internal to
the runner: expanding the app's full test list exceeds the Windows command-line
limit before tests can start.

### `yarn test:style`

Runs repository checks for test style, documentation links, the checked Graph
Builder policy project, compact generated Graph Builder node specifications,
the legacy Graph Creator rollback boundary, rich-text sinks, AI
runtime boundaries, desktop shell policy, low-level editor boundaries, tracked
Yarn PnP install state, and generated web-app client freshness.
The web-app freshness check runs through the Node workspace's
`check:web-app-client` script so both generation and verification resolve the same
package-owned `esbuild` dependency. The generator uses `createRequire(...)` for
that dependency for the same Yarn PnP ESM-loader compatibility reason as the Core
CJS and app-executor bundlers.
The test-style script fails when `test.only`, `it.only`, `describe.only`,
`suite.only`, or `context.only` calls are present in tracked or untracked
non-ignored test files. Source-reading candidates are controlled by the explicit shrinking
allowlist in `source-reading-test-allowlist.mjs`: a new candidate fails, and removing one
requires removing its stale allowlist entry. The lexical candidate check intentionally also
catches direct filesystem reads, so a retained black-box fixture or generated-artifact test
needs a narrow comment explaining why it is not a production-source contract. `.skip` remains a
visible review queue because several parked runtime optimizations intentionally keep
characterization cases beside the active suite.

The Studio Server monorepo import added its existing source-contract tests to this
same shrinking baseline. They are migration debt, not precedent for new static tests;
remove each entry when its contract moves behind an observable owner seam.

`check-ai-runtime-boundaries.mjs` prevents Generate using AI and the graph builder
from regaining legacy Chat/Azure endpoint seams. It also keeps the selectable
legacy Graph Builder on `runLegacyGraphBuilderDraft` plus the atomic editor
commit gateway and rejects direct `graphState` publication or history clearing
from its host hook. `check-desktop-shell-contract.mjs`
owns static Tauri minimum-size/macOS-menu invariants that previously lived in a
brittle TSX source parser. `check-editor-boundaries.mjs` prevents low-level Monaco
owners from importing app state/product layers.

The documentation-link checker validates local Markdown links in root-level
docs and direct `developer-docs/*.md` files. It skips external URLs, anchors,
and fenced code blocks, then resolves remaining links against the repo root so
Windows and Linux CI runners use the same containment rules.

`check-legacy-graph-creator-rollback.mjs` owns the temporary legacy Graph
Creator rollback boundary. The former 1 MB `graph-creator.rivet-data` bundle
was not imported by either Graph Builder implementation and has been retired:
the hardened legacy path uses the live safe authoring catalog, while the
transactional path's compact checked knowledge is covered by
`check-graph-builder-node-specs.mjs`. The check rejects restoring the retired
bundle, regression of removed legacy repository-discovery, nested-research,
dormant mutation, and per-operation publication nodes, and reintroducing a
runtime dataset dependency.

`check-graph-builder-policy.mjs` owns the small transactional policy project's
serialized topology and runtime manifest. It deserializes
[`graph-builder-policy.rivet-project`](../packages/app/graphs/graph-builder-policy.rivet-project),
checks its two stable graph/LLM/output seams against
[`graph-builder-policy.manifest.json`](../packages/app/graphs/graph-builder-policy.manifest.json),
instantiates every node through the four-node minimal registry, verifies every
connected port, and rejects extra graphs, nodes, capabilities, outputs, stale
schema edges, prompt drift, serialized secrets/headers, tools, retries, cache,
partial output, reasoning, usage, request-status/body exposure, or alternate
custom-provider programmatic/environment credential lookup names. It then
compares both files with the output of the Core node factories and serializer,
so a structurally safe but stale asset also fails. Run the focused unit and
asset checks with:

```powershell
node .yarn/releases/yarn-4.17.1.cjs tsx --test scripts/checks/check-graph-builder-policy.test.mjs
node .yarn/releases/yarn-4.17.1.cjs check:graph-builder-policy
```

`yarn check:graph-builder-assets` is the release-facing aggregate gate. It
runs the legacy Graph Creator rollback-boundary check plus the policy and
generated node help/specification checks. The node-spec command first builds Core's ESM
output because the app authoring catalog deliberately consumes Core through its
public package export; this keeps the aggregate gate valid in fresh CI
checkouts where `packages/core/dist` does not exist yet. The checker then uses
that same compiled export for its built-in registry, avoiding a mixed
source/compiled module graph. Keep release workflows on this aggregate command
so adding a transactional asset does not silently leave packaging prerequisites
behind.

Policy-runner unit and mocked-provider contract tests use
`policyRunnerTestFixture.ts` to construct the same sealed two-variant shape in
memory. They must not read the serialized repository asset directly: exact
asset text, prompt hash, serialization, and freshness remain the checker's
responsibility, while runtime tests own processor behavior and provider wire
contracts. The current runtime selects the text variant for every provider, so
the wire tests must reject a Graph Builder `json_schema` request for OpenAI,
Anthropic, Google, and Custom providers. The packaged schema variant stays
freshness-checked but inactive until a separate provider-safe decision DTO and
normalization adapter are implemented and tested.

After an intentional checked prompt, topology, manifest, or Core-default
change, regenerate both files together:

```powershell
node .yarn/releases/yarn-4.17.1.cjs check:graph-builder-policy --write
```

`check-graph-builder-evaluation.mjs` validates the frozen public fixture,
threshold, holdout-contract, and manifest assets. It also guards the concrete
execution seams: production and evaluation must both invoke
`runLegacyGraphBuilderDraft` for hardened legacy and
`createPlanBGraphBuilderSessionRuntime` for Plan B. The focused runtime-adapter
suite drives those real host runtimes with deterministic fake policy/agent
executors, so it needs no credentials and must report provider accounting as
unknown rather than inventing attempts:

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-app exec tsx --test src/features/graphBuilder/evaluation/runtimeAdapters.test.ts
node .yarn/releases/yarn-4.17.1.cjs check:graph-builder-evaluation
```

Credentialed development comparisons may supply the bundled legacy executor,
the checked Plan B policy runner, and their real attempt/audit collectors to
the same adapters. Collectors are created and consumed per fixture trial; reuse
is rejected so accounting cannot accumulate across observations. The retired
as-shipped legacy slot is artifact-only; the checker and adapters must never
synthesize it from hardened behavior.

`check-graph-builder-node-specs.mjs` constructs the built-in, project-aware
authoring catalog through the same app adapter used by transactional Graph
Builder sessions and compares its compact portable metadata with
[`graph-builder-node-specs.generated.json`](../packages/app/graphs/graph-builder-node-specs.generated.json).
Its package command builds `@valerypopoff/rivet2-core` ESM first; do not invoke
the `.mjs` file directly unless that output is already present and current.
The same checker derives bounded summaries from the checked node-reference
pages into
[`graph-builder-node-help.generated.json`](../packages/app/graphs/graph-builder-node-help.generated.json).
The live catalog consumes that help map so every built-in has useful search/read
context without loading source files or full documentation at runtime; the
node-spec file remains the deterministic freshness and packaging snapshot.
The asset contains choice IDs, display names, safe descriptions, independent
capability flags, explicit settings descriptors, safe defaults, and the
catalog fingerprint; it contains no source files, React editors, UI metadata,
plugin-opaque node data, or credentials. Update and verify it with:

```powershell
node .yarn/releases/yarn-4.17.1.cjs check:graph-builder-node-specs --write
node .yarn/releases/yarn-4.17.1.cjs check:graph-builder-node-specs
```

The second command is part of `yarn test:style`, so changing a built-in
authoring adapter, registered default, captured preference contract, or any
node-reference page that supplies generated help without refreshing the checked
assets fails locally and in CI. Run the write command before staging those
changes; do not wait for the CI freshness gate to discover the drift.

When changing the authoring semantics or transaction normalization contract,
also run the focused suites below. They cover project-aware and variadic ports,
secret-safe projection, boundary authorization, cycle-safe deterministic
placement, explicit LLM-tool/Delegate/Loop Until adapters, ambiguous
continuation and bounded-loop validation, run-mode envelope fields, and the
kernel rule that only newly created nodes may be repositioned:

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-app exec tsx --test src/features/graphBuilder/authoringSemantics.test.ts
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-app exec tsx --test src/domain/graphBuilder/graphBuilderTransactionKernel.test.ts
```

`yarn check:file-tree` rejects unignored generated paths and package source deep
imports. The remaining production long-relative-import queue has a shrinking numeric
baseline; increasing it fails so settled boundaries cannot silently regress.

### Yarn PnP install state

The root `.pnp.cjs` and `.pnp.loader.mjs` files are tracked zero-install artifacts.
They are required before Yarn can start, so they must remain present in the working
tree, Git index, and `HEAD`. `node scripts/checks/check-pnp-install-state.mjs`
verifies all three locations without loading Yarn; `yarn check:pnp` is the
equivalent workspace command once Yarn can start. The
shared [setup-yarn action](../.github/actions/setup-yarn/action.yml) runs the same
check before dependency installation, which makes a commit that deletes either
loader fail with a direct diagnostic instead of a later Yarn "project has not been
installed" error.

The build workflow then runs `yarn check:pnp:fresh` immediately after its immutable
install. This second check requires the generated loaders to remain byte-for-byte
unchanged. It catches the opposite failure mode: package manifests or the lockfile
were updated without committing regenerated PnP dependency maps. The full build
follows this check and starts with the Core and Node workspaces, so undeclared
runtime imports fail under the same strict PnP resolution used by downstream
wrappers. Both `develop` and `main` run this workflow because wrappers consume
`main` directly.

If a local checkout is missing either loader, run the direct check first, then
restore the install state and stage the generated files:

```powershell
node scripts/checks/check-pnp-install-state.mjs
node .yarn/releases/yarn-4.17.1.cjs install --immutable
node scripts/checks/check-pnp-install-state.mjs --fresh
git add .pnp.cjs .pnp.loader.mjs
```

Do not remove these files during cleanup or include their deletion in a broad
`git add -A`. They are part of the repository's install contract, not disposable
build output.

The root `.yarnrc.yml` may also contain narrowly scoped `packageExtensions` for
upstream packages with undeclared runtime peers. `react-node-resolver` must
declare `react` and `react-dom` as peers because Atlaskit Select loads both at
runtime; keep that extension while Rivet uses Atlaskit Select under strict PnP.
After changing an extension, rerun Yarn install and commit the resulting tracked
PnP loader update.

### `yarn lint`

Runs lint across:

- core
- node
- app
- evaluations
- app-executor
- cli

### `yarn prettier:fix`

Runs:

- `prettier --write .`

### `yarn publish`

Runs:

- `node scripts/publish-npm-packages.mjs`

This publishes only the public npm package set: `@valerypopoff/rivet2-core`,
`@valerypopoff/rivet2-node`, `@valerypopoff/rivet2-evaluations`, and
`@valerypopoff/rivet2-cli`. Build those workspaces before publishing.

## Per-Package Build Notes

### Core

`packages/core/package.json`:

- `build`: `build:esm` then `build:cjs`
- ESM output via `tsc -b`
- CJS bundle via `node bundle.esbuild.cjs`. The launcher itself is CommonJS so
  esbuild and its synchronous internal `require()` calls stay on Yarn PnP's CJS
  hook. Do not move this launcher back behind `tsx` or an `.mjs` entry: on Node 22
  Linux, imported CommonJS can otherwise reach the asynchronous PnP ESM loader
  through `require()` and fail because that loader has no `resolveSync()` hook.
- watch mode via `tsc -b -w`

#### CJS bundle alias strategy

The CJS bundle (built by `bundle.esbuild.cjs`) targets Node 16 and aliases several ESM-only dependencies to older CJS-compatible versions:

| ESM dependency | CJS alias       | Reason                   |
| -------------- | --------------- | ------------------------ |
| `lodash-es`    | `lodash`        | lodash-es is ESM-only    |
| `p-queue`      | `p-queue-6`     | p-queue v7+ is ESM-only  |
| `emittery`     | `emittery-0-13` | emittery v1+ is ESM-only |
| `p-retry`      | `p-retry-4`     | p-retry v6+ is ESM-only  |

The alias packages are installed via `npm:` aliases in `package.json`. Because the CJS `p-queue` alias wraps the default export differently, [`pQueueCompat.ts`](../packages/core/src/utils/pQueueCompat.ts) normalizes the import at runtime so consumers never need an inline type check.

ESM-only packages that cannot be aliased (e.g. `mdast-util-to-markdown`, `@google/genai`) use dynamic `import()` at call sites instead.

### Node

`packages/node/package.json`:

- `build`: `build:esm` then `build:cjs`
- CJS bundle reuses core's esbuild bundler script (same alias strategy applies)
- `pretest`: builds `@valerypopoff/rivet2-core` ESM output first, because the node tests import the workspace package through its published-style export surface

Wrappers that embed this checkout but consume `@valerypopoff/rivet2-core` and
`@valerypopoff/rivet2-node` as built packages should not create symlinks inside the
Rivet workspace or change Rivet's package-manager mode. After building both
workspaces, run `yarn build:packages:local` or
`node scripts/create-built-package-artifacts.mjs --out-dir <dir>`. By default,
the script stages the `runtime` target (`core` + `node`). It also accepts
`--target hosted-web-deps`, `--target executor-runtime`, `--target wrapper`, or
`--include core,node,evaluations,app-executor` for custom sets. Custom sets
automatically include required local package artifacts such as core when node or
Evaluations is selected. The script validates built outputs, writes
package-manager-neutral `file:` package directories, rewrites generated
internal dependencies to local `file:` dependencies, copies the app-executor
bundle/sidecar artifacts when requested, and writes `rivet-build-artifacts.json`
with the resolved Rivet revision/ref. npm, Yarn, and pnpm based wrappers can
then depend on those generated local directories without pulling stale public
registry packages and without mutating this checkout's PnP/node-modules layout.
The artifact script recreates its output directory, so it refuses targets that
are the repo root, a parent of the repo root, inside this checkout outside
`.rivet-built-packages`, or overlapping a source package directory.

### App

`packages/app/package.json`:

- `start`: Vite dev server
- `dev`: `node scripts/dev.mjs`
- `build`: `tsc && vite build`
- `prepare:tauri`: rebuild `@valerypopoff/rivet-app-executor` before desktop launch/build steps

Current dev/build detail:

- `packages/app/scripts/dev.mjs` does a Windows-only cleanup pass for stale `src-tauri/target/*/app-executor.exe` processes before launching `tauri dev`, because Tauri's sidecar-copy step fails if a previous dev session left that copied sidecar binary locked
- The root Yarn setup uses Plug'n'Play. Keep the root `.pnp.cjs` and `.pnp.loader.mjs` files tracked even though they are generated, because `yarn dev` and other Yarn commands refuse to run scripts when `.pnp.cjs` is missing. `.yarn/install-state.gz` remains ignored/cacheable because Yarn can regenerate it from the tracked PnP loader and lock/cache state.
- `packages/app/scripts/dev.mjs` and `packages/app/scripts/prepare-tauri.mjs` use the shared `packages/app/scripts/pnp-env.mjs` child-process environment helper. It strips stale `NODE_OPTIONS` preloads for missing `.pnp.cjs` / `.pnp.loader.mjs` files, because some local checkouts can temporarily have Yarn PnP config plus a `node_modules` install layout; nested Tauri, Node, and Yarn sidecar commands must be allowed to start the pinned Yarn file instead of failing before Yarn runs.
- `packages/app/src-tauri/tauri.conf.json` runs `node ../../.yarn/releases/yarn-4.17.1.cjs prepare:tauri` before both dev and build commands, then uses that same pinned Yarn file for `start`/`build`. Keep those Tauri commands on the explicit root Yarn path instead of bare `yarn`: Tauri runs them from `packages/app`, and the explicit path avoids workspace package-manager drift and missing `.pnp.cjs` loader failures while still rebuilding the sidecar when app/core code has changed.
- `packages/app/src-tauri/vendor/` now carries the small vendored Tauri v1 plugin crates (`tauri-plugin-persisted-scope` and `tauri-plugin-window-state`) so Cargo no longer has to parse the upstream `plugins-workspace` template manifest during metadata/check/dev runs
- Vite bundle visualization is opt-in for normal app builds. Set `RIVET_BUNDLE_ANALYZE=true`
  before running `yarn workspace @valerypopoff/rivet-app run build` when a Rollup visualizer
  report is needed; CI leaves it off so routine builds do not spend time generating analysis
  artifacts.

#### pnpm sidecar binaries

The app also tracks `pnpm` sidecar binaries in [`packages/app/sidecars/pnpm`](../packages/app/sidecars/pnpm).

These binaries are currently intentional tracked artifacts because:

- Tauri lists `../sidecars/pnpm/pnpm` in `bundle.externalBin`
- package-plugin installation starts that pnpm binary through the Tauri sidecar shell API
- desktop builds should not depend on a user-installed global `pnpm`

Maintenance rules:

- Treat the directory as vendored binary artifacts.
- Keep [`packages/app/sidecars/pnpm/SHA256SUMS`](../packages/app/sidecars/pnpm/SHA256SUMS) updated whenever the binaries change.
- Keep [`packages/app/sidecars/pnpm/README.md`](../packages/app/sidecars/pnpm/README.md) updated with version/provenance notes.
- Keep `.gitattributes` marking the sidecars as binary and vendored.
- If the release pipeline later gains checksum-verified artifact downloads or Git LFS support, reassess whether these binaries should stay in normal Git history.

### App executor

`packages/app-executor/package.json`:

- `build`: `node scripts/build-executor.cjs`
- `dev`: `tsx watch --inspect=9228 --experimental-network-imports bin/executor.mts`
- `start`: build then run bundled executor

The CommonJS build launcher (`scripts/build-executor.cjs`) bundles the ESM source to CJS using esbuild, then compiles the CJS bundle into a native binary via `pkg`. Keeping the launcher itself in CJS avoids the Node 22/Yarn PnP mixed-loader failure described under Core; the ESM-only `execa` and `chalk` build helpers are loaded asynchronously after esbuild. CJS output format is required because `pkg` needs static analysis of `require()` calls. A custom esbuild plugin (`resolveRivet`) maps `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` to their workspace source entrypoints before package exports are resolved. This keeps the desktop Node executor in lockstep with local source edits and prevents stale `packages/core/dist` / `packages/node/dist` output from being bundled into a fresh sidecar.

The app-executor binary accepts `--port` / `-p` and `--host` flags. The default
host is `127.0.0.1` for the desktop internal sidecar; hosted/container wrappers
can pass `--host 0.0.0.0` or set `RIVET_EXECUTOR_HOST=0.0.0.0` without patching
`executor.mts`. If no port flag is passed, `RIVET_EXECUTOR_PORT` can override
the default `21889`; custom ports must be valid TCP ports from `1` to `65535`.
Code-family `require()` resolution can likewise be redirected
with `RIVET_CODE_RUNNER_REQUIRE_ROOT` or `RIVET_CODE_RUNNER_REQUIRE_ANCHOR` so
wrapper runtimes can provide per-project libraries without string-rewriting
`NodeCodeRunner` or the app-executor worker runner. Hosted bootstrap code can
also expose `globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__`; the app-executor
worker runner calls it before require-enabled/Rivet-capable Code-family nodes so Docker
or server wrappers can synchronize runtime libraries before module resolution.

## Hosted Wrapper Image Build Contract

Wrappers that build Docker images from this source should keep the Rivet build
surface narrow:

- API endpoint runtime images need built `@valerypopoff/rivet2-core` and
  `@valerypopoff/rivet2-node`; use `yarn build:runtime` and
  `node scripts/create-built-package-artifacts.mjs --target runtime`.
- Executor images need built core, node, and app-executor bundle/artifacts; use
  `yarn build:executor-runtime` and
  `node scripts/create-built-package-artifacts.mjs --target executor-runtime`.
  The app-executor binary artifacts are platform-specific, so build this target
  on the platform that will run the executor image.
- Hosted web/editor images need built core and Evaluations plus app host/editor
  source under `packages/app/src`; use `yarn build:hosted-web-deps` and
  `node scripts/create-built-package-artifacts.mjs --target hosted-web-deps`.

Wrapper image builds do not need the CLI, docs, test suites, desktop Tauri
bundle, or full root `yarn build` unless the image explicitly packages those
surfaces. Cache image layers by the exact Rivet revision, not by a moving branch
name alone. The artifact helper records the resolved revision in
`rivet-build-artifacts.json`; wrappers can also pass `--revision <sha>` or
`RIVET_SOURCE_REVISION=<sha>` when the source checkout does not have `.git`.
Set `RIVET_SOURCE_REF=<branch-or-tag>` when the artifact manifest should record
the configured source ref separately from the resolved revision.

Studio Server images use the monorepo root as their Docker build context. Keep
the root `.dockerignore` aligned with that boundary: local Yarn PnP state,
Rust/Tauri targets, desktop sidecars, browser-test artifacts, and existing build
outputs are never image inputs. The checked-in Yarn cache, Yarn release, patches,
workspace manifests, and package source remain available to immutable installs.

For cache-safe dependency install layers, copy only dependency metadata before
`yarn install`:

- root `package.json`
- `yarn.lock`
- `.yarnrc.yml`
- `.pnp.cjs`
- `.pnp.loader.mjs`
- `.yarn/releases/**`
- `.yarn/patches/**`
- `.yarn/plugins/**`, if present
- `package.json` files for declared workspaces under `packages/*`

Copy source files only after dependency installation. This keeps Docker
dependency layers stable when regular TypeScript/source files change.

### CLI

`packages/cli/package.json`:

- `build`: `tsc -b`
- `test`: `tsx --test test/**/*.test.ts`
- `start`: build then run CLI
- `docker-publish`: delegated shell script

The CLI now includes a small smoke suite so root `yarn test` / `npm run test` validates the package instead of failing on an empty test glob.

The CLI Dockerfile installs the published CLI package through its `RIVET_CLI_VERSION` build argument, and `docker-publish.sh` reads that value from `packages/cli/package.json`. Keep the package version and Docker publish flow aligned whenever the product version changes.

### Evaluations

`packages/evaluations/package.json`:

- dual ESM/CJS build similar to core/node

### Docs

`packages/docs/package.json`:

- Docusaurus local dev/build/serve
- `typecheck` via `tsc`

The public docs are part of the release surface. Keep them aligned with the
current Rivet 2 package/runtime model instead of preserving old fork-era
wording. In practice, docs changes should follow package renames, executor
contract changes, app-level plugin behavior, LLM Chat/HTTP Call output
contracts, Code-family runtime-permission changes, and wrapper/embedder seams.

## CI Workflows

Workflows live under [`.github/workflows/`](../.github/workflows/).

### Shared setup and cache behavior

Node/Yarn CI jobs should use
[`.github/actions/setup-yarn`](../.github/actions/setup-yarn/action.yml)
after checkout. The composite action installs Node `22.21.1` by default and
restores only Yarn's generated `.yarn/install-state.gz` file with a key based
on the OS, Node version, `yarn.lock`, and `.yarnrc.yml`.

The generated root PnP loader files (`.pnp.cjs` and `.pnp.loader.mjs`) are
tracked source inputs, not cache outputs. Do not exclude them from clean-tree
checks: if Yarn changes either file after dependency installation, commit the
updated loader with the lock/cache changes so fresh checkouts can run `yarn dev`
without regenerating install state first.

The main build workflow enforces this contract after the immutable install
(`yarn install --immutable --immutable-cache`) with `yarn check:pnp:fresh`, before
building Core and Node.
This prevents a stale committed loader from being masked by CI's install step and
then failing in a consumer that uses the tracked zero-install state.

The `.yarn/cache` package archives are also tracked repository inputs. Do not
restore that directory from `actions/cache`; doing so can reintroduce stale
archives from old cache keys and duplicates Git checkout work. `--immutable-cache`
validates the checked-in archive set quickly, and the npm publish workflow adds
the slower `--check-cache` checksum pass before publication.

The root `.yarnrc.yml` `supportedArchitectures` list must include every native
package axis expected by CI runners, not just the operating systems. Keep Linux
CI and desktop bundle jobs covered with `os: linux`, `darwin`, and `win32`,
`cpu: x64` and `arm64`, and `libc: glibc`; otherwise a Windows developer
install can leave native archives such as Rollup, SWC, esbuild, or Tauri CLI out
of the tracked cache, and the next `--immutable-cache` install will fail before
tests start.

The documentation stack uses `image-size` while reading checked-in image assets.
Root `resolutions` applies the checked-in `image-size` patch because its Node 22
file-handle path reads incorrectly from a Yarn zip archive. Keep the patch and
resolution together unless the package removes that PnP incompatibility; this no
longer requires `dependenciesMeta` or an unplugged package copy.

### Dependency security

`yarn security:audit` parses Yarn's recursive NDJSON audit output, discarding only
Yarn reporter lines in its `➤ YN####:` format, and fails closed on every other
non-JSON line. A nonzero audit command exit must first contain JSON finding output,
then is accepted only when at least one audit finding row was parsed, so a
reporter-only or transport failure cannot look like a clean audit. It fails on every
critical finding and every unreviewed high finding. A single retry is reserved for
known transient registry socket, DNS, rate-limit, timeout, and server failures; malformed
reports and all other command failures surface immediately. The audit child alone defaults to npm's canonical
`https://registry.npmjs.org` registry and a two-minute HTTP timeout, while honoring
explicit `YARN_NPM_REGISTRY_SERVER` and `YARN_HTTP_TIMEOUT` overrides. Normal dependency
installation keeps its existing registry and timeout configuration. The audit passes
Yarn's `--no-deprecations` option because deprecation annotations require a metadata
request for every audited package but do not affect vulnerability findings. Temporary high-severity
exceptions live in
[`security/dependency-audit-exceptions.json`](../security/dependency-audit-exceptions.json)
and must name their package/advisory, normalized direct dependents, scope, reason,
owner, and expiry. The dependent allowlist prevents a docs/build exception from
silently waiving a new runtime ancestry for the same vulnerable package. The check
validates policy rather than a frozen advisory count, so a newly published high
finding or a new unreviewed dependent fails CI even when lower-severity counts
change.

An exception for a parser used only by a build tool must state that the input is
repository-controlled and identify the owning toolchain. An exception for a
runtime dependency must instead identify the exact safe API boundary (for
example, a default-only ID generator) and must not treat unused vulnerable APIs
as a blanket runtime waiver. In both cases, retain the shortest practical expiry
and remove the entry as soon as a compatible upstream release exists.

When a transitive finding has a compatible upstream fix, prefer refreshing that
resolution with `node .yarn/releases/yarn-4.17.1.cjs up -R <package>` instead of
adding an exception. Commit the resulting `yarn.lock`, `.pnp.cjs`, and
replacement `.yarn/cache` archive together so zero-install CI resolves the same
patched dependency as local development.

When a Studio Server workspace bundles a Rivet dependency that is also pinned by
Rivet Core, use Core's exact tested version rather than a wider caret range. A
separate range can silently select a different AI SDK adapter and introduce a
second runtime dependency chain; this happened with the OpenAI-compatible
adapter and its vulnerable Undici 5 dependency. Treat intentional adapter
upgrades as coordinated Core-and-host changes with their own compatibility
verification.

For vulnerable descriptors that multiple upstream tools still constrain, a root
`resolutions` override may be the safer refresh mechanism. Pin the reviewed
fixed release (rather than a floating caret), then run `yarn install` and the
audit. This keeps the zero-install lockfile deterministic while the owning
upstream packages catch up.

The root `js-yaml` resolutions keep `gray-matter`'s js-yaml 3.x path and
ESLint's js-yaml 4.x path on their current maintained patch releases. Keep them
pinned until the owning documentation and lint toolchains refresh their declared
ranges; this preserves zero-install determinism without a broad major-version
override. The root `postcss@npm:^8.4.21` resolution keeps the `rtlcss` documentation
toolchain on the same patched PostCSS 8.x release used by the rest of the
workspace. Keep that descriptor pinned until `rtlcss` or its owning Docusaurus
dependency refreshes the transitive lock entry; do not replace that fix with an
audit exception. The `nanoid@npm:^3.3.16` resolution keeps PostCSS's CommonJS
dependency on the supported NanoID 3.3.18 security patch, while the workspace's
direct NanoID dependencies use the same release. The `tar@npm:^7.5.4`
resolution keeps fsevents' optional `node-gyp` build helper on tar 7.5.22,
which fixes the audited `filesFilter` recursion denial of service without
changing node-gyp's supported major range. Likewise, keep the direct
`brace-expansion` resolutions for the `^1.1.7`, `^2.0.2`, `^5.0.5`, and
`^5.0.8` descriptors on their reviewed fixed releases. Keep the matching
`fast-uri` and `ip-address` resolutions current as well: they patch the Ajv and
Express rate-limiting dependency paths without waiting for every upstream range
to refresh. These paths are used by build-time glob consumers and server/runtime
dependencies; keep their deterministic lock entries current instead of
restoring the former audit exceptions.

The build workflow runs that JavaScript audit immediately after dependency
installation. A separate Rust job restores the pinned `cargo-audit` release from a versioned binary cache (installing it only on a cache miss) and
scans `packages/app/src-tauri/Cargo.lock`; keeping it separate avoids adding Rust
setup time to the normal Node build and avoids an indirect Node runtime from an
audit action. JavaScript exceptions that no longer match an audit finding are
blocking: remove them instead of carrying stale approvals forward. RustSec
advisories may be temporarily ignored only when the checked-in
[`audit.toml`](../packages/app/src-tauri/.cargo/audit.toml) and structured
[`rust-audit-exceptions.json`](../security/rust-audit-exceptions.json) agree.
The workflow validates that every Rust ignore is documented, has the upstream
constraint, scope, mitigation, owner, and re-review date, and is not expired.
It also audits the same lockfile without those ignores before the normal audit,
so a temporary Rust exception that no longer matches an advisory fails CI and
must be removed. Remove it as soon as a compatible fix is available.
Informational RustSec reports (currently Tauri 1's Linux GTK stack and build-time
dependency chain) remain visible rather than being suppressed; every
vulnerability not explicitly listed in the temporary policy fails the job.
Weekly Dependabot groups Yarn
production/development updates, Cargo updates, and GitHub Action updates into
reviewable pull requests.

Current reviewed JavaScript exceptions are limited to docs/build/lint tooling,
native build tooling, and the archived `pkg` executor packager. They are not a
waiver for runtime dependencies. The checked-in pnpm 8.8 desktop sidecar binaries
are outside Yarn's audit graph; their version, provenance, and hashes remain owned
by `packages/app/sidecars/pnpm/README.md` and `SHA256SUMS` and must be reviewed as a
binary dependency during each sidecar refresh.

Use the pinned Yarn file for CI installs so workflow behavior follows the
repository toolchain instead of the runner's package-manager shim. Regular
release jobs should use `install --immutable --immutable-cache` so missing or
extra cache archives fail fast without rechecking every package over the
network. Keep `--check-cache` only on the npm publish workflow, where one
checksum-verification pass catches stale tracked archives before publication
without adding the same cost to regular build/test and desktop release jobs.

Desktop/Tauri jobs should also use `Swatinem/rust-cache@v2` after the Rust
toolchain is installed, scoped to `packages/app/src-tauri -> target`. Keep that
cache per runner OS/target; do not share a Tauri target directory across
platforms.

Desktop/Tauri jobs should also run
[`.github/actions/setup-pkg-cache`](../.github/actions/setup-pkg-cache/action.yml)
before `yarn tauri build`. The app executor sidecar build uses `pkg`, and `pkg`
downloads base Node.js binaries into `PKG_CACHE_PATH`. The composite action sets
that path under the runner temp directory with a Windows-specific PowerShell
step and a Unix `bash` step, then caches it by runner OS, architecture,
`yarn.lock`, `packages/app-executor/package.json`, and the app-executor build
script. Including the build script keeps the cache key fresh if the packaged
Node target changes.

Build helper scripts that can hide meaningful work should report timings with
[`scripts/ci-timing.mjs`](../scripts/ci-timing.mjs). The helper prints
`Timing: ... took ...` to logs and appends the same values to
`GITHUB_STEP_SUMMARY` in CI. Current timing coverage includes the
`build-wrapper-target.mjs` workspace builds and the two `prepare-tauri` phases
(desktop version sync and app-executor sidecar build). Because the app package
typechecks its Node-side scripts, [`packages/app/tsconfig.json`](../packages/app/tsconfig.json)
must explicitly include the shared timing helper whenever `prepare-tauri.mjs`
imports it.

## `build.yml`

### Trigger conditions

- pushes to `develop` and `main`
- pull requests targeting `develop` and `main`

Superseded runs for the same ref are canceled. The final job remains named
`build`, so branch protection keeps the stable `Build / build` check while the
work behind it is parallelized.

### Parallel job graph

1. `compiled-artifacts` runs the complete `yarn build`, then uploads only the
   compiled Core, Node, Evaluations, and App Executor dependencies required by
   downstream package checks. GitHub Actions stores those selected paths relative
   to their shared `packages/` ancestor, so `package-tests` restores the artifact
   beneath `packages/`; this preserves each workspace package's declared
   `packages/<name>/dist` export path.
2. `package-tests` fans out Core, Node, Evaluations, App, App Executor, and CLI
   into six isolated jobs. Every suite always runs; changed-path selection is
   deliberately not used for the general correctness gate.
3. `package-lint` fans out the same six source-only workspaces immediately; it does not
   wait for compiled artifacts. Test and lint matrices use `fail-fast: false`, so one
   failure cannot hide failures in other packages.
4. `static-validation` runs PnP freshness, JavaScript dependency audit, docs
   typechecking, `yarn test:style`, and Prettier in parallel with compilation.
   Graph Builder assets are not checked in a second named step because
   `yarn test:style` already owns that complete gate.
5. `rust-audit` runs independently. It restores the pinned `cargo-audit 0.22.2`
   binary from a runner/architecture/version cache and compiles it only on a
   cache miss; the advisory database itself is still refreshed by the audit.
6. The lightweight `build` aggregator fails unless compilation, every test and
   lint shard, static validation, and Rust audit all succeeded.

Each substantive job records its wall time through
[`scripts/ci/job-timing.mjs`](../scripts/ci/job-timing.mjs). The helper writes a
compact duration to `GITHUB_STEP_SUMMARY`. The final `build` aggregator also
reads the Actions run start time and reports the complete Build critical path.
Use the per-job durations to distinguish runner work from orchestration or
runner queueing when evaluating the optimization target.

Desktop push releases share a cancellable per-branch lane, while each manual release has its own lane. A later push therefore cancels only an older push release, never a manual release. The final Pages transaction remains separately serialized across channels.

The artifact fan-out is an execution optimization, not a new build contract.
`yarn build`, `yarn test`, and `yarn lint` remain the canonical complete local
commands. Only test jobs restore compiled package exports, and only after the same commit
has completed the full build.

Artifact names deliberately stay stable within a workflow run: re-running only
a failed consumer job must be able to download the previous producer artifact.
Because `upload-artifact@v7` artifacts are immutable, each of these fan-outs
has exactly one producer and that producer sets `overwrite: true`; a re-run of
the producer then replaces its own stale artifact instead of failing. The same
rule applies to the three desktop-release build artifacts. Diagnostic Kubernetes
gate artifacts instead include `github.run_attempt`, preserving evidence from
each retry rather than replacing it.

The Studio Server verifier applies the same restore rule. Its build job uploads
compiled workspace outputs from `packages/`; the API shards, pure-web tests, and
deployment-contract jobs must download that artifact beneath `packages/`, never
the repository root. `upload-artifact` preserves paths relative to their common
ancestor, so restoring at the root would move `packages/core/dist` to
`core/dist` and make consumers fail module resolution even though the build job
succeeded. `check-ci-workflows.mjs` guards both fan-outs.

## `release.yml`

### Trigger conditions

- pushes to `windows-builds`
- tags matching `app-v*`

### Matrix targets

- `windows-latest`
- `macos-latest`
- `ubuntu-22.04`
- `ubuntu-22.04-arm`

### Current steps

Per matrix entry, the workflow:

1. checks out the repo
2. runs the shared Node/Yarn setup and restores Yarn install state
3. configures and restores the `pkg` base-binary cache
4. sets up Rust toolchains
5. restores the Tauri/Rust cache
6. installs Linux system dependencies where needed
7. runs `node .yarn/releases/yarn-4.17.1.cjs install --immutable --immutable-cache`
8. runs `yarn build:hosted-web-deps`
9. invokes `tauri-apps/tauri-action`

A separate Linux prerequisite job installs the pinned Yarn dependencies and
runs `yarn check:graph-builder-assets` once per workflow before any platform
bundle job starts. The gate covers the retained legacy context plus the Plan B
policy project/manifest and generated node help/specification assets. It is
platform-independent, so release workflows should keep it as one shared
prerequisite instead of repeating it in every Windows/macOS/Linux build job.

`yarn build:hosted-web-deps` builds only the core and Evaluations package outputs
that the app package typecheck consumes. The Tauri `beforeBuildCommand` still
runs `prepare:tauri` and the app `build` from `packages/app` through the pinned
root Yarn file, so the final app frontend and app-executor sidecar are built
once by the Tauri packaging path instead of being built once by the root
`yarn build` and again by Tauri.

### Tauri release details

The workflow currently uses:

- `projectPath: packages/app`
- `tauriScript: yarn tauri`
- draft GitHub releases
- universal macOS target

### Release secrets/environment

Current workflow references:

- `GITHUB_TOKEN`
- `TAURI_PRIVATE_KEY`
- `TAURI_KEY_PASSWORD`
- Apple signing/notarization-related secrets for macOS release builds

## Desktop Release and Pages workflows

Rivet uses thin branch-specific callers plus one reusable implementation:

- [`.github/workflows/developer-windows-release.yml`](../.github/workflows/developer-windows-release.yml) selects the developer channel on `develop`.
- [`.github/workflows/official-windows-release.yml`](../.github/workflows/official-windows-release.yml) selects the official channel on `main`.
- [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml) owns the shared Windows, macOS, docs, release-asset, and Pages behavior.

Push triggers are conservatively path-gated to desktop/runtime packages, public
documentation, release tooling, Graph Builder inputs, and root dependency
manifests. Studio Server-only and developer-documentation-only commits no longer
consume signed desktop runners. Manual dispatch remains available and always
runs the selected branch's release.

Graph Builder validation, Windows packaging, macOS packaging, and documentation
building start concurrently. The Windows job produces MSI and NSIS installers;
the macOS job produces, signs, notarizes, staples, and verifies the universal
DMG. The reusable workflow retains the existing rolling GitHub Release feeds and
`official-release.json`/`developer-release.json` download-page contract.

Superseded push build work is canceled per channel/ref; manual releases do not interrupt an active release. Only the final publication
job uses the shared `rivet-docs-pages` concurrency group. That job performs
release-asset publication, opposite-channel metadata preservation, Pages
assembly, artifact upload, and deployment as one serialized transaction. Immediately
before release-asset publication and again before the Pages transaction, it resolves
the current remote branch head and skips a stale artifact SHA. This keeps developer and official publications from overwriting
each other without forcing their expensive platform builds to queue behind one
another.

A Pages deployment still gets one bounded retry after a transient first failure.
The shared publication job preserves the other channel from the live Pages site
before writing its own metadata, and aborts rather than silently dropping valid
published metadata.

The platform jobs continue using the pinned Yarn install, `pkg` cache, Rust
cache, `yarn sync:desktop-version`, and `yarn build:hosted-web-deps`. macOS
signing requires `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, and
`APPLE_API_PRIVATE_KEY`. Installer-only workflows do not require Tauri updater
signing keys.

### Pages requirements

The repository's GitHub Pages source must be configured for GitHub Actions deployments. There are two supported setup paths:

- Enable Pages once in repository settings: **Settings > Pages > Build and deployment > Source > GitHub Actions**.
- Or add a `PAGES_ENABLEMENT_TOKEN` Actions secret. When that secret exists, the workflow passes `enablement: true` to `actions/configure-pages` so the workflow can create/enable the Pages site before deploying.

`PAGES_ENABLEMENT_TOKEN` must be stronger than the default `GITHUB_TOKEN`; `actions/configure-pages` requires a separate token for enablement. Use a fine-grained token with Pages write access for this repository, a classic token with `repo` scope, or a GitHub App token with `administration:write` and `pages:write`. After Pages is enabled, the normal deployment still uses the workflow's `pages: write` and `id-token: write` permissions.

The developer deploy job uses the historically named `developer-windows-pages` environment instead of the default `github-pages` environment. Even though the workflow now publishes Windows and macOS desktop downloads, keeping the existing environment name avoids requiring a one-time GitHub environment migration. This keeps the develop-branch installer feed from being blocked by production-oriented `github-pages` environment protection rules, such as "only main can deploy." If the `developer-windows-pages` environment is later given branch restrictions, it must allow `develop`.

The Pages release workflows use Node 24-compatible action majors (`actions/checkout@v6`, `actions/upload-artifact@v7`, `actions/download-artifact@v7`, and `actions/upload-pages-artifact@v5`) and do not force Node 24 globally with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`. The build itself uses the pinned Node `22.21.1` toolchain; that is separate from the JavaScript runtime used by GitHub's actions.

### Secrets/environment

The Pages release workflows do not pass updater-signing secrets. They explicitly request only Windows installer bundles and the macOS DMG bundle, so Tauri does not create updater zip bundles and does not need `TAURI_PRIVATE_KEY` or `TAURI_KEY_PASSWORD`.

The Pages macOS job uses the same Tauri macOS packaging path as the tagged release workflow's universal target, but it does not publish signed updater feeds. Mac signing/notarization is separate from updater signing: missing Apple secrets should fail the macOS build before upload, while missing Tauri updater keys should not affect these installer-only workflows.

Required macOS signing/notarization secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` export for the Developer ID Application certificate and its private key
- `APPLE_CERTIFICATE_PASSWORD`: password for that `.p12` export
- `APPLE_SIGNING_IDENTITY`: Developer ID signing identity, usually the full `Developer ID Application: ... (TEAMID)` name or the identity suffix accepted by Tauri
- `APPLE_API_ISSUER`: App Store Connect API issuer ID
- `APPLE_API_KEY`: App Store Connect API key ID, not the private key contents
- `APPLE_API_PRIVATE_KEY`: raw contents of the downloaded `AuthKey_<key-id>.p8` file; multiline PEM content is preferred, and literal `\n` newlines are also accepted by the helper script

Do not add `APPLE_API_KEY_PATH` or `APPLE_SIGNING_KEYCHAIN` as GitHub secrets for these workflows. They are runner-local paths generated by `prepare-macos-signing-env.sh` after writing `APPLE_API_PRIVATE_KEY` to a temporary `.p8` file and importing `APPLE_CERTIFICATE` into a temporary keychain.

For local macOS builds, the repo-root `.env` can use the same Tauri variables and point `APPLE_API_KEY_PATH` at a local `.p8` file in an ignored local-only directory. Local `.env` files and local key files are never read by GitHub Actions; mirror the values into repository or environment secrets before expecting the pushed workflow to produce a trusted DMG.

If the prepare step says `APPLE_SIGNING_IDENTITY did not match an identity imported from APPLE_CERTIFICATE`, the GitHub secret values are inconsistent: the `.p12` export must contain the private key for the Developer ID Application identity named by `APPLE_SIGNING_IDENTITY`. Export the identity from Keychain Access under **My Certificates**, not just the downloaded `.cer` file.

Optional Pages-release secret:

- `PAGES_ENABLEMENT_TOKEN`: only needed if the workflow should enable GitHub Pages automatically instead of relying on the one-time repository setting described above.

Deployment environment:

- `github-pages`: used by the main-branch stable release deployment. It should allow `main`.
- `developer-windows-pages`: historically named environment used by the develop-branch desktop Pages deployment. Leave it unrestricted or allow the `develop` branch.

Production updater/tagged desktop release workflows still use the updater-enabled Tauri packaging contract and therefore continue to require updater signing secrets. Keep the Pages release workflows installer-only unless one is intentionally promoted into an updater feed.

## `publish-npm-packages.yml`

### Trigger conditions

- pushes to `main`
- manual `workflow_dispatch` runs, guarded so jobs only execute when the selected ref is `main`

### Current behavior

This workflow publishes the public runtime packages under the `@valerypopoff`
npm scope. It intentionally does not run on `develop`.

The workflow:

1. checks out the repo
2. verifies the checkout starts clean
3. runs the shared Node/Yarn setup for the build, matching the repo development toolchain and restoring Yarn install state
4. installs dependencies with the checked-in Yarn release and `--immutable --immutable-cache --check-cache`
5. verifies that the four public npm package manifests use one lockstep version
   before building
6. verifies the retained legacy and Plan B Graph Builder assets with
   `yarn check:graph-builder-assets`
7. runs `yarn build:npm-public`, which builds `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, `@valerypopoff/rivet2-evaluations`, and `@valerypopoff/rivet2-cli`
8. verifies that dependency install and package build touched only generated artifacts
9. uses Node `22.21.1` and npm `11.5.1` for npm trusted-publishing compatibility
10. runs `node scripts/publish-npm-packages.mjs --skip-clean-check` through npm trusted publishing with the GitHub Actions OIDC identity

The publish step intentionally skips the script's clean-tree check because this
job installs dependencies and builds ignored publish artifacts immediately
before publishing. The workflow performs cleanliness checks before install and
after build instead, so source changes still fail while Yarn install artifacts,
generated `packages/core/dist`, `packages/node/dist`, `packages/evaluations/dist`,
`packages/cli/dist`, `packages/cli/bin`, and
`packages/cli/tsconfig.tsbuildinfo` files do not block publishing.

### Versioning policy

The package manifest version is the release source of truth. The four public
npm packages are versioned in lockstep and must stay on major version `2`.
When bumping one npm-published package for a `main` release, bump all four
manifests together:
`packages/core/package.json`, `packages/node/package.json`,
`packages/evaluations/package.json`, and `packages/cli/package.json`.

This lockstep rule is a repository publishing contract, not a general npm
requirement. The publisher emits the four packages as one compatible release
family and rewrites internal `workspace:` dependencies to `^<family version>`.
Desktop, app-executor, documentation, and private Studio Server versions are
separate release tracks and must not be forced to match the public npm family.

- patch releases: `2.0.1`, `2.0.2`, etc. for compatible fixes
- minor releases: `2.1.0`, `2.2.0`, etc. for compatible features
- prereleases: `2.1.0-beta.1`, etc. publish with the `next` dist-tag unless `NPM_DIST_TAG` overrides it

The publish script refuses to publish if the four package versions disagree, if
the version is not semver, or if the major version is not `2`. It also checks
that the CLI Dockerfile's local-build fallback matches the lockstep package
version. It checks npm before publishing each package and skips package versions
that are already present in the registry, so re-running the same main-branch
workflow does not turn an already-published package into a hard failure.

### npm trusted publishing

Main-branch npm publishing uses tokenless npm trusted publishing. The workflow
has `id-token: write`, uses npm `11.5.1`, and sets `NPM_CONFIG_PROVENANCE=true`;
it intentionally does **not** receive `NPM_TOKEN` or `NODE_AUTH_TOKEN` from
GitHub Actions. Do not add an npm token secret as a routine fallback.

Configure the following four existing npm packages independently through npmjs.com
**Package settings -> Trusted publishing**:

- `@valerypopoff/rivet2-core`
- `@valerypopoff/rivet2-node`
- `@valerypopoff/rivet2-evaluations`
- `@valerypopoff/rivet2-cli`

Every package configuration must allow the GitHub Actions publisher with these
exact values:

- organization or user: `valerypopoff`
- repository: `rivet2.0`
- workflow filename: `publish-npm-packages.yml`
- allowed action: `npm publish`
- environment: unset (the workflow does not use a GitHub environment)

The package `repository.url` must remain
`https://github.com/valerypopoff/rivet2.0`, and the workflow must remain on a
GitHub-hosted runner. npm validates the configuration only when `npm publish`
runs, so a package-level mismatch appears as a publish failure rather than when
the setting is saved. The workflow deliberately does not call `npm whoami`:
OIDC authentication occurs only for publish operations, and `whoami` cannot
validate it.

#### First publish of a new package

npm only permits trusted-publisher configuration after a package exists. To
introduce a new public package, use a short-lived granular token with scoped
write permission and Bypass 2FA for exactly its first release. Set it only in a
local ignored `.env` or temporarily in the CI secret, publish through
`scripts/publish-npm-packages.mjs`, configure the package's trusted publisher
immediately after it exists, then revoke the token and remove any temporary CI
secret. Do not create a dummy version solely to create the trusted-publisher
setting; bootstrap with the first real lockstep release.

For exceptional local publishing, `scripts/publish-npm-packages.mjs` reads a
repo-root `.env` before it stages packages. A local `NPM_TOKEN=...` entry is
mapped to `NODE_AUTH_TOKEN` and written only to a temporary npm user config
inside the staging directory while `npm view` / `npm publish` run. The temporary
`.npmrc` is removed before the script exits, including when `--keep-stage`
leaves staged packages available for inspection. The repo-root `.env` is ignored
by Git and must not be committed.

### Package staging

[`scripts/publish-npm-packages.mjs`](../scripts/publish-npm-packages.mjs) does
not publish directly from the workspace package directories. It stages clean
temporary package directories containing only package metadata, README/LICENSE
files, and built outputs:

- `dist/cjs`, `dist/esm`, and `dist/types` for `rivet2-core`, `rivet2-node`, and `evaluations`
- `bin` and `dist` for `rivet2-cli`

During staging, internal `workspace:^` dependencies are rewritten to the same
published `^2.x` version. For example, `@valerypopoff/rivet2-node` receives a
normal npm dependency on `@valerypopoff/rivet2-core`,
`@valerypopoff/rivet2-evaluations` receives the same normal npm dependency on core, and
`@valerypopoff/rivet2-cli` receives a normal npm dependency on
`@valerypopoff/rivet2-node`.

The public workspace packages intentionally do not define package-level
`publish` lifecycle scripts. Publishing directly from a workspace package
directory is not supported because those manifests can still contain
workspace-only metadata and dependencies. Always use the root
`scripts/publish-npm-packages.mjs` path, or the GitHub workflow that calls it,
so package manifests are staged and normalized before npm sees them.

## Rolling desktop release feeds

The existing `rename-release-assets.yml` workflow remains responsible for stable aliases on ordinary tagged GitHub Releases. It explicitly skips the two feed tags below, so its post-publication download/re-upload behavior cannot race with the metadata-first desktop feed.

The desktop release workflows now create or update their own dedicated feed release before the Pages metadata is written:

- `rivet-2-stable-feed` stores the current `main` installer build and is not marked as GitHub's latest semver release.
- `rivet-2-developer-feed` stores the current `develop` installer build and is marked as a prerelease.

Each asset name includes the desktop version, source commit suffix, Actions run number, and attempt number. Feed releases deliberately retain historical assets rather than deleting them during automated publishing: this keeps existing Pages metadata valid if a later workflow fails before its Pages deployment. The download page always uses the metadata file rather than guessing a release URL, so the externally hosted filenames do not change the user-facing update or download flow. If feed storage eventually needs pruning, do it as an explicitly approved maintenance operation after verifying that no retained metadata refers to the candidate assets.

## Tauri Build and Packaging

Tauri config lives in [`packages/app/src-tauri/tauri.conf.json`](../packages/app/src-tauri/tauri.conf.json).

### Verified current details

- `beforeDevCommand`: `node ../../.yarn/releases/yarn-4.17.1.cjs prepare:tauri && node ../../.yarn/releases/yarn-4.17.1.cjs start`
- `beforeBuildCommand`: `node ../../.yarn/releases/yarn-4.17.1.cjs prepare:tauri && node ../../.yarn/releases/yarn-4.17.1.cjs build`
- `devPath`: `http://localhost:5173`
- `distDir`: `../dist`
- product name/window title: `Rivet 2`, so installed desktop builds are distinguishable from the older Rivet app
- `package.version`: the version Tauri uses for installer filenames; it must match `packages/app/package.json`
- the legacy Tauri updater endpoint still exists in the default config, but the app's Settings > Updates flow does not call it
- external binaries include app-executor and bundled `pnpm`
- Tauri compile features mirror the APIs the app actually calls: targeted file,
  dialog, HTTP, and window operations replace the previous `*-all` feature groups;
  path and global-shortcut remain all-or-nothing in Tauri v1, and the updater
  feature remains because tagged updater packaging still consumes its config

### Packaging significance

The app package is not standalone frontend output. Tauri packaging, sidecars, update-check behavior, and shell permissions are part of the build contract. CI workflows that only need installer artifacts can override the bundle targets at build time to avoid updater signing.

Settings > Updates uses the GitHub Pages stable release feed at `https://valerypopoff.github.io/rivet2.0/official-release.json`, the same metadata source rendered by the `/download` documentation page. The `official-release.json` filename is kept as the internal compatibility name for the `main`-branch release feed, but the user-facing site calls it the latest stable release. The app compares the current desktop version and browser-reported operating system against that metadata. It intentionally avoids `@tauri-apps/api/os` so the update check does not require enabling the Tauri OS allowlist. When a newer compatible stable desktop release exists, the toast opens the public `/download` page instead of calling Tauri's signed in-place updater. This keeps update checks working with the current Pages-based installer workflow, which publishes `.exe`, `.msi`, and `.dmg` downloads but intentionally does not publish signed updater bundles.

The current app shell does not mount the old updater modal or Tauri updater event monitor. Update availability is announced directly from `useCheckForUpdate` through a toast with a `Download` action that opens the public download page.

The Pages release metadata includes an explicit `version` field from `packages/app/package.json`, after confirming that Tauri's synced `package.version` matches it. The app also keeps a fallback parser for existing metadata that only has versioned original artifact filenames, so already-published Pages metadata can still be understood until the next stable release regenerates the file.

Startup checks stay quiet when the stable feed is missing or temporarily unavailable. Manual checks from Settings > Updates show a friendly status such as "No stable release has been published yet" instead of surfacing the stale Tauri `latest.json` error.

The skipped-version notice in Settings > Updates is display-only and uses semantic-version comparison against the installed desktop app version. Keep the stored `skippedMaxVersion` preference intact, but hide the notice when the current installed version is the same as or newer than the skipped version so upgraded apps do not keep showing obsolete skip text.

## Publish Scripts

## `scripts/publish-npm-packages.mjs`

Current behavior:

1. load local `.env` publish authentication when present
2. fail if git tree is dirty, unless `--skip-clean-check` is passed
3. verify the four public package manifests are named correctly
4. require lockstep semver package versions on major version `2`
5. validate required built output exists
6. stage clean temporary npm package directories
7. rewrite internal workspace dependencies to public `^2.x` package ranges
8. skip already-published package versions
9. publish core, node, Evaluations, and cli with `npm publish --access public --registry https://registry.npmjs.org/`

### Operational implication

This script assumes the packages have already been built. It is resumable across
already-published package versions, but it does not version-bump packages or
publish Docker images.

Useful local validation flags:

- `--stage-only`: validate and stage the packages without invoking npm
- `--check-versions`: validate only the public package manifests' lockstep semver
  version; this is safe in a dirty checkout and runs before publishable packages
  are built
- `--keep-stage`: keep the temporary staged package directory for inspection;
  npm auth config is still removed before exit
- `--dry-run`: run `npm publish --dry-run` against the staged package directories
- `--skip-clean-check`: allow validation from a dirty working tree; the main-branch GitHub Actions publish workflow uses this only after it has already verified that the checkout was clean before building generated package artifacts

## Release Process As Implemented

The current effective release flow is:

1. update the four public npm package manifests to the same version; for desktop app releases, `packages/app/package.json` is the source and `yarn sync:desktop-version` updates Tauri/Cargo metadata
2. push to `main` to publish npm packages, update the current stable Windows/macOS installers in the rolling GitHub Release feed, and publish their metadata through GitHub Pages
3. push `app-v*` tag for updater-enabled desktop release drafts when that path is needed
4. let `release.yml` create draft desktop artifacts
5. let the release-page workflows publish the Docusaurus site and both release-feed metadata documents through GitHub Pages

## Known Operational Risks

Visible from the current scripts/workflows:

- npm publishing depends on correct npm scope authentication or trusted publisher configuration
- npm package publishing and desktop release versioning are separate workflows and must be kept intentionally aligned
- app release depends on sidecar and Tauri packaging staying aligned
- build/test coverage is not symmetrical across all packages

## Practical Refactor Guidance

- Keep root build order aligned with runtime/package dependencies.
- If moving or renaming packages, update root scripts, CI workflows, and publish scripts together.
- If changing app-executor packaging, update both Tauri config and release/build assumptions.
- If changing app execution/session code, manual verification should cover both Browser executor mode and Node executor mode in the desktop app, plus at least one multi-consumer path that listens to executor events while the main graph execution UI is mounted.
- Treat docs publish and package publish scripts as operational code that deserves review, not just maintenance glue.
