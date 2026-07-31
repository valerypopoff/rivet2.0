# Rivet Developer Docs

Maintainer-facing documentation for the current Rivet 2 monorepo.

Start here when changing architecture, runtime behavior, package boundaries, build
contracts, or source layout. User-facing docs live under `packages/docs/docs`.

## Core Docs

- [Overview](./OVERVIEW.md)
- [Package Boundaries](./PACKAGES.md)
- [Repo File Tree](./REPO-FILE-TREE.md)
- [Build And CI](./BUILD-AND-CI.md)
- [App Architecture](./APP-ARCHITECTURE.md)
- [Core Engine](./CORE-ENGINE.md)
- [Execution Data Flow](./EXECUTION-DATA-FLOW.md)
- [Editor Workspace State](./EDITOR-WORKSPACE-STATE.md)
- [Monaco And Editor Surfaces](./MONACO-EDITOR-SURFACES.md)
- [Canvas Interactions](./CANVAS-INTERACTIONS.md)
- [Execution Identity And Snapshots](./EXECUTION-IDENTITY-AND-SNAPSHOTS.md)
- [Hosted And Web App Contracts](./HOSTED-WEB-APP-CONTRACTS.md)
- [Provider-neutral Knowledge Source API](./KNOWLEDGE-SOURCE-API.md)
- [LLM Chat V2 Contract](./LLM-CHAT-V2-CONTRACT.md)
- [Building Complex Rivet Projects With An AI Agent](./AI-ASSISTED-PROJECT-AUTHORING.md)
- [Transactional Graph Builder Domain](./GRAPH-BUILDER-DOMAIN.md)
- [Graph Builder Evaluation](./GRAPH-BUILDER-EVALUATION.md)
- [Plugin System](./PLUGIN-SYSTEM.md)
- [Unreachable Graph Detection](./UNREACHABLE-GRAPH-DETECTION.md)

## Refactor Tracking

- [Refactor History](../refactor-history.md)

When changing code structure, update the relevant developer doc in the same
change so future maintainers can see the current contract instead of reverse
engineering it from imports.
