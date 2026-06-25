# Refactor Plan: Next Fragility Pass

Status: Planned

This plan replaces the previous completed `refactor.md`. Completed refactor history lives in `refactor-history.md`.

## Context

The previous refactor pass is complete and recorded in `refactor-history.md`. It covered:

- Graph Tree Presentation Model.
- Output Rendering And Fullscreen Modal Pipeline.
- Project Comparison Engine.
- Theme And Color Token Architecture.
- Project Tab And Main Strip Shell.
- Hosted Workspace API Hook.
- Canvas Connection And Port Interactions.
- Node Canvas Command Glue.
- Executor Session Ownership.
- Brittle Source-Contract Tests.

This pass should not rework those freshly stabilized seams unless a concrete bug or risk makes it necessary. The new focus is not broad polish, raw line-count reduction, or cosmetic cleanup. The goal is to reduce fragility in behavior that can break user workflows, wrapper execution, security/privacy, or runtime correctness.

## Refactor Rules

- No functionality changes unless explicitly called out as a bug fix discovered during refactor.
- No project YAML, recording, or hosted-wrapper API shape changes unless a section explicitly says so.
- Add characterization tests before moving fragile behavior.
- Update developer docs for every implementation phase.
- Prefer one small behavior owner over broad component rewrites.
- Do not combine visual polish or new features with these refactors.
- Do not chase line-count reduction if it makes the code denser or less obvious.

## 1. MCP Provider Env, Logging, And Client Lifecycle Safety

### Problem

`packages/node/src/native/NodeMCPProvider.ts` still has security and reliability smells:

- it logs raw server config;
- it repeats open/call/close code;
- it has redundant catch/rethrow blocks;
- stdio transport env handling is not clearly owned;
- close-on-error behavior is easy to miss.

MCP nodes can touch local commands and environment variables, so this is a high-risk surface even though the file is relatively small.

### Refactor Vector

Add a small MCP client lifecycle helper that makes HTTP and stdio behavior explicit, removes config logging, guarantees clients close after successful connection, and keeps any diagnostics redacted.

### Implementation Notes

- Keep MCP node data and project YAML unchanged.
- Keep the public `MCPProvider` interface unchanged unless tests prove a tiny internal type is needed.
- Add helper functions for:
  - creating an HTTP client with streamable HTTP first and SSE fallback second;
  - creating a stdio client;
  - running an operation with guaranteed close;
  - redacting config values for future diagnostics.
- Remove raw `console.log(serverConfig)`.
- Remove redundant `try { ... } catch (err) { throw err; }` blocks.
- If stdio env support is missing in the current config type, document it as a follow-up instead of inventing a schema change in this refactor.

### Tests

- HTTP client falls back from streamable HTTP to SSE.
- Tool calls close clients on success.
- Tool calls close clients on failure after connect.
- Stdio config is not logged.
- Stdio args are passed unchanged.
- No env secrets appear in logs or thrown diagnostics.
- Prompt and tool-list methods still map SDK responses correctly.

### Risks

- Breaking MCP discovery.
- Breaking stdio server startup.
- Accidentally changing error messages users rely on.
- Overcorrecting env behavior without schema support.

### Completion Criteria

- No raw MCP server config logging remains.
- Lifecycle helper owns close-on-error behavior.
- Tests cover HTTP and stdio lifecycle.
- Developer docs document MCP env/logging safety.

## 2. LLM Chat V2 Request Plan And Provider Capability Contract

### Problem

Recent issues around custom providers, streaming, retries, response schemas, strict JSON, Groq/OpenAI-compatible behavior, and tool use show request construction is fragile.

Request options are spread across runtime options, provider options, response-format helpers, AI SDK bridge code, retry handling, and output assembly. Legacy Chat should not receive major investment; the risk is in the Vercel SDK-powered `LLM Chat`.

### Refactor Vector

Introduce a single request-plan layer for `LLM Chat V2`. The request plan should be a plain object describing what will be sent to the AI SDK before the call happens. It should make streaming, retries, schema mode, strictness, tool behavior, provider compatibility, and unsupported settings visible and testable.

### Implementation Notes

- Add a builder such as `buildChatV2RequestPlan(...)`.
- The plan should include:
  - provider kind;
  - model id;
  - stream enabled or disabled;
  - max retries;
  - response format mode;
  - whether structured outputs are enabled;
  - tool-call mode;
  - provider warnings or compatibility notes;
  - final AI SDK call kind.
- `chatV2Pipeline` should consume the plan rather than rebuilding decisions inline.
- Existing node settings and output fields must stay unchanged.
- Existing API request bodies should remain behaviorally equivalent unless tests expose a current bug.
- Legacy Chat remains compatibility-only and should not be redesigned as part of this work.

### Tests

- Custom provider without streaming does not stream.
- Tool use without streaming returns the expected final output.
- Retry count is exactly controlled by Rivet settings.
- JSON Schema response format maps consistently for supported and unsupported provider modes.
- `strict: true` behavior remains where currently intended.
- Unsupported provider settings are warned or omitted consistently.
- Existing LLM Chat output fields remain stable.

### Risks

- Accidentally changing request payloads.
- Breaking provider-specific behavior.
- Masking AI SDK warnings that users need.
- Changing tool-call continuation behavior.

### Completion Criteria

- One request-plan test suite can explain what the node will send without live API calls.
- The Vercel SDK-powered `LLM Chat` path is easier to audit.
- Legacy Chat is untouched except compatibility guards if needed.
- Developer docs update the LLM Chat V2 contract.

## 3. Execution Event Routing And Snapshot Reconciliation

### Problem

Browser, Node, and Remote Debugger execution now work per project tab, but ownership spans many hooks and helpers. Recent bugs showed that project tabs could steal executor state from each other, stale run events could update the wrong project, and remote debugger sessions could disconnect unexpectedly.

The current system works, but remains fragile because routing rules are spread out.

### Refactor Vector

Centralize event acceptance and snapshot reconciliation. Create one small policy owner that decides whether an incoming execution event belongs to the current project, run, and session. Browser, Node, and Remote Debugger paths should all use the same acceptance policy.

### Implementation Notes

- Candidate owner names:
  - `executionEventRouting.ts`
  - `executionSnapshotRouting.ts`
- Inputs should include:
  - project id;
  - selected/open project id;
  - executor mode;
  - rootRunId;
  - graphRunId;
  - remote debugger request id;
  - sidecar/browser session id if available.
- Outputs should be explicit:
  - accept event;
  - ignore stale event;
  - terminate stale run;
  - update selected snapshot;
  - preserve hidden tab snapshot.
- Do not change executor mode persistence.
- Do not change hosted-wrapper APIs.
- Do not change recording playback behavior.

### Tests

- Browser executor events from project A do not update project B.
- Node executor events from project A do not update project B.
- Remote Debugger events from project A do not update project B.
- Hidden tab execution continues to update its own snapshot.
- Abort events only affect their owning run.
- Loaded recording playback is not treated as live execution.
- Subgraph execution selectors remain available after graph navigation.

### Risks

- Dropping valid late terminal events.
- Breaking run history in hidden tabs.
- Reintroducing remote debugger single-session behavior.
- Losing abort completion events.

### Completion Criteria

- Every executor path calls the same routing policy.
- Tests cover cross-tab Browser, Node, and Remote Debugger events.
- Developer docs explain project-scoped executor ownership and event routing.

## 4. Canvas Wire/Port Geometry And Interaction Model

### Problem

Wire hover, connection mode, bend handles, port rearranging, conditional labels, port labels, and wire hit testing are visually sensitive. This logic is split across canvas components and interaction helpers.

Small changes can break dragging, canvas panning, connecting distant nodes, or port-label layout.

### Refactor Vector

Extract pure geometry and interaction state models. Keep React components as renderers and event dispatchers. Move hit zones, label placement, bend handle placement, connection-mode transitions, and hover decisions into tested pure helpers.

### Implementation Notes

- Candidate owners:
  - `wireGeometry.ts`
  - `portLabelGeometry.ts`
  - `connectionInteractionState.ts`
- Keep project YAML unchanged.
- Keep existing bend-point data shape unchanged.
- Keep existing context menu and drag behavior unchanged.
- Prefer unit tests with explicit coordinates over DOM/source tests.
- Avoid changing visual constants unless required to preserve current behavior.

### Tests

- Hovering a connection highlights the connection.
- Hovering a connected port highlights its connection.
- Ghost bend handle appears at the expected point.
- Double-clicking a bend handle removes it.
- Connection mode survives canvas pan/zoom.
- Right-click does not remove an existing connection.
- Conditional `if` label placement is stable connected and unconnected.
- Variadic port rearranging preserves connections correctly.

### Risks

- Tiny visual shifts.
- Broken wire creation.
- Broken bend handles.
- Regressed canvas panning while connecting.
- Port label overlap.

### Completion Criteria

- Wire and port geometry decisions are testable without rendering the whole canvas.
- Components become thinner.
- Existing manual canvas behavior remains unchanged.
- Developer docs describe the geometry and interaction ownership boundary.

## 5. GraphProcessor Runtime State And Lifecycle Ownership

### Problem

`packages/core/src/model/GraphProcessor.ts` remains the largest and riskiest runtime file. It still owns run state, lifecycle events, abort behavior, subprocessor wiring, frozen outputs, globals, terminal events, node timing, and scheduling adjacency.

This makes subtle runtime regressions likely when changing subgraphs, debugger behavior, aborts, recordings, frozen outputs, or graph execution speed.

### Refactor Vector

Extract one narrow runtime owner at a time. Start with lifecycle and run-state bookkeeping, not scheduling. The first extraction should own pure bookkeeping decisions and helper methods, not event dispatch order.

### Implementation Notes

- Candidate owner names:
  - `GraphRunLifecycle`
  - `NodeRunLifecycle`
  - `GraphProcessorRunState`
- Keep public `GraphProcessor` API unchanged.
- Preserve exact lifecycle event order.
- Preserve all execution metadata fields.
- Keep event emission in the processor until tests prove an event-dispatcher extraction is safe.
- Move only pure logic or state transitions with no side effects first.
- Document what remains intentionally in `GraphProcessor`.

### Tests

- Normal node start/finish order.
- Node error terminal order.
- Node exclusion terminal order.
- Graph start/finish order.
- Subgraph `graphRunId` and `parentGraphRunId`.
- Abort success and abort failure.
- Recording replay compatibility.
- Frozen-output replay terminal events.

### Risks

- Event ordering regressions.
- Incorrect graphRunId or processId propagation.
- Subgraph or recording history drift.
- Abort behavior changing subtly.

### Completion Criteria

- `GraphProcessor.ts` loses one meaningful responsibility.
- New owner has focused tests.
- Existing public runtime behavior is unchanged.
- Developer docs explain the new runtime owner boundary.

## Cross-Cutting Verification

For every item:

- Add characterization tests before moving fragile code.
- Update developer docs in the same change.
- Run focused tests for the touched package.
- Run `git diff --check`.

For app-facing changes:

- Run `yarn workspace @valerypopoff/rivet-app run build`.
- Run focused app tests for affected helpers.

For core/runtime changes:

- Run focused core tests first.
- Run `yarn workspace @valerypopoff/rivet2-core test` when runtime behavior is touched.

For Node/package changes:

- Run focused Node package tests.
- Run Node package typecheck/build if package exports or runtime APIs are touched.

## Suggested Order

1. MCP Provider Env, Logging, And Client Lifecycle Safety.
2. LLM Chat V2 Request Plan And Provider Capability Contract.
3. Execution Event Routing And Snapshot Reconciliation.
4. Canvas Wire/Port Geometry And Interaction Model.
5. GraphProcessor Runtime State And Lifecycle Ownership.

This order starts with the smallest high-value safety cleanup, then moves through provider correctness and executor-session risk before touching broad visual interaction and core runtime machinery. `GraphProcessor` is the most important area, but it is also the easiest place to cause subtle regressions, so it should be handled after the team is back in careful-runtime mode.

## Assumptions

- The goal is reducing fragility, not reducing LOC.
- No behavior changes should be introduced intentionally.
- The previous completed refactor plan should stay only in `refactor-history.md`.
- This new `refactor.md` is an active plan, not a completed-history record.
