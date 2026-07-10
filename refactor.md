# Refactor Plan: Security, Reliability, And Maintainability

Status: Completed

Audit date: 2026-07-10

Completion date: 2026-07-10

Baseline: `6dfa1273 Add JSON downloads for web app outputs`

Completion record: `refactor-history.md` item 133

## Purpose

This completed plan identifies the ten highest-value refactors for making Rivet safer, more
reliable, easier to understand, and easier to extend. It is based on the current
code, current dependency graph, `refactor-history.md`, the deleted previous
`refactor.md`, and the feature work added after the June 2026 ownership refactor.

The goals are, in order:

1. Remove known security hazards and make security regressions difficult to add.
2. Reduce bug-prone duplicated policy and implicit state.
3. Give each important behavior one clear owner with behavioral tests.
4. Make the codebase easier to navigate and change without knowing its history.
5. Reduce production code where removal also improves clarity.

This is a refactor plan, not a promise that a single pass can prove the entire
repository bug-free or vulnerability-free forever. The durable target is a codebase
that has explicit trust boundaries, current dependencies, strong regression tests,
and automated checks that keep those properties from silently degrading.

## Historical Reconciliation

`refactor-history.md` is the source of truth for completed work. In particular,
history item 132 records the completed ten-item ownership refactor after
`f11847c5 PRE-refactor`. That work already covered:

- graph-tree presentation models;
- node-output rendering and fullscreen output ownership;
- project comparison;
- theme tokens;
- project tabs and the main strip;
- hosted workspace APIs;
- canvas connection and port interactions;
- node-canvas command glue;
- executor-session ownership;
- the first pass over brittle source-contract tests.

Those areas should not be broadly rewritten again. This plan only returns to a
previously refactored area where later features added new responsibility or current
evidence shows that the original boundary has regrown.

The deleted previous `refactor.md` contained five planned items. They were reassessed
as follows:

- **MCP provider safety** remains valid and is promoted to item 1 because the exact
  logging, environment, and lifecycle gaps still exist.
- **LLM Chat V2 request planning** remains valid, but now also needs to include the
  newer Generate using AI path and model-catalog ownership. It is item 8.
- **Execution event routing** is not repeated as a standalone item. The completed
  executor-session refactor and `projectExecutionSnapshotRouting` already own that
  seam, and post-refactor churn there is lower than the new hotspots in this plan.
- **Canvas wire/port geometry** is not repeated. The completed canvas interaction
  helpers remain the right owners, and no current evidence justifies another broad
  rewrite.
- **GraphProcessor lifecycle ownership** remains valid and is item 9, but its scope
  is narrowed to one extraction at a time to preserve runtime event order and speed.

## Baseline Evidence Snapshot

The plan was grounded in the following pre-refactor observations. They are retained
as baseline evidence and must not be read as descriptions of the completed code:

- `packages/core/src/model/GraphProcessor.ts` is approximately 2,532 physical lines
  and still owns run lifecycle, abort/pause state, node processing, loops, races,
  frozen output replay, subprocessors, user input, and scheduling coordination.
- `packages/app/src/components/renderDataValue/JsonStringPreviewAffordance.tsx` is
  approximately 1,379 physical lines. It was added after the last refactor and owns
  Monaco hit detection, coordinate conversion, hover state, popover placement,
  resizing, persistence, editing, keyboard behavior, and modal rendering.
- `packages/app/src/components/UiGraphBuilder.tsx` is approximately 1,203 physical
  lines and duplicates component knowledge across creation, settings rendering,
  graph-boundary normalization, key validation, drag/drop, and preview orchestration.
- `packages/app/src/components/GraphList.tsx` is approximately 1,403 physical lines.
  It grew again after the graph-tree refactor as Node library and web-app resource
  operations were added directly to the shell.
- `packages/node/src/webAppHandler.ts` is approximately 741 physical lines and embeds
  a second web-app renderer as a `String.raw` client program. The React preview and
  hosted client duplicate component rendering, output formatting, copy/download
  behavior, Markdown policy, state mutation, and action state.
- The app currently has 53 test files that read production source files. The style
  checker reports these but does not prevent new ones. Several recent feature tests
  assert exact source strings and CSS fragments instead of behavior.
- `useMarkdown(...)` currently defaults `allowHtml` to `true`, and multiple project-
  or runtime-controlled surfaces pass its output to `dangerouslySetInnerHTML`.
  `AiAssistEditorBase.tsx` also calls `marked(...)` directly before rendering HTML.
- `NodeMCPProvider.ts` logs the complete stdio server config, does not pass the
  already-supported `config.env` to `StdioClientTransport`, and closes clients only
  on successful operations.
- A recursive Yarn audit on 2026-07-10 reported 2 critical, 92 high, 142 moderate,
  and 17 low entries before runtime/build/exploitability triage. Directly relevant
  outdated surfaces include Hono in the CLI, the MCP SDK in the Node package, `ws`,
  `yaml`, Vite/Rollup, and other workspace dependencies. The repository currently
  has no dependency-audit workflow or Dependabot configuration.
- Workspace content selection is represented by a current graph plus independent
  `nodeLibraryOpenState` and `selectedUiGraphIdState` values. Transitions repeatedly
  clear and set those values manually, which makes impossible mixed states possible
  and duplicates save/snapshot/viewport logic.

These numbers are diagnostics, not line-count targets. A smaller file is useful only
when the resulting owners are clearer and the total system has fewer concepts.

## Completion Evidence

- All ten numbered items below are implemented and marked `DONE`; durable ownership
  and reassessment details are recorded in `refactor-history.md` item 133.
- The final audit fixed additional integration gaps found only by broad verification:
  package-owned generated-client tooling, ancestry-scoped dependency exceptions,
  browser-safe Gentrace imports, a public core web-app runtime entrypoint, and
  Windows-safe app test discovery.
- Full build, aggregate tests, lint, docs typecheck, style/boundary checks, file-tree
  checks, formatting, JavaScript and Rust audits, runtime equivalence/benchmarks, and
  diff hygiene pass. A clean temporary workspace also passes the exact immutable
  cache install used by CI while the developer's live `yarn dev` process remains
  untouched.
- Legacy source-reading tests and long relative imports are no longer open-ended:
  57 reviewed source-reading tests and 154 long-relative imports remain on shrinking
  baselines, while new entries and package source deep imports fail immediately.

## Priority Order

| Order | Refactor                                                | Primary value                        | Relative risk | Expected production LOC                           |
| ----- | ------------------------------------------------------- | ------------------------------------ | ------------- | ------------------------------------------------- |
| 1     | MCP transport, environment, and client lifecycle safety | Security and reliability             | Low-medium    | Decrease                                          |
| 2     | Default-safe Markdown and HTML rendering boundary       | Security                             | Medium        | Neutral or decrease                               |
| 3     | Dependency and toolchain security baseline              | Security and release hygiene         | Medium-high   | Small increase in checks, dependency code removed |
| 4     | Shared Minimal Web App runtime model                    | Correctness and maintainability      | Medium        | Decrease                                          |
| 5     | Schema-driven UI graph builder                          | Maintainability and feature velocity | Medium        | Decrease or neutral                               |
| 6     | Monaco feature and JSON-preview architecture            | Reliability and maintainability      | Medium-high   | Decrease or neutral                               |
| 7     | Project workspace target and navigator ownership        | Correctness and maintainability      | Medium-high   | Decrease                                          |
| 8     | LLM Chat V2 and AI-assist request contract              | Provider correctness and security    | High          | Neutral                                           |
| 9     | GraphProcessor run-lifecycle extraction                 | Runtime correctness                  | High          | Neutral or small increase                         |
| 10    | Behavioral test, boundary, and documentation contracts  | Maintainability and transparency     | Medium        | Test code decreases; small guardrail increase     |

The order favors high benefit with a small blast radius first. Items 4 and 5 are
adjacent intentionally: establish shared web-app runtime policy before simplifying
the editor that creates that policy. Item 10 should also be applied incrementally
inside every earlier item rather than postponed entirely to the end.

## Global Refactor Rules

- Preserve `.rivet-project`, `.rivet-data`, recording, and hosted-wrapper formats
  unless a section explicitly calls out a security-driven compatibility change.
- Preserve public package APIs unless the item names a migration and compatibility
  layer.
- Add characterization tests before moving runtime or UI policy.
- Prefer pure functions and small lifecycle owners over new generic frameworks.
- Do not add an abstraction only to make a large file look smaller.
- Do not introduce a second compatibility path after establishing one owner.
- Measure production line deltas for every item, but reject line savings that make
  code denser or less testable.
- Update the owning developer documentation in the same commit as each code move.
- Keep `refactor-history.md` unchanged until an item is actually complete; then add
  one durable completion entry with scope, outcome, verification, and line delta.
- Run focused tests first, then package typecheck/lint/build according to blast radius.
- Use `git diff --check` for every item.

## 1. MCP Transport, Environment, And Client Lifecycle Safety — DONE

### Why This Is A Priority

MCP is a high-trust integration: it can connect to network servers, start local
processes, and pass environment variables. The current implementation is small but
unsafe in ways that are easy to fix without touching project data or node behavior.

### Current Problem

`packages/node/src/native/NodeMCPProvider.ts` currently:

- logs `serverConfig` directly, which can disclose command arguments and environment
  secrets;
- ignores `serverConfig.config.env`, even though the core MCP contract already
  exposes it;
- repeats open/operation/close code for tools and prompts;
- closes clients only after successful operations, so an exception after connect can
  leave a transport or child process alive;
- reuses the same SDK `Client` after a failed Streamable HTTP connection when trying
  SSE fallback, leaving fallback behavior dependent on SDK internal state;
- contains catch-and-rethrow blocks that add no context and obscure cleanup;
- has no focused tests around fallback, cleanup, or secret handling.

The current dependency audit also reports known issues in the pinned MCP SDK. The SDK
upgrade belongs to item 3, while this item fixes Rivet-owned lifecycle policy.

### Target Ownership

`NodeMCPProvider` should be a thin adapter over two explicit owners:

1. transport creation (`http` with clean Streamable HTTP -> SSE fallback, and
   `stdio` with command/args/env); and
2. `withMcpClient(...)`, which runs one operation and guarantees close in `finally`.

No raw server configuration should reach logs. Diagnostics may identify transport
kind and server id, but never command arguments, headers, environment values, or tool
arguments.

### Detailed Change Plan

1. Add an internal `McpClientFactory`/transport helper under
   `packages/node/src/native/mcp/` or keep a few private functions in
   `NodeMCPProvider.ts` if the final code is still short.
2. Create a fresh client for each HTTP transport attempt. Dispose the failed
   Streamable HTTP attempt before constructing the SSE attempt.
3. Add one `withMcpClient(createClient, operation)` helper with `try/finally` cleanup.
   If both the operation and close fail, preserve the operation error and attach the
   close failure as a cause/diagnostic rather than replacing the useful error.
4. Pass `serverConfig.config.env` into `StdioClientTransport`. Preserve the current
   environment inheritance semantics required by the SDK; merge only if the SDK
   contract requires an explicit full environment.
5. Remove `console.log(serverConfig)` and all redundant catch/rethrow blocks.
6. Deduplicate tool/prompt response mapping in small pure mappers.
7. Decide and document whether each call intentionally creates a short-lived client.
   Do not add connection pooling in this refactor.
8. Add abort/time-limit support only if the existing provider interface already
   carries a signal. Otherwise record it as future functionality rather than widening
   the public contract here.

### Files To Change

- `packages/node/src/native/NodeMCPProvider.ts`
- optional new files under `packages/node/src/native/mcp/`
- `packages/core/src/integrations/mcp/MCPProvider.ts` only for clarified comments or
  an internal type correction; keep the public shape compatible
- new focused tests under `packages/node/test/`
- `developer-docs/PACKAGES.md`
- `developer-docs/CORE-ENGINE.md`

### Verification

- Streamable HTTP success does not construct SSE.
- Streamable HTTP failure closes its attempt and retries with a fresh SSE client.
- Tool, list-tools, list-prompts, and get-prompt operations close on success and
  failure.
- Stdio receives command, args, and env exactly once.
- No config/env/tool payload appears in captured logs or normalized errors.
- Existing MCP nodes still map SDK responses to the same Rivet data shapes.
- Node package tests, typecheck/build, lint, and `git diff --check` pass.

### Risks And Mitigations

- **SDK fallback semantics may differ after upgrade.** Characterize current accepted
  Streamable HTTP and SSE behavior before changing the dependency.
- **Environment merging can drop `PATH`.** Test inherited and explicit env behavior
  on Windows, macOS, and Linux-compatible inputs.
- **Close failures can mask operation failures.** Preserve the first failure.
- **Pooling could look attractive while refactoring.** Keep clients short-lived until
  a separate performance requirement proves pooling is worth its lifecycle cost.

### Result After Refactor

MCP calls have one cleanup path, configured stdio env works, secrets are not logged,
and the adapter is shorter. Public node/YAML behavior remains unchanged.

## 2. Default-Safe Markdown And HTML Rendering Boundary — DONE

### Why This Is A Priority

Rivet renders project-authored text, plugin descriptions, LLM output, user-input
questions, comments, and AI-assist errors. These are untrusted content surfaces even
inside a desktop app. A permissive shared default plus `dangerouslySetInnerHTML`
creates an avoidable script/unsafe-link injection boundary.

### Current Problem

`packages/app/src/hooks/useMarkdown.ts` defaults `allowHtml` to `true`. Callers that
do not pass options therefore render raw Markdown HTML. Current sinks include:

- `NodeBody.tsx` and `nodes/CommentNode.tsx` for project content;
- `renderDataValue/createScalarRenderers.tsx` for runtime/LLM output;
- `UserInputModal.tsx` for graph-provided questions;
- `ContextMenu.tsx` and `pluginsOverlay/PluginCatalogItem.tsx` for node/plugin metadata;
- `AiAssistEditorBase.tsx`, which bypasses the shared helper and calls `marked(...)`
  directly before `dangerouslySetInnerHTML`;
- other static Trivet and modal surfaces.

Escaping raw HTML tokens is also not a complete sanitizer: Markdown links/images and
future renderer extensions need an explicit URL/attribute policy. The existing web-
app renderer is safer because it passes `allowHtml: false`, but its hosted client has
a separate Markdown implementation.

### Target Ownership

Introduce one safe rich-text boundary with explicit trust modes:

- `untrusted`: sanitize generated Markdown HTML, reject active content and unsafe URL
  schemes, and use this as the default;
- `trusted-static`: allowed only for checked-in constant content, with an explicit
  call-site annotation; and
- `plain`: no HTML rendering.

No component should call `marked(...)` or assign generated HTML directly. Every
`dangerouslySetInnerHTML` sink should receive a branded/specially named sanitized
result or be documented as static compile-time HTML.

### Detailed Change Plan

1. Replace `allowHtml?: boolean` with an explicit rendering policy, or keep it as a
   deprecated adapter while making the default safe.
2. Use a maintained sanitizer rather than writing an ad hoc regex sanitizer. Define a
   narrow allowlist for headings, paragraphs, emphasis, lists, blockquotes, tables,
   code/pre, and safe links.
3. Allow only intended protocols (`http`, `https`, `mailto`, and relative/hash links
   if required). Strip `javascript:`, event handlers, style injection, iframes,
   objects, and SVG active content.
4. Route `AiAssistEditorBase.tsx` through the same helper and remove its direct
   `marked` import.
5. Inventory every `dangerouslySetInnerHTML` and `innerHTML` use. Keep YAML diff HTML
   only if its generator is proven to escape content; otherwise sanitize it too.
6. Make plugin-supplied and project-supplied metadata untrusted by definition.
7. Keep a small trusted-static path only where needed for checked-in prose. Prefer
   using the untrusted path everywhere if visual output is identical.
8. Add a repository check that rejects new unapproved raw HTML sinks and direct
   `marked(...)` calls outside the renderer owner.
9. Coordinate the hosted web-app sanitizer with item 4 so the desktop preview and
   hosted client use the same policy and fixtures.

### Files To Change

- `packages/app/src/hooks/useMarkdown.ts`
- new Markdown/sanitization helpers under `packages/app/src/utils/markdown/` or a
  shared runtime location selected by item 4
- `packages/app/src/components/NodeBody.tsx`
- `packages/app/src/components/nodes/CommentNode.tsx`
- `packages/app/src/components/renderDataValue/createScalarRenderers.tsx`
- `packages/app/src/components/UserInputModal.tsx`
- `packages/app/src/components/ContextMenu.tsx`
- `packages/app/src/components/pluginsOverlay/PluginCatalogItem.tsx`
- `packages/app/src/components/editors/custom/AiAssistEditorBase.tsx`
- `packages/app/src/components/NodeChangesModal.tsx`
- `packages/node/src/webAppHandler.ts` or the generated client owner from item 4
- app/node package manifests and `yarn.lock` for the sanitizer dependency
- `scripts/checks/` for the sink guard
- `developer-docs/APP-ARCHITECTURE.md`
- `developer-docs/PACKAGES.md`

### Verification

- Script tags, event attributes, unsafe URLs, SVG payloads, malformed tags, and nested
  encoded payloads do not execute or survive sanitization.
- Ordinary Markdown, fenced code, tables, links, and existing styling remain stable.
- LLM output and user-input questions use the safe path.
- Web-app desktop and hosted Markdown produce equivalent sanitized DOM.
- No direct `marked(...)` + `dangerouslySetInnerHTML` pair remains outside the owner.
- App tests/typecheck/lint/build and hosted renderer tests pass.

### Risks And Mitigations

- **Some users may rely on raw HTML in Comment/Text output.** This is an intentional
  security hardening. Document it clearly and consider a future sandboxed component
  instead of preserving unsafe inline HTML execution.
- **Sanitization can change Markdown output.** Lock the supported tag/attribute
  contract with fixtures before switching all callers.
- **Browser and Node sanitizer behavior can drift.** Share policy and fixture tests;
  do not maintain two handwritten allowlists.

### Result After Refactor

Untrusted Markdown is safe by default, raw HTML sinks are auditable, and components
lose repeated rendering choices. The only visible changes should be removal of unsafe
HTML/URL behavior.

## 3. Dependency And Toolchain Security Baseline — DONE

### Why This Is A Priority

Code-level hardening cannot compensate for known vulnerable runtime libraries. The
current lockfile contains old direct dependencies and no automated audit gate, so
fixed advisories can remain indefinitely or reappear during unrelated installs.

### Current Problem

The 2026-07-10 recursive audit found a large advisory backlog. Not every entry ships
in every artifact, but several are directly connected to Rivet runtime surfaces:

- CLI HTTP serving uses old `hono` and `@hono/node-server` versions with routing,
  static-file, auth, CORS, and denial-of-service advisories.
- Node MCP support uses an old `@modelcontextprotocol/sdk` with ReDoS, cross-client
  state, and DNS-rebinding advisories.
- app/node WebSocket dependencies are below patched `ws` releases.
- app/core YAML and JSONPath dependencies need advisory-specific review because they
  parse user/project-controlled expressions and data.
- Vite/Rollup and related development servers/build tools have file-read/write and
  dev-server advisories relevant to local development.
- old packaging/build chains (`pkg`, pnpm embedded as an app dependency, old CRA/
  Docusaurus ancestry) pull in many vulnerable or abandoned transitive packages.
- Tauri/Rust dependencies have no automated `cargo audit`/`cargo deny` gate.
- root metadata disagrees about toolchain ownership (`packageManager` uses Yarn 4.6,
  while `volta.yarn` still names Yarn 3.5).

### Target Ownership

Create a repeatable dependency-security process with three classified graphs:

1. shipped runtime dependencies;
2. build/release dependencies that process repository or untrusted inputs; and
3. docs/test-only dependencies.

CI should fail on new unreviewed high/critical findings in each relevant artifact,
not merely dump an untriaged monorepo report.

### Detailed Change Plan

1. Add a script that records audit output as structured data and maps findings to
   workspaces/artifacts. Do not parse human-formatted text.
2. Upgrade direct runtime dependencies first: Hono, MCP SDK, `ws`, `yaml`,
   `jsonpath-plus`, and any directly exploitable HTTP/parser package.
3. Upgrade Vite/Rollup and plugins as one tested build-tool batch. Verify desktop dev,
   browser-hosted app, Monaco workers, and release bundles.
4. Remove obsolete type stubs already supplied by their packages.
5. Review whether `pnpm` and `pkg` must remain app dependencies. If they are only
   build tools, isolate them from shipped runtime dependencies; if `pkg` is no longer
   supportable, plan a sidecar packaging replacement without changing it silently.
6. Upgrade or isolate old docs tooling so documentation-only vulnerabilities do not
   block runtime releases forever, while still keeping a separate docs audit.
7. Add Rust auditing for `packages/app/src-tauri/Cargo.lock`. Review the broad Tauri 1
   capability set (`http-all`, `fs-all`, `shell-execute`, etc.) separately; remove
   capabilities that the app no longer uses.
8. Add `.github/dependabot.yml` (or an equivalent update bot) for Yarn and Cargo with
   grouped, reviewable updates rather than noisy one-package PRs.
9. Add a checked-in, expiry-based exception file only for advisories that cannot yet
   be removed. Every exception must name scope, exploitability, owner, and expiry.
10. Add a CI job that uses the same Yarn binary and immutable cache policy as normal
    workflows. Cache audit metadata where possible without weakening freshness.
11. Align Node/Yarn version declarations across `package.json`, Volta, workflows,
    docs, and release scripts.

### Files To Change

- root `package.json`, `.yarnrc.yml`, and `yarn.lock`
- `packages/*/package.json`, especially app, core, node, CLI, app-executor, and docs
- `packages/app/src-tauri/Cargo.toml` and `Cargo.lock`
- `.github/dependabot.yml`
- `.github/workflows/build.yml` and release/publish workflows through a shared audit
  job or reusable workflow
- new scripts/config under `scripts/checks/`
- `developer-docs/BUILD-AND-CI.md`
- `developer-docs/PACKAGES.md`
- root `README.md` if supported toolchain requirements change

### Verification

- Zero unreviewed critical/high findings in shipped runtime artifacts.
- Any temporary exception has a reason and expiry and is checked by CI.
- `yarn install --immutable --immutable-cache` passes on Linux, Windows, macOS, x64,
  and arm64 workflow variants without inflating every job unnecessarily.
- Root build, test, lint, docs typecheck, CLI smoke tests, app dev startup, desktop
  sidecar preparation, and Tauri release builds pass.
- `cargo audit`/chosen Rust gate passes or produces only explicit exceptions.
- Published package smoke tests still load CJS/ESM exports.

### Risks And Mitigations

- **Large dependency jumps can hide behavior changes.** Upgrade by runtime group and
  commit separately, with focused compatibility tests.
- **A monorepo-wide zero-warning gate can be impractical initially.** Gate new and
  high-impact findings immediately, then burn down reviewed lower-severity debt.
- **Tauri major migration is large.** Do not combine a Tauri 2 migration with routine
  dependency patching unless an unpatchable security issue forces it.
- **Audit output changes over time.** Store policy, not a frozen count.

### Result After Refactor

Rivet has a current, coherent toolchain; known runtime vulnerabilities are removed or
explicitly time-bounded; and CI prevents silent reintroduction.

## 4. Shared Minimal Web App Runtime Model — DONE

### Why This Is A Priority

Minimal Web Apps now run in the desktop preview, detached Tauri window, Node handler,
CLI, and wrapper servers. The feature works, but the same six components are rendered
by both React and a large embedded JavaScript string. Every new action currently has
to be implemented and tested twice.

### Current Problem

Behavior is split across:

- `packages/app/src/components/rivetWebApps/RivetWebAppRenderer.tsx`;
- the `WEB_APP_CLIENT_JS` string in `packages/node/src/webAppHandler.ts`;
- shared CSS in `packages/core/src/model/UiGraphRendererStyles.ts`;
- action/state helpers in `packages/core/src/model/UiGraph.ts`;
- source-reading parity tests in `UiGraphBuilderLayout.test.ts`.

The two renderers duplicate:

- output formatting and missing-value handling;
- copy and JSON-download behavior/filenames;
- Markdown conversion and safety policy;
- button pending/error state;
- component labels and state reads/writes;
- revision-mismatch UI;
- DOM class names and accessibility labels.

The embedded string previously broke because normal template-string escaping changed
its regex/string contents. This is a structural warning: production browser code
should be compiled and tested as code, not maintained as a handwritten string.

### Target Ownership

Create a framework-neutral `UiGraphRuntimeModel` that owns state transitions,
component render data, output actions, action payloads, and error/revision states.
Keep two thin view adapters only where necessary:

- React adapter for editor preview/cross-highlighting/drag handles;
- DOM adapter for hosted HTML.

The hosted client must be authored as normal TypeScript/JavaScript and bundled into
an embeddable asset at build time. `webAppHandler.ts` should own HTTP routing and HTML
assembly, not client implementation details.

### Detailed Change Plan

1. Move pure output formatting, value-presence checks, JSON download serialization,
   filename generation, action request construction, and state patch reduction into
   core/shared helpers.
2. Define an exhaustive component-to-render-model function. Adding a new
   `UiGraphComponent` should fail TypeScript until the model and both adapters handle
   it.
3. Extract hosted client code from `webAppHandler.ts` into a normal source file.
4. Add a small build step that bundles that client to a deterministic string/asset
   consumed by the Node package. Verify that package publishing includes it.
5. Keep `renderRivetWebAppHtml(...)` synchronous if the public API requires it by
   loading a generated module constant, not by reading mutable source files at
   request time.
6. Put Markdown sanitization behind item 2's shared policy and fixtures.
7. Keep CSS tokens in `UiGraphRendererStyles.ts`, but move document reset, runtime
   classes, and component classes into clearly named exports if that improves asset
   assembly.
8. Convert desktop and hosted parity tests from source regexes to shared runtime-model
   fixtures and DOM/HTML assertions.
9. Preserve `createRivetWebAppHandler`, `renderRivetWebAppHtml`, and
   `runRivetWebAppAction` API behavior.
10. Add a generated-asset freshness check similar to the graph-creator data check so
    a source edit cannot ship with a stale embedded client.

### Files To Change

- `packages/core/src/model/UiGraph.ts`
- `packages/core/src/model/UiGraphRendererStyles.ts`
- new shared runtime-model files near `UiGraph.ts`
- `packages/app/src/components/rivetWebApps/RivetWebAppRenderer.tsx`
- `packages/app/src/components/rivetWebApps/RivetWebAppPreviewWindow.tsx`
- `packages/node/src/webAppHandler.ts`
- new Node/browser client source and generated-asset module
- Node/core/app bundle scripts and package `files` lists as needed
- CLI `serve-app` tests that consume the public Node API
- `scripts/checks/` for generated client freshness
- `developer-docs/CORE-ENGINE.md`
- `developer-docs/PACKAGES.md`
- `developer-docs/APP-ARCHITECTURE.md`

### Verification

- One fixture suite covers all component types in both adapters.
- Desktop preview and hosted HTML have identical state/output/label/action behavior.
- Markdown attack fixtures are safe in both adapters.
- Copy/download filenames and payloads match.
- Revision mismatch and non-revision errors render consistently.
- Wrapper-facing and CLI handler tests remain compatible.
- Generated asset freshness is enforced in local style checks and release workflows.

### Risks And Mitigations

- **A shared runtime can become an abstract UI framework.** Limit it to the current
  declarative component contract and pure state/render data.
- **Generated assets can go stale.** Make generation deterministic and checked.
- **Desktop editor needs wrappers not present in hosted mode.** Keep drag handles and
  active-component frames in the React adapter, outside the shared runtime.
- **Public HTML output can change.** Characterize route, payload, class, and
  accessibility contracts first.

### Result After Refactor

New web-app behavior is implemented once, hosted client code is normal testable
source, `webAppHandler.ts` becomes smaller, and wrapper/desktop parity stops relying
on regex tests and human synchronization.

## 5. Schema-Driven UI Graph Builder — DONE

### Why This Is A Priority

`UiGraphBuilder.tsx` was added after the previous refactor and already exceeds 1,200
physical lines. Minimal Web Apps are likely to gain components, so duplicating every
component rule across switches will compound quickly.

### Current Problem

The file currently owns:

- the entire settings/preview layout and most CSS;
- component palette and creation defaults;
- per-component settings fields;
- drag/drop and active-component synchronization;
- graph selection and Graph Input/Output boundary synchronization;
- data-key producer/consumer discovery and duplicate warnings;
- read-only graph port rows;
- desktop preview availability and launching;
- direct project mutation for every field.

Component knowledge appears in multiple switches (`renderComponentFields`,
`createUiComponent`, type-name formatting) and in separate data-key/boundary helpers.
This makes a new component easy to implement incompletely.

### Target Ownership

Use a typed, finite component descriptor table. Each descriptor should own only:

- display name and palette metadata;
- default construction;
- settings editor component;
- declared data-key reads/writes;
- optional validation.

Graph action binding normalization should remain a separate pure model because it is
specific to button/graph boundaries, not a generic component concern.

### Detailed Change Plan

1. Extract pure graph-boundary synchronization (`normalizeButtonAction...`, row
   alignment/equality) to `uiGraphBuilder/buttonBindings.ts`.
2. Extract data-key usage/indexing and duplicate detection to
   `uiGraphBuilder/dataKeys.ts`.
3. Add an exhaustive descriptor map keyed by `UiGraphComponent['type']` with typed
   constructors and labels.
4. Split component settings into focused components under
   `components/uiGraphBuilder/settings/`. Keep small components together; do not
   create one file per trivial field.
5. Add one `updateUiGraph`/`updateComponent` mutation boundary so nested field editors
   do not each know how to clone and write `project.uiGraphs`.
6. Ensure graph changes reconcile button mappings through the pure binding owner.
7. Keep preview drag/drop in a dedicated `UiGraphPreviewEditor` component and keep
   hosted rendering in the renderer from item 4.
8. Move large builder CSS to a colocated style module only if it improves navigation;
   avoid splitting CSS solely to lower the main file count.
9. Keep project YAML and existing UI component types unchanged.
10. Add descriptor exhaustiveness tests so every component has defaults, settings,
    and data-key policy.

### Files To Change

- `packages/app/src/components/UiGraphBuilder.tsx`
- new files under `packages/app/src/components/uiGraphBuilder/`
- `packages/core/src/model/UiGraph.ts` only for shared type helpers, not editor UI
- `packages/core/src/model/GraphBoundaryCache.ts` consumers as needed
- `packages/app/src/state/uiGraphs.ts`
- UI graph builder tests, replacing large source contracts with pure/model tests
- `developer-docs/APP-ARCHITECTURE.md`
- `developer-docs/CORE-ENGINE.md`

### Verification

- Every current component creates the same serialized data and renders the same
  settings.
- Selecting a graph creates exactly the rows represented by its Graph Input/Output
  boundary and preserves existing compatible data-key mappings.
- Duplicate producer warnings and consumer dropdown options remain correct after
  reorder/delete/type changes.
- Dragging remains vertical-only and preview cross-highlighting remains bidirectional.
- Desktop preview gating and detached launch remain unchanged.
- Serialization round trips are byte/semantic equivalent for unchanged projects.

### Risks And Mitigations

- **Descriptor tables can hide React complexity in configuration.** Keep actual field
  rendering in normal components; use the table for ownership/exhaustiveness.
- **Mutation helper can capture stale project state.** Use functional atom updates and
  pure recipes.
- **Boundary reconciliation can erase user keys.** Characterize current preservation
  rules before extraction.

### Result After Refactor

The builder shell is substantially smaller, adding a component has one obvious path,
and graph-binding/data-key correctness is testable without rendering the full editor.

## 6. Monaco Feature And JSON-Preview Architecture — DONE

### Why This Is A Priority

Monaco now supports model/view-state caching, folding, interpolation diagnostics,
Markdown folding, schema navigation, spellcheck, text tools, font sizing, fullscreen
search, and editable decoded JSON strings. The features are valuable, but lifecycle
and overlay behavior are concentrated in broad components that have already required
many bug-fix iterations.

### Current Problem

There are two broad owners:

- low-level `packages/app/src/components/CodeEditor.tsx` creates Monaco and manually
  installs/disposes every feature;
- node-settings `packages/app/src/components/editors/CodeEditor.tsx` owns field UI,
  footer, AI assist, resizing, validation, Escape priority, and decoded-string wiring.

`JsonStringPreviewAffordance.tsx` alone owns geometry, hover/focus lookup, refs mirroring
state, button portals, popover portals, scroll revalidation, resize listeners,
persistent size, edit-modal resize, Monaco edits, and CSS. Coordinate bugs have
recurred because detection, placement, and view rendering are interleaved.

### Target Ownership

Define an explicit editor capability/lifecycle model:

- low-level Monaco owner: create/dispose/model/view state/layout;
- feature installers: each returns one `IDisposable` and declares its language/
  read-only requirements;
- node-editor chrome: footer, validation, AI assist, field sizing;
- decoded-string controller: pure active-range and placement decisions;
- decoded-string views: button/popover and editor-only edit modal.

### Detailed Change Plan

1. Introduce a `CodeEditorCapabilities` object instead of adding more unrelated
   booleans. Preserve current props through an adapter during migration.
2. Build one disposer collection for spellcheck, text tools, definition navigation,
   interpolation, comment highlighting, keyboard hooks, and model listeners.
3. Move text-tool action registration and spellcheck action ownership out of the
   React component into focused installers.
4. Keep global language/provider registration idempotent and separate from per-editor
   registration.
5. Split `JsonStringPreviewAffordance` into:
   - pure geometry/clamping functions;
   - a Monaco range/viewport adapter;
   - a small interaction controller/hook;
   - `JsonStringPreviewPopover`;
   - `EditJsonStringModal`.
6. Use one coordinate system per rendered surface and convert only at the portal
   boundary. Represent anchor rectangles explicitly instead of passing ambiguous
   `left`/`top` values.
7. Centralize outside-click, Escape, scroll, text-change, and unmount close reasons in
   a small state machine/reducer. Avoid parallel booleans and refs for the same state.
8. Keep persistent width/height preferences in Jotai but move clamp/default logic next
   to the stored state schema.
9. Keep Monaco replacement via `executeEdits` and validate that a stale range/model
   cannot overwrite newly edited text.
10. Preserve model cache/folding state behavior and separate editable/fullscreen font
    sizes.
11. Add a minimal browser-level interaction harness only for portal coordinates,
    pointer activation, and resize behavior that pure tests cannot prove.

### Files To Change

- `packages/app/src/components/CodeEditor.tsx`
- `packages/app/src/components/editors/CodeEditor.tsx`
- `packages/app/src/components/editors/DefaultNodeEditor.tsx`
- `packages/app/src/components/renderDataValue/JsonStringPreviewAffordance.tsx`
- `packages/app/src/components/renderDataValue/FoldingCodeBlock.tsx`
- new modules under `packages/app/src/utils/monaco/` and
  `packages/app/src/components/renderDataValue/jsonStringPreview/`
- `packages/app/src/state/ui.ts` or a focused editor-preferences state module
- focused Monaco/JSON preview tests
- `developer-docs/APP-ARCHITECTURE.md`

### Verification

- Editor mount/unmount leaves no Monaco model markers, listeners, DOM portals, or
  window resize listeners behind.
- Folding and cursor/scroll state restore only for the correct project/node/editor.
- Escape closes suggest/find/preview UI before node settings.
- Preview buttons stay at string ends, never create panel overflow, and hide when the
  anchor is outside the Monaco viewport.
- Popovers open beside the clicked button and remain stable during valid scrolling.
- Resize preferences and edit-modal size persist without jump/dead-zone behavior.
- Fullscreen remains read-only; node settings can edit with undo/redo.
- Search decorations, selection, wrapping, and clipboard behavior remain unchanged.

### Risks And Mitigations

- **Monaco lifecycle bugs are subtle.** Preserve current feature tests and add cleanup
  tests before moving installers.
- **Ref reduction can introduce stale closures.** The controller should consume an
  explicit current snapshot and event, not hide mutable state in many callbacks.
- **Portal tests can be brittle.** Test pure geometry broadly and keep only a few real
  browser interaction tests.

### Result After Refactor

Monaco features become composable and disposable, decoded-string UI has clear
geometry/controller/view ownership, and future editor features do not enlarge one
mount effect or one 1,300-line overlay component.

## 7. Project Workspace Target And Navigator Ownership — DONE

### Why This Is A Priority

Graphs, Node library, and web apps are three mutually exclusive workspace targets,
but the app represents them through independent state. Historical bugs where graphs
or linked nodes appeared/disappeared on alternating navigation demonstrate how easy
it is for snapshot and selection policy to drift.

### Current Problem

- A graph is always present in `graphState`.
- Node library selection is a separate boolean (`nodeLibraryOpenState`).
- Web-app selection is a separate optional id (`selectedUiGraphIdState`).
- `RivetApp`, `GraphList`, hotkeys, context menus, workspace transitions, and run
  gating each reconstruct which target is actually active.
- `switchGraph`, `switchToNodeLibrary`, and `switchToUiGraph` repeat persistence,
  current-graph merge, viewport save, snapshot update, selection reset, and modal
  cleanup logic.
- `GraphList.tsx` directly owns UI graph create/duplicate/delete, graph/folder menus,
  confirmation modals, header actions, sections, filtering, and drag/drop.

Independent values permit impossible states such as Node library and a UI graph both
being selected. Current functions usually clear them correctly, but correctness
depends on every caller remembering every atom.

### Target Ownership

Introduce a project-scoped transient workspace target:

```ts
type ProjectWorkspaceTarget =
  | { type: 'graph'; graphView: GraphViewContext }
  | { type: 'nodeLibrary'; editingPrefabId?: NodePrefabId }
  | { type: 'uiGraph'; uiGraphId: UiGraphId };
```

One transition coordinator should persist the target being left, commit the live
graph when needed, switch the target atomically, restore target-local view state, and
update navigation history. Project YAML remains unchanged.

### Detailed Change Plan

1. Characterize all entry points: sidebar, graph history, subgraph links, Node library
   links, search, context menus, project-tab switching, opening/closing projects, and
   hosted workspace replacement.
2. Add a pure transition plan that separates `leave current target`, `commit live
graph`, `enter target`, and `restore viewport/selection` effects.
3. Introduce the discriminated target as transient per-project editor state. Keep
   adapters for old atoms while consumers migrate; remove adapters at completion.
4. Deduplicate the repeated graph-save/snapshot/viewport block in
   `useWorkspaceTransitions.ts`.
5. Make run/save/menu eligibility derive from the target, not ad hoc booleans.
6. Extract explicit `useUiGraphOperations` and Node library operations instead of
   mutating project resources inside `GraphList.tsx`.
7. Split `GraphList` into header actions, web-app resource section, graph/folder
   section, context-menu dispatch, and dialogs. Keep `useGraphListPresentation` as
   the existing graph-row presentation owner.
8. Preserve graph navigation history semantics for Page Up/Page Down/Home and decide
   explicitly whether UI graphs participate. Do not infer behavior from stale graph
   state.
9. Store target-local canvas state only where meaningful: graphs and Node library use
   canvas view state; UI graphs use builder state.
10. Add invariant checks in development/tests that exactly one target is active.

### Files To Change

- `packages/app/src/hooks/useWorkspaceTransitions.ts`
- `packages/app/src/hooks/useLoadGraph.ts`
- `packages/app/src/hooks/useOpenNodeLibrary.ts`
- `packages/app/src/hooks/useOpenUiGraph.ts`
- `packages/app/src/state/nodeLibrary.ts`
- `packages/app/src/state/uiGraphs.ts`
- project editor/snapshot state under `packages/app/src/state/` and `utils/`
- `packages/app/src/components/RivetApp.tsx`
- `packages/app/src/components/GraphList.tsx`
- existing/new components under `packages/app/src/components/graphList/`
- `packages/app/src/hooks/useCanvasHotkeys.ts`
- search/navigation/context-menu consumers
- `developer-docs/APP-ARCHITECTURE.md`
- `developer-docs/EXECUTION-DATA-FLOW.md`

### Verification

- Switching graph -> Node library -> graph never alternates between stale snapshots.
- Unsaved graph edits survive switching to Node library/UI graph and project tabs.
- Node library selection cannot also select a graph folder or UI graph.
- Deleting the active UI graph chooses the same fallback graph as today.
- History keys and viewport restore remain deterministic.
- Run commands are unavailable only for non-executable targets.
- Hosted open/replace/close and dirty baselines remain unchanged.
- GraphList behavioral tests replace target-related source assertions.

### Risks And Mitigations

- **This touches persistence-sensitive transitions.** Build pure transition tests and
  replay the known historical bug scenarios before changing atoms.
- **Adapters can become permanent duplication.** Add a completion gate that removes
  old independent selection atoms.
- **Graph history may mix target kinds unexpectedly.** Specify and test the intended
  history contract before implementation.

### Result After Refactor

Workspace selection has one valid state, transition code is shorter, `GraphList` is a
shell again, and adding another project resource no longer requires new booleans in
every app subsystem.

## 8. LLM Chat V2 And AI-Assist Request Contract — DONE

### Why This Is A Priority

Provider request behavior is externally visible and expensive to debug. Recent issues
included hidden retries, accidental streaming, structured-output compatibility,
custom-provider keys, model listing, Azure endpoint leakage, tool continuation, and
AI generation using stale helper nodes. The Vercel SDK-powered path is now the product
path; legacy Chat must remain isolated.

### Current Problem

Policy is spread across:

- `llmChatV2NodeRuntime.ts` and `chatV2RuntimeOptions.ts`;
- `chatV2Pipeline.ts`, `aiSdkBridge.ts`, response-format/provider-option/tool/retry
  helpers;
- `llmChatV2NodeEditors.ts` and app model-catalog editors;
- `LlmSettingsPage.tsx`, which keeps module-level refresh maps;
- `aiAssistModelSettings.ts` and `aiAssistVercelGenerator.ts`;
- hidden graph-based AI assist and graph-builder orchestration.

AI assist reuses `runChatV2Pipeline`, which is good, but it creates an app-owned
dynamic node implementation and has its own provider/model/credential selection
layer. The final request cannot be explained by one serializable, secret-free object.

### Target Ownership

Add two explicit contracts:

1. `ChatV2ProviderProfile`: provider, model, normalized base URL, capability flags,
   and a credential reference/result that is never logged; and
2. `ChatV2RequestPlan`: transport mode, retry policy, messages, tools, response
   format, provider options, generation parameters, and output policy.

`LLM Chat`, Generate using AI, and AI graph builder should consume the same profile
and request planner. They may supply different prompts/tools/output policies, but
must not rebuild provider transport decisions.

### Detailed Change Plan

1. Add pure `buildChatV2RequestPlan(...)` with no network calls and no raw secret
   value in its debug/inspection representation.
2. Move stream-vs-generate, max retries, response-format compatibility, structured
   output, tool choice, and provider options into the plan.
3. Make `chatV2Pipeline` execute the plan and assemble outputs; do not let it infer
   the same policy again.
4. Consolidate provider/model/base-URL/credential resolution so app settings,
   programmatic settings, env fallback, input-port keys, and named custom keys have
   one precedence table.
5. Keep request-body capture tied to the actual AI SDK transport callback, not a
   reconstructed artifact.
6. Extract model-catalog fetch/cache/status ownership from `LlmSettingsPage.tsx` and
   `LLMChatV2ModelCatalogEditor.tsx` into one service keyed by provider + base URL +
   credential identity. Avoid module-level mutable maps in view components.
7. Replace `graphApi` compatibility naming in AI-assist settings with provider-native
   terms after proving no persisted consumer depends on it.
8. Decide whether the AI-assist generator node definition belongs in core as an
   internal reusable node or whether a direct shared service is simpler. Keep the
   graph builder's tool-loop semantics unchanged.
9. Add an enforcement test that app AI generation cannot import/use legacy Chat or
   Azure configuration.
10. Keep legacy Chat compatibility code isolated and frozen. Do not refactor legacy
    provider files into the new contract unless deleting them becomes a separately
    approved breaking change.

### Files To Change

- `packages/core/src/model/chat-v2/chatV2Pipeline.ts`
- `packages/core/src/model/chat-v2/aiSdkBridge.ts`
- `packages/core/src/model/chat-v2/chatV2RuntimeOptions.ts`
- `packages/core/src/model/chat-v2/providerOptions.ts`
- `packages/core/src/model/chat-v2/chatV2ResponseFormat.ts`
- `packages/core/src/model/chat-v2/chatV2Types.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- `packages/app/src/utils/aiAssistModelSettings.ts`
- `packages/app/src/utils/aiAssistVercelGenerator.ts`
- `packages/app/src/components/settings/pages/LlmSettingsPage.tsx`
- `packages/app/src/components/editors/custom/LLMChatV2ModelCatalogEditor.tsx`
- `packages/app/src/hooks/useAiGraphBuilder.ts`
- `packages/app/src/components/editors/custom/AiAssistEditorBase.tsx`
- focused core/app tests
- `developer-docs/LLM-CHAT-V2-CONTRACT.md`
- `developer-docs/CORE-ENGINE.md`
- `developer-docs/APP-ARCHITECTURE.md`

### Verification

- Request-plan fixtures cover every provider and transport mode without live calls.
- Stream response off always chooses generate mode, including tools.
- AI SDK retries remain disabled; Rivet retries exactly match node settings.
- JSON object and JSON Schema modes omit unsupported options consistently.
- Tool continuation, usage, partial output, and request-body outputs are unchanged.
- Settings and node editor model catalogs share refresh/error/cache behavior.
- Every credential source precedence is tested, including named custom programmatic
  keys, and no secret appears in plan snapshots/errors/cache logs.
- Generate using AI and AI graph builder run through Chat V2 only.

### Risks And Mitigations

- **Request shape changes can break providers.** Snapshot normalized request plans and
  transport calls before switching execution.
- **Secret-free plans can accidentally omit runtime credentials.** Separate the
  inspectable plan from a non-serializable execution credential reference.
- **Provider capabilities change with AI SDK versions.** Keep capability policy
  explicit and version-tested, not inferred from warnings.
- **AI graph builder has tool-loop-specific behavior.** Preserve its graph and tool
  semantics while replacing only provider/request ownership.

### Result After Refactor

One request plan explains what Rivet sends, all Vercel SDK consumers share provider
policy, model fetching leaves view components, and legacy Chat cannot silently leak
back into new features.

## 9. GraphProcessor Run-Lifecycle Extraction — DONE

### Why This Is A Priority

`GraphProcessor` is Rivet's runtime heart and the largest production TypeScript file.
It has already benefited from targeted extractions, characterization tests, and
runtime-speed work. A broad rewrite would be reckless, but leaving all remaining
mutable lifecycle policy in one class keeps every runtime feature expensive to
change.

### Current Problem

The class still owns, among other concerns:

- run initialization/finalization and finish-once behavior;
- abort, pause, resume, and per-node abort-controller bookkeeping;
- graph/node event metadata and timing;
- compatible and fast scheduling coordination;
- node readiness, exclusion, loops, races, and downstream queueing;
- normal, split, frozen, and preloaded node execution;
- project references and subprocessors;
- user input and globals.

History explicitly warns to extract one policy at a time. The runtime-speed work also
means any refactor must preserve allocations and hot-path complexity, not only output
equivalence.

### Target Ownership

The first extraction should be `GraphRunLifecycle` (or an equally narrow name) that
owns pure state transitions and finish/abort bookkeeping. `GraphProcessor` should
continue emitting events and orchestrating scheduling until tests prove another move
safe.

### Detailed Change Plan

1. Extend existing characterization tests before moving code. Record event order,
   metadata, errors, abort reasons, and finish count for normal/error/abort/subgraph/
   frozen/recording cases.
2. Define a small lifecycle state object with explicit states such as idle, running,
   paused, aborting, and finished. Avoid an elaborate generic state-machine library.
3. Move initialization/reset decisions currently spread across `#initProcessState`,
   `#initializeGraphRun`, finish guards, and abort flags into the lifecycle owner.
4. Let the owner return effects/decisions; keep actual emitter calls in
   `GraphProcessor` during the first phase so event order remains visible.
5. Move node abort-controller registration/unregistration/abort-all into a focused
   registry only if it can be tested independently without changing signal timing.
6. Do not move scheduler selection, ready queues, loops, races, or subprocessors in
   the same commit.
7. Benchmark before/after using the existing runtime matrix. Reject extra per-node
   allocations in hot paths.
8. After the first extraction, reassess the file. A second extraction is allowed only
   if a distinct responsibility and test boundary remain obvious.
9. Keep constructor/public API and all process event types unchanged.

### Files To Change

- `packages/core/src/model/GraphProcessor.ts`
- new `packages/core/src/model/GraphRunLifecycle.ts`
- optional focused abort-controller registry only if justified
- `packages/core/test/model/GraphProcessor.characterization.test.ts`
- new focused lifecycle tests
- Node runtime equivalence tests and runtime benchmarks
- `developer-docs/CORE-ENGINE.md`
- `developer-docs/EXECUTION-DATA-FLOW.md`

### Verification

- Exact event order and count for start/graphStart/nodeStart/nodeFinish/nodeError/
  nodeExcluded/graphFinish/graphError/abort/finish/done.
- `rootRunId`, `graphRunId`, `parentGraphRunId`, process id, and executor metadata are
  unchanged.
- Pause/resume and abort settle all waits and controllers once.
- Successful graph abort, failed abort, race-loser abort, nested subgraphs, recording
  replay, frozen nodes, user input, split runs, and reference graphs match baseline.
- Compatible/default-safe/headless-fast runtime profiles remain equivalent where
  promised.
- Runtime benchmark has no regression beyond the documented noise gate.

### Risks And Mitigations

- **Event order can change while outputs stay correct.** Assert ordered event traces.
- **State object can become a second GraphProcessor.** Limit it to lifecycle state and
  decisions; no graph traversal or node execution.
- **Aborts are race-sensitive.** Add repeated/concurrent characterization, not only a
  single deterministic case.
- **Extra indirection can hurt cheap graphs.** Measure allocation and latency.

### Result After Refactor

`GraphProcessor` loses one meaningful responsibility, lifecycle invariants become
explicit and testable, and runtime behavior/performance remain unchanged.

## 10. Behavioral Tests, Architecture Boundaries, And Navigable Contracts — DONE

### Why This Is A Priority

Tests are part of the architecture. The repository has strong pure/runtime coverage,
but app UI regressions are still frequently protected by reading source files and
matching implementation text. This makes harmless refactors expensive and can pass
while real behavior is broken.

### Current Problem

- 53 app test files currently call `readFileSync` on production source.
- `check-test-style.mjs` reports source-reading tests but allows the count to grow.
- `UiGraphBuilderLayout.test.ts`, `NodeEditorMetadataLayout.test.ts`,
  `ProjectSelector.test.ts`, and other suites contain large regex contracts for JSX,
  CSS, function names, and call order.
- Several files verify desktop/hosted parity by asserting that matching strings exist
  in two implementations instead of executing a shared contract.
- `check-file-tree.mjs` reports import-boundary issues but does not enforce settled
  boundaries.
- `APP-ARCHITECTURE.md` and `EXECUTION-DATA-FLOW.md` have grown into very long
  chronological rule collections, making ownership facts difficult to find and easy
  to contradict.

Some source contracts are appropriate for static assets or intentional forbidden
imports. The problem is using them as the default UI test technique.

### Target Ownership

Use the cheapest reliable test at each level:

- pure unit tests for models, geometry, selectors, serializers, and policies;
- component/browser tests for actual interaction and layout ownership;
- source checks only for static repository invariants that cannot be expressed by
  TypeScript, lint, or behavior;
- generated-asset freshness checks for generated code/data;
- concise domain contract docs linked from an architecture index.

### Detailed Change Plan

1. Inventory all source-reading tests and classify each as behavioral candidate,
   static repository invariant, visual contract, or obsolete duplication.
2. Make `check-test-style.mjs` reject new source-reading tests immediately using an
   explicit shrinking baseline/allowlist. Remove the allowlist as tests migrate.
3. Start with the highest-churn suites from items 4-8. Export pure owners rather than
   parsing their call sites.
4. Replace CSS regex tests with semantic token tests for generated style strings or a
   small number of browser screenshots at stable desktop/mobile sizes.
5. Add a minimal browser component harness only for interactions that Node tests
   cannot prove: portals, focus/Escape priority, drag/drop, resize, and web-app DOM.
6. Keep browser tests focused and deterministic; do not build a large slow end-to-end
   suite before the first critical workflows are stable.
7. Convert settled package boundaries from report-only to enforced rules. Keep an
   explicit review queue for genuinely ambiguous legacy imports.
8. Add ownership checks for direct `marked`, raw HTML sinks, generated web-app client
   freshness, and legacy Chat use from new features.
9. Split very large developer docs by stable domain, not by date:
   - editor/workspace state;
   - Monaco/editor surfaces;
   - canvas interactions;
   - execution identity and snapshots;
   - hosted/web-app contracts.
     Keep `APP-ARCHITECTURE.md` and `EXECUTION-DATA-FLOW.md` as short indexes and core
     invariants rather than dumping grounds.
10. Update `refactor-history.md` only when an implementation item completes; do not
    copy active plans into history.

### Files To Change

- `scripts/checks/check-test-style.mjs`
- `scripts/checks/check-file-tree.mjs`
- new focused checks under `scripts/checks/`
- source-reading tests under `packages/app/src/**/*.test.ts(x)`, beginning with:
  - `components/UiGraphBuilderLayout.test.ts`
  - `components/NodeEditorMetadataLayout.test.ts`
  - `components/ProjectSelector.test.ts`
  - `components/GraphListLayout.test.ts`
  - `components/nodeOutputWrapping.test.ts`
- package test configuration/dependencies if a browser harness is introduced
- `.github/workflows/build.yml` and shared release verification jobs
- `developer-docs/APP-ARCHITECTURE.md`
- `developer-docs/EXECUTION-DATA-FLOW.md`
- new domain pages under `developer-docs/`
- `developer-docs/README.md` and docs-link checks

### Verification

- Source-reading test count cannot increase and materially decreases during each
  refactor item.
- Migrated tests fail when behavior breaks and stay green after implementation-only
  renames/reformatting.
- Critical browser interactions have deterministic component/browser coverage.
- Import/security/generated-asset checks fail locally and in CI.
- Developer doc links pass and every major owner has one canonical page.
- Full test time remains reasonable; track and cap added browser-suite duration.

### Risks And Mitigations

- **Replacing source tests can reduce coverage accidentally.** Map each old assertion
  to behavior or an intentional static invariant before deletion.
- **Browser tests can become slow/flaky.** Use pure tests first and browser tests only
  for browser behavior.
- **Strict boundary checks can block unrelated work.** Enforce only settled rules and
  use a shrinking reviewed baseline for legacy cases.
- **Docs splitting can create duplication.** Give each domain one canonical page and
  use links instead of copied paragraphs.

### Result After Refactor

Tests protect behavior instead of spelling, architecture violations become enforceable,
developer docs become navigable, and future refactors require less test churn and less
historical knowledge.

## Cross-Item Delivery Strategy

Each item should be implemented as its own commit or short commit series. Do not mix
unrelated visual polish or product features into these changes.

For every item:

1. capture baseline behavior and line counts;
2. add or strengthen characterization tests;
3. move one owner at a time;
4. remove the superseded path immediately;
5. update developer docs;
6. run focused verification, then package-wide verification;
7. record production/test/doc line deltas;
8. reassess for unnecessary abstractions;
9. append a completion entry to `refactor-history.md` only after the item is done.

Suggested broad verification after the entire plan:

```text
yarn install --immutable --immutable-cache
yarn test
yarn lint
yarn prettier:check
yarn test:docs
yarn test:style
yarn check:file-tree
yarn build
git diff --check
```

Add dependency/Rust security commands from item 3 once their stable scripts exist.
Runtime-sensitive items must also run the existing runtime equivalence and benchmark
matrix. UI interaction items must include focused browser verification at the
viewports they affect.

## Completion Definition

The plan is complete only when:

- all ten items have implementation evidence in `refactor-history.md`;
- no superseded compatibility adapters or duplicate owners remain;
- all high/critical shipped-runtime dependency findings are removed or covered by a
  reviewed, expiring exception;
- untrusted rich text is sanitized by default;
- MCP env/lifecycle/diagnostic tests pass;
- desktop and hosted web-app behavior derive from shared runtime policy;
- workspace target state is mutually exclusive by construction;
- LLM Chat V2 and AI assist share one request/profile contract;
- `GraphProcessor` has lost a tested lifecycle responsibility with no speed or event
  regression;
- source-reading tests are a small, enforced exception rather than the default;
- developer docs identify one owner for every moved behavior;
- production code is no larger unless the added lines buy a clear tested boundary.
