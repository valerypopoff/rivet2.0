# Refactor Baseline And Verification

Use this document to plan and assess a behavior-preserving refactor. It joins the
feature guides to source owners and observable checks. It is a checklist for
collecting evidence, not a claim that every listed scenario has passed on the
current machine or deployment. The documentation audit began at `6dd9466af` on
2026-09-07; record the actual baseline commit again when refactor work starts.

## Establish the baseline

Record the commit, dirty-tree diff, Node/Yarn versions, OS, runtime profile,
storage mode, fixture revision, and exact commands before moving implementation.
Build dependencies before testing their consumers. Retain exit codes, test
reports, and any skipped or blocked checks alongside the before/after revision.
An older report or a server running another build cannot certify new code.

For each refactor slice, name the public entrypoint, state owner, persistence
boundary, and disposal owner. Define the observations that must stay equal:
values and exclusions, errors, event order/identity, incurred work, stored data,
HTTP status/headers, and visible interactions where relevant. Keep new behavior
separate from equivalence work so an intentional product change cannot conceal
a regression. Existing incorrect behavior needs an explicit decision and a
regression case before changing the baseline.

## Ownership and compatibility map

| Boundary                     | Owner and canonical guide                                                                                                                                                                                   | Must survive a structural refactor                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph execution              | Core `GraphProcessor`, planners, lifecycle, split processor; [Core Engine](./CORE-ENGINE.md)                                                                                                                | Preprocessing, effective ports, dependency scheduling, conditional exclusion, loops/races, cancellation, frozen effects, nested execution and events      |
| Public runtime entrypoints   | Core/Node exports and `packages/node/src/api.ts`; [Packages](./PACKAGES.md)                                                                                                                                 | ESM/CJS/types, options/defaults, reference loading, runtime adapters, cache lifetime, headless behavior                                                   |
| Node execution in editor     | App executor-session owners, app-executor, Node debugger; [App Architecture](./APP-ARCHITECTURE.md)                                                                                                         | Upload/run readiness, request correlation, per-project target, pause/abort, disconnect and pending-request cleanup                                        |
| Project representation       | Core serialization and project model; [Core Engine](./CORE-ENGINE.md#serialization)                                                                                                                         | Supported older formats, stable IDs, node data, references, library nodes, web apps and optional fields; editor-only state stays outside project YAML     |
| Open projects                | App workspace transitions and `RivetWorkspaceHost`; [Editor Workspace State](./EDITOR-WORKSPACE-STATE.md)                                                                                                   | Active/inactive tabs, graph/resource navigation, dirty baselines, asynchronous save ownership, Undo/Redo, read-only views                                 |
| Hosted project collaboration | Shared editor bridge, web reconciliation, API workflow storage; [Hosted Contracts](./HOSTED-WEB-APP-CONTRACTS.md) and [Editor Bridge](./studio-server/editor-bridge.md)                                     | Immutable project identity despite path changes, revision preconditions, explicit content-conflict resolution, no duplicate save at stale paths           |
| Execution data and replay    | Core recorder/player, app history/snapshots; [Execution Data Flow](./EXECUTION-DATA-FLOW.md), [Identity](./EXECUTION-IDENTITY-AND-SNAPSHOTS.md), [Run Activity](./RUN-ACTIVITY.md)                          | Root/child/process/split identity, terminal events, reference-backed values, selected invocation isolation and project-owned replay                       |
| Canvas and output inspection | App interaction/model owners; [Canvas](./CANVAS-INTERACTIONS.md), [Monaco](./MONACO-EDITOR-SURFACES.md)                                                                                                     | Coordinate transforms, drag intent, keyboard/focus ownership, port IDs, search/pager behavior, theme/layout, listener/model disposal                      |
| Evaluation resources         | Evaluations package plus app/host stores; [Evaluations](./EVALUATIONS.md)                                                                                                                                   | Shared reusable library versus project-scoped runs; revisioned updates, snapshots, recording ownership, independent execution/quality/accounting statuses |
| LLM and tools                | Core chat-v2 and delegation resolvers; [LLM Chat](./LLM-CHAT-V2-CONTRACT.md)                                                                                                                                | Provider request translation, retries/fallback, tool continuation, usage/cost, trace identity and abort cleanup                                           |
| Profile reliability          | Core policy, host health store; [LLM Profile Suspension](./LLM-PROFILE-CIRCUIT-BREAKER.md)                                                                                                                  | Explicit host activation, per-candidate deadlines, logical attempt counting, recovery lease and cancellation classification                               |
| Plugins and retrieval        | Core registry/provider controller plus host adapters; [Plugins](./PLUGIN-SYSTEM.md), [Knowledge Sources](./KNOWLEDGE-SOURCE-API.md)                                                                         | Registry lifetime, defaults and secret boundaries, capabilities, per-run resources, version activation and cleanup                                        |
| AI authoring                 | App graph-builder domain/session/gateway; [Graph Builder](./GRAPH-BUILDER-DOMAIN.md), [Evaluation](./GRAPH-BUILDER-EVALUATION.md)                                                                           | Private revisioned drafts, bounded edits, validation and one atomic publication; no direct model writes to editor state                                   |
| Declarative web apps         | Core UI runtime, Node handler/generated client, hosted adapters; [Hosted Contracts](./HOSTED-WEB-APP-CONTRACTS.md), [Browser Storage](./studio-server/web-app-browser-storage.md)                           | Renderer parity, transport ownership, idempotent/resumable actions, storage scope, auth, cancellation and stale-action suppression                        |
| Publication/storage          | Studio API workflow services; [Publication](./studio-server/workflow-publication.md)                                                                                                                        | Frozen published versus latest draft, endpoint ownership, project/data transactions, references, revision retention, recording durability                 |
| Deployment                   | Studio API lifecycle, proxy, Compose/Helm and release tools; [Architecture](./studio-server/architecture.md), [Routing](./studio-server/access-and-routing.md), [Kubernetes](./studio-server/kubernetes.md) | Control/execution/evaluation roles, trust boundaries, readiness/drain, schema compatibility, artifact identity, exact predecessor and retention policy    |

## Execution regression matrix

Use deterministic probes and fake providers. Count executed work independently
of timing. A matching final output is insufficient if unused effects run, an
error disappears, the recording loses a terminal event, or a queued item starts
after cancellation.

| Scenario                           | Required observation                                                                                                                                                                         | Existing evidence entrypoints                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default execution                  | Unchanged outputs, side effects, errors and lifecycle with omitted options                                                                                                                   | [GraphProcessor characterization](../packages/core/test/model/GraphProcessor.characterization.test.ts)                                                                                                                                                                                                                                              |
| Selected subgraph outputs          | Default off; selected prerequisites only; shared producer once; all duplicate output producers; no fan-out leak; skipped boundary ports excluded                                             | [Selection helper](../packages/core/test/model/GraphOutputSelection.test.ts), [processor tests](../packages/core/test/model/GraphProcessor.outputSelection.test.ts), [integration](../packages/core/test/model/GraphProcessor.outputSelection.integration.test.ts), [projection](../packages/core/test/model/SubGraphNode.outputProjection.test.ts) |
| Empty demand and exceptions        | No child lifecycle for empty demand; full execution for direct inspection, partial forwarding, or consumed enabled Error; authored metric names retained                                     | Same selection/projection suites; [Core contract](./CORE-ENGINE.md#subgraphs)                                                                                                                                                                                                                                                                       |
| Loops and split modes              | Stable item ordering and independent child IDs across parallel/sequential loops; concurrent/reused runners do not share selection/results                                                    | [Node repeated-call matrix](../packages/node/test/outputSelectionRepeatedCalls.test.ts), [Node runtime matrix](../packages/node/test/outputSelectionRuntime.test.ts), CLI tests                                                                                                                                                                     |
| Cancellation and unavailable state | Pause then abort settles; queued race losers never start; selected waits on omitted writers/events release resources                                                                         | Core `GraphProcessor.outputSelection.globalWait`, `.eventWait`, `.userInput`, `.cachedResults` and `.integration` suites; [lifecycle tests](../packages/core/test/model/GraphRunLifecycle.test.ts)                                                                                                                                                  |
| Runtime parity                     | Browser source, freshly built Node exports, bundled sidecar and CLI agree; fast parent/compatible selected child preserves semantics                                                         | `yarn test:core`, `test:node`, `test:app-executor`, `test:cli`; hosted pruning specs below                                                                                                                                                                                                                                                          |
| Record and replay                  | Serialize/deserialize and replay actual events; preserve parent/child/process/split grouping; omitted children have no invented history; selected empty invocation cannot show prior results | [Recorder tests](../packages/core/test/recording/ExecutionRecorder.test.ts), Node repeated-call matrix, app history/recording suites                                                                                                                                                                                                                |
| Serialization compatibility        | Load supported old fixtures, round-trip optional settings, preserve IDs/library/web-app/reference data and reject malformed boundary data                                                    | [Serialization tests](../packages/core/test/utils/serialization.test.ts), Evaluations transfer tests                                                                                                                                                                                                                                                |
| Custom host adapters               | Provider capabilities, CodeRunner permissions/environment and per-run cleanup remain correct when host defaults differ                                                                       | Node runtime tests; Studio API `managed-code-runner`, `runtime-health`, `evaluation-runs` and workflow execution suites                                                                                                                                                                                                                             |

Output pruning is intentional omission of unused branches, including their side
effects and errors. It does not infer dependencies through globals, Stored
Values, events, arbitrary Code, or plugins. It is local to each opted-in Subgraph;
other graph callers retain their policy. These are compatibility requirements,
not missing general laziness that a refactor should silently add.

## UI acceptance scenarios

Pure tests cover decisions; browser checks cover event delivery, geometry, focus,
iframes and rendering. A browser fixture using mocked storage proves the client
contract only. Pair it with the owning API/storage suite for durability claims.

1. Open two projects with different executor choices. Load a recording for one,
   switch tabs, replay, inspect nested/split history, and unload. Only the owner
   gets recording chrome/controls; live executor choices survive. Repeat with a
   second invocation that prunes more nodes: omitted nodes show no stale results.
2. Open the same hosted project in two windows. Rename and move it, including its
   enclosing folder, in one window. The other keeps its edits and immutable
   binding, updates title/tree, and reports the change. Saving updates the current
   canonical file once. A content edit/save instead requires Reload or Keep mine;
   deletion/ambiguous ownership must not create a replacement at a stale path.
3. Rename an evaluation suite in the second window. Only evaluation-library
   synchronization applies; the open project's content-conflict toast must not
   appear. Verify suite/dataset reuse across projects and run-history ownership.
4. In fullscreen output, use Page Up/Down for discrete response navigation and
   Home/End for boundaries, including expanded Messages blocks and a clicked
   round pager. Check visible short scrolling, readable opaque pager, no content
   focus border, search/input key ownership, and interruption/teardown of scrolling.
5. Drag existing and newly added wire bends under pan/zoom. Shift selects and
   retains the dominant axis relative to drag start; release restores free motion.
   Check commit/Undo/Redo, click thresholds, double-click removal and read-only mode.
6. Edit Tool descriptions and Subgraph settings. Tool name remains `Name: ...`
   with the field style/separator; description uses Text-style formatting/clipping.
   Skip unused outputs appears after the graph selector only when enabled; its
   saved setting survives Undo/Redo and save/reload independently per instance.
7. Exercise embedded editor commands from dashboard and iframe focus; save while
   switching tabs and while new edits arrive. Completion marks only the captured
   saved generation clean and retains newer edits and moved paths.
8. For native changes, also verify Tauri file dialogs, sidecar startup, clipboard,
   platform shortcuts and window behavior on the affected OS. Hosted Chromium
   cannot certify these native behaviors.

Existing observer specs include `workflow-tree-sync`, `renamed-open-project-cache`,
`project-inline-rename`, `evaluation-save-shortcut`, `subgraph-output-pruning`,
`subgraph-node-executor-pruning`, `subgraph-prompt-cancellation`, `rivet-web-app`
and `proxy-routing` under
[playwright-observe](../packages/studio-server-web/playwright-observe).
They are starting points, not a claim that every step above is automated.
Fullscreen and bend helpers have unit/DOM coverage under app `components/nodeOutput`
and `components/nodeCanvas`; perform the browser scenarios when those interactions
change, adding targeted automation where the existing specs do not exercise them.

## Commands and evidence boundaries

Run from the repository root using the pinned Yarn. If the shell's Yarn shim is
unavailable, use `node .yarn/releases/yarn-4.17.1.cjs` in its place.

| Gate                       | Command                                                                                           | Scope / limitation                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Install/tooling            | `yarn install --immutable`; `yarn check:pnp:fresh`                                                | Lockfile and PnP consistency; does not prove compiled consumers are current                                                                                                                |
| Static baseline            | `yarn test:style`; `yarn lint`; `yarn test:docs`; `yarn prettier:check`                           | Finish style first: its authoring checks rebuild Core ESM. Docs test is typechecking, not the complete site build                                                                          |
| Shared artifacts and tests | `yarn build`; `yarn test`                                                                         | Core, Node, app-executor, Evaluations, app and CLI; `:all` aliases do not include Studio Server or native packaging                                                                        |
| Hosted system              | `yarn studio-server:test`                                                                         | Builds dependencies and five private workspaces, API/web tests and repository/deployment contracts; requires its documented host tools                                                     |
| Proxy recovery             | `node deploy/studio-server/scripts/verify-proxy-dns.mjs`                                          | Disposable real Nginx templates and mock upstreams; API/web IP replacement, auth, paths, redirects, SSE, upgrades, health/recovery. Explicit CI step, not included in `studio-server:test` |
| Docs/promo build           | `yarn workspace docs run build`                                                                   | Full docs build and its promo dependency path; use for changes to docs-site/build/host integration                                                                                         |
| Browser                    | `yarn studio-server:ui:observe <spec-name>.spec.ts`                                               | Existing app target must contain current code; see command below                                                                                                                           |
| Runtime performance        | `yarn bench:runtime-speed`; `yarn bench:runtime-attribution`                                      | Use documented fixtures/profiles and paired runs; attribution overhead is not end-user latency                                                                                             |
| Deployment release         | Candidate-image, Kind and protected provider gates in [Kubernetes](./studio-server/kubernetes.md) | Select by affected deployment boundary; static chart tests do not prove provider failover, restore or production capacity                                                                  |

For a focused hosted browser check in PowerShell:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL if the verified current-code app is not at the runner default.
yarn studio-server:ui:observe proxy-routing.spec.ts
if ($LASTEXITCODE -ne 0) { throw 'Hosted browser verification failed' }
```

Use a disposable test environment for mutation scenarios. Inspect fresh
`artifacts/playwright/report/` and `artifacts/playwright/test-results/`; the runner
records traces/video and failure screenshots. A launcher exit, detached process,
or report left by an older run is not a completed check. When output handling
returns a running process/session, retain and wait on that process until its exit
status is known. Classify an unavailable target as blocked, not passed.

## Storage and deployment checks

Exercise both filesystem and managed adapters when their shared contract changes.
Preserve project/data atomicity and crash recovery, compare-and-swap revisions,
published versus latest materialization, reference identity after path moves,
recording metadata/blob ownership, and evaluation checkpoints/retention.
Run `filesystem-project-transactions`, `workflow-publication-filesystem`, managed
schema/migration, publication, recording, retention and invalidation API suites
as applicable. A mocked adapter cannot establish real PostgreSQL transaction or
object-store recovery behavior.

Maintain the singleton control-plane/latest-debugger ownership and independent
published execution/evaluation worker budgets. Preserve per-request settings and
environment snapshots, admission/drain ordering, liveness versus readiness,
trusted proxy/internal authentication, WebSocket owner scope, bounded pending
recording writes, and release-library snapshots. Retention enforcement and schema
changes require their existing migration/operational procedures; do not turn a
refactor test into an unreviewed production cleanup or provider exercise.

## Before declaring equivalence

Every affected row needs a before/after observation or an explicit unresolved gap.
Compare semantic results and recorded lifecycle relationships; normalize only
documented nondeterminism such as generated IDs and timestamps while retaining
their relationships and ordering. Preserve errors, exclusions, effects and
cleanup, not just successful return values. Report performed-work counts and
timing separately, with the same fixture/toolchain/profile and warmup policy.
Update the owning guide with any accepted contract change and keep historical
measurements dated. Passing these checks supports the covered behaviors; it does
not establish universal equivalence for arbitrary plugins or external services.
