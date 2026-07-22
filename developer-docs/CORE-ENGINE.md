# Core Engine (`@valerypopoff/rivet2-core`)

> Detailed internal reference for the shared runtime package.

## Purpose

`@valerypopoff/rivet2-core` is the foundational package in the repo.

It owns:

- graph/project/node types
- the `DataValue` type system
- the execution engine
- node registration and built-in nodes
- built-in provider plugins
- runtime integration contracts
- serialization/deserialization
- recording/playback support
- public programmatic execution APIs

Every other runtime-oriented package in the monorepo builds on this package.

## Source Layout

```text
packages/core/src/
  api/           High-level APIs for processor creation and event streaming
  integrations/  Interfaces and implementations for LLMs, datasets, MCP, code runner, etc.
  model/         Graph model, processor, node contracts, plugin contracts, registration
  native/        Browser/node native API abstractions
  plugins/       Built-in provider/integration plugins
  recording/     Execution recording and playback support
  utils/         Serialization and shared helpers
  vendor/        Vendored support code
  exports.ts     Public export surface
  index.ts       Top-level entry
  plugins.ts     Built-in plugin export map
```

Important architectural note:

- built-in capabilities are split between `model/nodes` and `plugins/`
- not every feature node comes from the same registration path

## Public API Surface

The published export surface is defined by [`packages/core/src/exports.ts`](../packages/core/src/exports.ts).

That file re-exports:

- model types and runtime contracts
- the graph processor
- built-in nodes
- plugins
- integration interfaces
- recording APIs
- execution streaming APIs
- create/run processor helpers

For refactors, `exports.ts` is the API contract that downstream packages rely on. Downstream package code should import core through `@valerypopoff/rivet2-core`; it should not import `packages/core/src/...` files directly. The shared ESLint config enforces that boundary. When app presentation or another package needs to mirror runtime semantics, such as interpolation token parsing, warning-port handling, JS-list callback source interpolation, Gentrace app-facing utilities, `RivetUIContext`, tokenizer implementations, or project-reference loading, the shared contract should be exported intentionally from core instead of reaching into the source tree.

## Runtime Logging And Diagnostics

Runtime code must not log raw graph values by default.

That includes:

- graph inputs
- graph outputs
- `DataValue` payloads
- prompts
- provider stream chunks
- tool-call arguments
- processor traces

Core exposes small logging helpers from [`runtimeLogging.ts`](../packages/core/src/utils/runtimeLogging.ts). Use these helpers from app, executor, Trivet, and provider paths when runtime diagnostics are needed:

- `summarizeDataValueForLog(...)`
- `summarizePortMapForLog(...)`
- `summarizeUnknownForLog(...)`
- `summarizeErrorForLog(...)`
- `logRuntimeInfo(...)`
- `logRuntimeWarn(...)`
- `logRuntimeError(...)`
- `logRuntimeDebug(...)`

Default logs should contain lifecycle information and counts, not values. Useful default metadata includes ids, counts, durations, and status. Binary values, `ArrayBuffer`s, and typed-array views should be summarized by byte length rather than by enumerating their contents.

Shape summaries from `summarizePortMapForLog(...)` are safer than raw values, but they can still expose user-authored port names. Use them only for explicit diagnostics, preferably behind `logRuntimeDebug(...)`, unless the call site has a clear reason to expose those names in normal logs.

`logRuntimeDebug(...)` is gated by:

- `RIVET_DEBUG_RUNTIME_LOGS=true` in Node-like runtimes
- `localStorage.setItem('rivet.debugRuntimeLogs', 'true')` in browser-like runtimes

Only use debug logging for details that would be too noisy or too sensitive for normal logs.

Provider stream JSON parsing should use [`parseProviderJsonChunk(...)`](../packages/core/src/utils/providerStreamParsing.ts). That helper preserves parse failures while avoiding raw chunk logging. If a provider needs richer parse diagnostics, extend the helper rather than adding a provider-local raw `console.error(chunk)`.

Provider SSE transport belongs in [`fetchEventSource.ts`](../packages/core/src/utils/fetchEventSource.ts). Legacy OpenAI and Anthropic streaming both use this single reader so event splitting, `data:` / `event:` parsing, response-body isolation, header handling, and timeout cleanup stay consistent. Providers that need a timeout different from the shared chat default must pass it explicitly to the helper rather than cloning the transport.

## GraphProcessor Loop-Control Boundary

`GraphProcessor` remains the central execution engine and still owns scheduling, event emission, subprocessors, control-flow exclusion, and loop/race handling.

Loop-controller break detection is intentionally isolated in [`loopControllerBreak.ts`](../packages/core/src/model/loopControllerBreak.ts):

- `control-flow-excluded` with value `loop-not-broken` means the loop continues
- missing break output means the loop is treated as broken
- ordinary break output means the loop is broken
- other `control-flow-excluded` values mean the loop is treated as broken

Keep this policy covered by focused tests. The `loop-not-broken` sentinel is exported from the helper and reused by `GraphProcessor`; do not reintroduce duplicated string literals. If loop-controller behavior changes, update the helper and tests first, then wire `GraphProcessor` to the new policy. Avoid reintroducing inline type suppressions in loop/race control-flow branches.

### Required Inputs With Nullish Payloads

Node input definitions describe the expected data type, but a runtime `DataValue`
can still carry a `null` or `undefined` payload. Node-specific semantics decide
whether that is an error, a default, or a control-flow result; generic coercion
must not be treated as the whole behavior contract. For example, `MatchNode`
treats a missing, `null`, or `undefined` `Test` value as an unmatched result,
marks every case output as control-flow-excluded, and emits its `Unmatched`
output. It still preserves normal coercion and matching for non-nullish values,
including an empty string.

## Optional Node Duration Metadata

Per-node run durations are transient execution metadata, not graph outputs. [`GraphProcessor`](../packages/core/src/model/GraphProcessor.ts) only reads monotonic timestamps and emits `durationMs` on `nodeFinish` / `nodeError` when it is constructed with `captureNodeTimings: true`. The default remains `false`, so ordinary headless runs do not pay extra timestamp reads just because the app can display timings.

Timing starts after the awaited `nodeStart` event and ends when the node succeeds or errors. Preloaded `processId: 'preload'` values, `nodeExcluded`, output maps, graph YAML, and node data are intentionally unchanged. Subprocessors inherit the parent processor's `captureNodeTimings` value. Split-run nodes report the aggregate split node duration as `durationMs` from aggregate `nodeStart` to aggregate `nodeFinish` / `nodeError`, and also report per-item timings in transient `splitRunDurationMs` so the app can show a total plus one duration line per split item without changing output values.

Subgraph node `duration` is a graph-boundary wall-clock metric around the child `processGraph(...)` call, not the sum of the child nodes' `durationMs`. In Remote Debugger runs it can include awaited lifecycle listener and transport work, including display-safe debugger serialization, while child node `durationMs` excludes the awaited `nodeStart` and terminal event listener work around each node. Keep this distinction: changing Subgraph `duration` to a cosmetic child-duration sum would hide real graph-boundary overhead and would diverge from existing output semantics.

Recordings preserve incoming `durationMs` and `splitRunDurationMs` when present. [`RecordingPlayer`](../packages/core/src/model/RecordingPlayer.ts) can also derive replay-only legacy aggregate durations from existing recorded `nodeStart.ts` and terminal event `ts` values; that fallback is not used for live remote-debugger traffic where receive timing would be misleading.

`GraphProcessor` also has an off-by-default runtime profiler hook used by Node
benchmark attribution. It records coarse diagnostic buckets such as
preprocessing, scheduler wall time, node implementation time, subprocessor
creation, and subprocessor listener wiring without emitting logs or changing
outputs. Normal app, debugger, and headless runs do not pass a profiler and
therefore do not collect these buckets. Some buckets are inclusive across
nested graph/subgraph calls. Treat the profiler as attribution instrumentation
only: benchmark speed claims still need unprofiled before/after runs because
the diagnostic spans add timestamp reads and aggregation work.

## Frozen Output Resolver

`GraphProcessor` exposes an optional frozen-output resolver for the desktop app's editor-only Freeze node output feature. The resolver is a low-level runtime hook, not serialized graph state and not part of normal headless execution unless an app caller explicitly attaches it with `setFrozenNodeOutputResolver(...)`.

The resolver receives the current execution metadata, processor graph id, node, process id, and already-resolved input values. `GraphProcessor` calls it only after normal readiness checks, missing-required-input checks, disabled-node handling, and control-flow exclusion checks have passed. This means a frozen node still does not run when it would have been skipped by ordinary graph semantics.

When the resolver returns frozen `Outputs`, `GraphProcessor` skips the node implementation and emits the same high-level node lifecycle shape as a normal successful node: `nodeStart`, `nodeFinish`, `nodeResults`, visited-node bookkeeping, cost accumulation, and downstream scheduling. Frozen replay happens before split-run dispatch, so a frozen split-run node replays the captured aggregate terminal output and does not synthesize per-item partial-output events. Subprocessors inherit the parent resolver so frozen nodes inside subgraphs work with the child processor's graph identity.

Recoverable frozen graph-boundary effects are intentionally isolated in
[`GraphBoundaryEffects.ts`](../packages/core/src/model/GraphBoundaryEffects.ts)
with focused tests. `GraphProcessor` still owns event emission, global storage,
and mutable run state, but the rules for final cost output, defensive frozen
`Graph Output` replay, and frozen `Set Global` effect extraction live in one
pure helper module so future processor extractions do not duplicate those
policies.

Frozen replay replaces computation, not arbitrary host side effects. Core mirrors only recoverable dataflow side effects that downstream graph execution depends on:

- The desktop app blocks new `Graph Output` freezes because graph boundary nodes are not useful freeze targets. If a custom caller or stale in-memory state still supplies frozen `Graph Output` data to the low-level resolver, core defensively writes the frozen `valueOutput` to `graphOutputs[data.id]` so graph state remains coherent.
- `Set Global` writes the frozen `saved-value` to the frozen `variable_id_out` global id and emits `globalSet`.

Other side effects such as dataset writes, raised events, audio playback, external I/O, and graph aborts are intentionally not replayed by frozen execution. Feature work that adds replay for another side effect must make that effect explicit and testable rather than relying on the skipped node implementation.

## Graph Model

Core graph model types live in `model/`.

Key concepts:

- `Project`
- `NodeGraph`
- `ChartNode`
- `NodeConnection`
- `GraphId`, `NodeId`, `PortId`, `ProcessId`

Projects currently include:

- metadata
- graph map
- optional library nodes (`nodePrefabs`)
- optional declarative web apps (`uiGraphs`)
- optional plugin load specs
- optional project references
- optional metadata path

Node display names are presentation metadata and are separate from serialized
node types. The built-in `MatchNode` keeps the internal type `match` and its
existing `MatchNode`/`matchNode` symbols, while its current UI display name is
`Regex Match`. Existing node titles remain project data and are not rewritten
when a display name changes, so old projects continue to load and run without
an implicit migration.

Graphs include:

- graph metadata
- node list
- connection list

`NodeConnection.bendPoint` is optional, visual-only canvas routing metadata.
It is ignored by runtime scheduling and dataflow: the four endpoint fields
(`outputNodeId`, `outputId`, `inputNodeId`, `inputId`) remain the complete
semantic connection identity. Runtime helpers, connection maps, comparison keys,
and graph execution must not treat the bend point as a second connection or as
an execution dependency.

## Data Type System

The type system lives in [`DataValue.ts`](../packages/core/src/model/DataValue.ts).

### Scalar value families

Current scalar types include:

- `any`
- `boolean`
- `string`
- `number`
- `date`
- `time`
- `datetime`
- `chat-message`
- `control-flow-excluded`
- `object`
- `gpt-function`
- `vector`
- `image`
- `binary`
- `audio`
- `graph-reference`
- `document`

### Composite value families

The type system also supports:

- array variants of scalar values
- lazy `fn<...>` variants for deferred evaluation

### Key helpers

Important utilities defined in `DataValue.ts`:

- `isScalarDataValue`
- `isArrayDataValue`
- `isFunctionDataValue`
- `getScalarTypeOf`
- `unwrapDataValue`
- `arrayizeDataValue`
- `getDefaultValue`

### Architectural significance

This type system is not just validation metadata. It is used directly in:

- port compatibility
- default-value generation
- split-run behavior
- lazy/deferred execution
- control-flow propagation
- output rendering and serialization

The `control-flow-excluded` type in particular is a core execution mechanism, not just a marker type.

## Node System

There are three main node-related concepts:

1. `ChartNode`: serialized data model for a node in a graph
2. `NodeImpl`: class-based execution/UI contract used by built-in nodes
3. `PluginNodeImpl`: object-based execution/UI contract used by plugin nodes

### Built-in nodes

Built-in node registration is centered in [`Nodes.ts`](../packages/core/src/model/Nodes.ts).

The current built-in node list is registered through `registerBuiltInNodes(...)`, which populates:

- `globalRivetNodeRegistry`
- built-in node constructors
- built-in node type union information

Current `Random number` behavior lives on the existing `randomNumber` node type rather than a replacement type. Its `Float` / `Integer` pill editor is presentation over the existing `integers?: boolean` data field, and `Min` / `Max` remain number settings with optional input-port toggles. The runtime keeps the original `maxInclusive` behavior: it only changes integer generation by adding one to the effective max before `Math.floor(...)`.

`Code` (internal type `codeNew`), `Expression`, `JS Filter`, and `JS Map` are core built-ins that evaluate JavaScript through `context.codeRunner` and share value-backed interpolation from [`jsValueInterpolation.ts`](../packages/core/src/model/nodes/jsValueInterpolation.ts). `{{var}}` tokens create `any` input ports and evaluate as connected values through generated internal references; input objects/arrays are cloned before evaluation so expression-side, code-body-side, or callback-side mutation cannot mutate upstream graph data. Function-valued inputs are wrapped so property mutation stays local, but invoking a function can still perform whatever side effects that function implements. The shared helper owns interpolation input-definition creation, safe internal input identifier selection, cloned-input initializer generation, parsed-source preview interpolation, and generated-error sanitization. Generated interpolation helper identifiers are chosen so they do not collide with identifiers already present in the authored source, which keeps user locals or callback parameters from shadowing `{{var}}` values. Missing interpolation inputs become `undefined`. `Code`, `Expression`, `JS Filter`, and `JS Map` still own their wrapper shapes and output contracts explicitly; do not replace them with a generic JS-node wrapper unless behavior is intentionally being redesigned. `Code` differs from `Expression` by wrapping the authored source in an async function body so users can declare locals, use `await`, and `return` one value, while still exposing the Code-family runtime permission toggles. Its normal generated wrapper returns the fixed `output` DataValue, and the node validates that runner boundary defensively so a custom or broken `CodeRunner` cannot store a missing/malformed `Output`. The older internal `code` node is user-facing `Code (legacy)` and keeps the manually configured inputs/outputs contract. User documentation intentionally keeps both pages: `node-reference/code-new` is the current Code node, while `node-reference/code` is Code (legacy), so existing external docs links stay valid while the sidebar labels match the UI.

`JS Filter` and `JS Map` share editor, input, body-preview, wrapper, interpolation, and output-validation scaffolding in [`jsListCallbackHelpers.ts`](../packages/core/src/model/nodes/jsListCallbackHelpers.ts). Their settings editor uses the generic code-editor contract with a pre-editor callback-signature helper, a post-editor interpolation note, and `interpolationSyntax: 'js-value'`, keeping the body-only UX in core metadata instead of custom app UI. Their node-specific editor tests should assert that same metadata so changes to the shared helper cannot silently drift away from the node contracts. Their callback bodies are still wrapped explicitly by each node so the filter/map runtime differences remain inspectable. The callback-local names `item`, `index`, and `array` are reserved and do not create input ports; if written as `{{item}}`, `{{index}}`, or `{{array}}`, they resolve to the existing callback parameters. App-side parsed-callback previews use their own presentation wrapper instead of expanding the core helper API; the core helper stays focused on runtime and node-body contracts.

`Extract Object Path` keeps the existing `extractObjectPath` node type and data shape. When `usePathInput` is false, the stored path uses the shared interpolation parser to add optional `any` input ports and to resolve the final JSONPath before execution. When `usePathInput` is true, the explicit `path` input remains the only path source and stored-path interpolation ports are not exposed.

`Object` builds its output by interpolating the stored JSON template, parsing the interpolated JSON, and emitting either `object` or `object[]`. Whole placeholders keep their compatibility semantics: `{{value}}` outside a JSON string inserts the raw JSON value, while `"{{value}}"` replaces the whole quoted string and turns non-string values into their JSON text string. Tokens inside larger JSON strings, such as `"Hello {{value}}"`, are escaped as JSON-string fragments instead: strings insert as text, non-strings insert as their JSON text, and `null` / `undefined` insert as the text `null`.

`Graph Output` is the public graph boundary for final graph outputs. Internally flexible producers such as `Expression` and current `Code` emit `any` DataValues, so `Graph Output` normalizes structurally matching incoming `any` plain-object values to `object`, and incoming `any` arrays of plain-object values to `object[]`, when that is the declared output type before writing `context.graphOutputs`. Scalars, primitive arrays, non-plain object instances, and mismatched shapes are not relabeled, already typed node outputs are left unchanged, `any` Graph Outputs stay `any`, and `control-flow-excluded` keeps its exclusion marker.

`Extract JSON` accepts an `any` input so graphs can normalize either raw text or already-structured values. String inputs keep the existing parse/extract/no-match behavior; `object`, `object[]`, `any[]`, and object-like `any` inputs are sent directly to the `Output` port and exclude `No Match`. This keeps the node safe to place after providers or custom nodes that sometimes return parsed JSON and sometimes return text.

`Coalesce` is the control-flow merge node for "first usable input wins" graphs. It can consume `control-flow-excluded` inputs instead of being excluded by the processor, then scans its dynamic `Input N` ports in order and returns the first connected value that is not `control-flow-excluded`; the `Conditional` port only gates whether Coalesce itself ran and is not a candidate output. `null` and `undefined` are treated as real values by default for compatibility with existing graphs; the `Ignore 'null'` and `Ignore 'undefined'` settings opt into treating those payloads as skipped values so Coalesce continues to the next input. New Coalesce nodes default to a 190px canvas width so the app's inline ignore toggles have room without making the node large by default. The desktop app renders these settings as inline canvas toggles that write the same node data as the settings panel; core still keeps the active-setting text fallback for callers that render node bodies through `getBody()`.

Numbered variadic ports derive their connected range through [`variadicPortIndex.ts`](../packages/core/src/model/nodes/variadicPortIndex.ts). `getNextVariadicPortIndex(...)` returns the highest matching connected index plus one for the trailing editable slot; Array, Did Run, Delay, Join, Passthrough, Start Async Branch, Race Inputs, Coalesce, Assemble Prompt, and Assemble Message use that policy. Loop Controller deliberately uses `getHighestVariadicPortIndex(...)` because it builds its own trailing input/default pair. The explicit policy literal retains existing parsing rather than normalizing serialized connections: `legacy` for Array, Assemble Prompt, Assemble Message, and Loop Controller keeps no-radix parsing; `decimal` for Did Run, Delay, Join, Passthrough, Start Async Branch, and Race Inputs keeps decimal parsing; `strict-positive` for Coalesce accepts only exact, positive, safe `inputN` ids. Do not silently make these policies stricter or more uniform without an explicit graph-compatibility change.

`Did Run` is a small control-flow adapter node. It has Coalesce-style dynamic `Input N` ports and one boolean `Ran` output. `GraphProcessor` already prevents normal node processing when any connected upstream value is `control-flow-excluded`, so the node implementation deliberately does not re-check payload truthiness or data type. If the processor invokes it with at least one dynamic input entry, it outputs `true`; if no dynamic inputs are connected, it outputs `control-flow-excluded`. This keeps the node's meaning focused on "did every connected branch run at all?" rather than "what values did those branches produce?" Its explanatory copy belongs in the settings panel through a read-only `info` editor; the node body intentionally stays empty and new nodes default to a compact 167px width.

Input definitions that are generated from user-authored `{{var}}` interpolation and exposed as connectable input ports must be created through [`packages/core/src/model/interpolationInputDefinition.ts`](../packages/core/src/model/interpolationInputDefinition.ts). This is a core maintainability rule for all current and future nodes, not just a convenience helper. The helper preserves the existing port id/title contract while adding `NodeInputDefinition.data` metadata that says the port came from interpolation and records the original interpolation name. The app relies on that metadata to preserve connections when a user clearly renames an interpolation token, so manually creating interpolation ports with plain input-definition objects will make rename preservation fail for that node. The metadata is runtime/editor-only and is not persisted in graph files. Built-in interpolation producers currently marked this way include Text, Prompt, Object, Tool schema interpolation, Code, Expression, JS Filter, JS Map, Extract Object Path, and the built-in OpenAI Thread Message plugin node. Nodes such as `To Tree` that use `{{...}}` only against per-item object properties do not expose connectable interpolation ports and therefore should not use this marker.

Interpolation safety coverage should stay broad whenever this contract changes: core tests cover parser edge cases and built-in input-definition marking, negative tests cover runtime-only consumers such as `To Tree`, app graph-editing tests cover rename preservation for marked built-ins and plugin nodes, and execution-data tests cover parsed-source previews using the captured run inputs rather than current editor state.

Dynamic interpolation port discovery uses a small bounded cache in the shared interpolation parser. The cache is keyed only by exact template text and stores extracted variable names, not node definitions, graph state, runtime values, or plugin results. When the cache is full, new templates are parsed normally instead of evicting entries on every miss. If the same uncached template repeats immediately, the cache adapts by clearing old entries and admitting that new hot template. Callers still receive a fresh array, so existing node-definition code can keep treating the result as mutable. Keep plugin node definitions and connection-sensitive built-ins out of this cache path unless a future API adds an explicit cache-safety contract.

The built-in node directory is intentionally broad; prefer documenting behavior contracts and shared helper boundaries over hard-coding file counts that drift whenever a node is added or split.

### Plugin nodes

Plugin nodes are registered through `NodeRegistration.registerPluginNode(...)`.

They are wrapped into a generated `PluginNodeImplClass` so they can participate in the same runtime paths as built-in nodes.

### Node UI contracts

Core also defines UI-facing contracts used by the app:

- `EditorDefinition`
- `NodeBody`
- `NodeBodySpec`
- `NodeUIData`

That is why core is not purely headless business logic. It also carries enough metadata for the editor to render and edit nodes.

`MarkdownNodeBodySpec.disableLinks` lets a node keep Markdown formatting for compact canvas previews while flattening any parsed links back to plain text, which is useful for dynamic configuration values such as provider URLs.

`EditorDefinition` includes read-only `type: 'info'` rows for settings-panel explanatory copy that is not project data. Info rows have no `dataKey`, do not mutate node data, and should be used instead of adding dummy fields or canvas-body text when a node only needs a settings-panel note.

## Node Registration

[`NodeRegistration.ts`](../packages/core/src/model/NodeRegistration.ts) is the registry and factory layer.

Current responsibilities:

- register built-in nodes
- register plugin nodes
- register whole plugins
- create serialized node instances
- create runtime `NodeImpl` instances
- provide dynamic lookup for unknown-at-compile-time node types
- provide plugin ownership lookup for a node type

Key APIs:

- `register(...)`
- `registerPluginNode(...)`
- `registerPlugin(...)`
- `create(...)`
- `createDynamic(...)`
- `createImpl(...)`
- `createDynamicImpl(...)`
- `getPluginFor(...)`
- `getPlugins()`

### Registry Assembly

[`RegistryAssembly.ts`](../packages/core/src/model/RegistryAssembly.ts) encapsulates the registry assembly lifecycle:

- `createBuiltInRegistry()` - creates a fresh registry populated with all built-in nodes
- `registerPluginsIntoRegistry(registry, plugins)` - registers an array of plugins into an existing registry
- `assembleRegistry(specs, loadPlugin)` - end-to-end helper: creates a built-in registry, then loads and registers plugin specs one by one so per-plugin load/registration failures are recorded without aborting the whole assembly

The app uses `assembleRegistry()` to rebuild `projectNodeRegistryState` from app-installed plugin specs. The sidecar (`app-executor`) uses the same helper for each uploaded project's YAML plugin specs and passes the result directly to `createProcessor()` without touching app state.

Built-in plugin resolution stays with the plugin catalogue in [`plugins.ts`](../packages/core/src/plugins.ts) through `resolveBuiltInPlugin(id)`. `RegistryAssembly.ts` deliberately does not import that catalogue; keeping registry assembly plugin-catalogue-free avoids cycles through plugins that need execution engine APIs, such as Gentrace.

The Gentrace plugin imports the SDK APIs it uses through
[`plugins/gentrace/gentraceSdk.ts`](../packages/core/src/plugins/gentrace/gentraceSdk.ts).
Do not replace that adapter with an `@gentrace/core` package-root import: the SDK
root also re-exports a Node-only test-job runner (`async_hooks` and `ws`), which is
unrelated to Rivet's pipeline integration and cannot be bundled into the browser
app. Keep any future Gentrace SDK path changes confined to this adapter and verify
both the core build and app Vite build.

Architectural significance:

- this registry is the bridge between serialized graph data and executable node implementations
- the app, node package, and sidecar all depend on this working consistently
- plugin loading mutates runtime availability through this registry
- `assembleRegistry()` returns a fresh registry without mutating the global, so callers choose whether to install it globally

## Built-In Plugins

Built-in plugins are exported from [`packages/core/src/plugins.ts`](../packages/core/src/plugins.ts).

`resolveBuiltInPlugin(id)` resolves one of these catalogue entries for app/executor loading paths and throws for unknown ids.

Current built-in plugin families present in the repo:

- Anthropic
- Autoevals
- AssemblyAI
- Pinecone
- Hugging Face
- Gentrace
- OpenAI
- Google

These plugins contribute:

- config specs
- context menu groups
- plugin nodes
- provider-specific execution behavior

This is why "nodes" and "plugins" in core cannot be treated as separate, non-overlapping concerns.

## Execution Engine

The main execution engine is [`GraphProcessor.ts`](../packages/core/src/model/GraphProcessor.ts).

### What `GraphProcessor` owns

At a high level, it owns:

- graph preprocessing
- node instance creation
- dependency resolution
- queue-driven node scheduling
- control-flow exclusion
- split-run handling
- subgraph execution
- pause/resume/abort orchestration and event emission
- user input requests
- global state/event propagation
- recording playback
- process event emission

Important current boundary:

- graph-topology queries and readiness checks have been extracted into [`NodeExecutionPlanner.ts`](../packages/core/src/model/NodeExecutionPlanner.ts)
- node exclusion decisions and excluded output construction have been extracted into [`NodeExclusionPolicy.ts`](../packages/core/src/model/NodeExclusionPolicy.ts)
- child-processor event/lifecycle wiring has been extracted into [`SubprocessorBridge.ts`](../packages/core/src/model/SubprocessorBridge.ts)
- run/paused/abort/finish-once transitions have been extracted into [`GraphRunLifecycle.ts`](../packages/core/src/model/GraphRunLifecycle.ts); it owns no queues, graph traversal, event emitter, or node work
- `GraphProcessor` still remains the public evented execution surface and the owner of execution state

## Chat Runtime Seams

`ChatNodeBase.ts` is still one of the larger remaining core hotspots, but it now has a dedicated helper seam under:

- [`packages/core/src/model/chat/openAIChatRequest.ts`](../packages/core/src/model/chat/openAIChatRequest.ts)
- [`packages/core/src/model/chat/openAIChatRuntime.ts`](../packages/core/src/model/chat/openAIChatRuntime.ts)
- [`packages/core/src/model/chat/chatMessages.ts`](../packages/core/src/model/chat/chatMessages.ts)
- [`packages/core/src/model/chat/tokenBudget.ts`](../packages/core/src/model/chat/tokenBudget.ts)
- [`packages/core/src/model/chat/streamChatResponse.ts`](../packages/core/src/model/chat/streamChatResponse.ts)
- [`packages/core/src/model/chat/chatCost.ts`](../packages/core/src/model/chat/chatCost.ts)

Current responsibilities split this way:

- `openAIChatRequest.ts`: request shaping shared inside the OpenAI-compatible chat path
- `openAIChatRuntime.ts`: OpenAI-specific streaming/non-streaming execution and retry behavior
- `chatMessages.ts`: prompt/input coercion into `ChatMessage[]` plus system-prompt injection helpers. Native
  `chat-message[]` values preserve every role.
- `tokenBudget.ts`: shared prompt/max-token limit enforcement and request/response token output helpers
- `streamChatResponse.ts`: streamed tool-call assembly and assistant-message reconstruction
- `chatCost.ts`: prompt/completion/audio cost calculation and token-cost helpers

These helpers are now reused across more than just `ChatNodeBase`:

- `ChatNodeBase.ts`
- `plugins/google/nodes/ChatGoogleNode.ts`
- `plugins/anthropic/nodes/ChatAnthropicNode.ts`

That means some of the former provider-level duplication is already removed in:

- prompt-to-chat-message coercion
- max-token clamping and warning generation
- assistant `all-messages` output reconstruction
- request/response token output wiring
- OpenAI chat runtime orchestration and retry handling

Current outcome:

- `ChatNodeBase.ts` is now closer to node-definition/editor contract plus orchestration
- the OpenAI execution loop is isolated from the node-definition surface
- Google and Anthropic nodes now share more chat-pipeline helpers instead of each keeping their own prompt/token/output plumbing

### LLM Chat seams

The built-in user-facing `LLM Chat` node keeps the internal `llmChatV2`
node type and `LLMChatV2*` implementation names for compatibility. Its code is
intentionally split under
[`packages/core/src/model/chat-v2/`](../packages/core/src/model/chat-v2/):

- `llmChatV2NodeData.ts` owns the persisted data/default shape.
- `llmChatV2NodeEditors.ts` owns the settings manifest and keeps provider-specific editor groups named in place.
- `chatV2ProviderProfile.ts` is the shared credential/provider boundary for LLM Chat and app AI-assist adapters. It applies one precedence table and returns the live credential separately from a secret-free provider profile; neither request-plan summaries nor catalog keys may contain the credential value.
- `chatV2RuntimeOptions.ts` converts persisted node data and input values into generation parameters, provider options, built-in provider tools, and tool choice; it delegates credentials/provider construction to the profile boundary.
- `chatV2RequestPlan.ts` is the pure transport-policy boundary. It selects stream versus generate, normalizes the explicit Rivet retry policy, fixes Vercel AI SDK retries at zero, and carries tools/response format/provider options/generation/output policy into `chatV2Pipeline.ts`.
- `chatV2EditorCache.ts` owns editor-only cache key construction, secret fingerprinting, and cached-output cloning.
- `llmChatV2NodeRuntime.ts` is a coordinator that assembles those policies for the runtime and re-exports compatibility helpers used by existing tests/imports.
- `chatV2Errors.ts` owns provider/Vercel SDK error normalization, including API-call and browser/runtime fetch-failure classification for request-status outputs where no HTTP response is observable. It extracts HTTP status codes from common raw/normalized error shapes for retry and request-status outputs. When an API response is observable, it preserves the provider's original message, preferring the response body over generic SDK data and following nested causes; Rivet's recommendation is supplemental and must not suppress an identical SDK/provider message. It must not stringify whole provider data objects into user-visible node errors.
- `chatV2Retry.ts` owns `Retry on non-200` defaults, repeat/cooldown normalization, and abort-safe repeat waits for LLM provider retries, including the zero-cooldown path before a repeat starts.
- `chatV2Outputs.ts` owns provider-neutral output assembly: `Response` typing for structured formats, assistant/function-call outputs, usage/cost normalization, reusable control-flow exclusion for absent optional outputs, reasoning exclusion, request-status/request-error/request-body outputs, retry-attempt status/error arrays, and provider-failure output shape.
- `chatV2Pipeline.ts` executes `ChatV2RequestPlan` and stays focused on provider-neutral orchestration, retry outcomes, provider-error decisions, and output assembly; `toolContinuation.ts` owns continuation. `aiSdkBridge.ts` adapts the planned request to Vercel AI SDK call signatures and retains a defensive zero-retry default for direct bridge callers. Rivet's request plan/retry loop is the single source of retry behavior and per-attempt status/error outputs. For structured response formats with an SDK output descriptor, `aiSdkBridge.ts` resolves the AI SDK's parsed `output` promise on a best-effort basis and `chatV2Outputs.ts` uses that parsed value for the `Response` output while keeping the assistant message text unchanged for chat history. Parsed-output failures fall back to the response text as a string instead of failing the node. Structured-output calls also ask `consumeAiSdkStream(...)` to collapse exact duplicate text blocks and normalize repeated parseable JSON text before partial-output updates or fallback parsing, because some AI SDK/provider combinations expose the same final JSON object more than once.
- `toolContinuationConnection.ts` derives the optional connected-Delegate continuation relationship from ordinary graph data. It is eligible only for an enabled `llmChatV2` node with tool use and auto-continuation enabled, an exact `function-calls -> function-call` connection, and one enabled `delegateFunctionCall` target. Core execution and app presentation must consume this resolver instead of reimplementing endpoint checks.
- `providerOptions.ts` keeps Custom provider requests on the conservative OpenAI-compatible path. Custom JSON object mode is represented by the raw `response_format: { type: "json_object" }` provider option instead of an SDK output descriptor, and the Custom provider factory does not request streamed usage via `stream_options.include_usage`; compatible providers can still return usage naturally, but Rivet does not force optional OpenAI stream metadata onto every custom endpoint. Provider factories also own the parsed request-body hook used by LLM Chat request diagnostics: the hook wraps the provider fetch function, records the body handed to the actual provider HTTP call, parses it for the `LLM request body` output, and deliberately omits request headers / Rivet-managed API key headers so the normal error formatter can remain payload-free while the explicit diagnostic remains a truthful body inspector.

#### Connected Delegate tool continuation

`GraphProcessor` supplies an optional owning-processor `ToolCallContinuation` through the LLM Chat process context. Its `run(...)` method delegates one whole model tool-call round and its `release()` method restores ordinary downstream scheduling for unresolved raw calls. This preserves the normal node boundary: `toolContinuation.ts` asks for a round to be delegated, while the processor owns graph scheduling, node lifecycle events, cancellation, cost aggregation, and downstream branches. When there is no eligible connected Delegate, the continuation object is absent and LLM Chat keeps the existing internal delegation path. More than one eligible connected Delegate is a hard graph error.

Split-run LLM Chat nodes are intentionally excluded by `resolveToolContinuationConnection(...)`. Each split index keeps the internal continuation path and the persisted edge remains ordinary, because one connected Delegate completion cannot safely be shared across parallel indexes.

For each model tool-call round, the processor creates one real Delegate invocation per tool call. It allocates process ids in model order, emits scalar `nodeStart` inputs, runs every invocation concurrently, and emits an independent scalar `nodeFinish` as each call completes. The LLM Chat process remains running and joins every result in original model order before continuing, regardless of completion order. Existing execution-history paging therefore shows every call as a selectable Delegate run without inventing a `Waiting for tools` state. Partial outputs reported by a live handler or external function use that invocation's Delegate process id. The persisted graph edge remains a normal one-way `NodeConnection`; bidirectionality is a runtime interpretation and must not introduce a second return edge or serialized mode.

Auto-delegation prefers a graph whose metadata name exactly equals the tool name. If no exact match exists, it preserves the legacy behavior by selecting the first graph whose name contains the tool name. Keep editor reachability analysis aligned with this exact-first, contains-fallback order so it marks the same graph that runtime dispatch will execute.

Each live handler-subgraph or external-function cost is carried only on `ToolCallDelegationResult`, copied to that invocation's hidden Delegate `cost` output, and accumulated exactly once into the owning graph. `DelegatedToolCallRecord` intentionally excludes cost: cached or replayed records expose their stored tool result without charging an earlier execution again.

The Delegate's persisted `message` output id is retained and displayed as `Tool Result Message`. Its persisted `assistant-message` output is displayed as `Message (fires before tool call invocation)` and carries nonblank assistant text emitted in the same model response as the tool calls. This output is intrinsically per-call and pre-tool: every invocation emits the shared assistant text under its own process id, then starts that Message branch and its tool handler in parallel. A `Start Async Branch` boundary returns immediately and registers its remaining work with the root run when the branch must not hold the foreground path open. After each invocation's `nodeFinish`, its scalar `output` and `message` branches execute independently. Whitespace-only assistant text does not activate the pre-tool branch.

Continuation output branches use temporary same-graph processors that inherit the root run and graph execution identity, original project and loaded-reference context, original-graph active-output-port view, globals, Stored Values controller, execution cache, external functions, credentials, cancellation, and event stream. Each parallel Delegate invocation gets isolated branch results so one call cannot make another call's descendants look ready. The active-output view matters for nodes such as Subgraph and Referenced Graph Alias: a branch slice may omit a consumer that is waiting for the final LLM or another late input, but the already-running producer must still compute the output that consumer will need later. Temporary processors suppress synthetic graph lifecycle and preload events while forwarding real downstream node events, and their event/lifecycle subscriptions must be removed after each branch. Graph Outputs use a branch-local overlay: reads can see values already written by the owning graph, successful writes are deferred until the parallel call set joins, and patches merge in model-call order under the ordinary first-value policy rather than completion-time order. A failed branch exposes no partial Graph Output patch. An explicit Graph Output named `cost` follows that same policy; derived run cost only fills a missing `cost` boundary and must not replace it.

The temporary scheduler must not preload unsafe dependency boundaries, because doing so would lose their cycle/loop/race attached-data semantics. Candidates that still need those boundaries or other late inputs remain with the parent scheduler. An already-ready pre-tool candidate that is itself unsafe, or a pre-tool continuation whose owning LLM/Delegate is unsafe, fails before tool side effects instead of being silently deferred. Self-loop safety checks include every definition-valid persisted edge, including secondary input edges, but ignore stale edges whose ports no longer exist. `Start Async Branch` is the explicit exception boundary: continuation traversal stops at the trigger and injects its complete closed subtree into the root-owned async scheduler.

Branch readiness is invocation-scoped. Outputs produced by one call's pre-tool Message branch may satisfy inputs for that call's final tool-result branch, but sibling-call and earlier-round outputs are not offered as fresh dependencies. After all calls settle, completed branch results are folded into parent state in model order, retaining the latest call's value for nodes that ran repeatedly. Once the owning LLM process finishes successfully, `#finalizeToolCallContinuation(...)` promotes those completions and records their LLM owner; `#propagateCompletedContinuationNode(...)` then queues their remaining consumers without rerunning completed nodes.

When auto-continuation stops with unresolved raw calls because the maximum round count was reached or a call is not one of the LLM node's declared Rivet tools, LLM Chat releases the processor's continuation reservation. The ordinary downstream connection is then scheduled normally so the raw calls remain observable. Connected continuation Delegate nodes cannot be frozen in the editor, and direct continuation execution rejects frozen or preloaded outputs before tool work begins; replaying a captured request/response round would omit required tool work.

Keep future Chat v2 changes inside the smallest relevant seam. Do not add provider
option parsing, cache-key fingerprinting, or credential-source behavior back into
the node class.

### Current state model inside `GraphProcessor`

The class maintains both:

- per-instance state, such as project/graph/registry/node-instance maps
- per-run state, such as results, visited nodes, abort controllers, globals, loaded references, and queue state

This distinction is important because some state is reused across runs and some is rebuilt on each `processGraph(...)`.

`GraphRunLifecycle` owns the small run-level state machine (`idle`, `running`,
`aborting`, `finished`), pause persistence, one accepted abort decision, and the
root `finish` claim. `GraphProcessor` still creates/aborts controllers and emits
all events, so event order remains explicit in the orchestrator. A lifecycle
transition must return a decision before `GraphProcessor` performs side effects;
do not move scheduler queues or node execution into this state owner.

Current behavioral detail:

- helper paths such as `getDependencyNodesDeep(...)` can trigger preprocessing before `processGraph(...)` starts, because the app uses them to plan editor run-from execution before preloading already-computed boundary inputs
- `contextValues` are refreshed per `processGraph(...)` call even when reusing the same processor instance
- `Context` nodes resolve values in a strict order: runtime `contextValues[id]`, then a connected default input when the default-input toggle is enabled, then the editor default, then the data type's built-in default. Every resolved value is coerced to the node's configured data type before being emitted.
- pause waits are abort-aware, so aborting a paused run unwinds instead of waiting forever for a later `resume`

### Preprocessing

Before execution, `GraphProcessor`:

- loads project references
- calls `preprocessGraphState(...)`
- builds node instances
- builds connection maps
- computes port definitions
- computes strongly connected components

The SCC and preprocessing work are significant because they shape cycle handling and graph validation before the main execution loop.
`preprocessGraphState(...)` also builds a reusable immutable execution plan:
directional input/output connection maps, input-node and output-node adjacency,
missing-required-input lists, default start nodes, and cycle indexes. Normal
editor and one-shot runs still build that plan per processor run. The
preprocessor removes invalid port connections only from the two endpoint
connection buckets that can contain the connection; valid graphs must not pay a
graph-wide cleanup loop for every node, and invalid graphs must not fall back to
whole-graph scans either. Execution-plan construction and the compatible
`NodeExecutionPlanner` path also group output connections by target node in one
pass so wide fan-out nodes do not repeatedly rescan the same connection list.
The Node wrapper can pass a run-scoped runtime cache into processors so
Subgraph, Call Graph, loop, cron, tool-delegation, and referenced-graph
invocations can reuse immutable child graph plans without sharing mutable run
state such as outputs, globals, pending user inputs, abort controllers, or
execution metadata. Cached plans do not reuse `NodeImpl` runtime objects; each
processor creates fresh node implementations before processing so custom node
instance state stays run-scoped. When a fresh subprocessor is created and the
runtime cache already has that child graph's immutable plan,
`#createSubProcessor(...)` seeds the child with the plan before its first
`processGraph(...)` call. That skips the preprocessor dispatch for that one
child instance while still creating fresh node implementations and fresh
mutable run state.

Current architectural detail:

- preprocessing is not only a `processGraph(...)` concern; some public helper paths depend on it being available lazily
- cached plans are scoped to immutable project/registry snapshots; graph edits,
  registry/plugin changes, settings that affect definitions, or
  project-reference changes require a fresh runtime cache
- applying a fresh or cached preprocessed state replaces the processor's
  node-instance, node-id, and connection maps instead of merging into old maps;
  this keeps reused processors from retaining stale graph-edit state
- `createProcessor(...)`, and eligible `runGraph(...)` calls that route through
  the same default policy, use the same plan shape only as run-scoped data
  for a fresh one-off processor run. The Node wrapper clears that cache before
  and after `run()` so endpoint-style callers do not depend on cross-request
  cache state. Its policy is split in
  [`createProcessorRuntimePolicy.ts`](../packages/node/src/createProcessorRuntimePolicy.ts):
  omitted `runtimeProfile` enables run-scoped root/subprocessor execution-plan
  caching and the internal `fast-acyclic` scheduler for eligible graphs,
  explicit `compatible` stays fully compatible, Remote Debugger forces the
  compatible policy, and trace-sensitive omitted runs stay fully compatible.
  Unknown runtime `runtimeProfile` strings use the compatible policy for
  untyped JavaScript callers.
  The fast acyclic scheduler uses an iterative reverse-reachable walk from the
  same start nodes as the compatible path and only unlocks downstream nodes
  through input dependencies that were actually counted, so very deep eligible
  graphs avoid recursive reachability limits and invalid or stale target-port
  connections do not make otherwise ignored nodes observable.
  This creates two deliberate observability contracts. Ordinary headless runs
  can take the faster path when outputs, errors, callbacks, and normal processor
  events remain equivalent. Remote Debugger, trace-sensitive runs, and CLI SSE
  streaming stay on the compatible path because the scheduler's internal order
  is part of the visible product contract there: node lifecycle ordering, trace
  text or SSE payload order, live running state, nested graph lifecycle
  ordering, and debugger timing are observable.
  Do not move debugger, trace, or CLI streaming runs to `fast-acyclic` without
  dedicated golden lifecycle, nested-subgraph, abort/race, trace/SSE, and manual
  debugger or streaming-client coverage.
  The loaded-reference flag controls both reading and writing
  `runtimeCache.loadedProjects`; a runtime cache alone is not enough to reuse
  referenced projects. Execution-plan caching is also disabled for projects
  with references unless loaded-reference caching is enabled, because node port
  plans can depend on referenced project definitions.
- Omitted-default compatibility characterization lives in
  [`packages/node/test/defaultSafeCompatibility.test.ts`](../packages/node/test/defaultSafeCompatibility.test.ts).
  It compares omitted default and compatible Node `createProcessor(...)`
  runs at the event, partial-output callback, user-input callback,
  global/user-event recorder, error, abort, custom provider,
  reference-loader, and shared-project-object seams.
  Recorder checks use the serialized replay shape because JSON drops
  `undefined` object properties, and subgraph `duration` outputs are normalized
  as timing-dependent values.
- Core cache-mode behavior is pinned in
  [`GraphProcessor.characterization.test.ts`](../packages/core/test/model/GraphProcessor.characterization.test.ts),
  including the run-scoped runtime cache requirement that cached execution plans
  are cleared before and after endpoint-style runs.

### Event system

`GraphProcessor` uses `Emittery` and defines a rich `ProcessEvents` map.

Current event families include:

- graph lifecycle events
- node lifecycle events
- partial output events
- user-input events
- pause/resume/abort events
- trace events
- global-set events
- dynamic `userEvent:${string}` and `globalSet:${string}` channels

The processor also exposes:

- direct listener methods (`on`, `off`, `once`, `onAny`, `offAny`)
- `events()` async generator for streaming-style consumption
- dedicated `onUserEvent(...)` and `offUserEvent(...)` helpers

Fire-and-forget event emission uses [`emitDetached(emitter, event, data)`](../packages/core/src/utils/emitDetached.ts), a thin wrapper around `void emitter.emit(...)` that makes the intent explicit. All detached emissions in `GraphProcessor`, `RecordingPlayer`, and `ExecutionRecorder` use this helper instead of inline `eslint-disable` suppressions.

Tokenizer `error` events are bridged into the processor's generic `error` event for the duration of a graph run only. `GraphProcessor` stores the tokenizer unsubscribe callback when the tokenizer provides one and clears it in the `processGraph(...)` `finally` path, including failed, aborted, and subgraph runs. Rejected overlapping `processGraph(...)` calls do not enter the cleanup path for the active run. If a custom tokenizer unsubscribe callback throws, the processor reports that as a generic `error` event instead of failing the graph result. Legacy custom tokenizers whose `on(...)` method still returns `void` remain accepted, but they cannot be cleaned up by the processor.

Current lineage invariant:

- execution-facing graph and node events now carry `GraphExecutionMetadata`
- `processId` remains node-run identity, while `graphRunId` identifies the enclosing graph invocation
- top-level runs create a fresh `rootRunId` and `graphRunId`
- each subgraph invocation receives its own child `graphRunId` while inheriting the same `rootRunId`
- subgraph events can also carry `parentGraphRunId` plus executor metadata (`nodeId`, `processId`, `splitIndex`) so downstream consumers can distinguish reused subgraph call sites

Characterization coverage:

- [`GraphProcessor.characterization.test.ts`](../packages/core/test/model/GraphProcessor.characterization.test.ts) is the current safety net for future processor extractions.
- It pins root event order, graph-error/finish behavior, partial-output `processId` identity, subgraph execution metadata, preload plus run-to boundaries, pause/resume scheduling, shared globals, and race winner/loser handling through public processor APIs and event streams.
- Future GraphProcessor extraction work should extend this file or the existing [`GraphProcessor.test.ts`](../packages/core/test/model/GraphProcessor.test.ts) before moving another policy boundary. Do not replace these tests with private-method assertions; the editor, remote debugger, recorder, and hosted runtimes depend on the public event/result behavior.

### Scheduling model

The processor uses `p-queue` with explicit bounded concurrency for queued node execution. The import is normalized through [`pQueueCompat.ts`](../packages/core/src/utils/pQueueCompat.ts), which handles the CJS/ESM default-export interop (see Build-and-CI docs for the CJS alias strategy).

Execution is dataflow-driven:

- nodes are queued when their dependencies become available
- completion of one node can trigger downstream nodes
- split-run can further fan a node into multiple executions

Current execution policy details:

- `GraphProcessor` resolves a `GraphProcessorConcurrency` policy per processor instance
- queued node execution uses a bounded `nodeConcurrency` limit instead of `Infinity`
- child subprocessors inherit the parent processor's concurrency policy
- split-run parallel execution uses its own bounded `splitRunConcurrency` limit instead of raw `Promise.all`; individual nodes can override that limit with `node.splitRunConcurrency`, while undefined nodes keep the processor-level default so older workflows that do not have the per-node field keep their existing behavior
- node-level abort signals are tracked in a run-scoped map keyed by exact `NodeId`. The common case stores the single active controller directly and promotes to a `Set<AbortController>` only when overlapping executions of the same node are active. Processor aborts walk active controllers directly instead of registering a processor-level abort listener for every node execution, while race winners still abort only controllers for exact nodes in that race branch. Keep controller registration and cleanup paired around every pre-process exit path, including paused nodes waiting to resume.
- each graph run prepares the stable part of `InternalProcessContext` once, then layers per-node fields such as `node`, `signal`, `processId`, `execution`, `attachedData`, partial-output callbacks, user-input callbacks, globals setters, wait-event handlers, plugin config, and subprocessor creation for every node execution. Do not move mutable node/run-scoped fields into the stable base.
- the default isomorphic Code runner is a shared stateless instance for core/browser-style contexts. Custom `ProcessContext.codeRunner` values remain per-caller and are still passed through unchanged.

The readiness/dependency logic used by this flow now lives largely in `NodeExecutionPlanner.ts`, while `GraphProcessor` coordinates queueing and mutable execution state.

`GraphProcessor` keeps the errored-input gate in
`#processNodeIfAllInputsAvailable(...)`. That method computes a node's upstream
inputs, checks ignored/visited/errored-input state, and only then calls
`#processNode(...)` without an intervening `await`. Keep the duplicate
errored-input scan out of `#processNode(...)`; reintroducing it adds measurable
per-node overhead to cheap workflow runs without improving the current event or
error contract. `GraphProcessor.characterization.test.ts` pins that downstream
nodes do not start or emit their own node errors after an upstream input node
fails.

The internal `fast-acyclic` scheduler is an internal TypeScript scheduler path.
It starts from source nodes and runs a small ready queue
instead of recursively pulling from graph-output nodes through `p-queue` at
every hop. Eligibility is intentionally narrow: no cycles, no split-run nodes,
no preloaded/run-to editor state, no trace mode, and no loop, race, user-input,
or wait-event nodes. Unsupported graphs automatically stay on the compatible
scheduler. Node processing, exclusion, events, abort checks, subgraph creation,
and output collection still go through the same `GraphProcessor` methods. The
ready counts are based on unique upstream node ids, not raw connection counts,
so a single source connected to multiple input ports releases the target once
that source has finished, matching the compatible scheduler.

The final runtime-speed reassessment kept this eligibility narrow. Scheduler-only
benchmarks show a substantial win for already-supported acyclic headless graphs,
especially wide fan-in shapes, but the remaining excluded classes are
behavior-sensitive: split-run, loop, race, user-input, and wait-event handling.
Do not broaden the scheduler into one of those classes without first adding
golden event, recording, abort, and pause/resume characterization for that exact
class plus a benchmark proving the expansion is worth the risk.

#### Root-owned async branches

`Start Async Branch` is an explicit scheduler boundary, not a detached job. It
processes like a variadic Passthrough after all connected inputs are ready, but
its downstream slice is registered with the root processor instead of being
queued on the foreground path. The compatible scheduler therefore resumes the
foreground immediately. Graphs containing this node deliberately fall back from
the fast acyclic scheduler until that scheduler has equivalent managed-branch
coverage.

The root processor owns a per-run managed-task registry and drains it to a fixed
point before `graphFinish`, `done`, and `finish`. A task may encounter another
Start Async Branch and register more work during that drain. Work launched
repeatedly by the same graph/node trigger is serialized in invocation order;
independent triggers may overlap. Background is intentionally not the
user-facing term because these branches remain observable async work in the
current run.

Ordinary `processGraph(...)` callers keep the full-lifecycle behavior. Callers
that set `returnWhenGraphOutputsReady` receive a two-phase run when foreground
scheduling completes while managed work is still pending: core fills the
foreground-derived `cost`, emits root `graphOutputsReady`, and resolves the
result promise without emitting terminal lifecycle events. The processor stays
Running. `waitForRunCompletion()` observes the later drain, errors,
`graphFinish`, `done`, and `finish`. Web-app action paths enable this mode so a
Chat response is not held behind a side-effect-only branch. Local/Node executor
owners defer abort-listener, recorder, debugger, code-runner, cache, and active
processor cleanup until `waitForRunCompletion()` settles. Remote execution
transports forward `graphOutputsReady` separately from `done`; the result waiter
settles on either event while run routing remains active until the real terminal
event. If no managed work remains, or foreground processing fails before an
early publication, the result promise retains ordinary full-lifecycle semantics
and settles only after terminal cleanup and `finish` listeners. An async failure
after early publication is reported through normal processor error events and
the completion promise, but cannot retract an action result already delivered.
Costs added only by later async work are therefore not part of an
already-serialized early result.

The ownership rules are:

- root-graph async slices reuse the still-running root graph-run identity and
  suppress synthetic graph lifecycle events; a branch originating in a
  subgraph receives a fresh managed graph-run identity parented to that
  subgraph, so its node events never arrive after its own `graphFinish`
- globals, Stored Values, graph inputs, execution cache, external functions,
  loaded references, and cost accounting remain shared
- root pause, resume, abort, and user-input routing continue through the branch;
  each branch also retains its source graph processor's run-abort signal, so
  async work launched inside a subgraph is cancelled if that subgraph loses a
  parent race. When a temporary continuation processor reaches the trigger,
  source ownership remains the real same-graph processor rather than that
  already-finished temporary slice
- a branch failure is attributed to its failing node and fails the root at the
  terminal boundary without rewriting an already-finished trigger or Delegate
  as failed

The async subtree must be closed and side-effect-only. Runtime topology
validation rejects Graph Output descendants, a path back to its own trigger,
and nodes with required incoming connections from outside the subtree. Values
needed by the branch must cross the trigger's paired variadic ports. Disabled
boundaries and invalid/stale port connections are not treated as runnable async
descendants. Frozen trigger replay is rejected because it would make external
side-effect repetition implicit.

Async descendants are excluded from ordinary parent scheduling. A same-graph
processor receives the trigger outputs as a suppressed preload, stops again at
nested async boundaries, forwards real node events, and is explicitly unwired
when its slice settles. It is attached to the true root lifecycle even when the
trigger was reached inside a subgraph or a synthetic LLM continuation processor;
attaching it to that temporary processor would let its work escape after the
temporary owner returns.

### Control-flow model

Control flow is implemented through data propagation rather than separate wire types.

Important mechanisms:

- built-in conditional port `IF_PORT`
- `control-flow-excluded` values
- special handling for loops and certain nodes that are allowed to consume excluded values

The decision policy lives in
[`NodeExclusionPolicy.ts`](../packages/core/src/model/NodeExclusionPolicy.ts).
It owns disabled-node exclusions, false conditional `IF_PORT` exclusions,
control-flow-excluded input decisions, merge-node exceptions, loop wait sentinel
skips, missing-required-input trace wording, and construction of excluded output
maps. `GraphProcessor` still owns applying those decisions: emitting trace and
`nodeExcluded` events, storing output data, propagating attached data, clearing
in-flight state, and queueing downstream nodes.

Required input ports are also part of the exclusion lifecycle. If a reachable node has an input definition with `required: true` and that port has no connection, `GraphProcessor` must not call the node implementation. Instead, it emits `nodeExcluded` with reason `missing required input`, stores `control-flow-excluded` values for every output, and queues downstream nodes so the editor shows `Not ran` and exclusion continues through the graph.

This path must still participate in runtime metadata:

- respect completed race branches before emitting exclusion
- register excluded loop nodes with active loop metadata
- propagate attached data to downstream nodes
- clear in-flight and remaining-node state just like completed nodes

Keep this centralized in `NodeExclusionPolicy` / `GraphProcessor` /
`NodeExecutionPlanner`; do not patch individual node implementations to handle
unconnected required ports.

### Subgraphs

Subgraph execution uses child `GraphProcessor` instances created by `#createSubProcessor(...)`.

Subprocessors:

- inherit executor mode
- share execution cache
- share globals
- share external functions
- inherit the parent processor's concurrency policy
- propagate events back to the parent
- participate in root-level pause/resume/abort behavior

This means subgraphs are not a separate execution engine. They are nested processors wired into the same event and lifecycle model.

The low-level event/lifecycle plumbing for that parent-child relationship now lives in `SubprocessorBridge.ts`.

Important current behavior:

- child processors emit already-enriched execution metadata rather than relying on the parent bridge to reconstruct lineage after the fact
- child processors can be seeded with a cached immutable child-graph plan, but
  never with prior node outputs, globals, abort state, pause state, queued
  nodes, execution metadata, or reused `NodeImpl` objects
- node events emitted inside a subgraph reference that subgraph invocation's `graphRunId`
- split-sequential subgraph calls preserve executor `splitIndex` in execution metadata so app-side consumers can distinguish sibling invocations that share the same graph definition
- `SubprocessorBridge` intentionally separates passive event forwarding from control lifecycle cleanup. Ordinary subgraphs keep passive process-event forwarding for the subprocessor object lifetime so late `nodeFinish`, `nodeError`, and `nodeExcluded` events from successful graph-abort paths are not dropped after a child `graphFinish`. Control listeners such as parent/child pause, resume, and abort use a run-scoped lifecycle subscription keyed by the child processor's own `graphRunId`, so those controls clean up when the child graph run reaches its terminal event. Synthetic same-graph continuation processors opt out of automatic terminal cleanup and explicitly dispose both passive and control subscriptions in their own `finally` boundary; otherwise a nested child graph terminal could be mistaken for the synthetic processor's suppressed lifecycle. Lifecycle wiring also preserves an abort that arrives before `processGraph(...)` starts and applies it at the child's own `graphStart`.
- Successful graph-abort paths treat abort-caused cancellation as exclusion, not failure. `Abort Graph` successful early exits and `Race Inputs` losing-branch cancellation propagate an internal successful-abort reason through active node controllers and nested subprocessors. A node that already produced outputs after a successful non-race abort emits its normal `nodeFinish`, but its dependents are not queued from that late finish because the graph is already terminal. A node whose work is actually interrupted emits `nodeExcluded` with reason `Graph aborted successfully`, and that successful-abort exclusion also does not queue dependents; race losers keep the more specific reason `Race branch lost`. Split-run workers must check the shared abort state before processing each item so a successful graph abort cannot launch additional split item work after the graph is already terminal. Do not surface these successful cancellations as `nodeError`: the graph already has a valid successful terminal path, and Remote Debugger/replay should clear spinners without showing false failed Expression/Subgraph nodes.
- `GraphProcessor` awaits `nodeError` terminal emissions just like normal `nodeFinish` emissions. Do not make node errors fire-and-forget: caught subgraph failures can let the root graph finish successfully, and remote debugger/replay consumers still need the inner node's terminal error event before subgraph bridge cleanup.

Graph boundary metadata for direct nested-graph callers is centralized in
[`GraphBoundaryCache.ts`](../packages/core/src/model/GraphBoundaryCache.ts).
The helper derives sorted, first-duplicate-wins Graph Input and Graph Output
ports, builds subgraph input maps without repeated object spreads, and builds
error-path excluded output maps. `SubGraphNode.data.inputPortOrder` and
`SubGraphNode.data.outputPortOrder` are per-node-instance visual ordering
overrides layered on top of that boundary metadata: ordered live ids are shown
first, duplicate/stale ids are ignored, and new boundary ports append in the
default sorted order. The optional Subgraph `Error` output is appended after
ordered graph outputs and is not part of `outputPortOrder`. The order arrays
live inside node `data` so project YAML
stays backward-compatible: old projects omit them, and older Rivet versions can
ignore the extra keys without changing connection ids or execution semantics.
Graph-boundary dataflow effects that are not
metadata-only live in
[`GraphBoundaryEffects.ts`](../packages/core/src/model/GraphBoundaryEffects.ts):
final `cost` output insertion and recoverable frozen `Graph Output` /
`Set Global` effects. `GraphProcessor` exposes boundary metadata to runtime
nodes through `InternalProcessContext.getGraphBoundary(...)`, backed by the
optional `GraphProcessorRuntimeCache.graphBoundaries` WeakMap. Fresh processors
get a fresh cache; `createGraphRunner` reuses the cache until `dispose()`,
matching its immutable-project execution-plan cache contract. If a processor
uses project references without loaded-project caching, the boundary cache is
reset at run start so a newly loaded or mutated referenced project cannot
inherit stale Graph Input / Graph Output metadata. The context resolver itself
is optional for compatibility with manually constructed internal contexts;
nested-graph nodes fall back to uncached boundary derivation when it is absent.
The same resolver is threaded into preprocessing through the internal
`NodeDefinitionContext`, but only for boundary-driven nodes
(`Subgraph`, `Referenced Graph Alias`, and `Loop Until`) so ordinary
node-definition loading keeps the no-cache hot path. Editor settings use
uncached boundary derivation so in-place graph input/output edits remain
visible immediately.

Subgraph output-demand execution is currently parked behind
`GRAPH_BOUNDARY_OUTPUT_DEMAND_OPTIMIZATION_ENABLED`, which defaults to `false`.
With the flag off, `SubGraph` and `Referenced Graph Alias` run their full child
graphs just like the legacy runtime: unconnected child `Graph Output` branches
still run, and their side effects/errors still occur. The implementation remains
in place for later re-enablement. Before a node implementation runs,
`GraphProcessor` still computes `activeOutputPortIds` from valid outgoing
connections whose immediate downstream node exists, is not disabled, and is
relevant to the current run-to slice when `runToNodeIds` is active. The node
process context also receives `isDirectRunTarget`, so the parked optimization
can distinguish "this Subgraph is being inspected" from "this Subgraph is only a
dependency of another target."

When the flag is re-enabled, `SubGraph` and `Referenced Graph Alias` use their
boundary metadata to map active output ports to the first-duplicate-wins child
`Graph Output` node ids and run the child processor with those ids as
`runToNodeIds`. Unrequested boundary outputs are returned from the caller node as
`control-flow-excluded` values. If no boundary output is active, the child graph
is not started; Subgraph returns excluded boundary outputs plus zero cost/duration
metrics, while Referenced Graph Alias returns zero cost/duration only when its
`Output Cost & Duration` setting is enabled.

When the flag is on, the full child graph still runs when the caller node is the
direct run-to target, when Subgraph partial-output forwarding is enabled, or when
an enabled Subgraph/Referenced Graph Alias `Error` output has an active
downstream consumer. Re-enabling the flag intentionally changes side-effect
behavior: side-effect-only work in unconnected child output branches no longer
runs. That includes globals, dataset writes, events, audio playback, aborts,
external calls, HTTP/LLM calls, and arbitrary Code/Expression side effects.
Errors in skipped branches are also skipped.

### User input

User-input nodes are supported directly by the processor.

Current behavior:

- a node requests user input through `requestUserInput(...)` in process context
- processor stores pending resolvers by `NodeId`
- processor emits a `userInput` event
- callers respond through `processor.userInput(nodeId, values)`

This is how the app bridges execution to the user-input modal.

### Globals and user events

`GraphProcessor` also provides lightweight runtime communication channels:

- graph-global values via `getGlobal`, `setGlobal`, `waitForGlobal`
- user events via `raiseEvent(...)` and `waitEvent(...)`

These are shared across subgraphs because subprocessors inherit the same root structures.

Persistent-capable run state is separate from globals. `Set Stored Value` and `Get
Stored Value` use one `RivetStoredValueController` created for each root run and
shared with every subprocessor. The controller provides strict portable-JSON
validation, read-through/write-through caching, one successful backend load per key,
same-key serialization, in-run Wait notification, and cache-only frozen Set replay.
The nodes' editor type selector exposes only JSON-compatible Rivet types; binary,
media, document, chat-message, and function types remain unavailable there.
`GraphProcessor.setStoredValueStore(...)` configures the optional backing store;
without one, a new run-local memory view is created even when the processor instance
is reused. Core and Node `RunGraphOptions.storedValueStore` configure the same seam.

Get Stored Value's On Demand mode still executes an async backend load when the node
runs, then returns a synchronous function backed by the run cache so later Sets in
that run are visible when downstream nodes consume it. Wait defaults off and waits
only for a successful Set in the same root run. Missing keys return the selected
type default plus `Found: false`; stored `null` remains `Found: true`.
An existing value that is incompatible with the node's selected type also returns
that type's default, but `Found` (or Set's `Had Previous Value`) remains true. This
keeps key schema changes deterministic without mutating persisted values or relying
on permissive cross-type coercion.

`Get Global` and `Set Global` runtime semantics are unchanged by editor conveniences. The app-side Get Global variable selector scans static `Set Global` node IDs in the current project, overlays the live open graph over the saved project graph list so unsaved Set Global edits are searchable immediately, and writes a selected ID into the normal `id` node data field; dynamic IDs supplied through the `Set Global` ID input port are runtime values and cannot be discovered safely by the editor. Variable ID input ports stay string-typed regardless of the selected global value data type, `Get Global` emits its `Variable ID` output even when `On Demand` returns a function value, and `Set Global` resolves `Previous Value` from the same static or dynamic ID that it is about to write. New Get Global nodes default to `wait: true` and `onDemand: false`, and their editor metadata makes those two toggles mutually exclusive in the UI.

## Split-Run Execution

Split-run logic has been extracted into [`SplitRunProcessor.ts`](../packages/core/src/model/SplitRunProcessor.ts).

### Why it matters

This is one of the clearest recent refactor seams in core:

- `GraphProcessor` still decides when split-run is needed
- the actual split-run loop/aggregation lives in a separate module

### Current split-run behavior

`processSplitRunNode(...)`:

- pulls input values from injected dependencies
- determines split count from array-valued inputs and `splitRunMax`
- emits and awaits the aggregate `nodeStart`
- runs sequentially when `isSplitSequential` is set
- otherwise runs in parallel through a bounded queue using `node.splitRunConcurrency` when present, or the processor's `splitRunConcurrency` fallback when the node has no override
- emits partial outputs for each split item as detached progress events
- aggregates split outputs back into array outputs
- emits and awaits the aggregate `nodeFinish` or routes errors back through the injected awaited `nodeErrored(...)`

### Architectural significance

The split-run module is intentionally dependency-injected through `SplitRunDeps`.

That means:

- split-run policy is still coupled to processor semantics
- but the orchestration details are now testable/refactorable separately

## Process Context

The runtime context exposed to nodes is defined in [`ProcessContext.ts`](../packages/core/src/model/ProcessContext.ts).

There are two layers:

### `ProcessContext`

Caller-provided execution environment:

- settings
- native API
- dataset provider
- MCP provider
- audio provider
- tokenizer
- code runner
- project reference loader
- project path
- optional chat-endpoint resolution hook

The `Tokenizer` interface supports an optional listener cleanup contract: `on('error', listener)` may return an unsubscribe callback. Built-in tokenizers return that callback, and `GraphProcessor` uses it to keep tokenizer error listeners run-scoped when processors or tokenizer instances are reused.

### `InternalProcessContext`

Processor-built node execution context:

- executor mode
- current project
- referenced projects
- abort signal
- process ID
- root run ID / graph run ID / parent graph-run lineage
- context values
- graph inputs/outputs
- graph input-node values
- optional graph boundary lookup for nested-graph callers
- current node
- attached execution data
- event/global helpers
- subprocessor factory
- partial-output callback
- external functions
- execution cache
- plugin config lookup
- code runner
- trace and abort helpers
- user-input request helper

This context is one of the most important extension surfaces in the runtime.

That is especially true for nested execution correctness: `ProcessContextBuilder` is the seam that threads root lineage into child processors while assigning fresh child graph-run identity.

### Code runner error locations

`Code (legacy)`, `Code` (internal type `codeNew`), `Expression`, `JS Filter`, and `JS Map` still execute
through the configured `CodeRunner`. Browser mode uses `IsomorphicCodeRunner`.
Compatible-profile `createProcessor(...)` execution through
`@valerypopoff/rivet2-node` still defaults to `NodeCodeRunner`, while
omitted-default `createProcessor(...)` and eligible `runGraph(...)` calls can
use the run-scoped cached Node CodeRunner when no custom runner is supplied.
The desktop app's internal `app-executor` sidecar passes its own worker-backed
runner so most Code-family JavaScript runs off the sidecar's main event loop.
The app-executor worker runner falls back to current-thread execution when a
Code-family node requests the `Rivet` capability, because packaged sidecar
module resolution for that capability must stay compatible.

The CodeRunner capability argument order is part of the runtime contract:
`inputs`, optional `console`, optional `require`, optional `process`, optional
`fetch`, optional `Rivet`, optional `graphInputs`, then optional `context`.
[`nodeCodeRunnerInvocation.ts`](../packages/node/src/native/nodeCodeRunnerInvocation.ts)
is the shared source of truth for public Node runners and the cached default
Node runner. The app-executor worker path mirrors this order in
[`codeRunnerWorkerHost.mts`](../packages/app-executor/bin/codeRunnerWorkerHost.mts)
for worker-safe capabilities, while
[`AppExecutorWorkerCodeRunner.mts`](../packages/app-executor/bin/AppExecutorWorkerCodeRunner.mts)
keeps the matching current-thread fallback for `includeRivet`. Refactors in
this area should change the capability order in one place first, then update
the worker/current-thread mirror and tests in the same change. The
app-executor runner tests include an equivalence case against the default Node
runner for worker-safe capabilities so that `inputs`, `require`, `process`,
`fetch`, `graphInputs`, and `context` do not silently drift.

The Code-family nodes that own full code editors, `Code (legacy)` and `Code`, append a generated `sourceURL` before calling
whichever runner is configured so runtime stack frames can be mapped back to the
user's code editor lines when the run fails. That source URL is stable per node
rather than per execution, because the process id is already carried by graph
events and stable source names let headless Node runners reuse compiled
functions across repeated backend calls. `Code` passes the generated
interpolation/wrapper source as diagnostic code plus a user-code line offset, so
runtime and syntax failures still point at the authored Code body instead of
the generated wrapper.

In the desktop app's Node executor, Code-family console observability stays
app-executor-specific. `codeRunnerWorkerHost.mts` injects the bridged console for
worker-backed runs, while `AppExecutorWorkerCodeRunner.mts` keeps the matching
bridge for the `Rivet`-capability current-thread fallback. In both paths those
calls become `codeConsole` executor messages that the app replays in the renderer
console. This does not change custom `codeRunner` ownership or the public
`NodeCodeRunner` default used by explicit compatible-profile
`createProcessor(...)` callers.

`NodeCodeRunner` exposes its CommonJS `require()` resolution policy through
`createCodeRunnerRequire(...)`, `getCodeRunnerRequireRoot(...)`, and
`getCodeRunnerRequireAnchorPath(...)` from `@valerypopoff/rivet2-node`. The default
anchor remains `process.cwd()/__rivet_node_code_runner__.cjs`, so programmatic
callers keep the old behavior. Hosted wrappers can set
`RIVET_CODE_RUNNER_REQUIRE_ROOT` or `RIVET_CODE_RUNNER_REQUIRE_ANCHOR` before the
runner is constructed to resolve Code-family `require()` from a runtime-library
directory without patching source.

The default Node policy can use a cached CodeRunner inside omitted-default
`createProcessor(...)` when the caller does not pass an explicit `codeRunner`.
The cache stores compiled functions by source text plus the injected argument
shape (`inputs`, permissions, graph inputs, and context presence). It does not
cache values or outputs, so locals remain fresh for every invocation and
per-run `inputs`/`context` still vary normally. Eligible `runGraph(...)` calls
use the same default CodeRunner policy as omitted-default
`createProcessor(...)`.
`runGraph(...)` does not expose `runtimeProfile`; untyped `runtimeProfile`
properties are ignored. Compatible `createProcessor(...)`, Browser mode,
Remote Debugger fallback, and app-executor worker execution keep their existing
CodeRunner ownership. Custom `codeRunner` instances always win over the cached
runner.

Syntax-error diagnostics are deliberately failure-only. The core does not pre-parse
successful `Code` node runs. If `AsyncFunction` construction throws a syntax error,
the node then performs a small parser pass over a synthetic async-function wrapper
and subtracts the wrapper offset to report the code-node line/column. Non-user-code
errors, such as disabled dynamic execution or unavailable Node-only permissions, are
left unchanged. When a location is found, the original thrown error object is
annotated in place rather than replaced, so programmatic callers keep the original
error type and custom properties.

## Programmatic API

The high-level API lives in [`packages/core/src/api/createProcessor.ts`](../packages/core/src/api/createProcessor.ts).

### `coreCreateProcessor(...)`

Returns:

- `processor`
- normalized `inputs`
- normalized `contextValues`
- `getEvents(...)`
- `getSSEStream(...)`
- `streamNode(...)`
- `run()`

This is the main composition API used by higher-level packages.

### `coreRunGraph(...)`

Thin convenience wrapper around `coreCreateProcessor(...).run()`.

### `RunGraphOptions`

Current options include:

- graph selection
- inputs and context
- native/dataset/audio/MCP providers
- external functions
- user-event handlers
- abort signal
- registry override
- trace toggle
- processor concurrency override
- chat-endpoint resolver
- tokenizer
- code runner
- project path
- project reference loader
- full settings payload
- generated event callbacks like `onNodeStart`, `onGraphFinish`, etc.

This option type is much broader than "just inputs and settings."

Runtime settings are normalized through [`processSettings.ts`](../packages/core/src/api/processSettings.ts). `resolveProcessSettings(...)` is the shared boundary used by core, `rivet-node`, and Trivet so programmatic execution gets the same runtime defaults while still preserving explicit runtime options such as `recordingPlaybackLatency`, without depending on app-only editor preference fields that still exist on the legacy `Settings` object for compatibility. Shared LLM credentials (`openAiApiKey`, legacy `openAiKey`, `anthropicApiKey`, `googleApiKey`, and `customAiApiKey`) are first-class runtime settings so LLM Chat configured-key mode works the same in the app, Node package, CLI, and test runners; provider plugin config remains the compatibility fallback for older Anthropic/Google plugin settings. Custom provider configured-key mode checks the node's `customProviderApiKeyProgrammaticName` as a top-level runtime setting name, then checks the node-specific env var name through `settings.pluginEnv` / `process.env`, then falls back to the shared `customAiApiKey`. `resolveProcessSettings(...)` must normalize `openAiApiKey` and `openAiKey` to the same resolved runtime value so old OpenAI-backed nodes and new programmatic callers stay compatible, and it must preserve extra top-level settings so wrapper/backend code can pass separate custom-provider secrets using the exact names configured on each LLM Chat node without abusing plugin environment settings. [`getPluginConfig(...)`](../packages/core/src/utils/getPluginConfig.ts) deliberately bridges shared `anthropicApiKey` and `googleApiKey` settings into the legacy Anthropic/Google plugin config lookup after non-empty explicit plugin settings and before plugin env fallbacks, so old plugin nodes and app-side helper graphs such as `Generate using AI` can use the same Settings > LLM keys without duplicating credentials into Plugins settings. Missing or blank plugin values fall through instead of blocking shared keys or environment fallbacks, because plugin settings are often partial.

## Event Streaming API

Streaming helpers live in [`packages/core/src/api/streaming.ts`](../packages/core/src/api/streaming.ts).

Current functionality:

- `getProcessorEvents(...)` exposes filtered async iteration over processor events
- `getProcessorSSEStream(...)` adapts that to SSE wire format
- `getSingleNodeStream(...)` streams partial output for a single node until completion

These APIs are used directly by higher-level surfaces like the CLI and Node-serving flows.

## Serialization

Serialization lives in [`packages/core/src/utils/serialization/`](../packages/core/src/utils/serialization/).

### Current behavior

- version detection happens centrally in `serializationUtils.ts`
- versioned serialized project/graph input is prepared once through the
  internal `serializationInput.ts` helper, which detects the serialization
  version and carries the already parsed v2-v4 YAML/JSON envelope into the
  selected deserializer
- project and graph deserialization dispatch by detected version
- v4 is the active serializer/deserializer path
- dataset serialization is handled separately through v4 dataset helpers
- project-level library nodes are stored in optional `Project.nodePrefabs`. Each entry is `{ id, sourceNode }`, where the source node is an isolated `ChartNode` outside executable graphs and has no connections. The v4 serializer writes `nodePrefabs` only when the project has entries, so old projects keep their previous shape. Older Rivet versions should ignore the extra top-level field, while `nodePrefabInstance` graph nodes appear as unknown/unavailable nodes if opened before this feature exists.
- project-level minimal web apps are stored in optional `Project.uiGraphs`. Each entry is a declarative `UiGraph` component tree, not a `NodeGraph`, and the v4 serializer writes `uiGraphs` only when the project has entries. Old projects load with no web apps. Older Rivet versions should ignore the extra top-level field, but they will not show or preserve web apps if they resave the project without opaque top-level field preservation.

### Node library runtime model

Node library support is intentionally modeled as project-level data plus a tiny graph-local linked node:

- [`Project.nodePrefabs`](../packages/core/src/model/Project.ts) stores library-node source definitions.
- [`nodePrefabInstance`](../packages/core/src/model/nodes/NodePrefabInstanceNode.ts) stores only `{ prefabId }` plus normal graph-local node identity and visual data.
- [`NodePrefabResolver.ts`](../packages/core/src/model/NodePrefabResolver.ts) resolves an instance into an effective clone of its source node before runtime node implementations are created.

The effective-node model keeps graph execution behavior aligned with ordinary nodes. During preprocessing, `GraphPreprocessor` replaces every linked node with the resolved source semantics while preserving the instance `id` and graph-local geometry (`x`, `y`, `width`, and `zIndex`). Library-node visual styling such as node color stays source-owned so V1 does not accidentally create per-link style overrides. Node lifecycle events, execution history, recordings, run-to/run-from behavior, Browser execution, Node execution, and Remote Debugger routing therefore use the instance node id but the library node type and ports. Downstream connections continue to point at the instance id, so changing a library node can recover or drop invalid linked-node connections without rewriting unrelated graph structure.

Missing or invalid library nodes stay as `nodePrefabInstance` fallback nodes. They render with a missing-source warning in the editor and fail only if execution reaches them, with a graph failure naming the missing library node.

Runtime execution-plan caching remains enabled for projects with `nodePrefabs`, but cached plans are keyed by the `Project.nodePrefabs` object identity used to build them. Library-node edits replace that map and force the next run to rebuild the plan, while repeated runs without Node library edits keep the normal cached path. Do not cache projects solely by `NodeGraph` identity; library-node edits can change the effective type, ports, split/conditional behavior, and implementation of many graph-local linked nodes without changing the graph object itself.

Library nodes are not graph nodes. They have no connections, are not executable by themselves, are not main-graph candidates, and should not enter reachability analysis. `canUseNodeAsPrefabSource(...)` blocks graph-boundary and graph-reference node types (`Graph Input`, `Graph Output`, `Referenced Graph Alias`, `Comment`, and `nodePrefabInstance`) so a V1 source remains a standalone node implementation instead of becoming another graph wrapper. Compare/search tools can inspect serialized source-node definitions, but runtime dataflow must always go through graph-local `nodePrefabInstance` nodes.

### Minimal web app model

Minimal Rivet web apps are stored in [`Project.uiGraphs`](../packages/core/src/model/Project.ts) and defined by [`UiGraph`](../packages/core/src/model/UiGraph.ts). A UI graph is a saved project resource, but it is not an executable workflow graph: it has no nodes, no connections, no graph inputs/outputs, cannot be selected as the Main Graph, and does not enter execution scheduling. Its stored Button and Chat `action.graphId` values are the one graph-list reachability exception: the editor treats each valid same-project target as a definite entry point and follows its ordinary graph dependencies, while the UI graph itself never becomes a graph candidate. V1 components are declarative (`text`, `markdown`, `gap`, `input`, `textarea`, `dropdown`, `button`, `chat`, and `output`) and actions can only run ordinary graphs in the same project. A `dropdown` stores a label, one state key, and ordered label/value string items; it initializes that key to an empty selection and its shared render model rejects stale state values that no longer exist in the items list. A `gap` stores one of `small`, `medium`, or `large`, produces no state or runtime action, and renders as a cardless empty spacer through the shared renderer CSS. The geometry is intentionally distinct (`8px`, `32px`, and `96px`) because the component surface also applies its regular inter-component gap; its editor-only frame still supplies selection highlighting and drag reordering. Markdown components and Markdown output mode use the app's standard `marked` conversion path and GitHub Markdown CSS baseline in the app preview; hosted Node HTML embeds the same packaged Markdown CSS and `marked` browser build before its declarative client renderer. Image output mode derives a renderer-safe source in [`UiGraphRuntimeModel.ts`](../packages/core/src/model/UiGraphRuntimeModel.ts): it accepts HTTP(S), relative, and `blob:` URLs, raster image data URLs, and recognized raw PNG/JPEG/GIF base64 while rejecting arbitrary schemes and non-image base64. Both renderer adapters receive that same derived source and keep the original state value for Copy. UI graphs still do not expose arbitrary JavaScript or a custom asset pipeline. This keeps the feature as a small app surface over existing workflow graphs rather than a custom frontend-code host.

`resolveUiGraphActionInputs(...)` maps UI data into graph input values. New button actions use ordered `inputMappings` rows so the editor can preserve in-progress blank/renamed rows; legacy `inputs` maps are still accepted for old saved projects and literal bindings. `resolveUiGraphActionOutputStatePatch(...)` maps one or more graph outputs back into UI data. New button actions use ordered `outputs` rows; each row with no `outputKey` stores the whole output map, and each row with an `outputKey` stores the selected Rivet data value's inner `.value`, matching the user-facing value produced by a Graph Output node. A Dropdown's selected string behaves like any other state-key value when explicitly mapped into a graph input. Legacy `outputKey` / `outputStateKey` fields are still accepted as a single output binding. A missing configured `outputKey` throws so preview and hosted handlers show an explicit action error rather than storing `undefined`.

Chat components store graph-role IDs, optional additional `inputMappings`, and an optional placeholder in YAML. Draft text and `UiGraphChatMessage[]` live under component-ID-derived runtime state keys. Submission appends the new user turn before dispatch, sends that text as a `string` to `userInputId`, and sends only the preceding user/assistant turns as a native `chat-message[]` Data Value to `historyInputId`. Additional mappings project explicitly selected page data into other graph inputs. The selected `responseOutputId` is unwrapped and appended as the assistant turn. `getUiGraphComponentActionState(...)`, `resolveUiGraphComponentActionInputs(...)`, and `resolveUiGraphComponentActionOutputStatePatch(...)` are the shared Button/Chat dispatch seam; hosts and renderers must not reconstruct Chat history independently.

[`UiGraphSchema.ts`](../packages/core/src/model/UiGraphSchema.ts) is the authoritative Zod runtime shape for persisted UI graph envelopes, component discriminators, actions, bindings, dropdown items, and enums. Bidirectional compile-time assertions keep the inferred schema output and exported persisted types in lockstep, so adding a component variant or envelope field cannot silently leave validation behind. [`UiGraphNormalization.ts`](../packages/core/src/model/UiGraphNormalization.ts) is the untrusted-data adapter around that schema: it preserves graph/component/binding diagnostic paths, enforces project-map IDs, and then applies the one supported legacy repair for component IDs. `normalizeUiGraph(...)`, `normalizeUiGraphRecord(...)`, and `normalizeProjectUiGraphs(...)` preserve already-valid object references and expose failures through `UiGraphNormalizationError.issues`. V4 serialization/deserialization, raw project validation, hosted editor snapshots, desktop rendering/action dispatch, and Node rendering/action dispatch all delegate to this parser; consumers must not add partial local shape checks or a second component validator.

The only intentional UI-graph shape migration is deterministic repair of missing, blank, or duplicate legacy component IDs. Wrong-type IDs, sparse component/binding arrays, unknown component/action discriminators, missing action/state/content fields, invalid `gap.size`, and invalid output `renderAs` values are rejected instead of being guessed. `validateProject(...)` disables ID repair so it reports raw project problems; V4 deserialization and runtime snapshot normalization enable the known legacy repair and preserve all already-valid object references. Serialization writes repaired IDs back on the next save. The older `normalizeUiGraphComponentIds(...)` API remains an ID-only compatibility helper; it must not become a second shape parser or acquire the stricter behavior of `normalizeUiGraph(...)`. Runtime callers still execute the target workflow through the normal graph processor path, so plugin providers, context values, datasets, project references, and node behavior stay owned by the existing processor options. In the desktop editor preview, UI actions are routed through the app's normal editor graph-run command rather than a hidden processor, so execution history and node outputs remain inspectable on the target graph. Hosted Node handlers run through `createProcessor(...)` because they serve deployed web requests outside the editor execution-history UI. Hosted handlers accept request-scoped processor option resolvers so wrappers can create per-request code runners, datasets, project-reference loaders, context, telemetry, and endpoint-style `inputs.input` values without Rivet owning route registration or auth. The button target graph is always forced by the UI action, while resolver-provided `inputs` and `context` override the default UI-mapping inputs and `resolveContext(request)` fallback. Hosted action requests are JSON-only, use object-shaped UI state, and reject malformed action bodies before mapping inputs so wrapper routes get predictable failures instead of graph-input shape surprises. Optional web-app `revisionKey` values are opaque wrapper consistency tokens embedded in the HTML and echoed by action calls; Rivet only rejects mismatches when the host configured a key. Revision mismatches are reported as `409` with machine-readable `code: "revision_mismatch"`, and the embedded client shows a blocking `This app was updated. Reload to continue.` modal while preserving the existing state underneath until the user explicitly reloads. `getUiGraphInitialState(...)` is the shared way to seed input/textarea defaults for both desktop preview and hosted Node rendering.

Long-running hosted actions reuse those semantics through
`prepareRivetWebAppAction(...)`, which returns the validated processor, a one-shot
`run()`, and an idempotent pre-run `dispose()`.
`createRivetWebAppWebSocketGateway(...)` adds transport and run ownership only:
idempotent request IDs, server run IDs, ordered event replay, progress,
cancellation, heartbeat, and injectable run-store/coordinator seams. Its
session-scoped `onProcessorPrepared(...)` callback is awaited after preparation but
before execution, giving hosts the same processor-observer attachment point as
direct `createProcessor(...)` integrations. Failed hooks and cancellation during
preparation dispose the action, and aborted Node processors detach pre-run Remote
Debugger ownership.

The public gateway facade stays in [`webAppSocketGateway.ts`](../packages/node/src/webAppSocketGateway.ts), while its internal lifecycle owners are deliberately narrow: `webAppRunJournal.ts` serializes persistence, broadcast, coordinator publication, and exactly-once terminal callbacks; `webAppActiveRuns.ts` owns per-scope reservations and terminal release; `webAppLeaseManager.ts` renews leases and reports lost ownership; `webAppRemoteRunSubscriptions.ts` owns cross-replica replay/subscription gaps; `webAppSocketSession.ts` owns handshake, heartbeat, limits, dispatch, and socket cleanup; and `webAppRunStore.ts` implements the bounded local store. New lifecycle behavior should be added to the owner that already controls its cleanup rather than reintroducing gateway-level maps.

The gateway does not change graph scheduling or make an in-memory processor
restartable. The bounded in-memory store and coordinator support local hosting only.
Distributed hosts pair a durable `RivetWebAppRunStore` with a message-bus-backed
`RivetWebAppRunCoordinator`: reconnecting replicas receive sequenced owner events,
remote cancellation is routed to the live processor, and store-clock leases fence
writes from stale owners. Any replacement worker may atomically convert expired
running rows into `action.interrupted` terminals, so Deployment recovery does not
depend on stable pod names or process slots.

Workflow-bound component consistency lives in [`UiGraphBindings.ts`](../packages/core/src/model/UiGraphBindings.ts). `reconcileProjectUiGraphBindings(previousProject, nextProject)` is the immutable project-level operation used when workflow graph boundaries are persisted. It never matches rows by position: exact IDs win, and an ID crosses a rename only when the same Graph Input/Output node proves it. Multiple Button mappings from one graph output to different UI data keys are valid fan-out and survive reconciliation. Automatic reconciliation touches only the boundary side whose IDs changed and preserves references for unrelated UI graphs. A Button that covered the complete previous boundary gains deterministic rows for new ports; intentionally partial or empty mappings stay partial/empty so graph defaults and ignored outputs keep their runtime meaning. Chat keeps its user/history/output roles only for exact IDs or proven renames and clears removed roles. `validateUiGraphActionBindings(...)` and `validateProjectUiGraphActionBindings(...)` are the non-mutating preflight APIs used by desktop and hosted runners. Stale IDs, duplicate Button input targets, duplicate output state writes, blank required data keys, missing Chat roles, and a Chat that maps user plus history to the same input are blocking errors. Legacy Button-named APIs remain compatibility aliases or Button-only preflight entry points.

`createUiGraphInteractionController(...)` is the shared mutable runtime for desktop and hosted renderers. It owns UI state, component-scoped errors, per-component loading/progress, abort controllers, graph replacement cleanup, and subscriptions. Its action runner receives only the state mapped to that Button or Chat plus an abort signal and normalized progress reporter; both hosts therefore use the same single-flight, stale-write, cancellation, progress, and error semantics. Each action component is single-flight, while different components may remain active independently. `runningComponentIds` reflects immediate internal execution ownership, while `loadingComponentIds` starts after a 300 ms presentation delay; Button renderers use the latter so fast actions do not flash a disabled/spinner/Abort state, without allowing a second action to begin. Each action claims its declared output state keys when it starts: disjoint patches can complete in any order, but for overlapping keys only the latest-started action may write. Atomic `updateStatePatch(...)` is used when Chat appends a user turn and clears its draft before dispatch; ordinary direct edits continue through `updateState(...)`. A direct edit claims its state key so an older action cannot overwrite newer user input. The lower-level `createUiGraphActionExecutionController(...)` remains the version/ownership primitive inside the interaction controller; renderers must not coordinate it themselves.

Browser-only output interactions live in [`UiGraphBrowserRuntime.ts`](../packages/core/src/model/UiGraphBrowserRuntime.ts). `copyUiGraphText(...)` owns Clipboard API fallback behavior and `downloadUiGraphJsonOutput(...)` owns the rendered JSON download contract. They are exported through the narrow `web-app-runtime` entry point so the generated hosted bundle and React preview execute the same implementation without pulling the full core surface into the browser client.

Project comparison treats UI graph additions, removals, and changed serialized component trees as project-level changes. UI graphs do not create graph-level compare overlays because they are not canvases. Search can index UI graph names, descriptions, and component text/bindings, but selecting a result should open the UI graph editor, not a workflow graph.

### Shared helpers

[`serializationHelpers.ts`](../packages/core/src/utils/serialization/serializationHelpers.ts) consolidates logic shared between V3 and V4 serializers:

- `serializeConnection` / `deserializeConnection` - convert `NodeConnection` to/from the compact string format. Optional visual `bendPoint` metadata is stored inside the existing quoted target-title portion of that string with a private suffix marker. Older Rivet versions ignore that title portion when reading connection endpoints, so they still load the connection normally; if they resave, the visual bend can be dropped without changing graph behavior. The marker must be sanitized out of ordinary target titles before writing so a user-authored node title is not mistaken for bend metadata on read.
- `parseVisualData` / `packVisualDataV3` / `packVisualDataV4` - encode/decode node visual data (position, size, colors). In the app UI, `visualData.color.bg` is the node header color and `visualData.color.border` is the optional resting frame color; Rivet 2 uses `transparent` as the header-only border sentinel so selected/hover/search/diff borders can still be painted dynamically without a permanent custom frame. Older border-only values with the neutral header color are normalized by the app renderer to the new header-only visual mode instead of keeping an unsupported third skin.
- `wrapInYamlEnvelope` / `unwrapYamlEnvelope` - standard YAML version-envelope wrapping with validation

`unwrapYamlEnvelope(...)` accepts either raw YAML text or the parsed envelope
prepared by `serializationInput.ts`. This avoids parsing the same project file
twice on `runGraphInFile(...)` / `loadProjectFromString(...)` paths while keeping
direct version-deserializer calls compatible with raw serialized text. Legacy v1
input remains string-based so old JSON compatibility and fallback errors do not
broaden accidentally. The preparation helper is intentionally internal; public
callers should continue using `detectSerializationVersion(...)`,
`deserializeProject(...)`, and `deserializeGraph(...)`.

Both `serialization_v3.ts` and `serialization_v4.ts` delegate to these shared helpers instead of keeping their own copies.

### Architectural significance

Serialization is not just persistence. It is also the compatibility boundary for:

- old project files
- graph import/export
- app save/load behavior
- Trivet/project attached data handling

Any structural refactor that changes graph/project/node shape must be reviewed together with serialization.

## Recording and Playback

Core includes execution recording support under `recording/` and exports:

- `ExecutionRecorder`
- recorded event types
- replay support used by `GraphProcessor.replayRecording(...)`

The app relies on this for execution replay and recording-driven UX.

Current replay/parity invariants:

- recorded event payloads preserve execution metadata when live execution emitted it
- replay emits metadata-rich graph and node events with the same shape expected by live consumers
- replay now re-emits `partialOutput` and `nodeOutputsCleared` instead of silently dropping them
- legacy recordings without execution metadata still replay through an explicit fallback path that synthesizes stable-enough graph-run identity for compatibility, but only metadata-rich recordings support full graph-view-aware inspection

## Current Refactor Seams

The most meaningful seams in core right now are:

- `GraphProcessor` vs `SplitRunProcessor` vs `NodeExecutionPlanner` vs `SubprocessorBridge`
- `NodeRegistration` vs `RegistryAssembly` vs concrete node/plugin definitions
- `ProcessContext` and `buildNodeProcessContext(...)`
- serialization modules by version, with shared helpers in `serializationHelpers.ts`
- `exports.ts` as the public boundary
- `plugins.ts` plus `model/Nodes.ts` as the two main capability registries
- `emitDetached` as the single fire-and-forget emission pattern
- `pQueueCompat` as the CJS/ESM interop boundary for p-queue

## Known Architectural Tensions

Visible from the current code:

- `GraphProcessor` still carries a very large amount of orchestration logic.
- the runtime mixes execution concerns and editor-facing metadata concerns in the same package.
- plugin and built-in node registration both affect global registry state.
- subprocessor wiring is powerful but increases hidden coupling between parent/child execution.
- control-flow semantics are powerful but non-obvious because they are data-type-driven.

## Practical Refactor Guidance

- Keep `exports.ts` stable unless downstream breakage is intended.
- Treat graph shape, serializer shape, and app save/load behavior as a single change set.
- When changing execution behavior, review `GraphProcessor`, `SplitRunProcessor`, and streaming APIs together.
- When changing node/plugin contracts, review both app editor usage and runtime construction paths.
- Be careful with registry-global behavior; several packages assume built-ins are present and plugins are additive/resettable.

# MCP provider lifecycle

Core exposes the transport-neutral `MCPProvider` contract, including optional
per-server stdio environment values. The Node package owns transport construction
and process/network lifecycle. Its default provider uses one short-lived client per
operation, guarantees cleanup after operation failures, and performs Streamable
HTTP-to-SSE fallback with separate SDK clients. Core nodes must not assume that an
MCP connection is pooled or retain transport-specific client state.

[`MCPBase.ts`](../packages/core/src/integrations/mcp/MCPBase.ts) owns the common behavior for MCP Discovery, Tool Call, and Get Prompt nodes: client/transport editor fragments, transport-specific server editors, compact node-body text, required-provider checks, HTTP `/mcp` validation, STDIO configuration resolution, and interpolation of JSON argument templates from dynamic `input-*` ports. Operation nodes keep only their request shape, response mapping, and intentionally node-specific browser error copy. Preserve the existing editor order by placing the shared client fragment before operation-specific fields and the shared server fragment after them. Do not add a node-local MCP editor or transport resolver; extend this base seam instead.
