# Unreachable Graph Detection Investigation

> Internal investigation notes for classifying graphs as definitely reachable,
> dynamically reachable, or unreachable from a project's configured main graph, web-app action entry points, and valid Tool-delegation targets.

## Summary

This repo can no longer treat "unreachable graphs" as a simple "is this graph selected by a Subgraph node?" question.

Current same-project execution reachability comes from a mix of:

- direct graph executors with stored `GraphId` fields
- dynamic graph dispatch through `Call Graph`
- active, connected `Delegate Tool Call` handler/fallback graph IDs and auto-delegate Tool-name matches
- bundled plugin nodes that store graph handlers (`openaiRunThread`)
- declarative web-app Button and Chat actions with stored same-project `graphId` values

The implementation is deliberately split into two seams:

- [`packages/app/src/utils/graphDependencyDiscovery.ts`](../packages/app/src/utils/graphDependencyDiscovery.ts)
  owns ordered connection indexes and the closed built-in dependency resolvers.
- [`packages/app/src/utils/graphReachability.ts`](../packages/app/src/utils/graphReachability.ts)
  owns roots, definite/dynamic propagation, plugin diagnostics, and final
  reachability buckets.
- [`findAutoDelegateGraphCandidate(...)`](../packages/core/src/model/nodes/toolCallDelegation.ts)
  is the shared runtime/analysis exact-then-contains name matcher. Its caller
  deliberately owns graph identity: runtime uses metadata IDs, while analysis
  uses serialized project-map keys.

The template-duplication graph-ID remap surface was also centralized in:

- [`packages/app/src/utils/templateProjectGraphIds.ts`](../packages/app/src/utils/templateProjectGraphIds.ts)

## Root Set

Feature semantics are rooted at `project.metadata.mainGraphId` plus every valid
same-project graph selected by a web-app Button or Chat action, and concrete
targets of enabled Tool-to-`Delegate Tool Call` paths anywhere in the project.

Why:

- that matches the product request for "graphs that can be run when the main graph is running"
- Button and Chat actions execute their selected same-project graph directly, so each valid stored target is another static entry point
- Tool delegation can execute a handler graph by name without a stored `GraphId` on the Tool node, so the analysis scans its active Tool-to-delegate paths as an additional entry surface
- the Project Info UI explicitly exposes `Main Graph`
- app-side project-run flows already use `project.metadata.mainGraphId`

An eligible LLM Chat `Tool Calls -> Delegate Tool Call` connection may be
interpreted bidirectionally by auto-continuation at runtime, but it remains an
ordinary persisted connection and does not add a new graph-reachability edge
kind. Reachability still starts from the connected Delegate's configured manual
handlers/fallback or its provable auto-delegate Tool-name matches. The continuation
return value goes back to the LLM node within the same graph run; it does not
select another graph by itself.

Important mismatch:

- `coreCreateProcessor(...)` errors when no main graph is configured
- `GraphProcessor` only falls back to `project.metadata.mainGraphId` when constructed without an explicit graph id
- `RecordingPlayer` still falls back to the first graph when `mainGraphId` is missing

That runtime inconsistency is now surfaced as a warning in the reachability helper rather than silently copied into the feature semantics.

## Reachability Buckets

- `definitely reachable`: graph identity is statically known from serialized project data
- `dynamically reachable`: the graph can be executed, but the graph identity is resolved at runtime
- `unreachable`: not reachable from the configured Main Graph, a web-app action, or a valid Tool-delegation target under the supported analysis rules

Important interpretation:

- this is **potential execution reachability**
- a reachable graph is not guaranteed to execute on every run
- disabled executor nodes are ignored
- control-flow proof is intentionally out of scope

## Source-Of-Truth Matrix

| Mechanism                                               | Role                | Edge kind                  | Static target? | Dynamic behavior                                                          | Cross-project? | Notes                                                                                                                                                            |
| ------------------------------------------------------- | ------------------- | -------------------------- | -------------- | ------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubGraphNode`                                          | Executor            | `direct-static`            | Yes            | No                                                                        | No             | Stored `data.graphId`                                                                                                                                            |
| `LoopUntilNode`                                         | Executor            | `direct-static`            | Yes            | No                                                                        | No             | Stored `data.targetGraph`                                                                                                                                        |
| `CronNode`                                              | Executor            | `direct-static`            | Yes            | UI suggests dynamic, runtime is static today                              | No             | `useTargetGraphInput` exists, but `process()` still uses stored `targetGraph`                                                                                    |
| `DelegateFunctionCallNode` manual handlers              | Executor            | `direct-static`            | Yes            | Handler chosen at runtime from a static set                               | No             | Counts only when an enabled node has a live, runtime-selected `function-call` input; `handlers[]` and `unknownHandler` are stored graph IDs                      |
| `DelegateFunctionCallNode` auto delegate                | Runtime name match  | `direct-static`            | Yes            | Shared matcher prefers an exact graph name, then the first contains match | No             | Counts only static-name `Tool` (`gptFunction`) nodes with an enabled connection path to the runtime-selected delegate input; dynamic Tool names are not provable |
| `CallGraphNode` + static immediate `GraphReferenceNode` | Executor            | `static-via-callgraph`     | Yes            | No                                                                        | No             | Only the immediate static `GraphReferenceNode` case is treated as statically provable                                                                            |
| `CallGraphNode` + any other input provenance            | Executor            | `dynamic-via-callgraph`    | No             | Graph identity resolved at runtime                                        | No             | Includes dynamic `GraphReferenceNode`, generic object producers, code, and all nontrivial upstream chains                                                        |
| `GraphReferenceNode`                                    | Reference carrier   | none by itself             | N/A            | Can become dynamic when input-enabled                                     | No             | Merely producing a reference does not imply execution                                                                                                            |
| `ListGraphsNode`                                        | Reference carrier   | none by itself             | N/A            | Exposes all graphs for downstream runtime selection                       | No             | Only matters when feeding dynamic dispatch                                                                                                                       |
| `RunThreadNode` tool handlers                           | Executor            | `direct-static`            | Yes            | Tool name chooses among a static set                                      | No             | Bundled OpenAI plugin surface                                                                                                                                    |
| `RunThreadNode` on-message hook                         | Executor            | `direct-static`            | Yes            | No                                                                        | No             | Bundled OpenAI plugin surface                                                                                                                                    |
| Web-app `Button` / `Chat` action                        | Project entry point | `direct-static`            | Yes            | No                                                                        | No             | Stored `action.graphId`; target and its supported dependencies are definitely reachable                                                                          |
| `ReferencedGraphAliasNode`                              | Executor            | `cross-project`            | Yes            | No                                                                        | Yes            | Must not mark current-project graphs as used                                                                                                                     |
| `NodeTestGroup.evaluatorGraphId`                        | Test-only reference | excluded from reachability | Yes            | No                                                                        | No             | Relevant for template duplication, not main-graph reachability                                                                                                   |

## `Call Graph` Findings

`Call Graph` is the main complexity multiplier.

The supported static allowlist is intentionally small:

- immediate upstream `GraphReferenceNode`
- connected from its `graph` output
- `useGraphIdOrNameInput === false`
- stored `graphId` still exists in the current project

Everything else is treated as dynamic.

That includes:

- input-enabled `GraphReferenceNode`
- nontrivial upstream chains
- code-generated graph reference objects
- `ListGraphsNode`
- generic object pipelines

Important nuance:

- `graph-reference` is coercible from `string` or `object`
- however, `CallGraphNode` currently looks up `context.project.graphs[graphRef.graphId]`
- a plain string input becomes `{ graphName, graphId: '' }` during coercion and therefore does **not** execute a graph by itself
- a compatible object or actual `graph-reference` value can still execute graphs without a `GraphReferenceNode`

So the stale assumption is not "strings definitely work", but rather "runtime-built graph-reference-like values can bypass `GraphReferenceNode` entirely".

## Supported Scope

Implemented analysis scope:

- built-in nodes
- bundled OpenAI `openaiRunThread` node

Explicitly unsupported:

- arbitrary third-party plugin nodes that may hide graph IDs in custom data shapes
- value-flow proof beyond the immediate static `GraphReferenceNode -> Call Graph` case

## Repo Mismatches Found

### `useNewProjectFromTemplate.ts`

The old comment and logic were stale.

Before this investigation, template duplication only remapped:

- `SubGraphNode.data.graphId`
- `LoopUntilNode.data.targetGraph`
- `project.metadata.mainGraphId`

That missed other persisted same-project graph references, including:

- `GraphReferenceNode.data.graphId`
- `CronNode.data.targetGraph`
- `DelegateFunctionCallNode.handlers[]`
- `DelegateFunctionCallNode.unknownHandler`
- `RunThreadNode.toolCallHandlers[]`
- `RunThreadNode.onMessageCreationSubgraphId`
- node test groups via `NodeTestGroup.evaluatorGraphId`
- node variants containing any of the supported graph-ID fields

The remap logic is now centralized in [`templateProjectGraphIds.ts`](../packages/app/src/utils/templateProjectGraphIds.ts).

### User docs

Current user docs still frame inter-graph execution mostly in terms of `Subgraph`.

That is incomplete relative to the current codebase because same-project execution can also happen through:

- `Call Graph`
- `Loop Until`
- `Cron`
- `Delegate Tool Call`
- `Run Thread` bundled plugin handlers

### `CronNode`

The editor exposes `useTargetGraphInput`, but the current `process()` path still throws when `data.targetGraph` is missing and always executes the stored `targetGraph`.

For reachability, this is treated as a static stored edge plus a warning.

## Current Implementation Recommendation

When the graph-list feature is implemented, use:

- `definitely reachable`: normal graph styling
- `dynamically reachable`: ambiguous styling / badge / tooltip, not "unreachable"
- `unreachable`: the only bucket that should be visually marked with the muted uniform-stroke single broken-thread icon, whose tooltip explains that the graph is not reachable from the Main Graph or a web app

That preserves the three-bucket model without collapsing dynamic `Call Graph` dispatch into a false negative. `Delegate Tool
Call` is handled from its connected Tool surface rather than by treating every graph name as callable: a manual delegate adds
only its stored handler/fallback IDs, while auto-delegate adds the exact first graph selected by the runtime for each connected
Tool node with a stored name. Selection prefers an exact graph-name match even if an earlier graph merely contains the Tool
name, then falls back to the first contains match. Both runtime and analysis call the same pure core matcher for that rule;
they only differ in the identity returned after matching (metadata ID for runtime, serialized project-map key for analysis).
Dynamic Tool names remain unproven and do not affect the indicator.

The graph list also uses the same dependency-edge collector in reverse for local context: when a graph is open,
every other graph with a supported same-project dependency edge to the open graph gets a small active-color dot beside
its name, and every web app with a Button or Chat action targeting it gets the same dot. This is source-reference visibility,
not reachability from Main, so it can mark direct static callers and Call Graph dynamic-dispatch callers even if those source
graphs are themselves unreachable. `Delegate Tool Call` nodes
are intentionally excluded from this reverse marker entirely, including manual handler and fallback edges, because
auto-delegate can theoretically route to any named graph and would make one delegate node appear to reference almost
every graph in the sidebar.

Both graph-list indicators are user-facing presentation preferences. The Settings modal's `Graphs` page can hide the
unreachable graph indicator feature and the reverse-reference dot feature independently, and both settings default to enabled.
When unreachable graph indicators are hidden, the sidebar also skips reachability analysis and does not show reachability
notices.
