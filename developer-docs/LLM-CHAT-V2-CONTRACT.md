# LLM Chat V2 Contract

The user-facing `LLM Chat` node is the current chat node. Its persisted internal
node type is `llmChatV2`; legacy `Chat` / `Chat Loop` nodes remain compatibility
paths and should not be used as the primary target for new provider refactors.

## Ownership Map

- [`LLMChatV2Node.ts`](../packages/core/src/model/nodes/LLMChatV2Node.ts) owns
  the node implementation boundary and delegates runtime work to `chat-v2`.
- [`llmChatV2NodeData.ts`](../packages/core/src/model/chat-v2/llmChatV2NodeData.ts)
  owns persisted node data shape, defaults, and migration-compatible fields.
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
  owns the Vercel AI SDK request/stream-or-generate/retry/result pipeline.
- [`aiSdkBridge.ts`](../packages/core/src/model/chat-v2/aiSdkBridge.ts) is the
  only place that should directly adapt to Vercel AI SDK call signatures.
- [`chatV2Outputs.ts`](../packages/core/src/model/chat-v2/chatV2Outputs.ts)
  owns output DataValue construction and output-port compatibility.
- [`chatV2Errors.ts`](../packages/core/src/model/chat-v2/chatV2Errors.ts) owns
  provider-error normalization and secret-safe messages.
- [`chatV2ResponseFormat.ts`](../packages/core/src/model/chat-v2/chatV2ResponseFormat.ts)
  owns structured-output/schema normalization.
- [`providerOptions.ts`](../packages/core/src/model/chat-v2/providerOptions.ts)
  owns model/provider option resolution and model catalog integration.
- [`toolContinuation.ts`](../packages/core/src/model/chat-v2/toolContinuation.ts)
  owns auto-continuation and tool-call follow-up behavior.

## Behavior That Must Stay Compatible

- Persisted field names, port ids, and the internal node type `llmChatV2` must
  remain stable unless a migration is added.
- The tool-call output keeps the persisted port id `function-calls` for graph
  compatibility, while the visible node output label is `Tool Calls`.
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
- The `API key source` helper text in `llmChatV2NodeEditors.ts` is part of the
  user-facing credential contract: `Configured key` must explain the matching
  Settings > LLM key plus the programmatic runtime setting or env fallback for
  the selected provider, while `Input port` must explain that the `API Key` port
  is used instead.
- Undefined SDK request fields should be omitted rather than serialized as
  explicit `undefined` provider options.
- New LLM Chat nodes leave optional generation fields such as `topP` unset
  unless the user configures them or enables the matching input port.
- Custom-provider model creation must keep AI SDK structured-output support enabled,
  and the raw `response_format` override behavior must remain intact.
- Tool calling and structured output stay mutually exclusive where the current
  runtime enforces that restriction.
- Structured-output fallback, deduping, and schema validation must stay covered
  by tests before moving normalization code.
- Streaming output must preserve response text, all messages, request status,
  request body, usage, reasoning, and response-error ports.
- `Prompt` and `Assemble Prompt` system messages remain system messages through
  Rivet's provider-neutral AI SDK request. The captured `LLM request body` is
  intentionally the provider's actual wire body, not a normalized Rivet view:
  OpenAI Responses uses `input` and represents system instructions as
  `developer` items, while OpenAI-compatible chat-completions providers keep
  them as `system` entries in `messages`. Do not rewrite either transport merely
  to make the diagnostic shape uniform.
- System messages supplied through the `Prompt` input are additive. An empty
  `System Prompt` input leaves them untouched; a non-empty dedicated system
  prompt is prepended without replacing any of them. The merge checks the
  coerced string value, not the truthiness of its `DataValue` wrapper.
- Provider errors must stay normalized and secret-safe; do not log raw provider
  payloads or credentials.
- Editor cache keys must keep secret fingerprints and provider/model identity
  separated enough to avoid stale catalog reuse.

## Docs-To-Code Coverage Matrix

Use this matrix before moving LLM Chat V2 code. Rows marked "focused" already
have owner-level tests that should be extended with any behavior move. Rows
marked "integration" are covered by broader node/pipeline tests today; add a
focused owner-level test before extracting that behavior.

| Contract area                                                                                                                                   | Primary owner                                                                     | Current coverage                                                                                                                                                                     | Status                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Persisted node type, data keys, port ids, labels, and `maxTokens` compatibility                                                                 | `LLMChatV2Node.ts`, `llmChatV2NodeData.ts`, `llmChatV2NodeEditors.ts`             | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                               | integration                                               |
| Provider/model option resolution and catalog labels                                                                                             | `providerOptions.ts`, `modelRegistry.ts`, `llmChatV2NodeEditors.ts`               | `packages/core/test/model/chat-v2/providerOptions.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                   | focused                                                   |
| Credential lookup and secret-free provider identity                                                                                             | `chatV2ProviderProfile.ts`, `llmChatV2NodeRuntime.ts`                             | `packages/core/test/model/chat-v2/chatV2ProviderProfile.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                             | focused                                                   |
| Stream/generate selection, retries, request/output policy, and secret-free inspection                                                           | `chatV2RequestPlan.ts`, `chatV2Pipeline.ts`                                       | `packages/core/test/model/chat-v2/chatV2RequestPlan.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                              | focused                                                   |
| Custom-provider base URL/header handling, generation parameters, and omission of unset SDK fields                                               | `llmChatV2NodeRuntime.ts`, `chatV2RuntimeOptions.ts`                              | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                               | integration                                               |
| Custom-provider JSON-schema `response_format` override and provider option conflict handling                                                    | `chatV2ResponseFormat.ts`, `chatV2RuntimeOptions.ts`                              | `packages/core/test/model/chat-v2/chatV2ResponseFormat.test.ts`, `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                              | focused                                                   |
| Tool use versus structured output mutual exclusion                                                                                              | `chatV2FeatureCompatibility.ts`, `llmChatV2NodeRuntime.ts`, app editor validation | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                               | integration                                               |
| SDK request streaming/non-streaming transport, stream consumption, and parsed-output fallback                                                   | `aiSdkBridge.ts`, `chatV2Pipeline.ts`, `chatV2Outputs.ts`                         | `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`                                                                  | focused                                                   |
| Structured-output dedupe, schema validation, and response typing                                                                                | `chatV2ResponseFormat.ts`, `chatV2Pipeline.ts`, `chatV2Outputs.ts`                | `packages/core/test/model/chat-v2/chatV2ResponseFormat.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`, `packages/core/test/model/chat-v2/chatV2Outputs.test.ts` | focused                                                   |
| Message normalization and provider-neutral message conversion                                                                                   | `messageConverter.ts`, `chatV2Pipeline.ts`                                        | `packages/core/test/model/chat-v2/messageConverter.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                               | focused                                                   |
| Tool conversion, `Tool Calls` output label / `function-calls` output id, output shape, and auto-continuation                                    | `toolConverter.ts`, `toolContinuation.ts`, `chatV2Pipeline.ts`                    | `packages/core/test/model/chat-v2/toolContinuation.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                               | focused                                                   |
| Output contracts for response, messages, tokens, usage, reasoning, status/error/request-body details, retry arrays, and control-flow exclusions | `chatV2Outputs.ts`, `chatV2Pipeline.ts`                                           | `packages/core/test/model/chat-v2/chatV2Outputs.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                                  | focused                                                   |
| Provider/API/fetch error normalization, status extraction, retry classification, and secret-safe messages                                       | `chatV2Errors.ts`, `chatV2Retry.ts`, `chatV2Pipeline.ts`                          | `packages/core/test/model/chat-v2/chatV2Errors.test.ts`, `packages/core/test/model/chat-v2/chatV2Pipeline.test.ts`                                                                   | focused                                                   |
| Editor cache identity, secret fingerprinting, clone-on-read/write, and project/node scoping                                                     | `chatV2EditorCache.ts`, `llmChatV2NodeRuntime.ts`                                 | `packages/core/test/model/nodes/LLMChatV2Node.test.ts`                                                                                                                               | integration; add focused editor-cache tests before moving |
| Legacy Chat compatibility boundary                                                                                                              | `ChatNodeBase.ts`, `ChatNode.ts`, `ChatLoopNode.ts`                               | legacy node tests and compile checks                                                                                                                                                 | compatibility-only; do not refactor for polish            |

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
