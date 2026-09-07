# Developer Documentation Audit — 2026-09-07

Baseline: `6dd9466af`. Scope: the 41 Markdown files then present under
`developer-docs/`, including Studio Server and its audits. The new
[Refactor Baseline](./REFACTOR-BASELINE.md) and this report are additions.

## Method and confidence

The whole collection was inventoried for navigation, document purpose, local
links, explicit repository paths, command references and historical/current
wording. High-risk contracts were cross-checked at source owners: workspace
manifests/build scripts, graph-output selection and projection, execution metadata,
recording tab/root ownership, evaluation library/run stores, hosted save/bridge
contracts, server startup/readiness/drain, CodeRunner caches, proxy templates,
schema version ownership, and the browser runner/configuration. Existing test
entrypoints were matched to the refactor verification map.

This is a source/documentation audit, not a fresh execution of all runtime,
provider, OS, browser, or deployment scenarios. It does not claim line-by-line
formal equivalence between every prose statement and every implementation. The
larger architecture guides contain accumulated detail; use their feature-owner
links and collect new baseline evidence before moving the corresponding code.

## Corrections

- The main index omitted the complete Studio Server area, Evaluations and LLM
  Profile Suspension. It now indexes all current guides and separates history
  and proposals from current contracts.
- Overview and file-tree maps omitted five private Studio Server workspaces and
  deployment tooling. The build/test descriptions now distinguish shared Rivet
  commands from hosted, docs, browser and native verification.
- The file-tree contract named a removed Evaluations `src/api.ts`; the portable
  runner is exported through `src/index.ts` from `src/runner.ts`.
- The documentation checker covered only direct children of `developer-docs`.
  It now checks nested Markdown paths as well. Its documentation explicitly says
  link existence does not validate anchors, commands or behavior.
- Studio repository instructions had malformed `npm` code spans; history still
  named the pre-migration test-style script location. These now use the current
  command/path spelling.
- The CodeRunner plan said implemented while instructing future implementation;
  LOC projections coexisted with completed outcomes and a false current claim
  that API code did not import Zod. Historical scope and current owners are now
  explicit. Kubernetes audit claims remain tied to their dated evidence.
- Proxy recovery previously sat under Environment loading, and the routing
  guide lacked that contract. It now has a dedicated health/DNS section and a
  routing cross-reference.
- The concise execution guide now states exact recording tab ownership by
  project ID and path, declared replay root, and the absence of lifecycle/history
  for pruned work. Workspace guidance points to content revisions, in-place
  identity and the independent evaluation library.
- The new refactor baseline joins source ownership, invariants, existing tests,
  manual scenarios and command limitations, including gaps in browser/native and
  provider evidence. The old blanket parked-optimization explanation for skipped
  tests has been replaced with the checker's actual report-only policy.

## Document coverage map

Each row gives the document's role in refactor planning. “Reference” means a
current contract/ownership guide; it does not mean its entire functionality was
executed during this review. History and plans must not be used as current
acceptance evidence without reconciliation.

| Document                                                                      | Role and audit disposition                                                                                                                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README](./README.md)                                                         | Complete navigation and current/history distinction; updated                                                                                             |
| [Overview](./OVERVIEW.md)                                                     | Workspace/runtime orientation; hosted packages and command scope corrected                                                                               |
| [Packages](./PACKAGES.md)                                                     | Public exports, builds, headless/sidecar consumers; private-package scope clarified                                                                      |
| [Repo File Tree](./REPO-FILE-TREE.md)                                         | Layout and compatibility paths; missing package map/runner path corrected                                                                                |
| [Build And CI](./BUILD-AND-CI.md)                                             | Check/release ownership; recursive links, aliases and skipped-test limits corrected                                                                      |
| [App Architecture](./APP-ARCHITECTURE.md)                                     | Detailed shell, providers, workspace, execution and output reference; use focused feature guides for individual moves                                    |
| [Core Engine](./CORE-ENGINE.md)                                               | Scheduling, preprocessing, lifecycle, nested/split work, public API and serialization reference; pruning contract matched to selection/projection owners |
| [Execution Data Flow](./EXECUTION-DATA-FLOW.md)                               | Event delivery, run selection, replay and output reference; central source for pruning history semantics                                                 |
| [Execution Identity](./EXECUTION-IDENTITY-AND-SNAPSHOTS.md)                   | Concise identity/lifecycle reference; exact replay ownership and omitted work added                                                                      |
| [Editor Workspace State](./EDITOR-WORKSPACE-STATE.md)                         | Resource/tab/transition ownership; external revision and library boundary added                                                                          |
| [Canvas Interactions](./CANVAS-INTERACTIONS.md)                               | Wire, port, data-bus, selection and preview invariants; manual/browser acceptance mapped                                                                 |
| [Monaco](./MONACO-EDITOR-SURFACES.md)                                         | Model/session lifetime, capability disposal, editor and preview boundaries                                                                               |
| [Run Activity](./RUN-ACTIVITY.md)                                             | Event projection, bounded journal and exact navigation; not a second run database                                                                        |
| [Hosted Contracts](./HOSTED-WEB-APP-CONTRACTS.md)                             | Public host/save seam and web-app runtime contracts; cross-window save scenarios mapped                                                                  |
| [Evaluations](./EVALUATIONS.md)                                               | Library/run/snapshot/recording separation, runner and transfer contracts; test/store ownership mapped                                                    |
| [LLM Chat](./LLM-CHAT-V2-CONTRACT.md)                                         | Provider/tool/output compatibility and existing detailed docs-to-code test matrix; retain its focused/integration distinctions                           |
| [LLM Profile Suspension](./LLM-PROFILE-CIRCUIT-BREAKER.md)                    | Host-activated reliability policy, deadlines and durable health; restored to index                                                                       |
| [Knowledge Source API](./KNOWLEDGE-SOURCE-API.md)                             | Provider-neutral schemas, secrets, capabilities, versioning and lifecycle reference                                                                      |
| [Plugins](./PLUGIN-SYSTEM.md)                                                 | Registry construction, configuration and multi-runtime loading reference                                                                                 |
| [AI Project Authoring](./AI-ASSISTED-PROJECT-AUTHORING.md)                    | Guidance for authoring actual project files; distinct from in-app transactional Graph Builder                                                            |
| [Graph Builder Domain](./GRAPH-BUILDER-DOMAIN.md)                             | Virtual documents, bounded decisions, revisioned Apply and explicit unsupported scope                                                                    |
| [Graph Builder Evaluation](./GRAPH-BUILDER-EVALUATION.md)                     | Synthetic evaluation and protected-holdout evidence contract; fixture validation does not certify live-model quality                                     |
| [Unreachable Graphs](./UNREACHABLE-GRAPH-DETECTION.md)                        | Potential reachability analysis; not a runtime branch-selection/purity proof                                                                             |
| [Promo Demo](./PROMO-DEMO-HOST.md)                                            | Browser-only in-memory host capability/iframe policy; separate from normal hosted persistence                                                            |
| [Studio Architecture](./studio-server/architecture.md)                        | Host process/storage/runtime ownership; server lifecycle and managed boundaries checked                                                                  |
| [Studio Repository](./studio-server/repo-structure.md)                        | Private packages, tooling and command policy; malformed npm spans fixed                                                                                  |
| [Studio Development](./studio-server/development.md)                          | Launchers, environment and verification; dedicated proxy recovery section                                                                                |
| [Access And Routing](./studio-server/access-and-routing.md)                   | Route/auth/trust ownership; runtime DNS and dev health contract added                                                                                    |
| [Editor Bridge](./studio-server/editor-bridge.md)                             | Typed dashboard/iframe commands, identity and reconciliation reference                                                                                   |
| [Workflow Publication](./studio-server/workflow-publication.md)               | Published/latest, filesystem/managed, recordings and endpoint execution reference                                                                        |
| [Runtime Libraries](./studio-server/runtime-libraries.md)                     | Release activation, per-run prepare/require snapshot, caches and cleanup reference                                                                       |
| [Web-App Browser Storage](./studio-server/web-app-browser-storage.md)         | IndexedDB/RPC, scope, legacy fallback and transport limits; compatibility matrix retained                                                                |
| [Deployment Status](./studio-server/deployment-status.md)                     | Operator UI reflects library synchronization, not cluster availability; distinction retained                                                             |
| [Kubernetes](./studio-server/kubernetes.md)                                   | Current operational contract, schema/release/restore and capacity gates; requires target evidence                                                        |
| [Mistakes And Misconceptions](./studio-server/mistakes-and-misconceptions.md) | Cross-boundary debugging policy; dev/published artifact distinction informs new baseline                                                                 |
| [Monorepo Migration](./studio-server/monorepo-migration.md)                   | History/provenance and current ownership mapping, not a pending migration                                                                                |
| [Studio Refactor History](./studio-server/refactor-history.md)                | Historical outcomes with checks to preserve; test-style script path corrected                                                                            |
| [CodeRunner Plan](./studio-server/wrapper-managed-code-runner-speed-plan.md)  | Implemented historical plan and measurements; current owner links added                                                                                  |
| [LOC Audit](./studio-server/audits/loc-reduction.md)                          | Historical estimates versus shipped outcomes; current Zod claim corrected                                                                                |
| [Managed Kubernetes Audit](./studio-server/audits/kubernetes-managed-mode.md) | Dated source/static/single-host evidence; no fresh provider certification implied                                                                        |
| [Backlog](./studio-server/backlog.md)                                         | Product ideas preserved as proposals rather than refactor acceptance requirements                                                                        |

## Remaining evidence to collect for the refactor

Validation of this documentation change includes recursive local-link checking,
JavaScript syntax/format checks for the checker, and a negative probe: a temporary
broken link under `studio-server/audits/` was rejected with exit status 1. The probe
was then removed. This verifies nested discovery without adding production-source
assertion tests or treating document existence as runtime certification.

1. Capture a fresh baseline suite/build report on the selected refactor commit;
   preserve exact commands, exit status and tested artifacts. Test file existence
   is coverage discovery, not a passed check.
2. Run the [UI scenarios](./REFACTOR-BASELINE.md#ui-acceptance-scenarios) on the
   affected hosts. The existing observer suite does not by itself prove every
   fullscreen, recording-tab, Tool-body or Shift-bend interaction. Native Tauri
   behavior needs its own affected-platform evidence.
3. Exercise real storage/transport boundaries for changes involving persistence,
   process loss, pending recording writes, remote execution or provider lifecycle.
   Do not substitute a mocked UI store for an API/database test.
4. Re-run paired performance fixtures after choosing a refactor slice. Earlier
   latency/LOC figures describe their original machine/code; node counts and
   scheduling/event equivalence provide independent correctness evidence.
5. Use current release/provider/restore gates for deployment changes. Historical
   local runs do not establish provider capacity, DNS/TLS behavior, RPO/RTO or
   remote CI success for a new commit.
