# Building Complex Rivet Projects With An AI Agent

This guide is for a coding AI agent that has been asked to create or modify a
real `.rivet-project` file. It is also useful to the person writing that task.

This is not the implementation contract for Rivet's in-app Graph Builder. That
system works through a transactional authoring model described in
[Transactional Graph Builder Domain](./GRAPH-BUILDER-DOMAIN.md). In particular,
its revisioned virtual per-graph `NodeGraph` YAML is full-fidelity for the graph
being edited, but it is not the persisted `.rivet-project` format and must not
be written to disk as one.

The golden rule is:

> Make the smallest coherent semantic change that satisfies the request,
> preserve everything outside that boundary, and verify the result through the
> real invocation path.

## 1. Establish The Ownership Boundary

Before designing nodes, identify where the requested behavior actually belongs.

Record:

- the exact project path and the Rivet checkout/version that will open it;
- the exact target graph or graphs;
- the project's Main Graph and any graph invoked by a web app, API endpoint,
  Subgraph node, Call Graph node, or delegated tool;
- the runtime surfaces involved: Browser, internal Node, external Remote
  Debugger, detached preview, published web app, CLI, or a programmatic host;
- whether the behavior is owned by the project, a reusable node, the graph
  runtime, a plugin/provider, or the host application.

Two ownership seams deserve explicit checks:

- A Node Library instance does not own most of its effective behavior. Decide
  whether the requested change belongs in the reusable library source, where it
  affects every linked instance, or only in this graph. Detach the instance
  before making a one-off behavioral change.
- When LLM Chat uses **From profile**, provider, model, credentials,
  provider-specific reasoning configuration, and generation parameters are
  owned by the connected LLM Profile. Do not edit inactive inline fields and
  assume they affect execution. Chat-owned outputs and behavior remain on LLM
  Chat.

Do not hide a platform defect inside one workflow. Conversely, do not turn a
project-only request into an unrelated platform refactor. If the task requires
both, keep the project migration and the platform change separately testable.

## 2. Treat The Project As Both Program And Diagram

A Rivet project is executable data, but it is also an authored visual artifact.
Its names, grouping, placement, and mocks communicate intent to the workflow
designer.

Unless the task explicitly says otherwise, preserve:

- graph IDs, names, folders, descriptions, and the Main Graph selection;
- node IDs, titles, descriptions, colors, positions, widths, and grouping;
- existing inputs, outputs, and their IDs and data types;
- mock/default input providers;
- disabled, conditional, split-run, and other execution settings;
- unrelated nodes, connections, graphs, web apps, Knowledge Stores, plugins,
  Node Library entries, project references, and attached data;
- serialized credential values and credential lookup policy, without printing
  them or placing them in an AI prompt.

Some credentials are app-local, environment-provided, or supplied by a
programmatic host and therefore do not exist in the `.rivet-project` file. A
project-editing agent cannot inventory or preserve those values; it must
preserve the lookup contract and document the host requirement instead.

Do not rebuild a graph merely because rebuilding is easier for the agent. If the
designer has just rearranged or renamed parts of it, assume those changes are
deliberate. Programmatic validity does not compensate for destroying a readable
canvas.

## 3. Inventory Before Mutation

Deserialize the current file through Rivet core. Separately assemble a node
registry containing current built-ins and the required installed plugins before
resolving effective nodes, deriving dynamic ports, validating connections, or
executing a graph. Deserialization alone does not prove that a node definition
is available. Do not infer the graph from a partial YAML search.

Create a compact inventory containing:

- graph IDs, names, node counts, callers, and public inputs/outputs;
- node IDs, types, titles, relevant configuration, and execution flags;
- connections using node IDs and port IDs rather than visible labels;
- dynamic ports derived from node configuration;
- subgraph, tool-handler, web-app, and project-reference dependencies;
- declared plugins, Knowledge Stores, stored-value requirements, and runtime
  credential lookup requirements, without assuming host-only values are visible;
- linked Node Library instances and their effective source nodes;
- saved node variants, which may contain alternate complete node data;
- Evaluation suites and their evaluator-graph dependencies, when an exported evaluation bundle is explicitly in scope;
- mocks and default-value connections;
- all branches that can produce a public output or a user-visible side effect.

Node titles are not stable identifiers and are not guaranteed to be unique.
They are useful for initial discovery, but a mutation script should assert
uniqueness within the selected graph and then operate on IDs. A connection to a
node also does not prove that the node will run: conditional exclusion, missing
required inputs, async boundaries, tool-continuation scheduling, and
unreachable entry points all affect execution.

Treat a linked Node Library instance as a reference, not as an ordinary node
whose local `data` owns its behavior. Resolve it through the current prefab
resolver. Edit the source only when every instance should change; otherwise
detach it while preserving its ID and graph-local geometry. If source ports
change, audit and repair every linked connection.

Plugin requirements are derived from actual plugin-owned node use across both
graphs and Node Library sources, plus plugin-owned Knowledge Stores. When
adding or removing such nodes, update project plugin declarations with the same
usage semantics as `packages/app/src/utils/pluginUsage.ts`. Preserve existing
specifications when unresolved node or provider definitions prevent a safe
reconstruction; never guess a missing plugin's fields or ports.

For quick read-only inspection, the CLI commands documented under
[`list`](../packages/docs/docs/cli/list.md),
[`inspect`](../packages/docs/docs/cli/list.md), and
[`doctor`](../packages/docs/docs/cli/doctor.md) are useful starting points. They
do not replace graph-specific runtime validation.

## 4. Define Contracts Before Nodes

Write down the contract of every graph or meaningful stage before editing it.

For each input and output, record:

- ID and data type;
- whether it is required;
- what missing, `undefined`, `null`, and empty values mean;
- a representative value;
- whether editor mocks provide a default;
- whether the value is trusted, private, or safe to expose to an LLM;
- which downstream consumers rely on it.

Also record:

- failure behavior;
- retry and idempotency expectations;
- persistence behavior across runs;
- ordering and concurrency requirements;
- what constitutes complete success rather than partial success.

Important defaults:

- Derive IDs, counts, indices, titles, fingerprints, flags, and other
  deterministic facts algorithmically. Do not spend model tokens regenerating
  known data.
- Coalesce only values with the same semantic type. Do not mix a valid result,
  an error string, and a planning object merely because all three can travel
  through an `any` port.
- Throw only for a genuine execution failure. Expected absence, such as "not
  initialized yet," should normally be represented as data or explicit control
  flow.
- Keep public graph inputs and outputs stable unless all callers are deliberately
  migrated in the same change.
- Treat mocks as editor defaults, not as hidden production fallbacks. Graph
  Input treats a `null` or `undefined` supplied value as absent and may fall
  through to its connected or static default. Test a non-null explicit input,
  `null`, a missing input, and an editor-default run as distinct cases.

Changing a public graph input or output requires more than updating its node.
Audit direct Subgraph connections, defaults, and port ordering; Graph Reference
or Call Graph object keys; web-app Chat and Button bindings; and name-based Main
Graph or tool-handler entry points. External file mutation bypasses editor-side
rename propagation and UI-graph binding reconciliation.

Mocks should be small enough to understand, representative enough to exercise
the graph, and free of reusable production secrets. Preserve user-supplied mock
nodes unless the task explicitly changes their contract. When an input changes,
update its mock deliberately and test both the default editor run and a run with
an explicit external value.

## 5. Choose A Graph Architecture That Explains Itself

Use stages whose names truthfully describe their responsibility. A graph named
`Index source` should not also generate an overview and persist browser state.

Good structural defaults:

- Split reusable, independently testable, or separately owned operations into
  subgraphs.
- Keep subgraph interfaces smaller and more stable than their internals.
- Run genuinely independent work in parallel and join it only where the results
  are assembled.
- Use conditional execution for gating and Coalesce for same-type fallback
  selection; do not blur those roles. Coalesce returns the first input that was
  not `Not Ran` or excluded by control flow, optionally skipping `null` or
  `undefined`. It does not order execution, prefer successful work, or suppress
  a real upstream error.
- Use `Start Async Branch` only for side-effect-only work. An async branch must
  not contain a Graph Output or become a hidden prerequisite of the main result.
- Use a Data Bus for a distant high-fanout value, not as a join, scheduler,
  cache, state store, or event trigger. Each channel is independent and permits
  at most one provider with any number of consumers. A channel without a
  provider creates no dependency. Duplicate providers and relay cycles are
  invalid. A Data Bus is topology-only: do not make it conditional, disabled,
  split-run, frozen, or a direct run target.
- Prefer direct connections for local data flow.
- Add wrapper graphs only when the wrapper owns real behavior such as progress,
  retry, persistence, or error conversion.

See [Canvas Interactions](./CANVAS-INTERACTIONS.md) for current connection and
Data Bus contracts, and [Execution Data Flow](./EXECUTION-DATA-FLOW.md) for
nested and observable execution behavior.

## 6. Use The Simplest Suitable Node

Prefer declarative, editor-readable nodes when possible:

- Text nodes for mostly static prompts with `{{interpolation}}` inputs;
- Object nodes for static schemas or templates with interpolated values;
- Expression nodes for small calculations;
- Code nodes for real transformations, dynamic batching, dynamic schemas, or
  logic that would otherwise become less readable;
- Subgraphs for reusable operations and meaningful stage boundaries.

A large Code node is sometimes appropriate, but it should have a narrow input
and output contract. Avoid combining projection, validation, provider request
construction, response normalization, persistence, and final assembly in one
opaque block.

When adding a node programmatically, create it through the current node registry
when practical so that it receives current defaults. Registry-aware node
creation and port derivation are separate from project deserialization. Plugin
nodes require their installed plugin definitions, and some dynamic definitions
also require graph or project context. If the applicable definition is not
available, do not guess fields or ports. Configure the node first, query its
actual dynamic ports in context, and only then create connections. Do not assume
that an old project's port layout is current.

## 7. Treat Every LLM Boundary As A Privacy And Cost Boundary

Before every model call, construct an explicit allowlisted projection. Never
pass a large source object and rely on a prompt that says to ignore forbidden
fields. Data the model must not know must not be in the request.

Useful rules:

- Put trusted instructions in the system/developer instruction and delimit
  untrusted user, book, story, or retrieved content clearly. Delimiters improve
  instruction clarity but are not a security boundary; the allowlisted
  projection is the privacy and access boundary.
- Treat prompt-like text inside source data as data, not instructions.
- Pass the actual identity the model acts for. For example, if a simulated
  player controls one protagonist, put that protagonist's real name in the
  instruction and in the structured context contract.
- Prefer a compact, human-readable transcript over verbose JSON when later
  nodes do not need to parse each message.
- Omit internal IDs unless the model needs them to produce a machine-readable
  mapping.
- Split broad analysis into narrower stages when later stages benefit from
  earlier results.
- Batch repetitive work at a size the provider can reliably complete.
- Parallelize LLM stages only when neither needs the other's output.
- Keep complete model-produced data in later history when later turns must
  inspect or repair it; optimize deliberately rather than silently removing
  context.

### Plain Text Versus Structured Output

Use plain-text response mode when the public result is exactly one string and no
machine parsing is needed. Connect that response directly to a string output
instead of adding an object schema and a one-line normalizer.

Use a rigid response schema when completeness or downstream parsing matters.
For exhaustive item sets, a dynamically generated object with one required,
stable property per expected item can be safer than an unconstrained array when
the batch is bounded. Keep the mapping between each schema property and its
source identity explicit. A rigid schema cannot defeat an output-token limit;
one enormous exhaustive schema can reproduce the reliability problem it was
intended to solve.

JSON Schema support varies by provider and model. Use only the subset verified
for the configured provider. A schema that is valid in the abstract can still be
rejected by a provider; keywords such as `uniqueItems` have caused real
compatibility failures. Preserve the provider's original error message so the
workflow designer can diagnose the request. At the project layer, do not catch
and replace a detailed LLM-node failure with a generic error unless the original
diagnostic remains available.

Do not trust the visible prompt nodes alone. Capture and inspect the actual
provider request after interpolation, profile resolution, message assembly, and
context projection. The current LLM runtime contract is documented in
[LLM Chat V2 Contract](./LLM-CHAT-V2-CONTRACT.md).

### Tool-using agents

Tool graphs have runtime relationships that are not always obvious from ordinary
left-to-right wiring.

- Keep the Tool node's name, argument schema, handler graph inputs, and handler
  result contract aligned.
- In Auto Delegate mode, runtime first looks for an exact graph-name/tool-name
  match and retains a legacy substring fallback. Use exact matching and do not
  rely on that compatibility fallback. Do not rename one side without migrating
  the other.
- A single model round may request several tools. In the connected
  auto-continuation path, Delegate Tool Call receives one scalar call per
  invocation, those invocations may run concurrently, and the LLM continuation
  joins results in the model's original call order.
- `Maximum tool rounds` counts model responses containing tool-call batches,
  not individual tool calls. One round may contain multiple calls.
- Delegate's Message output fires per delegated invocation. If one model message
  contains three tool calls, an attached status branch can receive that same
  assistant message three times unless the workflow deliberately deduplicates
  it.
- A direct-return tool bypasses the follow-up model request only under its
  documented single-call conditions. Mixed or multiple calls use normal
  continuation.
- A tool graph can be reachable through Tool and Delegate configuration even
  when it is not reached by ordinary downstream traversal. Include these graphs
  in inventory and validation.

See [Unreachable Graph Detection](./UNREACHABLE-GRAPH-DETECTION.md) for the
configuration-aware reachability rules around Tool and Delegate nodes.

## 8. Make Stateful And Multi-System Workflows Honest

Persistence and external systems create partial-success states that must be
represented explicitly.

- A cache miss must rebuild safely; it must not break the graph merely because
  a browser changed or local storage was cleared.
- Ordinary top-level editor and headless runs receive fresh run-local Stored
  Value memory. Nested subgraphs and delegated tools share the root run's store.
  Web-app actions use browser-local persistence when no host store is supplied;
  a host-provided store overrides browser persistence. Headless deployments
  need an explicit persistence and tenancy policy for cross-run state.
- Indexing source data and generating an AI overview are separate outcomes.
  Do not report full initialization success if only one completed.
- Commit/version markers only after the data they promise is actually ready.
- Repeated initialization should be idempotent or versioned. Never blindly
  duplicate expensive external writes.
- Provider callbacks own cross-request concurrency, authorization, and
  namespacing unless the project explicitly does.

For provider-neutral retrieval, versioning, and Knowledge Store responsibilities,
see [Provider-neutral Knowledge Source API](./KNOWLEDGE-SOURCE-API.md). For
published web-app and host behavior, see
[Hosted And Web App Contracts](./HOSTED-WEB-APP-CONTRACTS.md).

## 9. Preserve Visual Legibility

Layout is part of the deliverable.

- Keep the overall flow left to right.
- Group meaningful stages and place independent parallel branches vertically.
- Keep configuration and mock inputs near the boundary where they enter.
- Put normalization immediately after the operation it normalizes.
- Put final assembly and public outputs at the right edge.
- Name nodes after the operation or result, not after an accidental
  implementation detail.
- Avoid long crossing wires; use a Data Bus only when it genuinely improves the
  graph.
- Do not rename, recolor, or rearrange existing work unless requested.

After a programmatic edit, open the project in Rivet and navigate through every
changed graph. A successful serialization round trip does not prove that node
bodies render, ports are ordered correctly, labels fit, or the canvas remains
understandable.

## 10. Mutate The Real Project Safely

Do not use regex replacement as the primary project-editing mechanism. It is too
easy to match a similarly titled node in another graph, corrupt YAML quoting, or
lose attached data.

Preferred workflow:

1. Read and hash the original file. Create a backup when replacement is not
   trivially reversible; a hash detects change but is not a backup.
2. Deserialize it with the current core serializer, retaining the returned
   `attachedData`.
3. Before mutation, serialize and deserialize an untouched round-trip baseline.
   Current deserialization and serialization can normalize legacy project data,
   so inspect and record any migration-only raw-file diff.
4. Locate the exact graph and assert expected ownership seams.
5. Apply a minimal in-memory mutation to a clone of the normalized baseline,
   using stable IDs and the current registry.
6. Preserve `attachedData`, node variants, tests, comments, UI graphs, and other
   project-level data unless the task deliberately changes them. Editing a
   node's base `data` does not edit its saved variants.
7. Serialize to a candidate artifact and deserialize the candidate again.
8. Compare the candidate semantically against the untouched normalized
   baseline so intentional changes are isolated from serializer migrations.
9. Separately compare exact designer-owned data, including geometry, comments,
   UI graphs, and `attachedData`. `compareProjects(...)` intentionally ignores
   node geometry and z-order, comment nodes, and Subgraph per-instance port
   order, so it cannot prove visual preservation.
10. Run structural validation, registry-aware port and dependency checks, and
    execute the candidate before replacing the requested file.
11. Recheck the original hash to detect a stale source, replace the target once,
    and verify its hash matches the validated candidate.
12. Remove temporary scripts, inspection files, and generated artifacts.

If the untouched round trip changes the project, either avoid replacing the
file through that serializer path or disclose and deliberately accept the
migration. Never present migration-only churn as part of the requested graph
change.

Serialization ownership and compatibility rules live in
[Core Engine: Serialization](./CORE-ENGINE.md#serialization).

If a project lies outside the writable workspace, build the candidate inside
the workspace and request permission for the final copy. Recheck that the source
has not changed while the candidate was being prepared.

## 11. Verification Ladder

A complex project is not complete merely because it parses.

### Level 1: Structural validity

- Deserialize using the current core.
- Run `validateProject(...)` for project-shape validation. It is structural; it
  does not prove port validity, reachability, plugin availability, or
  schedulability.
- Separately run registry-aware node and port checks, dependency and
  configuration-aware reachability checks, and any available graph lints.
- Serialize and deserialize again.
- Confirm every connection refers to an existing node and current port.
- Confirm public graph input/output IDs and types.
- Confirm required plugins, Knowledge Stores, and referenced projects exist.

### Level 2: Deterministic stages

- Execute changed expressions, Code nodes, and subgraphs with representative
  values.
- Test empty, missing, `null`, malformed, repeated, and unchanged inputs where
  those states are meaningful.
- Verify batches cover every source item exactly once.
- Verify parallel branches join in the intended order.

### Level 3: LLM request and response

Use a fake provider whenever possible:

- capture the exact provider request;
- assert required dynamic values are present;
- assert forbidden/private fields are absent;
- return deterministic model output;
- exercise response parsing, normalization, and final assembly;
- confirm retries, fallback, tool rounds, and cancellation where relevant.

If no injected or local fake provider is available, temporarily expose and
inspect LLM Chat's `Messages Sent` and `LLM request body` diagnostics, then
restore the original node settings. Do not claim provider-request coverage from
prompt-node text alone.

Never print secrets, authorization headers, or full credential-bearing nodes
while inspecting a project.

### Level 4: Real invocation path

Run each invocation surface that is actually in scope, not only the deepest
subgraph. Depending on the project, that may include:

- Main Graph;
- delegated tool from its LLM round;
- web-app Chat or Button action;
- published HTTP/WebSocket action;
- CLI or programmatic headless call.

Check the final graph outputs and user-visible error/status behavior. Explicit
workflow-authored progress may update a web app; domain nodes should not publish
implicit status messages.

### Level 5: Editor and deployment parity

- Open and navigate the changed project in the desktop editor.
- Compare Browser and Node execution when both are supported.
- Verify detached/published web apps when they are in scope.
- Verify environment variables, plugin registration, persistence callbacks, and
  credentials in the actual headless host.

Use [Build And CI](./BUILD-AND-CI.md) for repository-wide checks after platform
changes. For a project-only external artifact, run the narrow structural and
runtime checks that exercise the changed path.

## 12. Common Failure Patterns

| Failure                                              | Why it is dangerous                              | Better approach                                         |
| ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Editing nodes by title alone                         | Titles can repeat or change                      | Discover by title, assert uniqueness, then mutate by ID |
| Editing a linked library instance like a normal node | Effective behavior belongs to its prefab source  | Edit the source intentionally or detach the instance    |
| Rebuilding the whole graph                           | Destroys layout and unrelated user work          | Patch only the owning stage                             |
| Hand-editing large YAML regions                      | Can corrupt quoting, IDs, or attached data       | Deserialize, mutate, serialize, round-trip              |
| Skipping an untouched serializer round trip          | Migration churn looks like requested work        | Diff against a normalized untouched baseline            |
| Assuming a connection means execution                | Conditions and missing inputs can exclude it     | Trace control flow and run the real path                |
| Mixing unrelated values in Coalesce                  | Obscures fallback logic and types                | Coalesce one semantic type only                         |
| Throwing for an expected state                       | Fails a tool or graph instead of reporting state | Return explicit data/control flow                       |
| One oversized LLM request                            | Encourages skipped items and weak detail         | Split stages and batch repetitive work                  |
| Asking the model for deterministic facts             | Wastes tokens and introduces errors              | Calculate or copy them algorithmically                  |
| Passing full source objects to an LLM                | Leaks hidden data and wastes context             | Build an allowlisted projection                         |
| Assuming all JSON Schema is supported                | Providers implement different subsets            | Test the exact provider request/schema                  |
| Treating Data Bus as a relay node                    | Invents false waiting or ordering semantics      | Treat every channel as independent topology             |
| Letting mocks become production fallbacks            | Produces plausible but wrong results             | Verify runtime inputs override defaults                 |
| Testing only a leaf subgraph                         | Misses caller gating and output assembly         | Execute the real Main/tool/web-app path                 |
| Declaring success after a partial initialization     | Leaves external state inconsistent               | Model each outcome and commit readiness last            |
| Logging complete project nodes                       | Can expose embedded secrets                      | Inspect redacted, targeted fields only                  |

## 13. Recommended Agent Work Loop

Use this sequence for every non-trivial project task:

1. **Discover**: identify the exact file, graph, callers, runtime, and ownership
   boundary.
2. **Inventory**: capture the current semantic and visual structure without
   mutating it.
3. **Specify**: translate the request into input/output, privacy, failure,
   persistence, and concurrency contracts.
4. **Plan**: choose the smallest coherent set of graph changes.
5. **Build**: edit through current node and serialization APIs while preserving
   designer-owned work.
6. **Verify**: climb the verification ladder, including the actual provider
   request and real invocation path.
7. **Reassess**: inspect adjacent seams that could fail for the same root cause;
   fix only confirmed problems.
8. **Handoff**: report changed graphs/nodes, preserved elements, assumptions,
   checks, and remaining limitations.

## 14. Task Brief Checklist For Humans

An AI agent can work much more safely when the task includes:

- exact project path and target graph name;
- representative inputs and expected outputs;
- which runtime/executor will run it;
- current provider/model constraints;
- which names, colors, folders, layout, mocks, and public contracts must remain;
- whether unrelated cleanup is allowed;
- expected failure and retry behavior;
- persistence and headless deployment expectations;
- whether the agent may modify platform code as well as the project.

When something is genuinely ambiguous and would change the public contract or
privacy boundary, the agent should ask. For safe internal details, it should
state a conservative assumption and continue.

## 15. Definition Of Done

- [ ] Exact scope, owner, entry points, and runtimes were identified.
- [ ] The original project was hashed, and backed up when replacement was not
      trivially reversible.
- [ ] Untouched serializer migrations were identified separately from intended
      edits.
- [ ] Existing IDs, public contracts, mocks, and unrelated visual work remain.
- [ ] New graph and subgraph responsibilities are truthfully named.
- [ ] Coalesce, conditions, parallel work, and async work have distinct roles.
- [ ] Deterministic facts are not model-generated.
- [ ] Every LLM request uses an explicit privacy allowlist.
- [ ] Dynamic identities and required items appear in the actual provider
      request.
- [ ] Response schemas are supported by the configured provider.
- [ ] Structural, registry-aware port, dependency/reachability, and
      serialization round-trip checks passed.
- [ ] Changed deterministic stages were executed with representative inputs.
- [ ] The actual Main/tool/web-app/headless invocation path was exercised.
- [ ] Failure, empty, repeated-run, and partial-success paths were considered.
- [ ] The project was opened and visually inspected in Rivet when possible.
- [ ] The final target matches the validated candidate.
- [ ] Temporary artifacts were removed and assumptions were documented.

## Related Documents

- [Developer Docs Overview](./OVERVIEW.md)
- [Core Engine](./CORE-ENGINE.md)
- [Execution Data Flow](./EXECUTION-DATA-FLOW.md)
- [Canvas Interactions](./CANVAS-INTERACTIONS.md)
- [LLM Chat V2 Contract](./LLM-CHAT-V2-CONTRACT.md)
- [Hosted And Web App Contracts](./HOSTED-WEB-APP-CONTRACTS.md)
- [Provider-neutral Knowledge Source API](./KNOWLEDGE-SOURCE-API.md)
- [Plugin System](./PLUGIN-SYSTEM.md)
- [Unreachable Graph Detection](./UNREACHABLE-GRAPH-DETECTION.md)
- [Transactional Graph Builder Domain](./GRAPH-BUILDER-DOMAIN.md)
- [Graph Builder Redesign Report](../graph-builder-process.md)
