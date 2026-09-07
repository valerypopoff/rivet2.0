# Rivet Developer Docs

Maintainer-facing documentation for the current Rivet 2 monorepo.

Start here when changing architecture, runtime behavior, package boundaries, build
contracts, or source layout. User-facing docs live under `packages/docs/docs`.

For a behavior-preserving refactor, start with the
[Refactor Baseline And Verification](./REFACTOR-BASELINE.md). It maps ownership,
observable invariants, regression suites, manual scenarios, and evidence limits.
The [documentation audit](./DOCUMENTATION-AUDIT.md) records this documentation
review's scope and remaining verification obligations.

## Core Docs

- [Overview](./OVERVIEW.md)
- [Package Boundaries](./PACKAGES.md)
- [Repo File Tree](./REPO-FILE-TREE.md)
- [Build And CI](./BUILD-AND-CI.md)
- [App Architecture](./APP-ARCHITECTURE.md)
- [GitHub Pages Promo Demo Host](./PROMO-DEMO-HOST.md)
- [Core Engine](./CORE-ENGINE.md)
- [Execution Data Flow](./EXECUTION-DATA-FLOW.md)
- [Editor Workspace State](./EDITOR-WORKSPACE-STATE.md)
- [Monaco And Editor Surfaces](./MONACO-EDITOR-SURFACES.md)
- [Canvas Interactions](./CANVAS-INTERACTIONS.md)
- [Execution Identity And Snapshots](./EXECUTION-IDENTITY-AND-SNAPSHOTS.md)
- [Run Activity](./RUN-ACTIVITY.md)
- [Hosted And Web App Contracts](./HOSTED-WEB-APP-CONTRACTS.md)
- [Provider-neutral Knowledge Source API](./KNOWLEDGE-SOURCE-API.md)
- [LLM Chat V2 Contract](./LLM-CHAT-V2-CONTRACT.md)
- [LLM Profile Suspension](./LLM-PROFILE-CIRCUIT-BREAKER.md)
- [Evaluations](./EVALUATIONS.md)
- [Building Complex Rivet Projects With An AI Agent](./AI-ASSISTED-PROJECT-AUTHORING.md)
- [Transactional Graph Builder Domain](./GRAPH-BUILDER-DOMAIN.md)
- [Graph Builder Evaluation](./GRAPH-BUILDER-EVALUATION.md)
- [Plugin System](./PLUGIN-SYSTEM.md)
- [Unreachable Graph Detection](./UNREACHABLE-GRAPH-DETECTION.md)

## Studio Server

- [Architecture](./studio-server/architecture.md)
- [Repository Structure](./studio-server/repo-structure.md)
- [Development And Verification](./studio-server/development.md)
- [Access And Routing](./studio-server/access-and-routing.md)
- [Editor Bridge](./studio-server/editor-bridge.md)
- [Workflow Publication](./studio-server/workflow-publication.md)
- [Runtime Libraries](./studio-server/runtime-libraries.md)
- [Published Web-App Browser Storage](./studio-server/web-app-browser-storage.md)
- [Deployment Status UI](./studio-server/deployment-status.md)
- [Kubernetes And Operational Gates](./studio-server/kubernetes.md)
- [Mistakes And Misconceptions](./studio-server/mistakes-and-misconceptions.md)

## Refactor Tracking

- [Refactor History](../refactor-history.md)
- [Studio Server Refactor History](./studio-server/refactor-history.md)
- [Monorepo Migration](./studio-server/monorepo-migration.md)
- [Implemented CodeRunner Plan And Measurements](./studio-server/wrapper-managed-code-runner-speed-plan.md)
- [Historical LOC Reduction Audit](./studio-server/audits/loc-reduction.md)
- [Dated Kubernetes Managed Mode Audit](./studio-server/audits/kubernetes-managed-mode.md)
- [Product Backlog (Proposals)](./studio-server/backlog.md)

History, dated measurements, and proposals explain earlier decisions; they do not
establish current runtime behavior or a passing deployment gate. Source and tests
at the refactor's baseline commit determine what must be preserved. Reconcile a
contradiction in its owning guide instead of silently treating an old plan as a
new requirement. Keep one canonical feature guide and link to it from overview
pages rather than copying another detailed contract into every package guide.

When changing code structure, update the relevant developer doc in the same
change so future maintainers can see the current contract instead of reverse
engineering it from imports.
