# LLM Runtime Refactor Plan

## Purpose

Rivet's LLM capability has grown quickly: LLM Chat, detachable LLM Profiles,
ordered profile fallback, provider retries, JSON-schema validation, Tool nodes,
direct tool responses, connected Delegate Tool Call execution, asynchronous
tool branches, response inspection, Run Activity, recording, and legacy editor
caching. The feature set is valuable, but several concepts now have more than
one implementation owner.

This plan makes the LLM subsystem easier to reason about without changing its
supported graph behavior, serialized project formats, port identities, or
provider integrations. Corrections to confirmed safety and correctness defects
are explicitly called out rather than being hidden inside refactoring work.

The phrase "does not change functionality" means that documented successful
behavior and compatibility remain stable. A behavior which violates an existing
contract, corrupts execution state, leaks reserved inputs, replays stale side
effects, or misclassifies cancellation is treated as a defect. Every such change
must be isolated, characterized, and recorded separately from structural code
movement.

## Implementation Status (2026-08-03)

**Completed:** the behavior-preserving runtime refactor in Phases 0–8 is now
implemented. LLM Chat keeps its serialized node types, port identities,
provider integrations, profile fallback semantics, Delegate scheduling, and
editor-cache compatibility surface. The completed ownership boundaries are:

- a declarative profile-field registry, invocation plan, resolved candidate
  resolver, and closed provider-capability registry;
- an invocation journal plus final output projection, a terminal-response
  materializer, and an invocation/tool-round coordinator;
- canonical tool declaration/codec/handler-resolution helpers and a common
  ordered tool-round executor;
- a `ConnectedToolContinuationHost` which holds continuation-local lifecycle
  state outside `GraphProcessor`; and
- explicit legacy-cache and serialized-node migration boundaries, with an
  import guard preventing `GraphProcessor` from reacquiring LLM policy.

The plan's suggested single mega compatibility harness was deliberately not
introduced: its listed cases already belong to focused pipeline, profile,
tool-continuation, GraphProcessor, cache, materializer, and journal suites.
Keeping those owner-level tests avoids an opaque second test runtime while still
pinning every confirmed defect. The **Prominent UX improvements** section is a
separate post-refactor product backlog, as this document already describes; it
is not an unfinished prerequisite for the behavior-preserving runtime work.

## Current Architecture

```text
LLM Profile
  -> resolves provider/model/credential/settings into llm-config or llm-config[]

LLM Chat
  -> resolves inline or profile-backed runtime configuration
  -> optional legacy editor-cache lookup
  -> provider request pipeline
       -> same-profile retry on eligible non-200 failures
       -> profile fallback when an ordered profile chain is supplied
  -> optional tool-continuation loop
       -> hidden internal delegation, or connected Delegate Tool Call
       -> parallel scalar tool runs, ordered join, next model round
  -> assembles outputs, profile diagnostics, usage/cost, cache result

GraphProcessor
  -> supplies the connected-Delegate host: process IDs, scheduler branches,
     child processors, lifecycle events, cancellation, costs, replay, and
     result commits.
```

The current design has several strong boundaries worth retaining:

- Provider request construction, output assembly, error normalization, and
  response formatting are already separate modules.
- Same-profile retries and profile fallback are distinct policies.
- A successful profile is sticky across later tool rounds and fallback is
  forward-only.
- Connected Delegate calls get genuine scalar node runs and execute handlers in
  parallel while returning results in model order.
- Tool continuation planning/coordinating has already been extracted from the
  general scheduler.
- Provider failures are normalized and profile-chain errors redact known
  credentials and header values.
- Focused LLM, profile, tool-continuation, and GraphProcessor tests already
  provide a substantial characterization base.

## Problems To Correct Before or During the Refactor

These are behavior defects or high-confidence correctness gaps. Their fixes are
not intended to change supported semantics; they enforce the semantics Rivet
already claims to provide.

### Unsafe tool argument input construction

The tool-delegation implementation creates a normal object with Rivet-owned
`_function_name` and `_arguments` inputs, then copies arbitrary model-produced
argument keys onto it. A tool argument can overwrite those reserved values, and
an own `__proto__` property has special behavior on an ordinary JavaScript
object.

Use a null-prototype input map, reserve Rivet-owned names, and introduce a
namespaced invocation envelope. Preserve safe legacy top-level argument inputs
for existing handler graphs.

### Parallel frozen/preloaded validation only checks the first call

The connected-continuation coordinator validates frozen/preloaded Delegate
output for only the first scalar call in a parallel round. Later calls can
therefore execute a real handler even when their own invocation is frozen or
preloaded.

Validate every scalar invocation before starting any handler side effect. If a
check fails, create the diagnostic Delegate error run for the first offending
invocation.

### Legacy editor cache is not safe for tool-powered conversations

The legacy editor cache fingerprints LLM configuration, prompt, profile chain,
and declared tools, but not the contents of a handler graph or an external
function implementation. It can return an obsolete final answer after a
handler graph changes. It also cannot faithfully replay the live per-call
Delegate run shape, early Message branch behavior, or nondeterministic tool
behavior.

The recommended policy is to make editor caching ineligible for executions that
use Rivet tools, provider-native tools, external functions, or other
nondeterministic effects. The cache remains available for eligible, ordinary
editor-only model calls.

### Missing handler output becomes a silent empty tool result

A handler graph without a string `output` is currently coerced to an empty
string. In normal continuation this gives the model an unexplained empty tool
result; in direct-return mode it can yield a blank assistant response.

Add a clear handler-contract error and a graph lint warning for handler graphs
that lack a string Graph Output. If a legacy compatibility exception is needed,
it must be explicit and temporary rather than silently returning an empty value.

### Cancellation and profile attempts use different classifications

Physical provider-call observation recognizes an abort, while profile-attempt
observation can briefly classify that same attempt as a provider failure before
the abort is rethrown.

Add an explicit `aborted` attempt outcome. An abort must never schedule a retry
or advance to another profile.

### JSON-schema validation needs a terminal-response boundary

JSON-schema response validation runs inside a single provider round, before tool
continuation decides whether the round is intermediate. A model response that
requests tools may not contain the final response object, so it can be rejected
before the tools run.

The intended behavior must be pinned before implementation:

- Intermediate model rounds that request tools are not final-response
  validated.
- A terminal model answer is validated after Rivet has assembled the final
  Response Data Value.
- Direct-return tools need an explicit policy. The recommended safe behavior is
  to treat an invalid direct tool result as a handler-contract failure, rather
  than falling back and potentially repeating an already side-effecting tool.

### Partial output cleanup is not candidate-scoped

Fallback currently clears the partial Response text when moving to another
profile. Other partial presentation outputs can remain visible if they are
introduced or streamed later.

Make partial output state candidate-scoped and replace it atomically when a
candidate fails or a new one begins.

### Implicit continuation result commits and permissive handler routing

Parallel continuation descendants currently collapse output by node ID, with
the last model-order invocation effectively winning. That may be correct for
compatibility, but it is not an explicit policy. Automatic graph handler lookup
also falls back from exact name matching to the first graph name containing the
tool name, which can change routing when unrelated graphs are renamed or added.

Make the branch commit rule explicit. Preserve exact-then-substring routing for
compatibility, but compile a handler index and surface warnings for ambiguity,
self-routing, duplicate tool names, and unresolved handlers.

## Target Architecture

```text
Flat serialized LLM Chat / LLM Profile node data
  -> Configuration contract and normalizer
  -> Invocation plan
  -> Invocation coordinator
       -> resolved model candidate
       -> provider attempt executor and same-profile retry
       -> profile fallback policy
       -> tool-round executor
  -> Append-only invocation journal
  -> Result projector
       -> existing LLM Chat output ports
       -> response trace / Run Activity / recording projections

GraphProcessor supplies only the connected tool-round host.
```

The following ownership rules are central:

1. The configuration contract owns which fields belong to an LLM Profile.
2. A candidate resolver resolves a provider/model/credential exactly once.
3. The invocation coordinator owns round, retry, fallback, and tool decisions.
4. The invocation journal is the single source for accounting and diagnostics.
5. The result projector owns existing output shapes.
6. GraphProcessor owns scheduling mechanics for connected tool execution, but
   not provider recovery or LLM output semantics.

### Failure taxonomy and fallback eligibility

The coordinator must use typed domain outcomes rather than infer failure meaning
from the location of a `catch` block. The compatibility policy is:

| Failure kind                             | Retry same profile        | Advance profile chain  | Notes                                                             |
| ---------------------------------------- | ------------------------- | ---------------------- | ----------------------------------------------------------------- |
| Candidate configuration/request planning | No                        | Yes                    | Existing profile-fallback behavior                                |
| Eligible provider transport/HTTP failure | According to retry policy | After retry exhaustion | Preserve request status/error history                             |
| Final response validation failure        | No                        | Yes                    | Only before any terminal tool side effect                         |
| Cancellation/abort                       | No                        | No                     | Propagate as cancellation                                         |
| Tool handler or Delegate branch failure  | No                        | No                     | A successful model request must not be rerun as provider recovery |
| Internal invariant/programmer error      | No                        | No                     | Fail loudly; do not disguise it as a bad profile                  |

Expected failures should be discriminated values. Abort and unexpected internal
errors may still throw, but the coordinator must distinguish them explicitly.
"Advance profile chain" applies only when another profile exists. Inline and
scalar-profile runs retain their current terminal error/output surfaces.

### Sensitive-data boundary

An `llm-config` value intentionally contains the resolved raw credential. That
existing behavior is preserved. The new journal must not become another secret
container:

- It stores credential source/identity metadata, never a raw credential.
- It stores redacted normalized errors, never raw provider error objects.
- It stores tool/result ownership IDs and safe execution metadata rather than
  duplicating full tool payloads. Conversation text remains in invocation state
  and existing graph outputs, not the diagnostic journal.
- Request-body capture remains an explicitly enabled graph output and retains
  its current prompt-bearing sensitivity; it never includes authorization
  headers or API keys.
- Response traces and recordings receive versioned, provider-neutral
  projections, not the complete internal journal.
- Existing host callbacks retain their public contract and fire exactly once
  per physical call.
- The journal is scoped to one root LLM invocation and is discarded after its
  required output/trace projections are finalized.

## Refactor Phases

### How to execute and read the file lists

The phases are ordered dependencies, not a menu of independent rewrites:

```text
Phase 0 characterization and isolated defect fixes
  -> Phase 1 configuration ownership
  -> Phase 2 invocation/candidate resolution
  -> Phase 3 journal shadowing and projection cutover
  -> Phase 4 coordinator/state-machine cutover
  -> Phase 5 canonical tool execution
  -> Phase 6 connected scheduler host extraction
  -> Phase 7 cache and migration isolation
  -> Phase 8 removal of temporary adapters and final guardrails
```

- **Files to add** are proposed ownership boundaries. They do not exist yet.
  Preserve the named responsibility even if implementation shows that two very
  small proposed files should be combined.
- **Files to modify** are the verified current owners or parity surfaces. A
  parity-only file should remain untouched when its contract and tests prove
  that no change is needed; it must not be edited merely because it appears in
  the list.
- Each phase should land in reviewable commits: characterization first,
  structural movement second, deletion last. Do not mix an unrelated UX change
  or behavior correction into an extraction commit.
- Update the affected developer documentation in the same phase as its code.
  Phase 8 is the final reconciliation and architecture-history pass, not the
  first time documentation is updated.
- Run the focused tests named by the phase after every ownership cutover. Run
  the full core/app/Node verification and generated-artifact checks at the end
  of every phase that changes a public event, protocol, renderer, or serialized
  contract.
- Keep the previous owner as a short-lived compatibility wrapper only when a
  single atomic cutover is impractical. Mark it, test parity through it, and
  remove it in the same phase; do not carry dual authority into the next phase.

### Phase 0: Compatibility Matrix and Defect Characterization

Before moving ownership, build a matrix covering:

- Inline, scalar-profile, and profile-array configuration.
- Provider configuration errors, invalid URLs, transport errors, HTTP errors,
  retries, fallback, JSON validation failures, and cancellation.
- Streaming and non-streaming calls.
- Plain text and JSON-schema responses.
- Provider-specific instruction-role conversion, reasoning/thinking controls,
  previous-response state, built-in tools, parallel-tool options, and custom
  OpenAI-compatible endpoints.
- No tools, one tool, several tools, internal delegation, connected delegation,
  and direct return.
- Early Message and Start Async Branch behavior.
- Editor cache hit/miss, frozen outputs, recordings, replay, local, remote, and
  hosted execution.
- Scalar profile versus one-item profile array, including their intentionally
  different diagnostic output shapes.
- Run-per-item execution with the profile-array input preserved as one ordered
  fallback chain.
- Malformed profiles in attempted and not-yet-attempted chain positions.
- Duplicate tool declarations, fuzzy handler matches, unknown tools, external
  function fallback, and connected Delegate policy differences.
- Cancellation during provider execution, retry cooldown, candidate
  resolution, handler execution, and parallel sibling cancellation.
- Retry repeat counts at zero/one/many and tool-round limits immediately below,
  at, and above the configured boundary.
- Conditional output-port combinations, excluded provider-failure outputs, and
  the exact compact scalar/array status and error shapes.

Add explicit tests for every confirmed defect above, including multi-call
frozen/preload checks, reserved tool arguments, tool-cache replay, fallback
during a multi-round conversation, direct return, and JSON schema plus tool
continuation.

Land the confirmed defect fixes as small, isolated changes after their failing
tests exist and before moving the affected ownership. Do not combine a bug fix
with a file extraction or output-projection rewrite in the same change.

**Implementation work:**

1. Add a shared deterministic provider/tool test harness. It must control
   response rounds, HTTP statuses, thrown errors, retry timing, abort timing,
   usage/cost, function calls, and partial outputs without contacting a real
   provider.
2. Add table-driven compatibility cases rather than duplicating full node setup
   in every test. Keep provider-specific request-body fixtures separate from
   provider-neutral recovery expectations.
3. Add one failing regression test for each confirmed defect before changing its
   implementation.
4. Land the safe tool-input map, all-call frozen/preload validation, cancellation
   classification, terminal JSON validation, candidate-scoped partial reset,
   missing handler output error, and immediate tool-cache bypass as separate
   changes.
5. Record which old behavior was a defect and which output/event contract remains
   intentionally unchanged.

**Files to add:**

- `packages/core/test/model/chat-v2/llmInvocationTestHarness.ts` — reusable fake
  provider, clock, abort, and expected-event helpers.
- `packages/core/test/model/chat-v2/llmInvocationCompatibility.test.ts` — the
  cross-mode recovery/output matrix. Keep scheduler-specific cases in the
  existing GraphProcessor suite rather than importing GraphProcessor here.

**Files to modify for characterization and isolated fixes:**

- `packages/core/src/model/nodes/toolCallDelegation.ts`
- `packages/core/src/model/ToolCallContinuationCoordinator.ts`
- `packages/core/src/model/chat-v2/chatV2Pipeline.ts`
- `packages/core/src/model/chat-v2/llmProfileFallback.ts`
- `packages/core/src/model/chat-v2/toolContinuation.ts`
- `packages/core/src/model/chat-v2/chatV2EditorCache.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`
- `packages/core/test/model/chat-v2/llmProfileFallback.test.ts`
- `packages/core/test/model/chat-v2/toolContinuation.test.ts`
- `packages/core/test/model/nodes/LLMChatV2Node.test.ts`
- `packages/core/test/model/nodes/DelegateFunctionCallNode.test.ts`
- `packages/core/test/model/ToolCallContinuationCoordinator.test.ts`
- `packages/core/test/model/GraphProcessor.toolContinuation.test.ts`
- `packages/core/test/model/AgentResponseTrace.test.ts`
- `packages/core/test/recording/ExecutionRecorder.test.ts`

**Parity surfaces to exercise without necessarily modifying them:**

- `packages/app/src/hooks/remoteResponseTrace.test.ts`
- `packages/app/src/features/runActivity/runActivityJournal.test.ts`
- `packages/node/test/webAppHandler.test.ts`
- `packages/node/test/webAppSocketGateway.test.ts`

**Risk:** tests can accidentally preserve a known bug. Mark tests as either
documented compatibility, intended invariant, or deliberate bug correction.
An overly broad harness can also hide real provider differences; the harness
must expose request plans and physical-call events rather than mock the whole
LLM Chat node as one opaque function.

**Exit gate:** all later phases run this matrix unchanged; public port
definitions, values, Data Value types, error categories, output visibility, and
event ordering remain pinned. Each confirmed defect has a test that fails on the
old behavior and passes on the corrected behavior.

### Phase 1: One Declarative Profile Configuration Contract

Introduce a small typed `LLMProfileFieldSpec` registry. Each specification
should declare only what is needed to keep profile-owned settings consistent:

- Persisted data key and default.
- Optional dynamic input port and data type.
- Input toggle key.
- Provider applicability.
- Normalization/resolution owner.
- Whether the field affects credential, provider identity, generation, or
  provider capability configuration.

Create internal type views such as `LLMProviderConfigurationData` and
`LLMInvocationPolicyData` while retaining the existing flat serialized
`LLMChatV2NodeData`. Add compile-time checks that every shared field has exactly
one owner and that every registry key is valid for the persisted node shape.

Derive from that registry:

- Profile-owned data keys.
- LLM Profile input definitions.
- Profile normalization and application to LLM Chat data.
- Profile export rewiring and recoverable connection handling.
- Profile-mode suppression of stale LLM Chat inputs.
- Static compatibility metadata used by Graph Builder and environment scanning.

Keep editor section builders explicit and provider-specific. This is not a
proposal for a universal settings UI DSL.

**Implementation work:**

1. Inventory every persisted LLM Chat field and classify it as profile-owned,
   invocation-owned, output-policy-owned, or compatibility-only.
2. Add `LLMProfileFieldSpec` entries for the current profile-owned fields. The
   registry must preserve current input IDs, toggle keys, defaults, and provider
   visibility.
3. Derive the profile key list and complete recoverable profile input-ID list
   from the registry. Keep exported compatibility constants as registry-backed
   aliases during this phase.
4. Refactor profile normalization and LLM Profile runtime resolution to consume
   the registry. Provider-specific transformations remain named functions, not
   anonymous callbacks embedded in metadata.
5. Refactor LLM Profile input definitions and the Export to Profile command to
   use the same registry projection.
6. Make Graph Builder's authoring schema and custom-provider environment scan
   consume canonical field metadata where practical. Where Zod must remain
   explicit, add parity tests against the registry rather than generating an
   unreadable schema dynamically.
7. Add compile-time and runtime assertions for unowned keys, duplicate ownership,
   duplicate input IDs, and registry/default mismatches.

**Files to add:**

- `packages/core/src/model/chat-v2/llmProfileFieldRegistry.ts` — canonical field
  ownership and static input metadata.
- `packages/core/test/model/chat-v2/llmProfileFieldRegistry.test.ts` — ownership,
  defaults, provider visibility, port-order, and projection parity.

**Core files to modify:**

- `packages/core/src/model/chat-v2/llmChatV2NodeData.ts`
- `packages/core/src/model/chat-v2/llmProfileTypes.ts`
- `packages/core/src/model/chat-v2/llmProfile.ts`
- `packages/core/src/model/chat-v2/llmProfileNodeRuntime.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- `packages/core/src/model/nodes/LLMProfileNode.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/src/model/chat-v2/index.ts`
- `packages/core/test/model/nodes/LLMProfileNode.test.ts`
- `packages/core/test/model/nodes/LLMChatV2Node.test.ts`

**App files to modify or parity-check:**

- `packages/app/src/domain/graphEditing/extractLLMChatProfile.ts`
- `packages/app/src/domain/graphEditing/extractLLMChatProfile.test.ts`
- `packages/app/src/utils/chatV2CustomProviderEnv.ts`
- `packages/app/src/utils/chatV2CustomProviderEnv.test.ts`
- `packages/app/src/features/graphBuilder/policyAssetContract.ts`
- `packages/app/src/features/graphBuilder/policyRunner.ts`
- `packages/app/src/features/graphBuilder/authoringCatalog.ts`
- `packages/app/src/features/graphBuilder/authoringSemantics.ts`
- Their corresponding focused Graph Builder tests.

**Risk:** changing input ordering, hidden-port recovery, defaults, or serialized
fields can break saved projects.
Generating too much behavior from metadata can also make the system harder to
read. The registry is authoritative for ownership and static port facts only;
provider request construction and editor grouping remain ordinary typed code.

**Exit gate:** old project fixtures load and serialize identically; Export to
Profile remains one undoable operation and retains all active/dormant dynamic
connections. During migration, generated registry projections are asserted
against the previous explicit lists before those lists are removed.

### Phase 2: Invocation Plans and Resolved Model Candidates

Split the current over-broad runtime options into internal layers:

```ts
interface LLMInvocationPlan {
  messages: unknown;
  tools: unknown;
  responseFormat: unknown;
  retryPolicy: unknown;
  outputPolicy: unknown;
}

interface ResolvedModelCandidate {
  provider: string;
  modelId: string;
  model: unknown;
  credential: unknown;
  providerConfig: unknown;
  generation: unknown;
  providerOptions: unknown;
  safeIdentity: unknown;
  cacheIdentity: unknown;
}
```

Create one `resolveModelCandidate()` path for both Inline and Profile modes.
It returns the executable provider configuration and safe cache/diagnostic
identity together.

Remove the temporary `undefined as unknown as ChatV2Model` state, duplicate
inline credential/configuration resolution, and the unused runtime
`providerProfile` field. Add a small typed provider-capability registry for
facts such as parallel tool support and provider-native feature availability.
Do not turn providers into a plugin framework in this refactor.

Provider-specific request behavior should be exposed through small typed
adapters for existing providers. An adapter may own credential/configuration
resolution, model construction, provider options, built-in tools, and capability
flags. Prompt/history policy, retry, fallback, response normalization, tools,
and output projection remain provider-neutral. Introduce only adapters that
replace existing provider switches; do not design for hypothetical providers.

**Implementation work:**

1. Split the current runtime option type into an unresolved invocation plan and
   a fully resolved candidate attempt. Eliminate any state that claims to be
   executable while lacking a model instance.
2. Extract `buildLLMInvocationPlan()` from node/runtime assembly. It resolves
   prompt/history, response-format inputs, tool policy, retry/output policy, and
   context once without choosing a provider candidate.
3. Implement `resolveModelCandidate(plan, profile)` and use it for Inline, scalar
   Profile, and every fallback candidate. Return executable settings, safe
   diagnostic identity, redaction values, and cache identity together.
4. Remove the second Inline credential/provider-config resolution and the dead
   runtime `providerProfile` property after parity tests prove no consumer
   remains.
5. Consolidate current provider capability switches into a small registry. Keep
   the existing provider factories and request transforms, but expose them
   through a typed adapter map with exhaustive provider coverage.
6. Keep the first profile's placeholder run options only as a compatibility
   adapter while callers are migrated; remove it before completing the phase.
7. Add request-plan snapshots that compare effective provider/model, generation
   parameters, provider options, built-in tools, headers, base URL, and
   credential source without serializing the raw credential.

**Files to add:**

- `packages/core/src/model/chat-v2/llmInvocationPlan.ts` — provider-neutral
  invocation plan and builder.
- `packages/core/src/model/chat-v2/llmModelCandidate.ts` — resolved candidate
  contract and resolver.
- `packages/core/src/model/chat-v2/chatV2ProviderRegistry.ts` — exhaustive,
  in-core provider adapter/capability map.
- Focused tests with matching names under
  `packages/core/test/model/chat-v2/`.

**Files to modify:**

- `packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts`
- `packages/core/src/model/chat-v2/chatV2Types.ts`
- `packages/core/src/model/chat-v2/chatV2RuntimeOptions.ts`
- `packages/core/src/model/chat-v2/chatV2ProviderTypes.ts`
- `packages/core/src/model/chat-v2/chatV2ProviderProfile.ts`
- `packages/core/src/model/chat-v2/providerOptions.ts`
- `packages/core/src/model/chat-v2/chatV2FeatureCompatibility.ts`
- `packages/core/src/model/chat-v2/parallelToolCalls.ts`
- `packages/core/src/model/chat-v2/modelRegistry.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/test/model/chat-v2/providerOptions.test.ts`
- `packages/core/test/model/chat-v2/chatV2ProviderProfile.test.ts`
- `packages/core/test/model/nodes/LLMChatV2Node.test.ts`
- `packages/core/test/model/nodes/LLMProfileNode.test.ts`

**UI files to parity-check:**

- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- `packages/app/src/components/editors/custom/LLMChatV2ModelCatalogEditor.tsx`
- `packages/app/src/utils/chatV2CustomProviderEnv.ts`

**Risk:** credential precedence, custom URL normalization, headers, provider
request transforms, built-in tools, and cache identity can drift.
Another risk is turning a few switches into an oversized abstraction. Require
every adapter member to replace an existing provider-specific branch, and keep
the registry closed over the currently supported providers.

**Exit gate:** request plans and provider bodies match pre-refactor behavior for
every supported provider and dynamic setting combination.

### Phase 3: One Invocation Journal and One Output Projector

Introduce an append-only internal journal with typed events for:

- Candidate selection and configuration failure.
- Physical provider request completion or abort.
- Retry and fallback transitions.
- Request body capture.
- Parsed-response and validation outcomes.
- Tool delegation, completion, cancellation, and direct return.
- Model-round completion and terminal disposition.

Adopt the journal in two steps:

1. **Shadow projection:** existing output/accounting code remains authoritative,
   while tests derive the same results from journal events and compare them.
   This never makes a second provider request.
2. **Authority cutover:** after parity is demonstrated, one projector becomes
   authoritative and the old mutable attempt/usage/output accumulators are
   removed together.

Use this journal to derive:

- Usage and cost.
- Response Status and Response Error.
- LLM Profile Attempts and Profile Summary.
- Request body history.
- Response Inspector and Run Activity data.
- Recording trace projections.

Create one final `LLMInvocationResultProjector` that turns the completed
invocation into the existing LLM Chat ports. The public scalar/array diagnostic
shapes remain adapters over the journal.

**Implementation work:**

1. Define a versioned internal event union and stable invocation, model-call,
   profile, round, retry, and tool-execution identities. Keep full messages and
   tool payloads outside the journal.
2. Add an invocation-scoped journal owner with append-only writes and immutable
   reads. It must be created once per root LLM Chat invocation and shared by its
   fallback candidates and tool rounds.
3. Instrument candidate resolution, physical request completion, response
   validation, retry/fallback transitions, and tool execution while retaining
   all existing output/accounting owners.
4. Implement pure journal projections for Usage, profile attempts/summary,
   compact request status/error shapes, request-body order, model/tool trace
   entries, and terminal status.
5. In tests, compare journal projections against the current outputs and traces.
   Do not emit both old and new public process events during shadow mode.
6. After parity, switch `LLMChatV2Node` and response-trace collection to the new
   projector in one change, then remove node-local physical usage collection,
   fallback-owned summary/compaction, and tool-round usage accumulation.
7. Preserve existing public event schemas initially. If a missing identity or
   outcome requires an additive protocol field, version its validator,
   recording codec, and hosted client in the same change.

**Files to add:**

- `packages/core/src/model/chat-v2/llmInvocationJournal.ts` — internal event
  schema, identity allocation, and journal owner.
- `packages/core/src/model/chat-v2/llmInvocationProjections.ts` — pure journal
  projections for graph outputs and observability.
- `packages/core/src/model/chat-v2/llmInvocationResultProjector.ts` — final
  existing-port projection.
- Matching focused tests under `packages/core/test/model/chat-v2/`.

**Core files to modify:**

- `packages/core/src/model/chat-v2/chatV2CallObserver.ts`
- `packages/core/src/model/chat-v2/chatV2UsageAccounting.ts`
- `packages/core/src/model/chat-v2/chatV2Outputs.ts`
- `packages/core/src/model/chat-v2/chatV2Pipeline.ts`
- `packages/core/src/model/chat-v2/llmProfileFallback.ts`
- `packages/core/src/model/chat-v2/toolContinuation.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/src/model/nodes/toolCallDelegation.ts`
- `packages/core/src/model/ProcessContext.ts`
- `packages/core/src/model/GraphProcessor.ts`
- `packages/core/src/model/AgentResponseTrace.ts`
- `packages/core/src/model/ExecutorProtocol.ts`
- `packages/core/src/recording/ExecutionRecorder.ts`
- `packages/core/src/model/RecordingPlayer.ts`
- `packages/core/src/model/SubprocessorBridge.ts`

**App, Node, and hosted surfaces to modify only if the public projection gains
additive fields; otherwise they are regression targets:**

- `packages/app/src/features/runActivity/runActivityJournal.ts`
- `packages/app/src/hooks/projectExecutionSnapshotEvents.ts`
- `packages/app/src/hooks/remoteExecutorHelpers.ts`
- `packages/app/src/hooks/remoteResponseTrace.ts`
- `packages/app/src/components/agentTrace/AgentResponseInspector.tsx`
- `packages/node/src/debuggerProcessorAttachments.ts`
- `packages/node/src/webAppHandler.ts`
- `packages/node/src/webAppSocketGateway.ts`
- `packages/node/src/webAppClientTransport.ts`
- `packages/node/src/webAppClientRenderer.ts`
- `packages/node/src/generated/webAppClient.generated.ts`
- Corresponding focused app/core/Node tests.

**Risk:** duplicated or missing cost, incorrect retry/fallback counts, redaction
regressions, request-body ordering, and stale cached diagnostics.
Shadow mode itself can accidentally double-emit lifecycle events or retain large
payloads. It must compare pure projections in memory/tests only, use the existing
physical-call observer exactly once, and discard the journal after finalization.

**Exit gate:** exactly one journal record and cost contribution per physical
provider request; unknown pricing remains unknown rather than becoming zero.
The journal-derived and legacy projections match across the Phase 0 matrix
before cutover. Old recordings without journal-era events remain inspectable
through the existing legacy projection path.

### Phase 4: Explicit Invocation State Machine

Make the nesting of tool rounds, profile candidates, retries, and terminal
responses explicit through immutable invocation state. Use pure decisions such
as:

- `final-model-answer`
- `delegate-tools`
- `direct-tool-response`
- `release-unresolved-calls`
- `max-rounds-reached`
- `cancelled`
- `failed`

The terminal outcome must also state continuation ownership explicitly, for
example `consumed`, `released`, or `replayed`. This replaces the current
implicit relationship between an overloaded Tool Calls array and the mutable
`release()` side channel.

This phase moves final JSON-schema validation to the terminal-response
boundary, preserving the documented response port behavior while avoiding
intermediate tool-round rejection.

Centralize response materialization behind one pure internal result:

```ts
interface MaterializedLLMResponse {
  rawText: string;
  value: DataValue;
  source: 'sdk-structured' | 'text-json' | 'plain-text';
  validation: 'not-requested' | 'valid' | 'invalid';
  validationError?: string;
}
```

The SDK bridge remains responsible for transporting provider output. Response
materialization owns SDK structured output, JSON text fallback, Rivet Data Value
inference, and final validation classification. The result projector remains
responsible for graph ports. This prevents parsing and validation policy from
being split among the SDK bridge, pipeline, output builder, and coordinator.

Direct-return validation must be finalized during Phase 0. The recommended
policy is:

- A single direct-return tool still returns its exact string when JSON object
  validation is not requested.
- If final-object validation is requested, a non-object direct result is a tool
  result contract error and never causes profile fallback or tool replay.
- A round containing multiple tool calls retains ordinary continuation even if
  one or all declared tools use Return directly.

**Implementation work:**

1. Define immutable invocation state containing current messages, round index,
   active profile index, delegated history, reasoning state, and journal.
2. Extract a one-candidate physical-attempt executor. It owns request planning,
   provider transport, and same-profile retry, but does not choose fallback or
   tools.
3. Replace the stateful fallback closure with a pure fallback policy plus
   coordinator state. A successful profile remains sticky and can advance only
   forward on later failures.
4. Replace the loop in `toolContinuation.ts` with coordinator decisions. During
   migration, adapt the current internal/connected callbacks to the new
   `ToolRoundExecutor` contract introduced fully in Phase 5.
5. Implement one response materializer that chooses SDK structured output,
   JSON-text fallback, or plain text and returns a typed Data Value plus
   validation outcome.
6. Run final-object validation only for a terminal response. Intermediate tool
   requests never validate as final answers. Tool-handler and downstream branch
   failures never enter provider fallback.
7. Return explicit continuation ownership and terminal disposition; remove the
   mutable `release()` side channel after all callers use the new result.
8. Keep the existing exported `runChatV2Pipeline` behavior through a thin
   compatibility wrapper if it is part of the public core surface.

**Files to add:**

- `packages/core/src/model/chat-v2/llmInvocationCoordinator.ts` — state machine
  and terminal decision ownership.
- `packages/core/src/model/chat-v2/llmResponseMaterializer.ts` — structured/text
  response materialization and final-value validation.
- Focused coordinator and materializer tests under
  `packages/core/test/model/chat-v2/`.

**Files to modify:**

- `packages/core/src/model/chat-v2/chatV2Pipeline.ts`
- `packages/core/src/model/chat-v2/chatV2RequestPlan.ts`
- `packages/core/src/model/chat-v2/chatV2ResponseFormat.ts`
- `packages/core/src/model/chat-v2/chatV2Outputs.ts`
- `packages/core/src/model/chat-v2/aiSdkBridge.ts`
- `packages/core/src/model/chat-v2/llmProfileFallback.ts`
- `packages/core/src/model/chat-v2/toolContinuation.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`
- `packages/core/test/model/chat-v2/chatV2ResponseFormat.test.ts`
- `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`
- `packages/core/test/model/chat-v2/llmProfileFallback.test.ts`
- `packages/core/test/model/chat-v2/toolContinuation.test.ts`
- `packages/core/test/model/nodes/LLMChatV2Node.test.ts`

**Risk:** maximum-round boundaries, profile stickiness, Messages Sent versus All
Messages, direct return, unknown tool release, and cancellation.
The largest sequencing risk is temporarily having two round/fallback owners.
Move one decision at a time behind compatibility adapters, and delete the old
owner in the same change that makes the new decision authoritative.

**Exit gate:** golden multi-round conversations retain the exact public output
and ordered tool-result message behavior.

### Phase 5: Canonical Tool Registry and Tool-Round Executor

Replace the LLM-side split between individual delegation and optional
round-delegation callbacks with one interface:

```ts
interface ToolRoundExecutor {
  executeRound(calls: unknown[], context: unknown): Promise<OrderedToolRoundResult>;
}
```

Provide two adapters:

- Internal automatic delegation.
- Connected Delegate Tool Call execution supplied by GraphProcessor.

Split tool delegation into a pure tool-call codec, a handler resolver/index, a
handler executor, and an observer decorator. Internally distinguish pending raw
calls, delegated history, direct-return state, provider tool IDs, and
Rivet-owned execution IDs. Preserve the existing Tool Calls port and Delegate
outputs at the public boundary.

The Rivet-owned execution ID is generated for every invocation even when a
provider omits or reuses its tool-call ID. Provider IDs remain separate metadata.
Recording/protocol additions are versioned and additive so old recordings still
play.

**Implementation work:**

1. Build a canonical ordered registry from declared `GptFunction` values. Keep
   current last-declaration-wins provider behavior for duplicate names while
   emitting deterministic diagnostics.
2. Project provider-safe tool definitions from the registry and retain
   Rivet-only `resultHandling` metadata locally.
3. Extract pure normalization for raw provider calls, delegated records,
   function-result messages, and the existing Tool Calls port projection.
4. Build a handler index once per project/invocation. Preserve exact match,
   current fuzzy fallback order, external-function fallback, manual handlers,
   unknown handler, and passthrough-error semantics while returning ambiguity
   diagnostics.
5. Build graph handler inputs through a safe null-prototype map and protected
   invocation envelope. Define collision behavior for reserved legacy names.
6. Implement one internal `ToolRoundExecutor` and one connected-Delegate adapter.
   Both return ordered scalar results, execution IDs, timing, cost, result-owner
   references, and explicit success/passthrough/failure outcomes.
7. Keep early Message and final output branches in the connected adapter. The
   provider-neutral coordinator sees only ordered tool results and terminal
   ownership.
8. Add lints/editor warnings for duplicate tool names, ambiguous fuzzy handlers,
   self-routing, unresolved handlers, and handler graphs without a string
   `output`.

**Files to add:**

- `packages/core/src/model/chat-v2/rivetToolRegistry.ts`
- `packages/core/src/model/chat-v2/toolCallCodec.ts`
- `packages/core/src/model/chat-v2/toolHandlerResolver.ts`
- `packages/core/src/model/chat-v2/toolRoundExecutor.ts`
- Matching focused tests under `packages/core/test/model/chat-v2/`.

**Files to modify:**

- `packages/core/src/model/DataValue.ts`
- `packages/core/src/model/nodes/ToolNode.ts`
- `packages/core/src/model/chat/aiSdkTools.ts`
- `packages/core/src/model/chat-v2/toolConverter.ts`
- `packages/core/src/model/chat-v2/toolContinuation.ts`
- `packages/core/src/model/chat-v2/toolContinuationConnection.ts`
- `packages/core/src/model/nodes/toolCallDelegation.ts`
- `packages/core/src/model/nodes/DelegateFunctionCallNode.ts`
- `packages/core/src/model/ToolCallContinuation.ts`
- `packages/core/src/model/ToolCallContinuationCoordinator.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/test/model/nodes/DelegateFunctionCallNode.test.ts`
- `packages/core/test/model/chat-v2/toolContinuation.test.ts`
- `packages/core/test/model/chat-v2/toolContinuationConnection.test.ts`
- `packages/core/test/model/ToolCallContinuationCoordinator.test.ts`
- `packages/core/test/model/GraphProcessor.toolContinuation.test.ts`
- `packages/app/src/features/graphBuilder/authoringSemantics.ts` and its test.

**Risk:** parallel startup, model-order joining, passthrough errors, process IDs,
early Message branches, direct return, frozen replay, and async ownership.
Handler lookup is especially compatibility-sensitive: do not sort graphs or
"improve" fuzzy matching during this phase. Safe reserved-name handling must
also preserve every non-conflicting legacy argument input.

**Exit gate:** connected and internal paths pass the same handler/result
contract tests, with existing scheduler characterization unchanged.

### Phase 6: Narrow GraphProcessor's Connected-Continuation Host

After the LLM-side contract is stable, extract a
`ConnectedToolContinuationHost` from GraphProcessor. It owns:

- Invocation registry and per-call process allocation.
- Coordinator adapter and branch adapter creation.
- Release/finalize/discard lifecycle.
- Explicit continuation result commit policy.
- Cached/replayed delegated record behavior.

Audit continuation-local mutable state while extracting the host. Parallel
scalar invocations may execute the same descendant node IDs; invocation-local
scheduler/output overlays must remain separate, while intentionally shared root
controllers such as Stored Values, knowledge stores, global state, and cost
accounting retain their current sharing behavior. Completed sibling side effects
are never rolled back after another sibling fails.

GraphProcessor should supply narrow scheduling/child-run operations and retain
general execution ownership. Do not combine this phase with a broad
GraphProcessor rewrite.

**Implementation work:**

1. Define the host's narrow adapter over GraphProcessor: allocate process IDs,
   wait for pause state, create continuation child processors, start/finish/error
   node runs, commit branch outputs, propagate cost, and request root abort.
2. Move the continuation invocation map and its release/finalize/discard lifecycle
   into the host. GraphProcessor keeps the root run and general scheduler state.
3. Introduce an explicit commit plan for node-output collisions. Preserve the
   current last-in-model-order result for deferred consumers while documenting
   that immediate branches still run once per scalar call.
4. Keep topology and unsafe-branch decisions in
   `ToolCallContinuationBranchPlanner`; do not duplicate that policy in the host.
5. Keep parallel-call orchestration in `ToolCallContinuationCoordinator`; the
   host adapts scheduler operations but does not reimplement model-order joining.
6. Formalize which child-processor state is invocation-local and which root
   controllers are intentionally shared. Add assertions around processor
   lineage, result ownership, and cost propagation.
7. Remove GraphProcessor's tool-specific private methods only after the host owns
   their state and all existing lifecycle tests pass.

**Files to add:**

- `packages/core/src/model/ConnectedToolContinuationHost.ts` — invocation
  lifecycle and GraphProcessor adapter.
- `packages/core/src/model/ContinuationCommitPlan.ts` — pure collision/commit
  policy, if it cannot remain a small part of the host.
- Focused tests under `packages/core/test/model/`.

**Files to modify:**

- `packages/core/src/model/GraphProcessor.ts`
- `packages/core/src/model/ToolCallContinuation.ts`
- `packages/core/src/model/ToolCallContinuationCoordinator.ts`
- `packages/core/src/model/ToolCallContinuationBranchPlanner.ts`
- `packages/core/src/model/NodeIO.ts`
- `packages/core/src/model/SubprocessorBridge.ts`
- `packages/core/src/model/ManagedAsyncBranches.ts` only if shared root ownership
  needs an explicit adapter; its behavior must not be redesigned.
- `packages/core/test/model/GraphProcessor.toolContinuation.test.ts`
- `packages/core/test/model/ToolCallContinuationCoordinator.test.ts`
- `packages/core/test/model/ToolCallContinuationBranchPlanner.test.ts`
- `packages/core/test/model/GraphProcessor.asyncBranches.test.ts`
- `packages/core/test/model/GraphProcessor.characterization.test.ts`

**Risk:** lifecycle event order, pauses, aborts, cycles, Run To, graph-output
readiness, child state sharing, recording identity, and cost propagation.
Extracting a generic child-processor factory at the same time would widen the
blast radius to ordinary subgraphs and async branches. That generalization is
out of scope unless the phase uncovers a small, already-identical constructor
helper with independent characterization.

**Exit gate:** existing continuation characterization, recording playback, and
async-branch tests pass without event-order changes. Add a convergence test in
which parallel calls traverse the same stateful descendant, plus both scheduler
modes, pause, cancellation, and fail-fast sibling settlement.

### Phase 7: Isolate Legacy Cache and Compatibility Adapters

Move editor-cache lookup/replay/write outside `LLMChatV2Node.process` and make
cache eligibility explicit. A cache hit is represented as an invocation origin,
not as a mutation of stored normal outputs.

The immediate tool-cache eligibility correction belongs to Phase 0. This phase
only relocates and simplifies the already-corrected cache ownership.

For remaining eligible calls, use a collision-resistant deterministic digest
for credential/configuration fingerprints. Raw secrets must never become part of
the cache key or stored output. Cache-version invalidation is acceptable for
this legacy editor-only feature and must be documented.

Move LLM-specific migration/normalization ownership behind a node-specific
adapter; generic serialization should delegate rather than carry LLM policy.

**Implementation work:**

1. Introduce a pure cache-eligibility decision with explicit reasons such as
   disabled, tool execution, provider-native capability, external handler,
   nondeterministic plan, missing fingerprint, hit, and miss.
2. Move lookup/clone/write/cache-hit output projection from
   `LLMChatV2Node.process` into one cache boundary around the invocation
   coordinator.
3. Version the cache key. Use the already available cross-runtime SHA-256
   implementation for secret/configuration fingerprints and never include the
   raw secret.
4. Preserve cache lifetime and project scoping in the editor, but ensure a
   project/handler/configuration edit cannot reuse an unsafe old entry.
5. Make cache hits produce current-run observability that truthfully says no
   physical calls occurred; do not reuse prior attempt history, model-call trace,
   or request bodies as current activity.
6. Extract the existing LLM request-diagnostic migration from generic
   serialization into an idempotent node-specific normalizer. Add future LLM
   migrations there rather than growing generic serialization conditionals.
7. Keep the legacy Cache outputs editor control hidden unless the loaded node
   already has it enabled.

**Files to add:**

- `packages/core/src/model/chat-v2/llmChatV2CachePolicy.ts` — eligibility,
  versioned key identity, lookup/write, and cache-hit origin.
- `packages/core/src/model/chat-v2/llmChatV2NodeMigration.ts` — idempotent
  serialized-node data normalization.
- Matching focused tests under `packages/core/test/model/chat-v2/`.

**Files to modify:**

- `packages/core/src/model/chat-v2/chatV2EditorCache.ts` — remove or reduce to a
  compatibility re-export after migration.
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeData.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- `packages/core/src/utils/serialization/serialization.ts`
- `packages/core/test/utils/serialization.test.ts`
- `packages/app/src/hooks/useLocalExecutor.ts`
- `packages/core/test/model/nodes/LLMChatV2Node.test.ts`
- Phase 0 cache/replay compatibility tests.

**Risk:** fewer cache hits and intentional cache invalidation for unsafe calls.
Changing the fingerprint invalidates existing in-memory entries, which is
acceptable for a legacy editor-only cache but must not become a serialized
project migration. Cache-hit output cloning must remain defensive so downstream
mutation cannot corrupt another run's stored entry.

**Exit gate:** tool-powered executions never replay side effects or stale tool
records; old cached entries fail safely or normalize to the current diagnostics
contract.

### Phase 8: Cleanup, Guardrails, and Documentation

After full parity:

- Remove dead runtime metadata and duplicate compaction/normalization paths.
- Deprecate unused public helpers before removing them in a major version.
- Add architecture/import-boundary checks so UI, fallback, and GraphProcessor
  cannot reach into each other's internal policy.
- Update the LLM Chat contract, Core Engine documentation, node reference,
  developer test matrix, and `refactor-history.md`.
- Record physical line movement honestly.

The final `LLMChatV2Node.process` boundary should do only four things: validate
node inputs, build the invocation request, call the coordinator, and return the
projected outputs. Cache, fallback, continuation accounting, and diagnostic
repair must no longer be implemented there.

**Implementation work:**

1. Remove superseded compatibility adapters, duplicate field lists, old
   accumulators, dead runtime metadata, and temporary shadow-projection code.
2. Keep public compatibility exports as deprecated wrappers where removing them
   would be a breaking package change. Add removal notes to the next-major
   backlog rather than leaving two internal owners.
3. Extend the existing AI runtime boundary check to enforce the final import
   direction: node boundary -> coordinator -> candidate/provider/tool services;
   GraphProcessor may import the connected host contract but not profile,
   response-format, retry, or output-projector internals.
4. Check that the editor consumes public field/capability projections and does
   not rebuild runtime policy independently.
5. Regenerate hosted web-app artifacts only when their source protocol or
   renderer changed, and run the existing freshness check.
6. Update maintainer and user documentation in the same phase that changes the
   relevant contract. Finish by recording actual file/line movement and
   intentional non-deletions in `refactor-history.md`.

**Files to modify:**

- `scripts/checks/check-ai-runtime-boundaries.mjs`
- `developer-docs/LLM-CHAT-V2-CONTRACT.md`
- `developer-docs/CORE-ENGINE.md`
- `developer-docs/EXECUTION-DATA-FLOW.md`
- `developer-docs/RUN-ACTIVITY.md`
- `developer-docs/APP-ARCHITECTURE.md` where editor/runtime ownership changes.
- `packages/docs/docs/node-reference/llm-chat.mdx`
- `packages/docs/docs/node-reference/llm-profile.mdx`
- `packages/docs/docs/node-reference/gpt-function.mdx`
- `packages/docs/docs/node-reference/delegate-tool-call.mdx`
- `packages/node/src/generated/webAppClient.generated.ts` only when its source
  contract changed.
- `refactor-history.md`

**Deletion candidates to verify rather than assume:**

- Dead `LLMChatV2RuntimeConfig.providerProfile` construction.
- Old profile field/input lists after registry-backed exports are established.
- Node-local physical usage collection.
- Fallback-owned summary/status/error compaction after journal projection.
- Tool-round usage accumulation after journal projection.
- Legacy cache helpers replaced by the cache policy boundary.

The configuration, candidate-resolution, output-projection, and legacy-helper
work should remove duplicate production code. The connected-host extraction may
be line-neutral or add code. Record a scoped physical-line baseline at the start
of each phase and its actual movement at completion; do not use an unverified
repository-wide LOC forecast as an acceptance criterion.

**Risk:** cleanup can accidentally remove a public export used outside this
monorepo or a compatibility adapter still needed by old serialized projects.
Search package exports and generated declaration output before deleting; prefer
a deprecated wrapper when external use cannot be disproved.

**Exit gate:** architecture checks enforce the intended import direction,
documentation matches the final owners and behavior, generated artifacts are
fresh, no temporary shadow/dual-authority paths remain, and physical line
movement is recorded with the exact scoped baseline.

## UX Improvements Enabled by the Refactor

These are follow-up presentation changes, not prerequisites for runtime
refactoring. Any new persisted field is additive and separately versioned.

- Add an **Effective configuration** view with provider, model, masked
  credential source, settings, retry policy, and fallback order.
- Let profiles have optional display names such as "Primary OpenAI" and
  "Backup DeepSeek".
- Present one recovery timeline: model round -> profile -> retry -> status ->
  validation -> fallback -> tool execution.
- Clearly distinguish retrying a profile from switching to the next profile.
- Show why JSON schema validation failed, including the final parsed Rivet data
  type and what Rivet did next.
- Show whether LLM Chat uses internal auto-delegation or a connected Delegate,
  including effective routing/error policy.
- Add handler-resolution preview and warnings for fuzzy matches, ambiguous
  matches, duplicate tool names, missing handlers, and missing string outputs.
- Show a legacy-cache warning whenever its eligibility policy refuses or bypasses
  caching.
- Keep raw diagnostics ports for workflow logic, while making the response
  inspector the primary human-readable diagnostic surface.
- Add a Test Profile action that resolves the effective profile and performs a
  minimal request without revealing a credential. It must clearly disclose that
  it makes a billable provider request and support cancellation.
- Explain the effective recovery policy in the editor: retries apply to eligible
  provider failures, while configuration, response validation, cancellation,
  and tool failures follow different paths.
- Label pre-run configuration as **Configured** and completed-run data as
  **Effective**, because dynamic profile inputs cannot be truthfully resolved in
  the editor before execution.

### UX work package A: Effective configuration and profile identity

**Work:** Use the LLM Profile node title as the default human-readable profile
label in runtime diagnostics. Add an optional label to the resolved
`LLMProfileValue` contract for programmatically constructed profiles. Show the
configured profile order before execution and the effective selected/failed
profile identities after execution. Mask credentials and show only their source.

**Files:**

- `packages/core/src/model/chat-v2/llmProfileTypes.ts`
- `packages/core/src/model/chat-v2/llmProfileNodeRuntime.ts`
- `packages/core/src/model/nodes/LLMProfileNode.ts`
- `packages/core/src/model/chat-v2/llmInvocationJournal.ts`
- `packages/core/src/model/AgentResponseTrace.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/app/src/components/agentTrace/AgentResponseInspector.tsx`
- `packages/app/src/components/nodeOutput/NodeInlineOutput.tsx`
- `packages/app/src/components/nodeOutput/NodeFullscreenOutput.tsx`
- Corresponding profile, trace, and node-output tests.

**Risk:** a dynamic profile input cannot be resolved accurately before a run.
The editor must say **Configured** for static graph information and **Effective**
only for journal-backed completed-run information. Adding the optional runtime
label must remain backward-compatible with version-1 profile values.

**Exit gate:** pre-run labels never claim an unresolved dynamic value is
effective; completed runs show the same profile identity in node output,
Response Inspector, Run Activity, remote traces, and recording playback without
exposing a credential.

### UX work package B: Recovery and tool timeline

**Work:** Replace separate human-readable retry/fallback summaries with one
grouped timeline in Response Inspector and Run Activity: round, profile, retry,
status, validation, fallback, tool execution, and terminal result. Keep raw graph
outputs unchanged for workflow logic.

**Files:**

- `packages/core/src/model/AgentResponseTrace.ts`
- `packages/app/src/components/agentTrace/agentTraceViewModel.ts`
- `packages/app/src/components/agentTrace/AgentResponseInspector.tsx`
- `packages/app/src/features/runActivity/runActivityJournal.ts`
- `packages/app/src/components/runActivity/buildRunActivityViewModel.ts`
- `packages/app/src/components/runActivity/RunActivityRenderer.tsx`
- `packages/node/src/webAppClientRenderer.ts`
- `packages/node/src/generated/webAppClient.generated.ts`
- Corresponding core/app/Node tests and the generated-client freshness check.

**Risk:** the React editor and generated hosted renderer can diverge. Build the
timeline from one provider-neutral trace view model where practical, and verify
both renderers. Do not expose prompt, response, tool payload, or raw error data
through the trace just to make the timeline richer.

**Exit gate:** the same recorded trace renders the same ordered recovery/tool
story in Response Inspector, Run Activity, playback, and hosted web apps; raw
diagnostic graph-output values remain byte-for-byte compatible.

### UX work package C: Tool routing and contract diagnostics

**Work:** Show whether LLM Chat uses internal auto-delegation or a connected
Delegate, the selected handler kind/name, and warning states for duplicate tools,
fuzzy/ambiguous matches, self-routing, missing handlers, and missing string
outputs. The warnings must use the canonical registry/resolver rather than
reimplement matching in the editor.

**Files:**

- `packages/core/src/model/chat-v2/rivetToolRegistry.ts`
- `packages/core/src/model/chat-v2/toolHandlerResolver.ts`
- `packages/core/src/model/chat-v2/toolContinuationConnection.ts`
- `packages/core/src/model/nodes/ToolNode.ts`
- `packages/core/src/model/nodes/DelegateFunctionCallNode.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/app/src/components/editors/custom/ToolCallHandlersEditor.tsx`
- `packages/app/src/features/graphBuilder/authoringSemantics.ts`
- Corresponding node, resolver, editor, and Graph Builder tests.

**Risk:** warnings must not change routing order or reject a graph that currently
runs. Treat them as diagnostics until a separately versioned breaking policy is
approved.

**Exit gate:** every warning is produced from the runtime's canonical registry
and resolver, disappears when the underlying ambiguity is corrected, and has no
effect on provider tool definitions, handler selection, or execution order.

### UX work package D: Cache eligibility explanation

**Work:** When a legacy cache-enabled node is bypassed, show the canonical
eligibility reason in its output/body and Response Inspector. Do not add the
legacy cache control to new nodes.

**Files:**

- `packages/core/src/model/chat-v2/llmChatV2CachePolicy.ts`
- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- `packages/core/src/model/nodes/LLMChatV2Node.ts`
- `packages/core/src/model/AgentResponseTrace.ts` only if cache origin is not
  already representable.
- `packages/app/src/components/agentTrace/AgentResponseInspector.tsx`
- Focused cache-policy and presentation tests.

**Risk:** the UI must not imply that an eligible cache hit made a provider call,
and must not show bypass reasons for ordinary nodes whose legacy cache setting is
absent.

**Exit gate:** eligible hit, eligible miss, and each bypass reason have focused
tests; current-run traces contain zero physical calls on a hit and never inherit
the cached run's attempt history.

### UX work package E: Test Profile action

This is an optional additive feature after the runtime refactor, not part of the
behavior-preserving completion gate.

**Work:** Add a cancellable editor action that resolves one LLM Profile and runs
a minimal invocation through the same candidate resolver/provider executor. Show
provider/model, duration, status, and safe normalized error. Require an explicit
click and disclose that it may incur provider cost. Never display or persist the
resolved credential.

**Likely files:**

- `packages/core/src/model/chat-v2/testLLMProfile.ts` — minimal-plan helper that
  reuses the real resolver/executor.
- `packages/app/src/components/editors/custom/LLMProfileActionsEditor.tsx`
- `packages/app/src/components/editors/CustomEditor.tsx`
- `packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts`
- Focused core/app tests.

**Risk:** a "test" is a real billable network request and can trigger provider
rate limits. It must not run automatically during editor render, project load,
or validation, and cancellation must use the same abort path as LLM Chat.

**Exit gate:** the action requires an explicit user gesture, can be cancelled,
uses the production resolver/executor rather than a second request builder,
redacts credentials and headers, and is excluded from the behavior-preserving
runtime-refactor completion gate.

## Compatibility Invariants

The refactor must preserve:

- Persisted LLM Chat and LLM Profile node types, flat YAML fields, default
  values, and port IDs.
- Missing `configurationMode` meaning Inline.
- A scalar `llm-config` and a one-item `llm-config[]` retaining their existing,
  intentionally different diagnostic shapes.
- Profile arrays remaining a single preserved fallback-chain input during
  Run-per-item execution.
- Every supplied profile value being normalized before the first provider call,
  including profiles that a successful earlier candidate may never need.
- Same-profile retries completing before profile fallback.
- Forward-only, sticky profile selection across tool rounds.
- Response-validation failures skipping non-200 retry.
- Tool-handler errors not becoming provider failures.
- Parallel tool handlers running concurrently while result messages remain in
  original model order.
- Fail-fast sibling cancellation not rolling back already completed side
  effects.
- Direct return terminating only a single-tool round and returning the exact
  handler string unless the explicitly enabled final-response validation policy
  rejects that terminal value under the corrected contract.
- Multiple tool calls always using ordinary continuation for that round,
  regardless of individual Return directly settings.
- Connected auto-continuation invoking Delegate once per scalar tool call, while
  manual raw tool-call arrays outside that path continue to require explicit
  Run per item.
- Duplicate declared tool names retaining today's last-declaration-wins provider
  behavior until a separately versioned policy change.
- Automatic handler lookup retaining exact-name precedence and current fuzzy
  fallback order, with new warnings but no silent rerouting.
- Messages Sent containing only provider-bound messages, while All Messages
  includes tool results.
- Usage and cost counted once per physical provider call.
- Unknown cost remaining unknown.
- Request bodies retaining physical order and excluding credentials/headers.
- Cancellation never starting a retry or fallback.
- Host physical-call callbacks and lifecycle events firing exactly once.
- Tool Calls, Usage, Reasoning, Response Status, Response Error, and Request Body
  ports retaining their current setting-controlled visibility and Data Value
  types; profile-mode diagnostic ports retain their current availability.
- Rivet-only Tool metadata such as Result handling remaining absent from provider
  tool definitions.
- Existing `llm-config`, `GptFunction`, process-event, and host callback public
  contracts remaining source-compatible unless an additive versioned field is
  explicitly introduced.
- The legacy cache setting remaining hidden for newly created nodes and visible
  only on old nodes where it was already enabled.
- Cached/frozen records never replaying external side effects.
- Existing recordings remaining playable.

## Definition of Done

The refactor is complete only when:

- Every Phase 0 compatibility and corrected-defect test passes in Browser,
  internal Node, remote Node, and relevant web-app execution paths.
- Recording and playback show the same model/profile/tool history without
  duplicate or invented physical calls.
- One configuration registry owns profile fields, one resolver owns effective
  candidates, one coordinator owns recovery/continuation, one journal owns
  attempt facts, and one projector owns graph outputs.
- No raw credential or unredacted provider error is added to traces, journals,
  recordings, or cache keys.
- `LLMChatV2Node.process` is a thin invocation boundary and GraphProcessor has no
  profile, retry, response-format, or LLM-output policy.
- Developer documentation, node/user documentation affected by UX changes,
  Graph Builder authoring specs, generated clients/protocol fixtures, and
  `refactor-history.md` are synchronized.
- Focused tests, core/app/Node type checks, lint, production builds, docs checks,
  generated-artifact freshness checks, and `git diff --check` pass.

## What This Plan Deliberately Does Not Do

- It does not rewrite provider transport or replace the AI SDK bridge.
- It does not move connected Delegate execution back into ordinary downstream
  graph scheduling.
- It does not replace flat project YAML with a new profile serialization format.
- It does not turn providers into an open-ended runtime plugin system.
- It does not use raw line-count reduction as the main acceptance criterion.
