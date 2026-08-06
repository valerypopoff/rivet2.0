# LLM Chat V2 Contract

## Response trace boundary

Every physical provider attempt completed by LLM Chat emits the additive
`llmCallFinished` process event. The event is correlated by root run, graph,
node, process, round, profile, and attempt identities and contains only timing,
outcome, finish reason, normalized token usage, and pricing state. It never
contains prompts, messages, generated text, reasoning text, request bodies,
headers, credentials, raw provider errors, or provider-specific raw usage.
The existing host-only `onChatV2CallFinished` callback remains exactly once per
physical attempt and may retain its existing raw accounting payload; failures in
either observer path are isolated from graph execution.
Subgraph processors resolve that callback from the root run's original host
context. They must not chain the immediate parent's internal observer wrapper:
the nested processor emits its own identity-bearing event, and the subprocessor
bridge forwards that event to the root exactly once.

`AgentResponseTrace` is a versioned projection built from these physical-call
events and the corresponding `toolCallFinished` events. It is presentation and
observability data, not an LLM input or graph output. Response traces stop their
duration when mapped graph outputs are ready, while invocation traces span the
selected LLM node process. Retry and fallback counts come from explicit attempt
and profile metadata, never timestamp inference. Unknown or partially known
pricing stays unknown/partial rather than becoming `$0`.

The normal inspector presentation groups the projection into **Execution**,
**Recovery behavior**, **Usage and cost**, and **Timing**. The recovery labels
are deliberately explicit: **Provider request retries** counts repeated physical
requests after failures, while **LLM profile fallbacks** counts transitions to a
later configured profile. Trace, graph, node, and process IDs remain mandatory
correlation data in the portable contract but are hidden from the ordinary UI;
they are not useful response-level diagnostics by themselves.

The editor stores trace events on the exact node process so the inline and
full-output inspectors follow the selected run and process page, including while
it is running. Editor-launched inspectors mount at the application overlay root,
outside transformed and overflow-clipped node output surfaces. Cache replay,
frozen output, and recordings that predate the
physical-call events truthfully show partial or unavailable data instead of
inventing zero calls or cost.

## Inline and profile configuration

`LLM Chat` has one runtime pipeline and two configuration sources:

- `inline` is the default and preserves every existing project's behavior.
- `profile` requires either one typed `llm-config` value or an ordered
  `llm-config[]` fallback chain produced by `LLM Profile` nodes.

`llmChatV2ProfileDataKeys` is the authoritative ownership list. An LLM Profile
owns provider, model, the resolved credential, common generation parameters,
provider-specific reasoning/thinking settings, provider-native capabilities,
Custom-provider URL and API protocol, headers, and extra provider options. LLM Chat continues to
own prompts and history, response format/schema, Rivet tools and continuation,
outputs, retries and request diagnostics, and editor caching. Provider/model
configuration, including OpenAI Previous Response ID, belongs to the profile.

The profile output contains the resolved raw API key by design, along with its
credential-source metadata. This supports fully detachable provider slots but
also means normal execution data, recordings, previews, and remote transport may
contain that key. The normal secret-free `ChatV2ProviderProfile` used for runtime
diagnostics remains secret-free, and editor-cache keys continue to use only a
credential fingerprint.

Profile mode must not fork the request implementation. It creates an effective
LLM Chat data object by applying only profile-owned fields, then uses the same
provider resolution, request planning, continuation, output, and cache code as
Inline mode. Missing `configurationMode` means `inline` for serialized backward
compatibility. Stale inline dynamic provider inputs must neither remain visible
nor affect execution after switching to profile mode.

### Profile fallback chains

The `LLM Profiles` input accepts either a scalar profile or a non-empty ordered
array. A scalar retains the old From profile behavior. An array is one
configuration collection, not a Many-runs input: its input definition declares
`splitRunBehavior: 'preserve-array'`, so an LLM Chat using **Run per item** keeps
the entire ordered chain for every prompt item.

For compatibility, a scalar profile also keeps its former terminal error shape
for provider-setup/request-planning failures. Only a real multi-profile chain
replaces an all-candidate failure with the aggregate, safe chain diagnostic.

For every provider/model round, LLM Chat starts at the currently active profile.
It first performs that profile's ordinary **Retry on non-200** attempts, then
tries the next profile only if the current candidate still does not complete.
Candidate setup/planning failures are also candidate failures. Cancellation is
never converted into fallback, including when it occurs while a candidate is
being configured. Once a profile completes a round, it is sticky
for later auto-continuation rounds; a later failure can only advance farther
right in the chain, never return to an earlier profile. This prevents a tool
conversation from oscillating between providers while preserving model-round
order.

For JSON schema response format, the final Data Value assembled for the
`Response` port is always validated after SDK structured output and Rivet's JSON
text fallback have both had a chance to produce it. Only an `object` Data Value
passes; strings, arrays, primitives, null, and missing values reject the current
profile. This is a profile-level response-validation failure after a successful
provider request, not a non-200 transport failure: it never enters **Retry on
non-200**. An actual fallback chain advances immediately to the next profile.
Inline and scalar-profile runs throw the detailed validation error when no
fallback is available.

The chain covers construction and execution of the provider/model round. Tool
handler/delegate execution, connected-continuation scheduling, direct-return
handler validation, and downstream graph work retain their normal errors; a
successful model response is not rerun on another profile because a tool handler
failed. A provider response with a non-200 status is always unsuccessful. A
terminal provider failure is a real LLM Chat node error; it never becomes an
excluded output and cannot trigger tool continuation.

`Output LLM attempts` (`outputLLMAttempts`) adds `LLM Attempts`
(`llmAttempts`, `object[]`) in both Inline and From profile modes. It is one
chronological, developer-visible record per profile configuration, physical
provider request, or JSON-schema response-validation attempt. Each record holds
provider/model identity, model round, retry index where applicable, outcome,
observable HTTP status, and original error text where available. Profile records
also carry their zero-based `profileIndex`. `LLM Profile Summary`
(`llmProfileSummary`, `string`) remains profile-only and names every configured
candidate as succeeded, failed, or not attempted. Captured response bodies and
attempt errors are deliberately neither redacted nor truncated. The editor cache
fingerprints the complete ordered profile chain, effective global Chat headers,
and each credential without storing
raw keys. A cache hit emits an empty LLM Attempts array and an explicit profile
summary because it made no provider call. Exhausted chains are never cached and
their error includes every retained attempt.

The editor's Inline-only **Export LLM settings to profile node** action is a graph-editing
convenience, not a third configuration mode. It creates a neighbouring LLM
Profile, copies every field in `llmChatV2ProfileDataKeys`, rewires current
connections for active Profile ports, and uses the complete `llmProfileInputIds`
contract for recoverable connections so disabled settings move to the Profile
too. It connects its `profile` output to LLM Chat's `llmProfile` input, and then
changes the Chat node to `profile`. The whole conversion is one undoable
command. Prompt/history, response format, tools, outputs, retries, and their
connections stay on LLM Chat.
The explanatory configuration copy occupies the full settings-panel width
above the controls. The action shares the configuration-switcher row and is
aligned to the right edge of the node settings panel. Its tooltip wrapper is
the aligned flex item, so tooltip composition cannot constrain or wrap the
switcher. This two-option switcher opts out of the shared segmented control's
automatic option wrapping, so **From profile** remains one label on one line.
The row reserves the switcher's intrinsic width and one standard control
height regardless of whether the Inline-only action is present: switching mode
must neither clip the trailing option padding nor move the following section.

**Output reasoning** is invocation-owned because it controls whether that LLM
Chat exposes a `Reasoning` output; it always appears in the Chat node's
**Outputs** section. LLM Profile's **Reasoning** section contains only
provider-specific inference controls. It is omitted for Custom providers, which
have no built-in provider-specific reasoning fields.

`llm-config` is a resolved value contract. Its normalizer clears every
profile-owned `use...Input` flag before LLM Chat consumes it, including for
externally constructed values. This prevents stale hidden Chat inputs from
changing a profile's model, credentials, headers, generation settings, or
thinking budget at runtime.

`Tool Calls` is declared and emitted only when LLM Chat's own `Tool use` setting
is enabled. Profile mode does not override that invocation-level choice: a
profile may enable provider-native tools, but a Chat with Tool use off has no
Rivet Tool Calls port or output. The shared `shouldIncludeLLMChatV2ToolCalls(...)`
policy owns this decision for both port declaration and runtime output
construction.

The app-level `toolWarnings.ts` is the editor-only guard for static Rivet Tool
wiring. It shows the normal node-header warning on every enabled Tool whose
literal name duplicates another Tool in the same LLM Chat **Tools** input,
because those definitions would overwrite each other in that model tool
registry. Tools in separate registries are allowed to share a name. For an
eligible connected LLM Chat → Delegate Tool Call continuation with **Auto
Delegate** enabled, it also warns every statically named connected Tool unless
the project contains a graph whose name exactly matches that Tool name. Dynamic
Tool names are intentionally not guessed, and Delegate external/unknown-handler
settings remain fallbacks rather than substitutes for a named handler graph.

### Invocation output and error controls

`Response Tokens` is retired from LLM Chat V2. `Usage` is the complete token and
cost observation surface and is emitted only when `Output usage details` is on.

The **Outputs** group owns `Output LLM attempts` (`outputLLMAttempts`),
`Output request body` (`outputRequestBody`), `Output response body`
(`outputResponseBody`), reasoning, usage, and streaming. **Error behavior**
owns retry controls. `LLM Attempts` is the sole retry/fallback debugging
surface; `Response Status` and `Response Error` are retired and are no longer
node ports. Request body exposes the provider request payload but not transport
headers. Response body clones the provider HTTP response before the SDK
consumes it, parses valid JSON for inspection, otherwise preserves text, and
leaves captured content unredacted and untruncated.

Older serialized `outputRequestStatus` and `outputRequestError` settings are
migrated to `outputLLMAttempts: true` and then removed. The old request-details
switch also preserves `outputRequestBody: true` when it had enabled that
supported capture. Programmatic old fields are ignored. Newly created nodes use
false defaults; `outputResponseBody` remains independently opt-in.

The `cache` setting is legacy editor behavior. Its control is rendered only
when the node already has `cache: true`; turning it off removes the control on
the next editor render, while runtime support remains for old projects. Cache
hits never replay LLM Attempts because no provider calls occurred in the current
invocation.

The user-facing `LLM Chat` node is the current chat node. Its persisted internal
node type is `llmChatV2`; legacy `Chat` / `Chat Loop` nodes remain compatibility
paths and should not be used as the primary target for new provider refactors.

## Ownership Map

- [`LLMChatV2Node.ts`](../packages/core/src/model/nodes/LLMChatV2Node.ts) owns
  the node implementation boundary and delegates runtime work to `chat-v2`.
- [`llmChatV2NodeData.ts`](../packages/core/src/model/chat-v2/llmChatV2NodeData.ts)
  owns persisted node data shape, defaults, and migration-compatible fields.
- [`llmChatV2NodeRuntime.ts`](../packages/core/src/model/chat-v2/llmChatV2NodeRuntime.ts)
  is the thin node-runtime adapter. It selects cache behavior and composes the
  invocation plan, candidate resolver, fallback runner, and output projector;
  it must not duplicate provider or profile resolution policy.
- [`llmProfileFieldRegistry.ts`](../packages/core/src/model/chat-v2/llmProfileFieldRegistry.ts)
  is the canonical declaration of profile-owned persisted fields and dynamic
  input ids. Its field-level scalar validation kind and resolved-input-toggle
  flag also derive profile normalization from the same declaration. Profile
  serialization, profile-mode stripping, validation categories, and UI ports
  must not keep parallel hand-written field lists.
- [`llmInvocationPlan.ts`](../packages/core/src/model/chat-v2/llmInvocationPlan.ts)
  owns provider-neutral, once-per-node-run inputs: prompts, Rivet tools,
  response-format policy, output policy, and request-body capture.
- [`llmModelCandidate.ts`](../packages/core/src/model/chat-v2/llmModelCandidate.ts)
  owns one resolved provider/model candidate. It applies an optional profile,
  resolves credentials and provider configuration, and returns executable
  pipeline options without fabricating a model for a profile that has not yet
  been selected by the fallback runner.
- [`chatV2ProviderRegistry.ts`](../packages/core/src/model/chat-v2/chatV2ProviderRegistry.ts)
  owns the closed capability table for Rivet's bundled providers. Parallel-tool
  and built-in-tool checks must use it rather than duplicate provider switches.
- [`llmInvocationCoordinator.ts`](../packages/core/src/model/chat-v2/llmInvocationCoordinator.ts)
  owns the invocation-level provider/tool/terminal decision boundary. It uses
  a provider-neutral round template, so profile fallback never carries a fake
  executable model before a real candidate has been resolved. It records one
  terminal journal disposition on every completion, failure, or root-signal
  cancellation without changing the original thrown error.
- [`llmResponseMaterializer.ts`](../packages/core/src/model/chat-v2/llmResponseMaterializer.ts)
  owns SDK-structured, JSON-text, and plain-text response materialization. The
  final JSON-schema acceptance policy inspects this exact Response Data Value.
- [`llmInvocationJournal.ts`](../packages/core/src/model/chat-v2/llmInvocationJournal.ts)
  owns the append-only physical-call event collection for one invocation. It
  records a privacy-bounded snapshot for every physical call even when Usage is
  not enabled, so diagnostics cannot depend on a particular output setting.
  [`llmInvocationResultProjector.ts`](../packages/core/src/model/chat-v2/llmInvocationResultProjector.ts)
  derives the public usage and profile diagnostics from that journal and the
  fallback result. New public outputs must be added to the projector instead
  of reimplementing aggregation in the node.
  [`llmInvocationProjections.ts`](../packages/core/src/model/chat-v2/llmInvocationProjections.ts)
  contains the pure usage and profile-diagnostic projections used by that
  projector.
- [`toolCallCodec.ts`](../packages/core/src/model/chat-v2/toolCallCodec.ts),
  [`toolHandlerResolver.ts`](../packages/core/src/model/chat-v2/toolHandlerResolver.ts),
  and [`toolRoundExecutor.ts`](../packages/core/src/model/chat-v2/toolRoundExecutor.ts)
  are the canonical tool boundary: raw-call normalization, legacy
  exact-then-fuzzy handler matching, result messages/records, and the common
  ordered round contract for internal and connected delegation.
- [`ConnectedToolContinuationHost.ts`](../packages/core/src/model/ConnectedToolContinuationHost.ts)
  owns connected Delegate lifetime. `GraphProcessor` supplies narrow scheduler
  callbacks and output commits but no longer keeps a second continuation map.
- [`llmChatV2CacheBoundary.ts`](../packages/core/src/model/chat-v2/llmChatV2CacheBoundary.ts)
  owns cache-hit/write projection. [`llmChatV2NodeMigration.ts`](../packages/core/src/model/chat-v2/llmChatV2NodeMigration.ts)
  owns idempotent serialized-node normalization; generic serialization merely
  invokes that node-specific normalizer.
- [`llmProfileFallback.ts`](../packages/core/src/model/chat-v2/llmProfileFallback.ts)
  owns ordered candidate attempts, retry-before-advance coordination,
  forward-only profile stickiness across continuation rounds, full developer-visible
  attempt history, and exhausted-chain errors.
- [`llmChatV2NodeEditors.ts`](../packages/core/src/model/chat-v2/llmChatV2NodeEditors.ts)
  owns settings-panel editor definitions and must preserve labels, port ids,
  and persisted data keys.
- [`chatV2ProviderProfile.ts`](../packages/core/src/model/chat-v2/chatV2ProviderProfile.ts)
  owns built-in/custom credential precedence and creates the live provider model
  together with a secret-free `ChatV2ProviderProfile`. The profile contains only
  provider identity, normalized base URL, capability flags, and a credential
  reference; the credential value never belongs in diagnostics.
- [`chatV2RuntimeOptions.ts`](../packages/core/src/model/chat-v2/chatV2RuntimeOptions.ts)
  owns node-data/input conversion for headers, tools, provider options, and
  generation parameters. It delegates credentials to the provider-profile owner.
- [`chatV2RequestPlan.ts`](../packages/core/src/model/chat-v2/chatV2RequestPlan.ts)
  is the pure request-policy owner. It selects stream versus generate transport,
  normalizes Rivet retries, fixes AI SDK retries at zero, and carries response,
  tool, generation, provider-option, and output policy into the pipeline.
- [`chatV2Pipeline.ts`](../packages/core/src/model/chat-v2/chatV2Pipeline.ts)
  owns the Vercel AI SDK request/stream-or-generate/retry/result pipeline and
  required validation of the final parsed `Response` Data Value for JSON schema
  profile acceptance.
- [`chatV2CallObserver.ts`](../packages/core/src/model/chat-v2/chatV2CallObserver.ts)
  owns the privacy-bounded physical-call accounting event. It snapshots safe
  usage, outcome, provider/model identity, and known/unknown pricing once per
  actual provider attempt while isolating malformed provider metadata and
  throwing or rejected host callbacks.
- [`modelRegistry.ts`](../packages/core/src/model/chat-v2/modelRegistry.ts)
  owns the LLM Chat V2 pricing boundary. Its available model rates are always
  USD per token. It normalizes the legacy OpenAI and Google catalogs, whose
  rates are USD per 1,000 tokens, before Chat V2 multiplies raw provider token
  counts.
  A legacy catalog row marked `pricing: 'unpriced'` remains selectable for
  model configuration but intentionally has no Chat V2 rate, so both `Usage`
  and Response Inspector report its cost as unknown rather than `$0`.
  The observer also preserves either reported cache-read or cache-write token
  subtotal; it only omits `cachedTokens` when the provider reports neither.
  Both the `Usage` output and physical-call observer use
  `calculateChatV2UsageCost(...)`, so a missing input or output token count
  leaves cost unavailable rather than inventing `$0`. The current figure is a
  baseline text-token estimate: cached-token discounts/writes, long-context
  premiums, and provider-tool fees are intentionally not inferred from the
  incomplete cross-provider billing metadata.
- When **Output usage details** is enabled, LLM Chat aggregates every physical
  provider call made by that node invocation: retries, abandoned fallback
  profiles, and every auto-continuation model round. Its token fields sum only
  safe provider-reported values; when a provider omits a physical call's total,
  the node derives that call's total from its safe input/output counts.
  `Usage.totalCost` is present only when every physical call has a calculable
  price; a failed transport call with no usage therefore never becomes `$0`,
  but makes the exact total unavailable. Response Inspector can still display a
  known subtotal as **partial** because it also retains the per-call rows.
  Editor-cache hits make no physical calls and keep their existing cached output
  contract.
- Response-trace fallback totals count forward profile-index advances for each
  LLM node invocation. This includes profiles that failed during configuration
  and therefore produced no physical-call event when a later profile reaches a
  physical call; sticky reuse of the selected fallback profile in later
  continuation rounds is not counted again. A chain that fails entirely during
  configuration has no physical-call rows from which to infer an exact fallback
  total. A known-price attempt may still have no calculable cost when a failed
  provider request reports insufficient usage, so its trace row remains valid
  and the aggregate cost is reported as partial or unknown rather than zero.
- [`aiSdkBridge.ts`](../packages/core/src/model/chat-v2/aiSdkBridge.ts) is the
  only place that should directly adapt to Vercel AI SDK call signatures.
- [`chatV2Outputs.ts`](../packages/core/src/model/chat-v2/chatV2Outputs.ts)
  owns output-port compatibility and delegates final Response DataValue
  construction to `llmResponseMaterializer.ts`.
- [`chatV2Errors.ts`](../packages/core/src/model/chat-v2/chatV2Errors.ts) owns
  provider-error normalization and complete developer-visible messages. For observable API-call
  failures it preserves the provider's original response message, preferring the
  HTTP response body over generic SDK metadata and following nested error causes;
  Rivet guidance supplements that message instead of replacing or deduplicating it.
- [`chatV2ResponseFormat.ts`](../packages/core/src/model/chat-v2/chatV2ResponseFormat.ts)
  owns structured-output/schema normalization.
- [`providerOptions.ts`](../packages/core/src/model/chat-v2/providerOptions.ts)
  owns model/provider option resolution and model catalog integration.
- [`toolContinuation.ts`](../packages/core/src/model/chat-v2/toolContinuation.ts)
  owns auto-continuation and tool-call follow-up behavior.
- [`rivetToolRegistry.ts`](../packages/core/src/model/chat-v2/rivetToolRegistry.ts)
  owns Rivet Tool-name lookup. Blank declarations are ignored and duplicate
  declarations retain the long-standing last-declaration-wins behavior in both
  provider projection and continuation/direct-return selection.
- [`ToolNode.ts`](../packages/core/src/model/nodes/ToolNode.ts) owns Rivet-only
  `GptFunction.resultHandling` metadata. Provider adapters must project only the
  provider tool definition and must never forward this execution policy.
- [`toolContinuationConnection.ts`](../packages/core/src/model/chat-v2/toolContinuationConnection.ts)
  is the shared core/app resolver for the special continuation relationship
  formed by an eligible `LLM Chat -> Delegate Tool Call` connection.
- [`ToolCallContinuationCoordinator.ts`](../packages/core/src/model/ToolCallContinuationCoordinator.ts)
  owns connected Delegate round coordination: scalar concurrent calls,
  fail-fast-but-settled cancellation, and model-order result joining.
  [`ToolCallContinuationBranchPlanner.ts`](../packages/core/src/model/ToolCallContinuationBranchPlanner.ts)
  owns the pure temporary-branch topology/preload plan. [`GraphProcessor.ts`](../packages/core/src/model/GraphProcessor.ts)
  remains the narrow adapter and owns lifecycle events, processor construction,
  mutable run state, branch-result commits, and downstream scheduling. The LLM
  node must not directly schedule graph nodes.
- [`llmChatV2CachePolicy.ts`](../packages/core/src/model/chat-v2/llmChatV2CachePolicy.ts)
  owns whether legacy editor replay is eligible. It is deliberately disabled
  for Rivet Tool use and known provider-native tools because replay cannot
  reproduce their live side effects or Delegate lifecycle. Cache secret
  fingerprints use SHA-256 and never retain raw credentials or headers. Its
  explicit cache-key version invalidates only in-memory editor entries when
  cache identity semantics change. In From profile mode, every candidate in
  the ordered chain must be eligible; a provider-native tool in any profile
  disables the shared cache entry.

## Behavior That Must Stay Compatible

- Persisted field names, port ids, and the internal node type `llmChatV2` must
  remain stable unless a migration is added.
- The tool-call output keeps the persisted port id `function-calls` for graph
  compatibility, while the visible node output label is `Tool Calls`.
- A connection from an eligible LLM Chat `function-calls` output to an enabled
  Delegate Tool Call `function-call` input is upgraded automatically to a
  bidirectional continuation relationship only while the LLM has both
  `Tool use` and `Auto-continue after toolcalls run` enabled. The connection
  remains a normal serialized `NodeConnection`; there is no additional
  execution mode, return connection, or node state to persist.
- An LLM Chat node with `isSplitRun` / **Run per item** enabled is deliberately
  ineligible for connected continuation in this iteration. Its edge remains
  ordinary and each split invocation uses the internal continuation path; one
  shared Delegate completion cannot safely represent parallel split indexes.
- Auto-continuation requires exactly one eligible connected Delegate. When no
  eligible Delegate is connected, LLM Chat preserves its internal
  auto-delegation path. Multiple eligible Delegates are an explicit graph error
  rather than an arbitrary first-match choice. The runtime and canvas must use
  `resolveToolContinuationConnection(...)` so eligibility cannot drift between
  execution, settings, wire styling, and freeze policy.
- A connected Delegate executes once per tool call. Calls from one model round
  receive distinct process ids, scalar inputs and outputs, and run concurrently.
  The processor joins their function-result messages in original model order
  before returning them to the still-running LLM Chat node. Both nodes remain
  `Running`, and the existing multi-run UI exposes every call without a new
  waiting state.
- `GptFunction.resultHandling` defaults to `continue` when absent. A value of
  `return-direct` is terminal only when auto-continuation is enabled and the
  current provider round contains exactly one call to that declared Rivet Tool.
  The Delegate or internal handler still executes normally. After success,
  `toolContinuation.ts` uses the exact string function result as `Response`,
  appends the complete function-result message to `All Messages`, retains the
  delegated record on `Tool Calls`, and skips the next provider request. It must
  clear the raw call before GraphProcessor finalization so a connected Delegate
  cannot run again through ordinary traversal. Multiple-call rounds always use
  normal ordered continuation, including mixed and all-direct rounds.
- Direct return does not fabricate provider accounting. `Messages Sent`, request
  bodies, response tokens, usage, reasoning, and provider metadata describe only
  requests that happened. Handler cost remains on the existing delegation/graph
  path and is accumulated once. Legacy Chat, manual Delegate execution, and LLM
  Chat without auto-continuation ignore this metadata.
- `Delegate Tool Call` keeps the persisted `message` output id, now displayed as
  `Tool Result Message`, and adds `assistant-message`, displayed as
  `Message`, for nonblank assistant text
  emitted alongside that tool-call round. This output is intrinsically per-call
  and pre-tool: each invocation emits the same assistant text under its own
  process id, then starts that branch and its tool handler in parallel, with no
  persisted mode flag. Placing `Start Async Branch` at its boundary makes that
  node return immediately when the remaining work must not hold the foreground
  path open, while keeping it owned by the root run. Each invocation's scalar
  tool-result downstream branches run after that invocation finishes.
- The Delegate Tool Call canvas header includes a non-interactive two-lane
  request/response icon immediately before its title: the upper arrow represents
  incoming LLM tool calls and the lower arrow represents results returning to
  the LLM, which can continue or issue another call. An eligible connected
  LLM Chat ↔ Delegate Tool Call edge uses two inset parallel lanes with matching
  directional arrowheads at their target endpoints, one LLM → Delegate and one
  Delegate → LLM. The arrowheads are rendered over and slightly into their
  target ports so they visibly enter, rather than disappear beneath, their
  destination. These are
  presentation-only and appear at normal and zoomed-out canvas detail levels.
- Delegate Tool Call exposes **Tool Name** and **Tool Arguments** for each
  completed invocation. Tool Arguments is the normalized object actually passed
  to the handler, including parsed JSON-string arguments from legacy call
  shapes. It also exposes **Tool Execution Time (sec)**, the seconds spent in the
  handler graph or external function rather than its pre-tool or downstream
  branches. The generic output order matches the node ports: Tool Name, Tool
  Arguments, Message, Output, Tool Execution Time (sec), Tool Result Message.
- A successful or passthrough-error physical Delegate invocation emits an
  optional privacy-bounded `toolCallFinished.resultOwner` pointer to its exact
  persisted `Output` process page. It is used by Run Activity to open that
  specific tool result rather than the Tool node's function definition. The
  pointer contains only Delegate node/process/port identity; it must not carry
  arguments or result text. Failed, aborted, and internal no-Delegate paths
  omit it, so observers do not invent a tool result destination.
- Early and final Delegate branches may converge within the same tool round:
  outputs completed by the early pre-tool message branch are available to the
  final tool-result branch for that round. Do not treat prior-round branch
  outputs as fresh dependencies of a later round. When the owning LLM finishes,
  the processor promotes the latest completed continuation nodes into the
  parent scheduler so consumers waiting for the final LLM result or another late
  input run exactly once instead of losing or replaying completed branch work.
- A node executed by a temporary continuation branch must receive the owning
  graph's active output-port set, not the smaller branch slice's set. It may
  need to compute an output for a consumer that is deliberately deferred until
  the final LLM or another late input becomes available.
- Unknown/provider-built-in calls and calls left unresolved when the maximum
  tool-round count is reached remain raw final tool calls. The connected
  continuation reservation is released so the ordinary downstream Delegate
  path can process or report them instead of silently swallowing them. The
  existing raw-input contract still applies there: a single-run Delegate accepts
  one raw call, while a raw multi-call array requires split-run or an explicit
  selection step. A tool round is one provider response containing one or more
  eligible Rivet calls, so the limit does not cap individual calls. After the
  final permitted round completes, the continuation loop makes one final
  provider request for the model's answer; any calls in that response are the
  unresolved raw calls described above and must not start another continuation
  round.
- A connected continuation Delegate cannot use frozen or preloaded output
  replay. The runtime rejects either boundary before tool side effects begin;
  silently bypassing it would make the visible editor/run-from boundary lie,
  while replaying it would skip the required per-round request/return exchange.
- Synthetic early/final continuation branches must not partially take ownership
  of nodes whose normal scheduler semantics depend on a cycle, loop/race
  attachment, Loop Controller, Race Inputs, self-loop, or foreground rejoin.
  A candidate still waiting on the final LLM/tool result or another late input
  remains for ordinary parent scheduling, and an unsafe completed dependency is
  not preloaded. If a pre-tool candidate is already ready but is itself unsafe,
  or the owning LLM/Delegate has unsafe ownership, the round fails before tool
  side effects. `Start Async Branch` is an unconditional continuation boundary:
  the continuation slice stops at the trigger and the root-owned async scheduler
  receives its complete closed subtree.
- `maxTokens` remains both the persisted field name and the input id even when a
  provider or SDK calls it `maxOutputTokens`.
- Credential resolution must preserve the current priority: explicit input
  credentials when configured; built-in providers use configured settings with
  legacy plugin/env fallback; custom providers use their named top-level runtime
  setting, then their node-specific env var, then the shared custom-provider
  setting.
- Request diagnostics should use `summarizeChatV2RequestPlan(...)`, which omits
  the live SDK model, prompt contents, and credential values. Never serialize a
  provider model or `ChatV2CredentialResult.value` for logging.
- `RunGraphOptions.onChatV2CallFinished` observes physical provider attempts,
  not logical node runs or recordings. It emits once for success, provider
  failure, or an in-flight abort, including explicit Rivet retries, and never
  includes prompts, request bodies, raw errors, provider metadata, headers, or
  credentials. Missing usage and unknown pricing remain absent rather than
  becoming zero. Core and Node run/processor entry points must forward the hook
  onto the live `ProcessContext`; replayed or frozen work emits no synthetic
  event. Observer exceptions and accidentally returned rejected promises must
  never affect graph execution.
- The `API key source` helper text in `llmChatV2NodeEditors.ts` is part of the
  user-facing credential contract: `Configured key` must explain the matching
  Settings > LLM key plus the programmatic runtime setting or env fallback for
  the selected provider, while `Input port` must explain that the `API Key` port
  is used instead.
- Undefined SDK request fields should be omitted rather than serialized as
  explicit `undefined` provider options.
- New LLM Chat nodes leave optional generation fields such as `topP` unset
  unless the user configures them or enables the matching input port.
- [`customProviderApi.ts`](../packages/core/src/model/chat-v2/customProviderApi.ts)
  owns the Custom protocol enum, editor options, legacy default, and validation
  so node data, profile normalization, and provider construction cannot drift.
  Custom provider protocol is profile-owned. Missing `customProviderApi` means
  `completions`, preserving serialized projects and the existing
  `@ai-sdk/openai-compatible` Chat Completions path. Opt-in `responses` uses the
  `@ai-sdk/openai` Responses model with provider name `custom`, the normalized
  Custom base URL, and the same credentials, headers, diagnostic fetch hooks,
  fallback chain, streaming, and tool-continuation pipeline. Unsupported
  serialized values fail locally before Rivet creates a provider request.
- The Responses adapter must not leak the built-in OpenAI credential into
  Custom mode. A configured but unresolved Custom credential remains a local
  configuration failure; Rivet never retries the request anonymously. To use
  an intentionally keyless endpoint, the workflow developer must clear both
  alternative key names and leave the shared Custom key empty. In that case,
  remove only the adapter-generated empty `Authorization: Bearer` header.
  Preserve an explicit Authorization header supplied by the workflow
  developer in either protocol mode.
- Custom Completions model creation must keep AI SDK structured-output support
  enabled and preserve Rivet's raw `providerOptions.custom.response_format`
  override. Custom Responses must instead use the adapter-owned structured
  output contract and place OpenAI-adapter options under
  `providerOptions.openai`; do not emit the Chat Completions raw override there.
- A Custom base URL may be entered as a base, `/chat/completions`, or
  `/responses` endpoint. `normalizeOpenAICompatibleEndpoint` validates an
  absolute HTTP(S) URL, removes either recognized endpoint suffix and redundant
  trailing slashes, and discards fragments. It preserves ordered query pairs
  outside the base URL; the provider fetch wrapper reapplies them after the
  selected adapter appends its endpoint path. Explicitly configured query
  values replace adapter-generated values with the same key. Cache identity
  fingerprints query values rather than retaining them verbatim. A malformed
  profile URL is a configuration failure for that candidate, so a fallback
  chain may continue without issuing a broken request.
- `customProviderApi` is optional on physical model-call events and response
  traces for recording compatibility. New Custom calls set it on LLM Attempts,
  fallback candidates, Run Activity rows, and Response Inspector rows so equal
  model names remain distinguishable as Custom Completions or Custom Responses.
- Tool calling and structured output stay mutually exclusive where the current
  runtime enforces that restriction.
- Structured-output fallback, deduping, and schema validation must stay covered
  by tests before moving normalization code.
- Streaming output must preserve response text, all messages, request body,
  response body, usage, reasoning, and the opt-in chronological `LLM Attempts`
  output.
- `Prompt` and `Assemble Message` can create distinct `system` and `developer`
  chat messages. AI SDK's provider-neutral `ModelMessage` exposes only `system`
  for instruction messages, so `messageConverter.ts` temporarily represents
  both roles that way. At the OpenAI and Custom OpenAI-compatible HTTP boundary,
  `developerMessageRoles.ts` restores the explicit Rivet roles in either
  chat-completions `messages` or Responses `input`. It sends the request only
  when the number of provider instruction items exactly matches the recorded
  role plan; unfamiliar or mismatched request shapes fail with a content-free
  diagnostic rather than silently downgrading a developer message or partially
  mutating the request. Anthropic and Google retain the provider-neutral system-instruction
  representation because their transports do not expose an equivalent
  developer role. The captured `LLM request body` remains the actual transformed
  body sent on the wire, not a normalized Rivet view.
- The legacy Anthropic and Google chat nodes also accept Prompt-provided
  `developer` messages. They combine those messages with their dedicated system
  input and any Prompt-provided `system` messages, then remove all instruction
  messages from the conversational message list before invoking the provider.
  Google's Generative AI key and Vertex project-credential transports both use
  the resulting provider-native system instruction.
  Their request-token estimates include the combined instruction text.
  Execution-output rendering must label developer messages explicitly rather
  than falling through to the unknown-message presentation.
- System messages supplied through the `Prompt` input are additive. An empty
  `System Prompt` input leaves them untouched; a non-empty dedicated system
  prompt is prepended without replacing any of them. The merge checks the
  coerced string value, not the truthiness of its `DataValue` wrapper.
- Provider errors must stay normalized without shortening or redacting provider
  diagnostics. The opt-in `LLM response body` output captures the raw response
  payload without consuming the SDK response stream. It deliberately omits no
  content, so workflow authors are responsible for where they expose it.
- Terminal LLM Chat failures must preserve diagnostics captured before the
  error. The node publishes its enabled `LLM request body` when an HTTP request
  was constructed, its enabled `LLM response body` when a provider response was
  received, and the enabled `LLM Attempts` / profile summary through the normal
  partial-output event before rethrowing the original error. These diagnostics
  are editor/run-history evidence only: they do not turn the failed node into a
  successful dataflow result and must never replace the originating error if
  diagnostic projection itself fails.
- Editor cache keys must keep secret fingerprints and provider/model identity
  separated enough to avoid stale catalog reuse. The editor-only cache control
  is legacy: it is visible only on nodes that already have it enabled, and once
  disabled it cannot be re-enabled through the editor.

## Docs-To-Code Coverage Matrix

Use this matrix before moving LLM Chat V2 code. Rows marked "focused" already
have owner-level tests that should be extended with any behavior move. Rows
marked "integration" are covered by broader node/pipeline tests today; add a
focused owner-level test before extracting that behavior.

| Contract area                                                                                                                           | Primary owner                                                                                                                                                                         | Current coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Persisted node type, data keys, port ids, labels, and `maxTokens` compatibility                                                         | `LLMChatV2Node.ts`, `llmChatV2NodeData.ts`, `llmChatV2NodeEditors.ts`                                                                                                                 | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration                                               |
| Provider/model option resolution, catalog labels, and pricing availability                                                              | `providerOptions.ts`, `modelRegistry.ts`, `llmChatV2NodeEditors.ts`                                                                                                                   | `packages/core/test/model/chat-v2/providerOptions.test.ts`, `packages/core/test/model/chat-v2/modelRegistry.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                    | focused                                                   |
| Credential lookup and secret-free provider identity                                                                                     | `chatV2ProviderProfile.ts`, `llmChatV2NodeRuntime.ts`                                                                                                                                 | `packages/core/test/model/chat-v2/chatV2ProviderProfile.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                        | focused                                                   |
| Stream/generate selection, retries, request/output policy, and complete developer inspection                                            | `chatV2RequestPlan.ts`, `chatV2Pipeline.ts`                                                                                                                                           | `packages/core/test/model/chat-v2/chatV2RequestPlan.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                         | focused                                                   |
| Custom-provider base URL/header handling, generation parameters, and omission of unset SDK fields                                       | `llmChatV2NodeRuntime.ts`, `chatV2RuntimeOptions.ts`                                                                                                                                  | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration                                               |
| Custom-provider JSON-schema `response_format` override and provider option conflict handling                                            | `chatV2ResponseFormat.ts`, `chatV2RuntimeOptions.ts`                                                                                                                                  | `packages/core/test/model/chat-v2/chatV2ResponseFormat.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                         | focused                                                   |
| Tool use versus structured output mutual exclusion                                                                                      | `chatV2FeatureCompatibility.ts`, `llmChatV2NodeRuntime.ts`, app editor validation                                                                                                     | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration                                               |
| SDK request streaming/non-streaming transport, stream consumption, and parsed-output fallback                                           | `aiSdkBridge.ts`, `chatV2Pipeline.ts`, `chatV2Outputs.ts`                                                                                                                             | `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`                                                                                                                                                                                                                                                                                                                                                                                             | focused                                                   |
| Structured-output dedupe, schema validation, and response typing                                                                        | `chatV2ResponseFormat.ts`, `chatV2Pipeline.ts`, `chatV2Outputs.ts`                                                                                                                    | `packages/core/test/model/chat-v2/chatV2ResponseFormat.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`                                                                                                                                                                                                                                                                                                                            | focused                                                   |
| Message normalization and provider-neutral message conversion                                                                           | `messageConverter.ts`, `chatV2Pipeline.ts`                                                                                                                                            | `packages/core/test/model/chat-v2/messageConverter.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                          | focused                                                   |
| Tool conversion, `Tool Calls` output label / `function-calls` output id, output shape, and internal auto-continuation                   | `toolConverter.ts`, `toolContinuation.ts`, `chatV2Pipeline.ts`                                                                                                                        | `packages/core/test/model/chat-v2/toolContinuation.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                          | focused                                                   |
| Connected Delegate resolution, round coordination, branch planning, pre-tool message branch, unresolved-call release, and freeze policy | `toolContinuationConnection.ts`, `ToolCallContinuationCoordinator.ts`, `ToolCallContinuationBranchPlanner.ts`, `GraphProcessor.ts`, `DelegateFunctionCallNode.ts`, app canvas helpers | `packages/core/test/model/chat-v2/toolContinuationConnection.test.ts`, `packages/core/test/model/GraphProcessor.toolContinuation.test.ts`, `packages/core/test/model/ToolCallContinuationCoordinator.test.ts`, `packages/core/test/model/ToolCallContinuationBranchPlanner.test.ts`, `packages/core/test/model/nodes/DelegateFunctionCallNode.test.ts`, `packages/app/src/components/nodeCanvas/toolContinuationWireState.test.ts`, `packages/app/src/components/nodeCanvas/nodeCanvasContextMenuModel.test.ts` | focused                                                   |
| Output contracts for response, messages, usage, reasoning, opt-in LLM Attempts/request/response bodies, and control-flow exclusions     | `LLMChatV2Node.ts`, `llmInvocationResultProjector.ts`, `chatV2UsageAccounting.ts`, `chatV2Outputs.ts`, `chatV2Pipeline.ts`                                                            | `packages/core/test/model/chat-v2/chatV2UsageAccounting.test.ts`, `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/llmProfileFallback.test.ts`                                                                                                                                                                                                                                                            | focused                                                   |
| Provider/API/fetch error normalization, status extraction, retry classification, and developer-visible diagnostics                      | `chatV2Errors.ts`, `chatV2Retry.ts`, `chatV2Pipeline.ts`, `llmProfileFallback.ts`                                                                                                     | `packages/core/test/model/chat-v2/chatV2Errors.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/llmProfileFallback.test.ts`                                                                                                                                                                                                                                                                                                                               | focused                                                   |
| Editor cache identity, secret fingerprinting, clone-on-read/write, and project/node scoping                                             | `chatV2EditorCache.ts`, `llmChatV2NodeRuntime.ts`                                                                                                                                     | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | integration; add focused editor-cache tests before moving |
| Legacy Chat compatibility boundary                                                                                                      | `ChatNodeBase.ts`, `ChatNode.ts`, `ChatLoopNode.ts`                                                                                                                                   | legacy node tests and compile checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | compatibility-only; do not refactor for polish            |

## Refactor Rule

For LLM Chat V2 refactors, update this contract and add or extend focused
`packages/core/test/model/chat-v2/*` coverage before moving provider or SDK
normalization code. Legacy chat files may be touched only to preserve
compatibility with existing legacy graphs.

Non-streaming structured-output handling has one important tool-use edge case:
the Vercel AI SDK only completes `output` parsing on final `stop` rounds. A
round that finishes with `tool-calls` can still be a successful Rivet result
because its useful payload is the tool call list, not a completed schema object.
`aiSdkBridge.ts` must therefore treat missing SDK `output` on non-`stop` rounds
as absent parsed output and keep the tool calls instead of surfacing
`AI_NoOutputGeneratedError`. Completed `stop` rounds must still preserve parsed
SDK output so JSON and JSON-schema responses keep their typed `Response` value.
If the SDK throws `AI_NoObjectGeneratedError` while parsing a completed
non-streaming structured response, the bridge must recover the raw text and let
the normal Rivet fallback parse/string-output path handle it, matching the
streaming path instead of failing the node solely because the SDK parser rejected
the final text. The non-streaming bridge also collects SDK step tool calls before
the final output parser runs so recovered parse failures keep any tool-call
metadata that was already emitted by earlier steps.
