# Build, CI, and Release

> Detailed reference for the current build and release workflows.

## Toolchain

### Node and Yarn

Repo-level toolchain expectations:

- Node `22.22.3` via Volta
- root `packageManager`: `yarn@4.17.1`
- Plug'n'Play enabled

Workspace manifests, Volta metadata, shared CI setup, and Tauri commands all use
the same Node 22.22 / Yarn 4.17 toolchain. Keep those declarations aligned so a
package-local command cannot silently select a different Yarn runtime.

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
4. trivet
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
  `@valerypopoff/trivet`. This is the hosted web/editor dependency set; the
  app source is still consumed from `packages/app/src`.
- `yarn build:executor-runtime`: builds `@valerypopoff/rivet2-core`,
  `@valerypopoff/rivet2-node`, and `@valerypopoff/rivet-app-executor`.
- `yarn build:npm-public`: builds the public npm publish set: core, node,
  Trivet, and CLI.

These scripts intentionally do not build docs, tests, the desktop app, or the
CLI unless that package is part of the named target.

### `yarn bench:build-timing`

Runs `node scripts/measure-build-phases.mjs`, which measures Yarn install,
core build, node build, Trivet build, app-executor build, and app build. Use
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
what makes Windows bundle names follow `packages/app/package.json`.

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

Runs repository checks for test style, documentation links, generated graph-builder
context, rich-text sinks, AI runtime boundaries, desktop shell policy, low-level
editor boundaries, and generated web-app client freshness.
The web-app freshness check runs through the Node workspace's
`check:web-app-client` script so both generation and verification resolve the same
package-owned `esbuild` dependency. The generator uses `createRequire(...)` for
that dependency for the same Yarn PnP ESM-loader compatibility reason as the Core
CJS and app-executor bundlers.
The test-style script fails when `test.only`, `it.only`, `describe.only`,
`suite.only`, or `context.only` calls are present in tracked or untracked
non-ignored test files. Source-reading tests are controlled by the explicit shrinking
allowlist in `source-reading-test-allowlist.mjs`: a new source-reading test fails,
and removing one requires removing its stale allowlist entry. `.skip` remains a
visible review queue because several parked runtime optimizations intentionally keep
characterization cases beside the active suite.

`check-ai-runtime-boundaries.mjs` prevents Generate using AI and the graph builder
from regaining legacy Chat/Azure endpoint seams. `check-desktop-shell-contract.mjs`
owns static Tauri minimum-size/macOS-menu invariants that previously lived in a
brittle TSX source parser. `check-editor-boundaries.mjs` prevents low-level Monaco
owners from importing app state/product layers.

The documentation-link checker validates local Markdown links in root-level
docs and direct `developer-docs/*.md` files. It skips external URLs, anchors,
and fenced code blocks, then resolves remaining links against the repo root so
Windows and Linux CI runners use the same containment rules.

The graph-creator-data checker verifies that the AI graph-builder bundled
context in `packages/app/graphs/graph-creator.rivet-data` is generated from the
current built-in node source files and current node-reference docs. If it fails,
refresh the generated bundle with
`node scripts/checks/check-graph-creator-data.mjs --write`.

`yarn check:file-tree` rejects unignored generated paths and package source deep
imports. The remaining production long-relative-import queue has a shrinking numeric
baseline; increasing it fails so settled boundaries cannot silently regress.

### `yarn lint`

Runs lint across:

- core
- node
- app
- trivet
- app-executor
- cli

### `yarn prettier:fix`

Runs:

- `prettier --write .`

### `yarn publish`

Runs:

- `node scripts/publish-npm-packages.mjs`

This publishes only the public npm package set: `@valerypopoff/rivet2-core`,
`@valerypopoff/rivet2-node`, `@valerypopoff/trivet`, and
`@valerypopoff/rivet2-cli`. Build those workspaces before publishing.

## Per-Package Build Notes

### Core

`packages/core/package.json`:

- `build`: `build:esm` then `build:cjs`
- ESM output via `tsc -b`
- CJS bundle via `tsx bundle.esbuild.ts`. The script loads esbuild with
  `createRequire(...)`, rather than a static ESM import, so Yarn PnP resolves
  esbuild through its synchronous CJS hook even when Node's ESM loader is active
  in Linux CI.
- watch mode via `tsc -b -w`

#### CJS bundle alias strategy

The CJS bundle (built by `bundle.esbuild.ts`) targets Node 16 and aliases several ESM-only dependencies to older CJS-compatible versions:

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
`--include core,node,trivet,app-executor` for custom sets. Custom sets
automatically include required local package artifacts such as core when node or
Trivet is selected. The script validates built outputs, writes
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

- `build`: `tsx scripts/build-executor.mts`
- `dev`: `tsx watch --inspect=9228 --experimental-network-imports bin/executor.mts`
- `start`: build then run bundled executor

The build script (`scripts/build-executor.mts`) bundles the ESM source to CJS using esbuild, then compiles the CJS bundle into a native binary via `pkg`. CJS format is required because `pkg` needs static analysis of `require()` calls. A custom esbuild plugin (`resolveRivet`) maps `@valerypopoff/rivet2-core` and `@valerypopoff/rivet2-node` to their workspace source entrypoints before package exports are resolved. This keeps the desktop Node executor in lockstep with local source edits and prevents stale `packages/core/dist` / `packages/node/dist` output from being bundled into a fresh sidecar.

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
- Hosted web/editor images need built core and Trivet plus app host/editor
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

### Trivet

`packages/trivet/package.json`:

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
after checkout. The composite action installs Node `22.22.x` by default and
restores only Yarn's generated `.yarn/install-state.gz` file with a key based
on the OS, Node version, `yarn.lock`, and `.yarnrc.yml`.

The generated root PnP loader files (`.pnp.cjs` and `.pnp.loader.mjs`) are
tracked source inputs, not cache outputs. Do not exclude them from clean-tree
checks: if Yarn changes either file after dependency installation, commit the
updated loader with the lock/cache changes so fresh checkouts can run `yarn dev`
without regenerating install state first.

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

`yarn security:audit` parses Yarn's recursive NDJSON audit output and fails on
every critical finding and every unreviewed high finding. Temporary high-severity
exceptions live in
[`security/dependency-audit-exceptions.json`](../security/dependency-audit-exceptions.json)
and must name their package/advisory, normalized direct dependents, scope, reason,
owner, and expiry. The dependent allowlist prevents a docs/build exception from
silently waiving a new runtime ancestry for the same vulnerable package. The check
validates policy rather than a frozen advisory count, so a newly published high
finding or a new unreviewed dependent fails CI even when lower-severity counts
change.

The build workflow runs that JavaScript audit immediately after dependency
installation. A separate `rustsec/audit-check` job scans
`packages/app/src-tauri/Cargo.lock`; keeping it separate avoids adding Rust setup
time to the normal Node build. Weekly Dependabot groups Yarn production/development
updates, Cargo updates, and GitHub Action updates into reviewable pull requests.

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

- pushes to `develop`
- pull requests targeting `develop`

This general build workflow is also develop-only for now. It should not be widened to `main` until main-branch CI/release behavior is deliberately introduced.

### Current behavior

Runs on `ubuntu-latest` and performs:

1. checkout
2. shared Node/Yarn setup and install-state cache restore
3. `node .yarn/releases/yarn-4.17.1.cjs install --immutable --immutable-cache`
4. `yarn security:audit`
5. `node scripts/checks/check-graph-creator-data.mjs`
6. `yarn build`
7. `yarn test`
8. `yarn test:docs`
9. `yarn test:style`
10. `yarn lint`
11. `yarn prettier:check`

The independent Rust audit job checks the desktop `Cargo.lock` in parallel with
the Node build.

### Important notes

- build runs with increased `NODE_OPTIONS`
- the AI graph-builder context check is also run as a named workflow step so stale node/source context gets a clear
  GitHub failure line before the heavier build/test phases; `yarn test:style` keeps the same guard for local parity
- formatting check covers repo-maintenance docs and scripts that are already Prettier-clean. The full repo is not
  currently Prettier-normalized, so do not switch this to `prettier --check .` without a dedicated format pass.

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

A separate Linux prerequisite job verifies the AI graph-builder context with
`node scripts/checks/check-graph-creator-data.mjs` once per workflow run before
any platform bundle job starts. The check is platform-independent and needs only
the checked-out repo, so release workflows should keep it as one shared
prerequisite instead of repeating it in every Windows/macOS/Linux build job.

`yarn build:hosted-web-deps` builds only the core and Trivet package outputs
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

## Desktop Pages release workflows

Rivet publishes desktop download metadata through the Docusaurus GitHub Pages site:

- [`.github/workflows/official-windows-release.yml`](../.github/workflows/official-windows-release.yml) runs on `main`
- [`.github/workflows/developer-windows-release.yml`](../.github/workflows/developer-windows-release.yml) runs on `develop`

The workflow filenames are historical, but the workflows are desktop release workflows. Each one builds Windows installers and a macOS disk image, builds the documentation site in parallel with the platform bundles, then publishes both sets of aliases and original artifacts to the `/download` page.

The platform and docs build jobs use `actions/checkout@v6` for the initial repository checkout. A failure in that step happens before any Rivet, Tauri, Rust, or Node build command runs. Treat `fatal: could not read Username for 'https://github.com': terminal prompts disabled` from this step as a GitHub repository checkout/authentication failure, not a macOS packaging failure. If the failing log fetches `origin/develop`, it is the developer release workflow; stable `main` runs fetch `origin/main`.

Both workflows build only installer-style artifacts:

- Windows jobs run `yarn tauri build --verbose --ci --bundles "msi,nsis"` from `packages/app`
- macOS jobs run `yarn tauri build --verbose --ci --target universal-apple-darwin --bundles "dmg"` from `packages/app`

They intentionally avoid updater zip bundles, so they do not need `TAURI_PRIVATE_KEY` or `TAURI_KEY_PASSWORD`.

The macOS jobs do require Apple Developer ID signing and notarization secrets. Before the Tauri build, the job runs [`.github/scripts/prepare-macos-signing-env.sh`](../.github/scripts/prepare-macos-signing-env.sh), which validates the required secrets, writes the App Store Connect `.p8` private key into the runner temp directory, imports the Developer ID `.p12` into a temporary keychain, and verifies that `APPLE_SIGNING_IDENTITY` matches an imported code-signing identity. The script exposes only runner-local paths (`APPLE_API_KEY_PATH` and `APPLE_SIGNING_KEYCHAIN`) through `GITHUB_ENV`; it must not print certificate, password, or private-key values.

Tauri v1 signs and notarizes the application bundle when those variables are present, but the Pages workflow treats the downloadable DMG as the release artifact that must be trusted by Gatekeeper. After Tauri builds the universal DMG, the job runs [`.github/scripts/notarize-macos-dmg.sh`](../.github/scripts/notarize-macos-dmg.sh), which signs the DMG, submits the DMG to Apple with `notarytool`, waits for notarization, and staples the DMG ticket.

The job then runs [`.github/scripts/verify-macos-dmg.sh`](../.github/scripts/verify-macos-dmg.sh). That verification mounts the generated DMG, checks the contained `.app` with `codesign` and `spctl`, validates the DMG's stapled notarization ticket, and assesses the DMG's primary signature before upload. This makes a successful Pages release mean the downloadable macOS DMG is signed and notarized rather than merely packaged.

Both workflows use [`.github/scripts/prepare-desktop-release-pages.mjs`](../.github/scripts/prepare-desktop-release-pages.mjs) after the docs build. The script reads `WINDOWS_BUNDLE_DIR` and `MACOS_BUNDLE_DIR`, copies original artifacts under platform-specific `downloads/<channel>/original/<platform>/` paths, creates stable download aliases, and generates a channel metadata file with a shared `version` field.
It fails the job if a requested platform does not produce a stable download alias, so a successful Pages deployment cannot silently drop the macOS DMG or the Windows installer links.

Before building installers, both platform jobs run `yarn sync:desktop-version`; Tauri's `beforeBuildCommand` also runs `prepare:tauri`, which performs the same version sync before rebuilding the sidecar. The `build-pages` assembly job runs `node scripts/sync-desktop-version.mjs` without installing dependencies before generating metadata, because it checks out a fresh workspace and the metadata script verifies that `packages/app/package.json` and Tauri's `package.version` match.
That sync copies `packages/app/package.json` `version` into
`packages/app/src-tauri/tauri.conf.json`, `packages/app/src-tauri/Cargo.toml`,
and the app entry in `Cargo.lock`. Tauri uses `tauri.conf.json`
`package.version` for bundle filenames, so this is what lets a
developer bump only the app package version and still get correctly versioned
developer/stable installer names.

Generated metadata and aliases:

- stable workflow: `official-release.json`, `downloads/official/Rivet-2-Windows-Setup.exe`, `downloads/official/Rivet-2-Windows.msi`, and `downloads/official/Rivet-2-macOS.dmg`
- developer workflow: `developer-release.json`, `downloads/developer/Rivet-2-Developer-Windows-Setup.exe`, `downloads/developer/Rivet-2-Developer-Windows.msi`, and `downloads/developer/Rivet-2-Developer-macOS.dmg`

The `/download` docs page reads both metadata files. A Pages deploy replaces the whole site, so each release workflow preserves the other channel from the currently published Pages site before writing its own current channel:

- `main` stable runs preserve `developer-release.json` and the developer assets referenced by that metadata
- `develop` developer runs preserve `official-release.json` and the stable assets referenced by that metadata

The release workflows share the `rivet-docs-pages` concurrency group with `cancel-in-progress: false`, so stable and developer Pages deployments queue instead of racing and accidentally publishing a site that only contains one release channel.

### `official-windows-release.yml`

#### Trigger conditions

- pushes to `main`
- manual `workflow_dispatch` runs, guarded so jobs only execute when the selected ref is `main`

#### Current behavior

The workflow has six jobs:

1. `verify-ai-graph-builder-context` runs on `ubuntu-latest`, checks out the repo, and runs `node scripts/checks/check-graph-creator-data.mjs`.
2. `build-windows` runs on `windows-latest` after that verifier, checks out the repo, restores Node/Yarn, `pkg`, and Rust caches, installs Rust stable, runs the pinned Yarn install with immutable cache validation, syncs desktop version metadata, runs `yarn build:hosted-web-deps`, then runs `yarn tauri build --verbose --ci --bundles "msi,nsis"` from `packages/app`.
3. `build-macos` runs on `macos-latest` after that verifier, checks out the repo, restores Node/Yarn, `pkg`, and Rust caches, installs the stable Rust toolchain with `x86_64-apple-darwin` and `aarch64-apple-darwin` targets, runs the pinned Yarn install with immutable cache validation, syncs desktop version metadata, runs `yarn build:hosted-web-deps`, then runs `yarn tauri build --verbose --ci --target universal-apple-darwin --bundles "dmg"` from `packages/app`.
4. `build-docs` runs on `ubuntu-latest` after that verifier, installs dependencies with the shared Node/Yarn setup, builds the Docusaurus docs site from `packages/docs`, and uploads the docs build as an intermediate artifact. This job intentionally starts without waiting for the platform bundles.
5. `build-pages` runs on `ubuntu-latest` after the platform bundles and docs artifact are ready, checks out the repo, syncs desktop version metadata without a Yarn install, downloads the docs site plus Windows and macOS bundle artifacts, preserves the current developer release feed from Pages if it exists, writes stable release metadata and installer files into `packages/docs/build`, and uploads that complete docs-site artifact.
6. `publish-pages` runs on `ubuntu-latest`, downloads the generated docs-site artifact, configures GitHub Pages, uploads it as a GitHub Pages artifact, and deploys it with `actions/deploy-pages`.

The stable deploy job uses the `github-pages` environment. If that environment has branch restrictions, it must allow `main`.

### `developer-windows-release.yml`

### Trigger conditions

- pushes to `develop`
- manual `workflow_dispatch` runs, guarded so jobs only execute when the selected ref is `develop`

This workflow is intentionally develop-only. It does not run for `main`.

### Current behavior

The workflow has six jobs:

1. `verify-ai-graph-builder-context` runs on `ubuntu-latest`, checks out the repo, and runs `node scripts/checks/check-graph-creator-data.mjs`.
2. `build-windows` runs on `windows-latest` after that verifier, checks out the repo, restores Node/Yarn, `pkg`, and Rust caches, installs Rust stable, runs the pinned Yarn install with immutable cache validation, syncs desktop version metadata, runs `yarn build:hosted-web-deps`, then runs `yarn tauri build --verbose --ci --bundles "msi,nsis"` from `packages/app`.
3. `build-macos` runs on `macos-latest` after that verifier, checks out the repo, restores Node/Yarn, `pkg`, and Rust caches, installs the stable Rust toolchain with `x86_64-apple-darwin` and `aarch64-apple-darwin` targets, runs the pinned Yarn install with immutable cache validation, syncs desktop version metadata, runs `yarn build:hosted-web-deps`, then runs `yarn tauri build --verbose --ci --target universal-apple-darwin --bundles "dmg"` from `packages/app`.
4. `build-docs` runs on `ubuntu-latest` after that verifier, installs dependencies with the shared Node/Yarn setup, builds the Docusaurus docs site from `packages/docs`, and uploads the docs build as an intermediate artifact. This job intentionally starts without waiting for the platform bundles.
5. `build-pages` runs on `ubuntu-latest` after the platform bundles and docs artifact are ready, checks out the repo, syncs desktop version metadata without a Yarn install, downloads the docs site plus Windows and macOS bundle artifacts, preserves the current stable release feed from Pages if it exists, writes developer release metadata and installer files into `packages/docs/build`, and uploads that complete docs-site artifact.
6. `publish-pages` runs on `ubuntu-latest`, downloads the generated docs-site artifact, configures GitHub Pages, uploads it as a GitHub Pages artifact, and deploys it with `actions/deploy-pages`.

Docusaurus owns the site root and reads `developer-release.json` on the `/download` page. The generated Pages site represents the current public docs plus the latest successful developer Windows and macOS release from `develop`, while preserving the stable release feed that was already published from `main`.

### Pages requirements

The repository's GitHub Pages source must be configured for GitHub Actions deployments. There are two supported setup paths:

- Enable Pages once in repository settings: **Settings > Pages > Build and deployment > Source > GitHub Actions**.
- Or add a `PAGES_ENABLEMENT_TOKEN` Actions secret. When that secret exists, the workflow passes `enablement: true` to `actions/configure-pages` so the workflow can create/enable the Pages site before deploying.

`PAGES_ENABLEMENT_TOKEN` must be stronger than the default `GITHUB_TOKEN`; `actions/configure-pages` requires a separate token for enablement. Use a fine-grained token with Pages write access for this repository, a classic token with `repo` scope, or a GitHub App token with `administration:write` and `pages:write`. After Pages is enabled, the normal deployment still uses the workflow's `pages: write` and `id-token: write` permissions.

The developer deploy job uses the historically named `developer-windows-pages` environment instead of the default `github-pages` environment. Even though the workflow now publishes Windows and macOS desktop downloads, keeping the existing environment name avoids requiring a one-time GitHub environment migration. This keeps the develop-branch installer feed from being blocked by production-oriented `github-pages` environment protection rules, such as "only main can deploy." If the `developer-windows-pages` environment is later given branch restrictions, it must allow `develop`.

The Pages release workflows use Node 24-compatible action majors (`actions/checkout@v6`, `actions/upload-artifact@v7`, `actions/download-artifact@v7`, and `actions/upload-pages-artifact@v5`) and do not force Node 24 globally with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`. The build itself still uses Node `20.4.x`; that is the project toolchain, not the JavaScript runtime used by GitHub's actions.

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
5. verifies the AI graph-builder context with `node scripts/checks/check-graph-creator-data.mjs`
6. runs `yarn build:npm-public`, which builds `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, `@valerypopoff/trivet`, and `@valerypopoff/rivet2-cli`
7. verifies that dependency install and package build touched only generated artifacts
8. uses Node `22.22.x` and npm `11.5.1` for npm trusted-publishing compatibility
9. verifies that the repository `NPM_TOKEN` secret is present and accepted by `npm whoami`
10. runs `node scripts/publish-npm-packages.mjs --skip-clean-check`

The publish step intentionally skips the script's clean-tree check because this
job installs dependencies and builds ignored publish artifacts immediately
before publishing. The workflow performs cleanliness checks before install and
after build instead, so source changes still fail while Yarn install artifacts,
generated `packages/core/dist`, `packages/node/dist`, `packages/trivet/dist`,
`packages/cli/dist`, `packages/cli/bin`, and
`packages/cli/tsconfig.tsbuildinfo` files do not block publishing.

### Versioning policy

The package manifest version is the release source of truth. The four public
npm packages are versioned in lockstep and must stay on major version `2`.
When bumping one npm-published package for a `main` release, bump all four
manifests together:
`packages/core/package.json`, `packages/node/package.json`,
`packages/trivet/package.json`, and `packages/cli/package.json`.

- patch releases: `2.0.1`, `2.0.2`, etc. for compatible fixes
- minor releases: `2.1.0`, `2.2.0`, etc. for compatible features
- prereleases: `2.1.0-beta.1`, etc. publish with the `next` dist-tag unless `NPM_DIST_TAG` overrides it

The publish script refuses to publish if the four package versions disagree, if
the version is not semver, or if the major version is not `2`. It also checks
npm before publishing each package and skips package versions that are already
present in the registry, so re-running the same main-branch workflow does not
turn an already-published package into a hard failure.

### npm authentication

The main-branch npm workflow currently requires a repository secret named
`NPM_TOKEN`. Add it under GitHub repository Settings -> Secrets and variables ->
Actions. The token should be an npm automation token that can publish public
packages under the `@valerypopoff` scope.

The workflow verifies the token with `npm whoami` before it runs the publish
script. This catches missing or invalid secrets before the package staging script
gets as far as `npm publish`.

The workflow still grants `id-token: write` and sets npm provenance so published
packages can include provenance metadata. Fully tokenless npm trusted publishing
can be revisited later, but this workflow's expected auth path is the
`NPM_TOKEN` repository secret.

For local publishes, `scripts/publish-npm-packages.mjs` reads repo-root `.env`
before it stages packages. A local `NPM_TOKEN=...` entry is mapped to
`NODE_AUTH_TOKEN` and written only to a temporary npm user config inside the
staging directory while `npm view` / `npm publish` run. The temporary `.npmrc` is
removed before the script exits, including when `--keep-stage` leaves staged
packages available for inspection. The repo-root `.env` file is ignored by Git
and must not be committed. GitHub Actions does not receive local `.env` values;
CI publishes need the repository secret named `NPM_TOKEN`.

### Package staging

[`scripts/publish-npm-packages.mjs`](../scripts/publish-npm-packages.mjs) does
not publish directly from the workspace package directories. It stages clean
temporary package directories containing only package metadata, README/LICENSE
files, and built outputs:

- `dist/cjs`, `dist/esm`, and `dist/types` for `rivet2-core`, `rivet2-node`, and `trivet`
- `bin` and `dist` for `rivet2-cli`

During staging, internal `workspace:^` dependencies are rewritten to the same
published `^2.x` version. For example, `@valerypopoff/rivet2-node` receives a
normal npm dependency on `@valerypopoff/rivet2-core`,
`@valerypopoff/trivet` receives the same normal npm dependency on core, and
`@valerypopoff/rivet2-cli` receives a normal npm dependency on
`@valerypopoff/rivet2-node`.

The public workspace packages intentionally do not define package-level
`publish` lifecycle scripts. Publishing directly from a workspace package
directory is not supported because those manifests can still contain
workspace-only metadata and dependencies. Always use the root
`scripts/publish-npm-packages.mjs` path, or the GitHub workflow that calls it,
so package manifests are staged and normalized before npm sees them.

## `rename-release-assets.yml`

### Trigger conditions

- release `published`
- release `edited`

### Current behavior

Runs `.github/scripts/rename-release-files.mjs`, which:

- enumerates release assets with pagination
- downloads versioned app artifacts
- re-uploads renamed stable filenames under the `Rivet-2` name
- deletes older assets with the same target filename if needed

The workflow does not run `yarn install`; the script uses Node's built-in
`fetch` and the GitHub REST API directly so release-asset aliasing does not pay
the full monorepo dependency install cost. If more than one versioned artifact
normalizes to the same stable filename, the script updates its in-memory asset
map after delete/upload operations so later uploads replace the current alias
without trying to delete an already-deleted stale asset. Upload failures are
collected and fail the workflow after all matching assets have been attempted,
so a green release-asset job means the stable download aliases were actually
created.

Current rename targets include patterns for:

- universal DMG
- AppImage
- Debian package
- Windows setup executable

The script resolves the target repository from `GITHUB_REPOSITORY` and defaults to `valerypopoff/rivet2.0` for local dry runs. Windows setup assets are normalized to `Rivet-2-Setup.exe`, while DMG/AppImage/Debian assets normalize to `Rivet-2.<extension>`.

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
9. publish core, node, Trivet, and cli with `npm publish --access public --registry https://registry.npmjs.org/`

### Operational implication

This script assumes the packages have already been built. It is resumable across
already-published package versions, but it does not version-bump packages or
publish Docker images.

Useful local validation flags:

- `--stage-only`: validate and stage the packages without invoking npm
- `--keep-stage`: keep the temporary staged package directory for inspection;
  npm auth config is still removed before exit
- `--dry-run`: run `npm publish --dry-run` against the staged package directories
- `--skip-clean-check`: allow validation from a dirty working tree; the main-branch GitHub Actions publish workflow uses this only after it has already verified that the checkout was clean before building generated package artifacts

## Release Process As Implemented

The current effective release flow is:

1. update versions in package manifests; for desktop app releases, `packages/app/package.json` is the source and `yarn sync:desktop-version` updates Tauri/Cargo metadata
2. push to `main` to publish npm packages and the current stable Windows/macOS desktop download feed on GitHub Pages
3. push `app-v*` tag for updater-enabled desktop release drafts when that path is needed
4. let `release.yml` create draft desktop artifacts
5. let `rename-release-assets.yml` normalize asset names
6. let the release-page workflows publish the Docusaurus site through GitHub Pages

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
