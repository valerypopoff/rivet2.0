# Behavior-Preserving Refactor Plan

## Status

**Phases 1-2 completed and verified by 2026-07-25. Phases 3-5 remain planned
and are not yet implemented.**

This plan was prepared after reassessing the current repository and the 134
completed refactors recorded in `refactor-history.md`.

The plan received a second live-code audit after its initial draft. That audit
checked the current callers, package boundaries, test coverage, mutation and
identity behavior, editor/runtime differences, graph-order dependencies, DOM
measurement ownership, and execution-event contracts. The corrections from
that audit are incorporated below.

The repository has already received broad decompositions of `GraphProcessor`,
NodeCanvas, GraphList, Chat V2, UI Graph Builder, JSON previews, executor
sessions, and hosted web-app infrastructure. This plan does not repeat those
efforts. It targets five narrower ownership problems that remain in the current
code, primarily in features added after the latest history entry.

## Goals

- Preserve all runtime behavior and user-visible behavior.
- Make policy ownership explicit and easier to audit.
- Reduce the chance that editor, runtime, and provider behavior drift apart.
- Make high-risk execution code easier to test and safely change.
- Reduce production lines where doing so does not introduce denser or more
  abstract code.

## Non-goals

- No persisted project, graph, or settings format changes.
- No public behavior changes or opportunistic bug fixes.
- No redesign of NodeCanvas, GraphList, UI Graph Builder, hosted web apps,
  legacy Chat providers, or unrelated `GraphProcessor` policies.
- No new general-purpose framework solely to make files smaller.
- No line-count target that takes priority over clear ownership.

## Required Working Method

Each phase must:

1. Add or confirm characterization coverage before moving behavior.
2. Preserve errors, event order, output shapes, cancellation, costs, and
   serialization where applicable.
3. Land as an independent commit that can be reviewed or reverted separately.
4. Update the owning developer documentation.
5. Append a completed entry to `refactor-history.md` only after the phase is
   implemented and verified.

The recommended implementation order is deliberately different from the value
ranking: begin with the smaller policy consolidations and leave the
`GraphProcessor` extraction until its boundary is fully characterized.

## Reassessment Decisions And Invariants

- LOC estimates are directional planning aids, not acceptance criteria. A phase
  must not compress policy into harder-to-read code to meet an estimate.
- "No behavior change" includes error messages, object identity and mutation
  where observable, graph connection-order semantics, execution events,
  recording/debugger data, and browser layout behavior.
- Pure helpers needed across the app/core package boundary may be added to the
  existing exported core Knowledge Store and delegation surfaces. Those
  helpers become supported additive API and must be typed and documented; no
  internal source deep import is allowed.
- Characterization fixtures must use both valid and malformed-but-currently
  tolerated inputs. A refactor must not silently turn validation tightening
  into an unplanned behavior change.
- The current graph/project object and connection insertion order remain
  authoritative where runtime code currently relies on them.
- DOM geometry stays owned by DOM measurement. Pure Data Bus models may
  describe topology and presentation state, but must not attempt to predict
  live port coordinates.
- Specialized execution coordination may move out of `GraphProcessor`, but
  root mutable run state must not be exposed through a broad mutable adapter.
- Existing benchmark and LOC baselines must be measured again immediately
  before implementation; the numbers in this document are not treated as
  current test assertions.

---

## Phase 1: Make Data Coercion a Single Declarative Policy - DONE

### Status

**Completed on 2026-07-24.**

The implementation added one exhaustive `scalarCoercionRules` registry that
owns both specialized runtime dispatch and type-level `canAttempt`
compatibility. Array recursion, function unwrapping, and `any` behavior remain
explicit structural wrappers so the existing order and permissive compatibility
semantics did not change.

The characterization baseline contains 80 data types and all 6,400 ordered
type pairs. It locks the existing 2,270 incompatible pairs with both an
independent legacy-policy comparison and a stable matrix digest. Value-level
coverage records nullish and falsy handling, `parseFloat` / `NaN`, array
mapping and failures, identity preservation, first-element inference, function
evaluation, media and graph-reference behavior, Knowledge value normalization,
and in-place legacy chat-message mutation.

The expected production deletion did not materialize. `coerceType.ts` grew by
65 physical lines because the previous compact `ts-pattern` dispatch and separate
compatibility conditions were replaced with an explicit entry for every scalar
type and structural array/function boundaries were made explicit. That trade is
intentional: the mapped registry makes a missing future scalar policy a
compile-time error and is easier to audit than compressing the matrix behind
implicit defaults.

Three reassessment passes removed a redundant target field, activated the
registry's `any` compatibility rule, and fixed concrete `DataValue` contract
violations. Deferred `any` values no longer create invalid empty data types;
`fn<T[]>` defaults return arrays; scalar extraction always returns a scalar
even for `fn<T[]>`; mutable defaults are isolated; dynamic `any`/`object`
arrays stay flat; matching concrete values can populate deferred ports; exact
deferred values keep their function identity; deferred `any` values never leak
raw scalars or nested callbacks; and missing values no longer pass the negative
function-value guard. Get/Set Global now use the shared default owner, while
app render/copy paths use the separate full return-type helper so
`Function<T[]>` labels remain accurate.

Across the affected production files, the phase is a net `+123` physical
lines: `coerceType.ts` `+64`, `DataValue.ts` `+17`, `expectType.ts` `+50`, the
two Global nodes `-9`, and app consumers `+1`. The focused characterization
file contains 359 lines.

### Problem

`packages/core/src/utils/coerceType.ts` contains both runtime conversion logic
and a separately maintained `canBeCoerced(...)` compatibility function. The
file explicitly warns that the two are hard to keep synchronized.

Port compatibility therefore depends on a second hand-maintained model of what
runtime coercion can do. Adding a data type or conversion can update one path
without updating the other.

There is also no focused exhaustive test that records the complete
`DataType x DataType` compatibility matrix.

### Implementation

- Add characterization tests for the current complete compatibility matrix
  before changing the implementation.
- Add representative value-level tests for every special coercion family:
  - scalar-to-scalar;
  - scalar-to-array;
  - array-to-array;
  - array-to-string and array-to-object;
  - `any`;
  - function values;
  - binary and media values;
  - graph references;
  - Knowledge Source values.
- Characterize non-obvious observable behavior before extraction:
  - `parseFloat(...)` results, including `NaN`;
  - array conversion order and failure behavior;
  - first-element array inference in `inferType(...)`;
  - `undefined`, `null`, empty string, zero, and false handling;
  - object and array identity preservation;
  - on-demand function unwrapping;
  - in-place normalization of assistant `function_call.arguments`.
- Introduce declarative scalar coercion rules containing:
  - the target scalar type;
  - the runtime coercer, when the target has specialized conversion behavior;
  - a separate `canAttempt` type predicate describing compatibility.
- Keep runtime conversion and type-level compatibility as distinct operations
  in the same exhaustive rule. Do not infer compatibility merely by invoking a
  coercer against a synthetic value.
- Centralize array, function, and `any` dispatch around those rules while
  preserving the existing recursive conversion order.
- Derive `canBeCoerced(...)` from the `canAttempt` side of the same rules used
  to select runtime conversion.
- Preserve the current permissive meaning of compatibility: it means that a
  conversion is possible for that pair of types, not that every possible
  runtime value will successfully convert.
- Preserve existing thrown errors and `undefined` results exactly.
- Keep `inferType(...)` behavior in the same module but outside the coercion
  rule registry; inference and conversion are related utilities, not the same
  policy.

### Expected Result

- One owner for runtime coercion and editor compatibility.
- The synchronization TODO is removed.
- Future data types cannot silently omit compatibility policy.
- Expected production reduction: approximately 40-100 lines.

### Risks

- **Compatibility can be mistaken for guaranteed conversion.** Several
  type-pairs are allowed even though particular values return `undefined`,
  produce `NaN`, or throw. The registry must retain separate type-level and
  value-level decisions.
- **Existing coercion mutates some inputs.** Chat-message normalization can
  stringify function-call arguments in place. Copying values during the
  refactor would be an observable change even if the returned data is equal.
- **`any` and function values recurse through inference and unwrapping.**
  Reordering the generic wrappers can change which coercer receives the value.
- **Array coercion is not uniformly all-or-nothing.** Mapping order, thrown
  errors, and retained `undefined` values must be characterized rather than
  "cleaned up."
- **This utility has a very large caller surface.** A small semantic change can
  alter node defaults, comparison, conditionals, port wiring, provider
  requests, and execution-data rendering. Full core and app coverage is
  required, not only the new focused tests.
- **An exhaustive table can become harder to read than the existing code.**
  Stop if the descriptor shape needs target-specific escape hatches that hide
  rather than clarify conversion behavior.

### Verification

- Exhaustive compatibility-matrix test.
- Representative runtime coercion tests.
- Identity and mutation assertions for object, array, chat-message, and
  function values.
- Compile-time exhaustiveness check against `dataTypes`/scalar type ownership
  so a newly added type cannot bypass the policy.
- Existing graph connection-validation tests.
- Core tests and typecheck.
- App tests that exercise port compatibility.

---

## Phase 2: Centralize Knowledge Store Field and Credential Normalization - DONE

### Status

**Completed on 2026-07-25.**

The implementation added
`packages/core/src/integrations/KnowledgeStoreFieldPolicy.ts` as the single
provider-neutral owner of draft defaults, structured field issues, permissive
draft normalization, strict persisted-definition normalization, and the nested
credential settings tree. Provider registration, runtime connection
resolution, editor save/test, and local credential persistence now consume
that shared policy through the normal core package export.

Editor-only workflow behavior moved into the small tested
`projectKnowledgeStoreDraft.ts` model. Existing drafts cannot change provider,
new-provider selection resets configuration and credentials, duplicate names
remain deterministic and case-insensitive, duplication never copies
credentials, and Save/Test Connection normalize the same unsaved data. React
continues to own modal state, confirmation, notifications, and aborting
superseded connection tests.

The policy deliberately preserves distinct draft/runtime behavior for both
connections and credentials. Unknown editor-draft properties are dropped,
while unknown persisted project configuration is rejected. Structured issues
contain only code, field key, and field label; rejected values and
credential-bearing field objects never enter errors or metadata. Ordinary,
malformed, and prototype-less settings records, false, zero, whitespace,
explicit null/undefined, defaults, select options, and empty credential-parent
behavior are characterized.

The post-implementation reassessment made the public boundary harder to misuse:
single-field normalization now requires one of the four explicit modes,
definition and editor-draft normalization reject a mismatched provider,
credential-draft naming is consistently plural, and dynamic settings keys are
created and read back as own data properties instead of going through object
prototype setters. The credential-only field contract is now named and accepts
readonly specifications, string-only defaults, and no select-only options,
matching registry snapshots and registration rules. Editor issue formatting is
exhaustive over the shared issue-code union. The shared declared-field loop was
also simplified to one default-selection helper plus an entry list.

The expected production deletion did not materialize. The two former private
implementations were smaller because neither exposed the complete reusable
policy surface or isolated the editor workflow. Across the affected production
files this phase is a net `+242` physical lines: the core policy and app draft
model add 447 lines, the existing core/app call sites and export move
`+70/-275`. This is an intentional ownership trade: the settings-shape and
field policy now each have one auditable owner, while the main React component
and provider/controller file both shrink substantially.

### Problem

Knowledge Store configuration policy is duplicated between:

- `packages/core/src/integrations/KnowledgeStoreProvider.ts`;
- `packages/app/src/components/ProjectKnowledgeStoresConfiguration.tsx`.

Both paths independently implement defaults, required-field validation, type
checks, select-option validation, credential lookup, and manipulation of the
`knowledgeStoreCredentials` settings tree.

The editor can therefore accept or serialize a value differently from the
runtime that later consumes it. Credential storage also has multiple owners
that need to understand its nested settings shape.

### Implementation

- Add a focused core provider-field policy module with pure helpers for:
  - constructing provider-field draft defaults;
  - validating and normalizing one declared field value;
  - normalizing UI draft connection fields;
  - strictly normalizing a persisted connection definition;
  - normalizing provider credential fields;
  - reading credentials for one provider connection;
  - immutably writing or removing credentials for one provider connection.
- Use the registered provider field specifications as the only schema.
- Preserve the two intentional normalization modes:
  - UI draft normalization iterates declared fields and drops unknown draft
    properties, matching the current save/test behavior;
  - runtime definition normalization rejects unknown persisted configuration
    fields, matching the current controller behavior.
- Have the shared field validator return a typed field issue rather than
  hard-coding one universal error sentence. The UI and runtime format the same
  issue with their existing context and exact current messages.
- Reuse the helpers in both `KnowledgeStoreController` and the project settings
  UI.
- Export the helpers through the existing core Knowledge Store API because the
  app consumes core through its package boundary. Do not create a source deep
  import or an additional package subpath.
- Keep React responsible only for modal state, controls, confirmation, and
  notifications.
- Preserve:
  - `Settings.pluginSettings` storage shape;
  - local-only credential behavior;
  - unknown-field rejection;
  - provider and plugin ownership checks;
  - default application;
  - exact outward validation messages.
- Preserve UI workflow details that are separate from field normalization:
  - an existing connection cannot switch provider;
  - changing provider on a new draft resets config and credentials;
  - duplicating a connection copies configuration but not credentials;
  - removing a connection clears only its credential entry;
  - testing a connection aborts the previous test and uses the unsaved draft.
- Do not expose credential values through project metadata, graph data, logs,
  or error metadata.

### Expected Result

- One owner for provider-field semantics.
- One owner for the credential settings shape.
- The settings UI loses its low-level credential-tree manipulation code.
- Expected net production reduction: approximately 30-80 lines.

### Risks

- **UI and runtime validation are deliberately different at the boundary.**
  Reusing one strict function for both would make the editor reject stale draft
  properties that it currently discards.
- **Error wording is user-visible behavior.** A shared validator must report
  structured issues so each caller can retain its existing connection-specific
  or field-only wording.
- **Credential data is sensitive.** Generic debugging, thrown metadata, test
  snapshots, or accidental placement in project metadata could expose secrets.
- **The credential tree is provider-scoped.** Confusing provider ID with owning
  plugin ID would make saved credentials appear missing or attach them to the
  wrong plugin settings.
- **Empty credential behavior is subtle.** The current code may retain empty
  parent settings objects while deleting the connection entry. Normalizing the
  surrounding tree more aggressively would change persisted settings.
- **Defaults and empty values are type-specific.** Boolean `false`, numeric
  zero, empty optional strings, required whitespace strings, and select values
  must retain current treatment.
- **New core exports become supported API.** Names and types must be narrow and
  provider-neutral; React draft types and UI-only wording must not leak into
  core.
- **Store instance caching is unrelated.** This phase must not alter
  `KnowledgeStoreController`'s project-object cache, host-store precedence, or
  provider factory lifecycle.

### Verification

- Characterize current editor and runtime normalization against the same field
  specifications.
- Test required, optional, boolean, number, select, string, and secret fields.
- Test malformed and prototype-less settings objects.
- Test write, replace, clear, duplicate, provider switch, and connection
  removal behavior.
- Assert that duplicate never copies credentials and that provider changes are
  only possible for new drafts.
- Assert that UI mode drops unknown draft fields while runtime mode rejects
  unknown persisted fields.
- Assert that no credential value appears in errors or serialized project
  metadata.
- Run Knowledge Store provider, controller, settings-modal, and Pinecone tests.

---

## Phase 3: Separate Graph Dependency Discovery from Reachability Traversal - DONE

### Status

- Added `graphDependencyDiscovery.ts` as the ordered, per-graph connection
  index and closed built-in dependency-resolver owner. It now covers the
  existing Subgraph, Loop Until, Cron, Delegate Tool Call, Run Thread, Call
  Graph/Graph Reference, and cross-project alias rules without changing their
  serialized inputs or reachability semantics.
- Kept `graphReachability.ts` focused on roots, traversal mode propagation,
  plugin diagnostics, blocked/partial/ready status, and final buckets. The
  reverse-reference query still excludes Delegate edges.
- Added the shared generic core auto-delegate matcher. Runtime retains metadata
  IDs; editor analysis retains serialized project-map keys, including malformed
  projects where those values differ.
- Characterization now proves exact/contains/missing matching, first-connection
  behavior, Delegate root/reference distinctions, and both malformed identity
  behaviors.

### Problem

`packages/app/src/utils/graphReachability.ts` combines:

- graph traversal and definite/dynamic classification;
- connection indexing;
- runtime-specific interpretation of many node types;
- Call Graph provenance;
- Delegate Tool Call reachability;
- UI Graph roots;
- plugin support diagnostics;
- warning construction.

Its auto-delegate graph-name resolution also duplicates runtime logic in
`packages/core/src/model/nodes/toolCallDelegation.ts`, including exact-name
matching followed by the `includes(...)` fallback.

This creates a concrete safety risk: runtime graph resolution can change while
unreachable-graph analysis continues using an older rule.

### Implementation

- Extract the auto-delegate name matcher into a shared generic pure core
  helper used by both execution and reachability analysis. It accepts ordered
  candidates plus a graph-name accessor and returns the original candidate.
- Runtime passes ordered graph objects; analysis passes ordered
  `[projectMapKey, graph]` entries. The helper must not impose a graph-ID source,
  so both callers retain their existing malformed-input behavior.
- Preserve `Object.values(...)`/`Object.entries(...)` insertion order: first
  exact-name match wins; only then does the first contains-name match win.
- Build one per-graph dependency index containing:
  - nodes by ID;
  - graph-order input and output connection lists;
  - effective first valid input connections where a resolver needs runtime
    first-connection semantics;
  - outgoing connections;
  - graph IDs and graph-name lookup data.
- Move node-specific dependency discovery into focused resolvers for:
  - Subgraph;
  - Loop Until;
  - Cron;
  - Delegate Tool Call;
  - Run Thread;
  - Call Graph and Graph Reference;
  - cross-project graph aliases.
- Keep `getGraphReachabilityReport(...)` responsible for:
  - reachability roots;
  - definite versus dynamic propagation;
  - unsupported-node reporting;
  - blocked/partial/ready status;
  - final unreachable buckets.
- Keep the two other public queries behaviorally distinct:
  - `getGraphIdsReferencingGraph(...)` must continue excluding Delegate Tool
    Call edges rather than treating every possible delegated handler as a
    direct reference;
  - UI Graph reference discovery remains limited to direct Button and Chat
    action targets.
- Preserve:
  - first-valid-input runtime semantics;
  - disabled-node behavior;
  - exact-name-before-contains auto-delegate matching;
  - fallback-handler rules;
  - static versus dynamic Call Graph classification;
  - warning text and ordering;
  - third-party plugin partial-analysis behavior.
- Preserve the current conservative analysis boundary for unknown and
  third-party node types. This refactor does not add a plugin dependency
  descriptor API.

### Expected Result

- Traversal is independent from node-specific dependency policy.
- Runtime and analysis share the most fragile resolution rule.
- New graph-executing nodes have an obvious dependency-resolver seam.
- Expected reduction in the main reachability module: approximately 250-350
  lines. Total production LOC may remain near neutral because named resolvers
  replace a monolithic switch.

### Risks

- **Static analysis intentionally approximates runtime.** "Improving" a
  conservative dynamic edge into a static edge can incorrectly mark graphs
  safe to delete.
- **Connection array order is observable.** Runtime and analysis use the first
  valid connection in several paths. Sorting or indexing through an unordered
  structure would change results.
- **Project map keys and `graph.metadata.id` are normally equal but are not
  interchangeable for malformed projects.** The shared name resolver must not
  silently choose one identity representation for both callers.
- **Delegate reachability has two roles.** Connected delegate handlers can act
  as reachability roots, while the "graphs referencing this graph" query
  intentionally excludes those broad edges. A generic traversal helper must
  not collapse the distinction.
- **Disabled and unsupported nodes are diagnostic policy, not just filtering.**
  Moving resolvers must retain when analysis is `partial`, when warnings are
  emitted, and when unsupported nodes in unreachable graphs are ignored.
- **Warning order is user-visible and test-visible.** Replacing ordered loops
  with unordered set/map projection can produce unstable reports.
- **A resolver registry can become an unnecessary framework.** Keep the
  built-in resolver set closed and explicit in this phase; plugin-extensible
  dependency metadata would be separate functionality.

### Verification

- Preserve the existing reachability suite as characterization coverage.
- Add direct shared-resolver tests proving runtime and analysis choose the same
  graph for exact, partial, missing, and fallback cases.
- Test malformed connections, disabled providers, multiple candidate inputs,
  dynamic Tool names, and missing graphs.
- Add malformed graph identity fixtures where the project map key and metadata
  ID disagree, and assert that execution-facing and analysis-facing callers
  preserve their current ID behavior.
- Assert stable edge/warning order and the intentional Delegate exclusion from
  `getGraphIdsReferencingGraph(...)`.
- Run app reachability, core delegation, project loading, and unreachable-graph
  diagnostics tests.

---

## Phase 4: Centralize Data Bus Topology And Presentation Derivation - DONE

### Status

- `createDataBusTopology(...)` now builds the one scoped preview-connection
  index for channel membership, input/output port groups, normal endpoint
  antennas, active channel keys, and wire visibility decisions.
- `buildDataBusGroupPresentation(...)` keeps channel pairing, provider state,
  consumer counts, and related-hover derivation pure while `DataBusRail` keeps
  `useCanvasNodeIO(...)` live for reactive plugin and variadic definitions.
- `NodePorts` and `WireLayer` consume the shared topology. The rail's DOM
  measurement and full-row state publication moved to `useDataBusRailLayout`,
  and its CSS moved to `dataBusRailStyles.ts`.
- Preview, definition-valid, comparison-removed, and port-coordinate ownership
  remain distinct; no geometry is synthesized by the topology model.

### Problem

`packages/app/src/components/nodeCanvas/DataBusRail.tsx` currently combines:

- responsive rail measurement;
- compact versus full-row state;
- global row-height publication;
- connection grouping;
- passthrough channel pairing;
- provider labels;
- consumer counts;
- related hover-channel discovery;
- settings and port interactions;
- a large CSS surface;
- rendered markup.

At the same time, `dataBusModel.ts`, NodeCanvas, NodePorts, and WireLayer build
related connection indexes independently. `DataBusGroup` scans all connections
again for every bus.

The feature works, but its presentation state has several owners. This is
especially risky for multiple buses, responsive full-width rows, hover-revealed
wires, and connection dragging.

### Implementation

- Extend the existing pure Data Bus model into one shared connection-topology
  index built per canvas from effective nodes and preview connections.
- The topology index must contain:
  - connections grouped by input and output node/port;
  - connection-to-bus-channel relationships;
  - normal-node port-to-channel relationships;
  - active channel keys;
  - enough information for WireLayer to decide hidden versus hover-revealed
    connections without rescanning the graph.
- Keep live node input/output definitions subscribed through
  `useCanvasNodeIO(...)` in each `DataBusGroup`. Those definitions can change
  with node data and plugins and cannot safely be snapshotted by a one-time
  canvas builder.
- Add a pure per-group presentation builder that combines current live
  definitions with the shared topology index and returns:
  - ordered channels;
  - paired input/output definitions;
  - provider connections and provider labels;
  - consumer counts;
  - missing/multiple-provider state;
  - related hover-channel keys.
- Reuse the shared topology index in NodePorts and WireLayer; reuse the
  per-group presentation builder in DataBusRail.
- Extract compact/full-row DOM measurement and observer ownership into a
  dedicated hook that delegates arithmetic to the existing pure layout
  helpers.
- Move rail styling to a focused style owner so the component primarily
  expresses structure and events.
- Keep port coordinates in `useNodePortPositions(...)`, measured from actual
  rendered `.port-circle` elements. The topology model must not synthesize
  coordinates or replace DOM observation.
- Preserve the distinction between persisted/effective connections, preview
  connections, and comparison-only removed connections.
- Preserve:
  - compact/full-row thresholds and geometry;
  - one full-width row per bus;
  - sidebar offset and canvas-height behavior;
  - fixed header and Connect Provider sections;
  - horizontal scrolling;
  - port drag behavior;
  - antenna and hover-revealed wire behavior;
  - selection, comparison, search, and disabled presentation;
  - context-menu suppression.

### Expected Result

- Connection topology is interpreted once.
- Rail rendering becomes mostly declarative while retaining reactive IO
  subscriptions.
- Multiple-bus and hover behavior become testable without reproducing DOM
  calculations.
- Expected net production reduction: approximately 50-120 lines, primarily by
  removing repeated indexing and channel derivation.

### Risks

- **Live port definitions are reactive.** Building one immutable canvas-wide
  presentation object from definitions would become stale when node data,
  plugins, referenced projects, or variadic ports change.
- **Topology and geometry have different owners.** Replacing DOM port
  measurement with calculated positions would break fixed/full-row rails,
  zoom, sidebar offsets, font scaling, and detached-window rendering.
- **There are several connection views.** Persisted connections, filtered
  effective connections, drag preview connections, and compare-removed
  connections must not be merged into one ambiguous collection.
- **Context identity can cause canvas-wide rerenders.** The topology index and
  derived sets must be memoized from stable inputs, and context values must not
  be recreated on unrelated node execution updates.
- **ResizeObserver feedback is easy to reintroduce.** Measuring constrained
  full-row widths instead of intrinsic compact widths can make the rail
  oscillate between modes.
- **Multiple bus rows publish global layout state.** Unmount cleanup, graph
  switches, zero-bus transitions, sidebar resizing, and one-row-per-bus height
  accounting must remain exact.
- **Hover wires use a fixed overlay and real DOM port positions.** Changing
  z-index, portal ownership, or when antennas are suppressed can render wires
  under the rail or make them start from stale coordinates.
- **Invalid and multiple-provider states are intentionally representable.**
  The model must describe them rather than normalizing them away.
- **Moving CSS alone is not a refactor benefit.** The style extraction only
  pays rent if it leaves layout ownership and selectors easier to audit; it
  must not create a second token or geometry source.

### Verification

- Pure presentation-model tests for empty, missing, single, multiple, and
  pathological provider configurations.
- Component behavior tests for:
  - compact and full-row transitions;
  - multiple pinned bus rows;
  - sidebar resizing;
  - scrollable channels with fixed ends;
  - provider and receiver drag starts;
  - hover wire replacement and highlighting;
  - settings selection;
  - context-menu suppression.
- Reactivity tests where a bus node's variadic definitions or effective node
  data changes after the initial render.
- Tests that compare-removed connections remain visible without becoming
  active topology and that preview connections drive drag-time presentation.
- Tests that topology memoization does not change on execution-only state
  updates.
- Observer cleanup tests for graph changes, bus removal, and component
  unmount.
- Existing wire geometry, port positioning, canvas interaction, and data-bus
  layout tests.

---

## Phase 5: Extract Tool-Call Continuation from `GraphProcessor` - DONE

### Status

- Added `ToolCallContinuationBranchPlanner` as a pure per-round topology
  snapshot. It indexes effective connections and derives only continuation
  branch nodes, safe preload boundaries, async branch inclusion, and the
  existing unsafe cycle/race/loop rejection.
- Added `ToolCallContinuationCoordinator` with an operation-only adapter. It
  creates model-order scalar Delegate invocations, overlaps early Message
  branches with handler work, cancels siblings on the first failure while
  waiting for settlement, and returns model-ordered results plus deferred
  branch writes.
- Kept temporary branch processor construction, root/run state inheritance,
  event emission, cost ownership, and parent-state commits in `GraphProcessor`.
  The processor snapshots the planner only after pause gating, preserving the
  original point at which a continuation round observes mutable graph state.
- Added direct planner characterization for effective connections/preloads,
  unsafe ready nodes, and async branch injection. The existing continuation
  suite remains the event/order integration contract. A focused coordinator
  test also pins the post-pause point at which the branch adapter is created.

### Problem

`packages/core/src/model/GraphProcessor.ts` remains the largest production
module. Earlier refactors correctly extracted individual policies rather than
rewriting its scheduler.

Since the latest refactor-history entry, the processor has gained a new
coherent responsibility: connected LLM tool-call continuation. The relevant
code now owns:

- continuation invocation registration and finalization;
- one real Delegate invocation per model tool call;
- parallel tool execution and ordered joining;
- early Assistant Message branches;
- final result branches;
- continuation-specific child processors;
- branch topology and unsafe-node detection;
- cancellation and sibling failure;
- cost aggregation;
- Graph Output overlays;
- replay and normal-traversal suppression.

This is now large enough to be a subsystem, while remaining tightly embedded
in the general graph scheduler.

### Implementation

- Do not perform a general `GraphProcessor` decomposition.
- Treat connected tool-call continuation as one policy boundary.
- Extract a pure continuation-branch planner responsible for:
  - effective connection indexes;
  - reachable continuation nodes;
  - boundary/preloaded nodes;
  - unsafe cycle/race/loop rejection;
  - async-branch inclusion;
  - the branch graph and preload plan.
- Extract a `ToolCallContinuationCoordinator` responsible for:
  - allocating model-order invocation records;
  - starting scalar Delegate invocations concurrently;
  - coordinating early and final branches;
  - cancelling siblings on the first failure while still awaiting every
    started invocation to settle;
  - ordered result joining;
  - returning completed outputs and Graph Output writes to the processor.
- Give the coordinator a narrow explicit adapter for operations that must
  remain owned by `GraphProcessor`:
  - node lifecycle event emission;
  - process-context creation;
  - child processor creation and wiring;
  - pause and abort signals;
  - cost accumulation;
  - committed node/graph result state.
- The adapter must expose operations, not mutable processor maps or private
  fields. The coordinator returns an immutable round result containing ordered
  tool results, per-call outputs, branch node outputs, and deferred Graph
  Output writes.
- Keep continuation child-processor construction and private
  `GraphProcessor` state transfer behind the processor-owned branch-run
  adapter. Do not duplicate subprocessor setup in the coordinator.
- Commit per-call branch results in original model-call order after all calls
  settle, matching the current behavior even when completion order differs.
- Keep `GraphProcessor` responsible for:
  - root-run lifecycle;
  - scheduler state;
  - shared globals and stored values;
  - subprocess ownership;
  - final graph outputs;
  - recording and debugger event transport.
- Preserve exactly:
  - one scalar Delegate run per tool call;
  - process ID allocation order;
  - parallel start and model-order join;
  - early Message/tool overlap;
  - normal versus async downstream completion;
  - fail-fast cancellation and passthrough errors;
  - nodeStart, partialOutput, nodeFinish, and nodeError ordering;
  - Run To behavior;
  - direct-return tools;
  - replay, preload, and frozen-output restrictions;
  - cost attribution and graph-level aggregation;
  - Graph Output conflict order;
  - no ordinary traversal replay of consumed continuation nodes.
- Preserve the current `latestOutputs` semantics for a node with multiple real
  Delegate invocations; editor run history remains event-backed while the
  processor's node-result map retains the same final round value it does now.
- Use a two-step implementation inside this phase:
  1. extract and verify the pure branch planner;
  2. extract the invocation coordinator against the stable planner contract.
     Do not combine both moves in one uncharacterized rewrite.

### Expected Result

- `GraphProcessor.ts` becomes approximately 500-700 lines smaller.
- Tool continuation has a named, testable owner.
- The general scheduler no longer contains the complete specialized
  continuation scheduler inline.
- Total production LOC may remain neutral or increase slightly; clarity and
  execution safety take priority for this phase.

### Risks

- **Execution events are externally observable.** Editor run pages,
  recordings, debugger transports, and remote executors depend on process IDs,
  event order, partial outputs, timings, and finish/error attribution.
- **"Fail fast" still waits for settlement.** Throwing as soon as the first
  call rejects can leak sibling events or child processors after the parent
  round has failed.
- **Completion order must not become commit order.** Tool-result messages,
  Graph Output conflict resolution, `latestOutputs`, and the next LLM request
  use original model-call order.
- **Cost has several accumulation paths.** Delegate outputs, branch
  subprocessors, and graph-level totals can be lost or counted twice if
  ownership is not explicit.
- **Early Message branches overlap tool work.** Accidentally awaiting the early
  branch before invoking the tool would reintroduce the latency behavior this
  subsystem was designed to remove.
- **Async branches have split completion semantics.** Logical graph completion,
  managed async lifetime, web-app response timing, and cancellation must retain
  their current relationship.
- **A broad adapter would only hide `GraphProcessor` coupling.** If the
  coordinator needs arbitrary access to processor maps or lifecycle flags, the
  boundary is wrong; keep that operation in the processor instead.
- **Child processors inherit substantial root state.** Stored values, Knowledge
  Stores, globals, graph inputs, execution identity, frozen outputs, loaded
  projects, pause state, and abort ownership must continue to be wired by the
  same owner.
- **Replay and normal traversal interact with continuation completion.**
  Incorrectly marking descendants complete can either repeat side effects or
  suppress legitimate downstream execution.
- **Extraction can affect hot paths.** Extra copies of branch graphs, outputs,
  or connection indexes may regress parallel tool rounds even when semantics
  remain correct.

### Verification

- Keep the existing tool-continuation suite as the primary characterization
  contract.
- Add focused planner tests that do not instantiate a full processor.
- Test single, parallel, mixed, direct-return, failed, cancelled, replayed,
  frozen, Run To, cycle, race, loop, async, and Graph Output cases.
- Assert exact node event sequences and process IDs for successful,
  completion-out-of-order, and first-failure rounds.
- Assert that all started siblings settle before the round rejects and that no
  child processor or abort listener remains registered.
- Assert model-order commit when completion order is reversed, including
  Graph Output conflicts and `latestOutputs`.
- Assert exact per-invocation and graph-level costs for normal, error
  passthrough, and branch-subgraph cases.
- Verify Browser, internal Node, remote Node, editor web apps, detached Tauri,
  hosted HTTP, and hosted WebSocket execution.
- Run runtime equivalence and benchmark suites to ensure the extraction does
  not introduce scheduler regressions.

---

## Final Repository Verification

After all five phases:

- Run focused suites after each commit.
- Run the aggregate repository test command.
- Run all affected workspace typechecks.
- Run lint and formatting checks.
- Run developer-document validation and link checks.
- Run file-tree and architecture-boundary checks.
- Run generated hosted-client and graph-creator freshness checks.
- Run the production build.
- Run the runtime equivalence and benchmark matrix.
- Run dependency security checks.
- Run `git diff --check`.

The final review must compare behavior and ownership against this plan, then
record the actual line movement and verification evidence in
`refactor-history.md`.

## Success Criteria

The refactor program is complete only when:

- all five policies have one clear owner;
- editor/runtime policy duplication identified by this plan is removed;
- persisted formats and public behavior remain unchanged;
- existing characterization tests pass without weakening assertions;
- new focused policy tests cover the extracted seams;
- developer documentation names the new owners;
- the repository passes its full verification pipeline;
- actual LOC movement is reported honestly, including phases where safer
  ownership increases total lines.
