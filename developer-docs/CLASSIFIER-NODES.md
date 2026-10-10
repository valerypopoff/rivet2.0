# Classifier node family

Classifier is a first-party Core node family, not a plugin. The canonical node types are `classifierQuestion`, `classifierProfile` and `classifierEvaluate`; they are registered by `registerBuiltInNodes` and appear only in the built-in **Classifier** context-menu group. The editor's fixed `addContextMenuGroups` list must include that group: registration and generated Graph Builder catalog entries alone do not make a node discoverable in the palette.

## Built-in type and documentation integration

Adding a profile family must also update the global-variable codec, the complete
coercion compatibility matrix, and the editor's node-documentation URL map.
Scalar/array `classifier-config` ports remain incompatible with `llm-config`.
Deferred ports retain the existing permissive wiring policy, but resolving their
values still rejects conversion between profile families. Object conversion is permitted, with provider-specific validation
at Evaluate's bounded boundary. Project global variables accept version-1
profile envelopes using the same structural rules as LLM profiles. The codec
preserves values rather than resolving credentials; explicitly persisting a
resolved profile also persists its credential, so use Profile nodes for secrets.

The Classifier Profile reference page must be registered in the editor Help map,
Node Reference index and documentation sidebar. `GlobalVariables.test.ts`,
`coerceType.test.ts` and `nodeDocumentation.test.ts` enforce these contracts;
include them when validating a new built-in type, not only the node's own tests.

## Profiles and ordered fallback

The Profile inspector mirrors the LLM Profile's collapsible suspension section:
host-capability notice and enable toggle, followed by response timeout, failure
threshold, rolling failure window and suspension duration only when enabled.
Each setting retains the corresponding LLM hint, adapted for classifiers. With
suspension disabled, only the notice and toggle appear inside the section, just
like LLM profiles.
Classifiers are non-streaming, so there is no stream-inactivity field. Their
response deadline sits inside the section, immediately after the toggle. The
entire suspension policy, including response deadlines, is inert when disabled
or without an executing project and host-supplied health store, matching LLM
profiles. Saved values remain intact when disabled. Evaluate's separate overall
execution deadline still bounds the run. Do not describe response deadlines as
independent of suspension, or suspension itself as merely skipping a profile.

Both families import the same concise notice, toggle and failure-policy hints
from `model/profileSuspensionHints.ts`; do not maintain family-specific copies.
Classifier batch deadlines and LLM first-output/stream deadlines retain short,
execution-specific hints. Presentation tests compare the actual shared editor
hints across both families to prevent wording drift.

Timing editor defaults, bounds and steps use **stored milliseconds**, with
`storageMultiplier: 1_000` converting to displayed seconds. Profile defaults
come from the same constants as runtime resolution: 0.5 seconds for response,
three failures, 300 seconds for the rolling window and suspension. Evaluate's
overall timeout uses the same units (30 seconds inline, 180 seconds in profile
mode). Reading defaults never writes them to the node or reinterprets explicit
saved values. The 500 ms response default applies to new profiles and absent
settings; explicit saved timeouts remain unchanged. The profile response timeout
accepts fractional seconds with millisecond precision (minimum and step: 0.001
seconds); for example, 0.25 seconds stores 250 ms. The failure window, suspension
duration and Evaluate overall
timeout retain a one-second editing step. Tests cover native definitions and
rendered defaults, fractional response deadlines, constraints, hints and toggle
behavior.

`ClassifierProfileNode` produces a version-1 sensitive `classifier-config` value containing resolved provider/model/credentials and optional suspension policy. `classifier/profile.ts` owns selection, validation, cumulative chain limits (1–128 candidates), timing and route identity. Classifier and LLM configuration types are intentionally distinct. Missing credentials make a candidate unavailable; invalid authored configuration fails instead of being hidden by fallback.

Evaluate keeps legacy Inline mode as the default. From profile hides inline configuration inputs and accepts one profile or a preserved ordered array (including Array's `any[]` output). Its total chain budget defaults to 180 seconds, independent of the retained inline 30-second setting. When hosted suspension is enabled, profile response budgets default to 0.5 seconds and include retries and their waits. These are repeated requests to the same provider (automatic transport/rate-limit retries and Evaluate's opt-in non-200 retries), not attempts of subsequent profiles. Each candidate gets one budget, not a fresh timeout per retry; a short budget may expire before a retry can occur. When suspension is inactive, only the remaining overall execution budget limits a candidate. Profiles use one cumulative deadline-aware validation/snapshot traversal, rather than a whole-chain scan plus fresh per-candidate scans. Shared State/questions are validated and detached before health or provider calls. A candidate's unsupported evidence fails that candidate without discarding content; malformed shared evidence fails the node before attempts. The first validated response wins. There is no cross-candidate answer merging, numerical reinterpretation or stream timing.

`classifier/profileExecution.ts` runs classifier-specific fallback while reusing bounded health operations and atomic permits from the LLM reliability infrastructure. Transport/timeouts/408/429/5XX count once per failed candidate, not per physical retry. Interrupted response-body receipt is a transport failure; invalid UTF-8/JSON is response parsing, while an invalid answer shape is response validation. Authentication, input/capability failures, malformed responses and cancellation finish permits as ignored. Suspension is opt-in and requires an injected `llmProfileHealthStore`; its absence disables durable suspension, not fallback. Health-service errors fail open with bounded diagnostics, and stale completions cannot resurrect cleared entries. Classifier keys use a separate namespace and `family: classifier`; legacy entries without a family are LLM. Provider/model/credential and project/source-node identity determine health; display-name/policy edits do not reset it.

The non-2XX suppression switch applies only when all attempted candidates ended in HTTP rejection. Mixed configuration, transport, timeout or response-validation failures still throw unless Catch all failures is enabled. Classify terminal candidate errors rather than physical retries, and never infer the entire chain's failure category from its last diagnostic cause.

The overall deadline is checked after provider completion and after bounded health completion. A response cannot become successful node output merely because it arrived before a slow health update exhausted the chain budget. Provider health still describes the validated provider response, not the speed of the health service. Health-service failures remain fail-open and their attempt diagnostics use a fixed safe message rather than an injected service's potentially sensitive exception text. Fully suspended chains make no provider calls; concurrent expired suspensions admit only one recovery probe through the shared atomic permit.

Failed-request health cleanup observes the same deadline: expiration overrides HTTP-only suppression, even on the final candidate, and records a timeout decision. Cancellation during admission or completion must never become caught outputs or advance fallback; a late admitted permit is finished as ignored without calling the provider. Regression tests cover these races using controlled clocks and promise gates, rather than timing-dependent sleeps.

The existing `llmProfileAttempt` event gains an optional family discriminator and non-streaming `response` timeout kind. Existing recording/debugger/activity paths carry it without a second event bus. Provider-internal failure classifications are mapped to these public fields, not spread into strict recording events. Optional `classifierAttempts` and `classifierProfileSummary` outputs contain sanitized decisions, not bodies or credentials; caught exhaustion retains them. Summaries use the terminal execution outcome, ignoring health-service observations: an earlier successful receipt cannot hide a later deadline failure, and a health-update failure cannot relabel a successful candidate. Native request/response bodies and Evaluate's Usage/Cost outputs remain from the winner only for compatibility.

Physical request events retain an optional `classifierUsage` receipt containing only safe nonnegative integer input/output token counts and, when pricing recognizes the requested/returned model pair, `estimatedCostUsd`. A decoded response with invalid answers can still carry usable usage; malformed JSON, unsafe counts and unread receipts cannot. No raw model string, response body or credential is copied into receipts. Attempts, debugger/recording replay and Response Inspector expose those receipts; the inspector's aggregate token/cost summary includes known failed-attempt receipts and marks unpriced or unavailable request costs **partial**/**unknown**, never free. Health observations, configuration failures, suspension skips and unreached candidates are not additional physical requests. Estimates do not claim to represent the provider's invoice.

The shared Configuration editor offers undoable extraction to a Profile. It moves active model/key wires (including midpoints), partitions recoverable connections, preserves State/question wires, copies response timing and retains Evaluate-owned retry/output controls. Extraction uses the editor's ordinary node-creation path and preferences; undo/redo preserve the generated node identity and wiring. Profile and Evaluate obtain provider/model/credential settings from the same definition helper, without constructing temporary nodes. Studio Server's separate Classifier profile suspension tab uses the same durable JSON-backed store and recording contributor links, with family-filtered list/reset operations; clearing classifier history cannot clear LLM history. No new health database/schema version is required. All existing host injection paths also support classifier identities.

Regression coverage lives in `ClassifierProfiles.test.ts`, the extraction domain tests, durable-store family tests and `jev-nodes.spec.ts`. Mock HTTP checks assert inline/profile parity across all three providers; they do not prove live credentials or provider availability. Run Activity and Response Inspector preserve classifier-family events and use non-streaming response-timeout labels. Regenerate the graph-builder catalog and the Node package's hosted web-app client after changing built-in node metadata or trace validation contracts.

Response Inspector uses family-neutral **Profile fallbacks** and **Profile attempts** labels because a trace can include LLMs, classifiers, or both; the shared counters must not imply that classifier fallback was an LLM call. Classifier failures include optional typed `failureKind` diagnostics: configuration, capability, authentication, transport, HTTP, timeout, response parsing or response validation. The inspector renders this category; old recordings without it remain valid. HTTP 401/403 retain HTTP failure-control semantics but are classified as authentication in diagnostics. Categories and sanitized errors never depend on matching provider error text.

The end-to-end Core graph regression runs the real Profile → Array → Evaluate path in normal and split modes, and after serialization, prefab resolution, bundle validation and cross-project profile loading. Only node settings are serialized; resolved credentials are runtime-only. `helpers/classifier-health-contract.ts` exercises competing stores, single recovery ownership, renewal, stale-result/reset fencing and recording contributor links against two SQLite connections and real PostgreSQL pools in `test:async-managed`. `test:migration-managed` verifies exact classifier-family health JSON, suspension identity and recording evidence through both legacy and live SQLite operational transfer; these use the existing health table, not a second storage schema.

Successful chains emit `outcome: skipped, skipReason: unreached` for remaining profiles. These events appear as **not reached**, not as suspension, and do not inflate the Response Inspector fallback counter. Run Activity retains both `failureKind` and `skipReason` during live execution and replay; neither carries provider bodies or credentials.

Managed health transitions use PostgreSQL's clock. Recovery contract tests wait
the duration between the store's `updatedAt` and `openUntil`, not the difference
between a database timestamp and the test host's clock; Docker/remote clock skew
must not turn a still-open circuit into a false recovery-ownership failure.

## Ownership and provider contract

- `ClassifierQuestionNode` is a pure definition builder. It has Choice, Score, and Noul modes but never reads credentials or calls a provider.
- `ClassifierEvaluateNode` owns active-port reads, bounded variadic flattening, API-key source selection, executor policy, and output projection. Providers own the shared preparation boundary for graph and direct calls. Its always-on output contract is **Answers**, **Usage**, and **Cost**; do not restore a Model port. The provider's resolved model remains available only in the opt-in raw response-body diagnostic.
- `classifier/providers.ts` owns the ordered provider registry. A provider has a stable ID, label, default model, default credential names, browser policy, optional static token pricing, and an `evaluate` adapter. Its successful result carries the aggregate response plus the exact JSON request and response bodies at the provider boundary. Use `createApiCompatibleClassifierProvider` for a future System One-compatible provider with a static Core-owned endpoint. New Evaluate nodes keep Model empty and resolve the selected provider's default at runtime; explicit existing models stay authored contracts.
- Jev is the first provider. Its specification owns the fixed TypeSafe System One endpoint and protocol mapping. All providers use one shared runner for preparation, retry/backoff, abort cleanup and high-level error summaries with preserved diagnostic causes. Its Core-owned USD pricing is fixed at **$0.042 / MTok input** and **$0 / MTok output**. Do not make this graph-authored or infer an unpriced future provider is free.
- Liquid AI uses stable provider ID `liquid`, default model `d1`, and the fixed `https://api.liquid.ai/decisions/v1/systemone` endpoint through the same System One adapter. Existing Choice, Score and Noul questions (including structured entries, legacy criteria and exact IDs) require no migration or rewriting. Its default credentials are `liquidApiKey` / `LIQUID_API_KEY`; saved credentials use `settings.classifierProviders.liquid.apiKey`. Liquid never reads Jev's legacy plugin credential. Both desktop and hosted Settings → Classifier enumerate the registry, as do both hosts' environment loaders. Node execution is required for both providers.

Liquid d1's Core-owned accounting rate is **$0.04 / MTok input** and **$0 / MTok output**, published in [Liquid's d1 announcement](https://www.liquid.ai/blog/d1-decision-model). The [decision-model API documentation](https://docs.liquid.ai/lfm/models/decision-models) defines the compatible question/response protocol. The Model placeholder and canvas default follow the selected provider. Switching providers does not overwrite an explicit authored or input-supplied model: clear Model to use the new provider's default. Calibrated thresholds may need reevaluation when changing models, even though the question format is compatible.

### OpenAI Decisions and image evidence

For multiple multimodal messages, connect each Assemble Message's ordered text/image Part inputs, set Type to **User** (or supply `user` through Type's input toggle), then connect their Message outputs to Assemble Prompt and its Prompt output directly to Evaluate's State. Array's Output is also supported. Assemble Prompt produces one ordered `chat-message[]` list, not a flattened message; each Message input accepts either a scalar message or an existing message array. Its numeric port order is preserved. Its optional empty-message filter retains image-only evidence; Anthropic cache-breakpoint metadata is ignored by Classifier State and never forwarded to decision providers. Keep arrays of messages distinct from arrays of content parts: OpenAI emits one native `input` message per assembled message, retaining boundaries and order. The [OpenAI Decisions input schema](https://developers.openai.com/api/reference/resources/decisions) currently permits only `role: "user"`; this is not the Chat/Responses role contract. System/developer/assistant/function messages are rejected before HTTP rather than silently relabeled. Liquid/System One has no chat-role field and flattens accepted user-message content with blank-line boundaries and numbered image references. The real GraphProcessor regression uses two Assemble Message nodes, a dynamic Type input and both Array and Assemble Prompt combiners, and verifies both native payloads plus all unsupported assembled roles for every provider. Additional real-node coverage checks mixed scalar/array message inputs, numeric port ordering, filtered empty prompts, image-only messages and cache metadata. Do not add extra supported roles until the provider's decision endpoint explicitly supports them.

OpenAI has stable provider ID `openai`, default model `gpt-6-luna`, fixed endpoint `https://api.openai.com/v1/decisions`, and credentials `openAiApiKey` / `OPENAI_API_KEY`. Default configured lookup also accepts legacy `openAiKey`; custom credential names do not activate that alias. Saved classifier keys and input-key mode remain provider-scoped. All providers require Node execution. No SDK upgrade or Chat/Responses fallback is involved.

`classifier/openai.ts` maps the [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) to the existing Rivet contract: exact IDs become ordered question names; Choice criteria become typed string choices; ordered Score criteria become levels; Noul becomes predicate, with optional paired criteria appended as labeled true/false instructions. Text entries remain text; list/object entries and JSON State become JSON strings without dropping fields. Native probability arrays become exact-key maps, Score labels become the provider-owned legend, and predicate probability becomes `noul`. Shape-only numeric validation remains unchanged. Refusals fail with the question ID through ordinary failure controls; no fabricated probability or partial successful Answers is returned. Native response diagnostics remain untouched. Base USD accounting is $0.10 / MTok input and free output; provider premiums are not included.

Classifier Evaluate has one optional multimodal **State** input, not a separate Images input. `classifier/state.ts` normalizes `string`, `string[]`, `image`, `image[]`, `chat-message`, `chat-message[]`, and mixed `any[]` containing native images or user messages. Assemble Message and Array nodes retain content order and message boundaries. Ordinary `object`/`object[]` inputs always remain structured JSON; pure JSON `any`/`any[]` arrays keep their legacy meaning. Use typed `string[]` or Assemble Message for an explicit sequence of text parts. Image data URLs and recognizable bare image base64 strings become image parts; ordinary base64-compatible text stays text. No recursive search of JSON fields or new conversation semantics is introduced. Non-user messages, documents, audio, tool calls and explicit URL parts fail rather than being silently flattened or dropped. URL/path strings are ordinary text, never fetched or read. The intermediate unreleased Images port is removed; a supplied old port fails with guidance to reconnect to State.

`classifier/images.ts` validates base64 syntax, supported image headers and matching media type; native bytes are encoded synchronously. OpenAI maps ordered messages/parts to `input` user messages containing `input_text` and `input_image`; plain text and JSON retain the string request format. Liquid maps ordered parts to text with numbered `[Image N]` placeholders and a top-level ordered `images` array. Text-only message sequences are joined with newlines for System One. Images remain shared evidence for every question. Jev and Liquid `d1:free` reject images before IO. OpenAI `gpt-6-luna` allows 128 images; Liquid `d1` allows 8, a complete UTF-8 JSON body below 4.5 MB, at most 10,000 32-by-32 pixel patches, and aspect ratios at most 100:1. These are provider-boundary checks; never silently resize, discard, or split evidence. Header inspection is not a full image decoder; providers still validate encoded image content. Classifier Question has no image setting or field; ordinary `{{images}}` interpolation is unchanged.

The provider boundary snapshots all State/questions/shared images before IO and submits the complete question batch in one request per candidate, subject to the existing retry policy. There is no image-based grouping, repeated State for different question scopes, usage aggregation, or multi-request diagnostic envelope. Inline mode has one candidate; profile mode advances only after the previous candidate fails or is suspended. Request/response diagnostics retain the winning native single-call JSON shape and can contain full image data, so they must be treated as sensitive. A question definition containing an `images` field is rejected before network IO with guidance to connect images to Evaluate instead; never silently discard that evidence or promote it to shared State.

`OpenAIDecisions.test.ts` runs real Question/Evaluate nodes and mocked HTTP boundaries for mixed/legacy/structured definitions, special keys, native diagnostics, shared image bytes, snapshots, unsupported question image fields, capability rejection, refusals, retry payloads and response shape. `ClassifierState.test.ts` exercises real Assemble Message/Array/Evaluate chains, ordered native provider payloads, structured-state compatibility, bare base64 detection, rejected content and provider limits. The headless observer covers OpenAI selection, model/credential defaults, the State port and absence of separate Images/Question image controls. Live calls require an operator-supplied key; mock contract tests do not prove account/model access.

Inline image validation checks the base64 alphabet and padding geometry separately, rather than a repeated four-character regexp group that can exhaust regexp stack space on normal large images. PNG/GIF/WebP inspection decodes only the first 36 bytes while checking the complete base64 string. JPEG shares one segment parser for native bytes and base64, skipping metadata bodies and decoding a small cached byte window instead of the complete image; the cache also bounds decoder calls for repeated fill bytes. Coverage includes 4 MiB payloads, large JPEG metadata, bounded header decoding, truncated segments, malformed padding, MIME mismatches and PNG/JPEG/GIF/WebP dimension layouts.

Evaluation captures credentials, model, retry settings and transport once, alongside the detached evidence. The node starts its absolute deadline before State normalization and image encoding; adapters cannot extend it. Preparation, serialization, retries and response validation share that budget. Inline-image arrays must be dense and match their declared Rivet data type; scalar string/image/message inputs and array inputs reject mismatched containers rather than silently reinterpreting them. The 128-item limit is checked before native image encoding. A complete GraphProcessor fixture connects Graph Input → Assemble Message → Array → Evaluate → Graph Output through both providers and proves one request without array splitting. Runtime validation checks old Images connections in the executing graph as well as supplied inputs: GraphProcessor omits unknown input ports, so a value-only check would silently lose that evidence. The shared HTTP boundary disallows redirects and initiates best-effort, non-blocking body cleanup when JSON reading fails or is cancelled.

Mixed arrays and user-message parts stop at the global image limit before encoding an excess native image, not just after constructing the complete State. Structured State and internal normalized messages reject callable `toJSON` hooks, including non-enumerable hooks and array hooks: serialization must not replace already-validated evidence. The provider checks unsupported question `images` fields before serialization, so undefined/function-valued fields cannot disappear and bypass the error. Ordinary JSON string fields named `toJSON` remain data.

Provider IDs are serialized graph contracts. Add future API-compatible providers to the registry; do not add another evaluator node, a user-configurable endpoint, or provider selection from an input port without a separate security review.

### Simplified execution ownership

Provider specifications contain metadata, a fixed endpoint, request construction,
response decoding/validation and an optional evidence-policy check. The System One
compatibility factory is a thin adapter to the same runner as OpenAI. Liquid's
image limits belong to its specification; shared execution must not branch on
provider IDs. `validateClassifierEvaluationResponse` validates the common Rivet
result, independently of the native protocol. The exported
`validateApiCompatibleClassifierResponse` remains a compatibility entry point.

First-party providers expose `evaluateInput` for graph-owned Rivet State wrappers
and `evaluate` for existing provider arguments; both reference the same runner.
The node uses the former when available. Custom descriptors that implement only
`evaluate` still receive the existing normalized `state`/`stateMessages` shape.
Their resource preflight remains node-owned and uses one cumulative budget for
Model, normalized State and all active Question ports; only the shared runner path
can remove that redundant walk. The node checks its original deadline after any
provider returns, even with diagnostics disabled. Custom providers remain
responsible for bounding asynchronous waits and honoring the passed signal/deadline.
Do not add trusted-input flags, private-brand registries or validation bypasses.
The optional `stateInput` wrapper cannot be combined with nonempty provider State
or `stateMessages`.

`ClassifierValueBudget` shares cumulative byte/value accounting across Model, State
and questions. Direct provider calls require a nonblank string Model and API Key;
API keys containing line breaks fail before HTTP. Invalid scalar arguments cannot
execute JSON or string-coercion hooks, and these errors never echo credentials.
Model is bounded before whitespace validation or protocol serialization.
Its descriptor-based traversal can measure, validate plain JSON and
copy it simultaneously. Explicit structured State and each question are detached
in that single traversal, before IO. Internal `PreparedClassifierQuestion` and
`PreparedClassifierState` unions distinguish question criteria and JSON versus
message evidence; public compatibility definitions remain unchanged. Question-node
interpolation uses the same traversal to validate and copy referenced values.
It retains one budget for the complete Question preparation instead of rebuilding
it per value, so expanded work as well as bytes accumulates across active inputs.
The 100,000 expanded-value cap applies to the whole preparation, not to each field.
Interpolation expansion checks use that budget's remaining bytes directly.
Allowed root-level undefined fields remain present in template snapshots so typed
missing values retain their meaning; ordinary JSON wire serialization still omits them.
Omitted fields still consume the expanded-work and conservative byte budgets:
scan/copy cost does not disappear just because JSON omits a value. Raw multimodal
preflight also counts sparse/accessor slots without invoking their getters, and
checks cancellation during these scans. JSON snapshot validation still rejects
sparse arrays and accessors outright.
Direct provider calls reject the removed top-level `images` field before copying
arguments, including inherited/non-enumerable fields and getters. Unsupported
evidence must not disappear during argument capture or execute an accessor.

Multimodal/ambiguous Rivet inputs still need an early resource preflight before
image encoding. Normalization constructs owned message/part arrays directly and
keeps inspected image dimensions beside them for provider policy checks, not in
the wire body. Recognized image strings reuse inspection results within this
preparation only; no cross-evaluation cache exists. Ambiguous pure-JSON `any` inputs
also require plain-data validation after classification. Do not force a nominal
single-pass design by weakening either boundary.

One operation-local deadline/check is reused by preparation, provider policy,
wire measurement, attempts and response receipt. HTTP owns attempt timers and
abort-listener cleanup, retaining bounded waits and disposal of late responses.
Direct callers' effective timeout must fit the platform timer range (2,147,483,647
ms); overflow fails before HTTP rather than becoming Node's unexpected 1 ms timer.
An earlier absolute deadline can still bound a larger declared relative timeout.
The final transformed request is independently measured because native protocol
conversion can expand content, especially escaped structured JSON for OpenAI.
Serialize the wire once and reuse it for every retry. There is no JSON round-trip
to create the input snapshot. `requestBody` is an enumerable, lazy result getter:
first access parses the exact wire, later accesses return the same object. A setter
preserves the public contract for callers that replace/redact their diagnostic;
replacement never changes the immutable wire or the private validation snapshot.
This preserves direct-provider result behavior while disabled graph diagnostics incur
no reconstruction. Enabled graph reconstruction checks the original deadline
before and after parsing. Response-validation questions remain private and detached.

Built-in descriptors use `modelPricing` only. The public cost helper normalizes
legacy `pricing` at its entry point for each call, not through a persistent cache;
caller-owned mutable metadata and unknown/invalid pricing keep their old behavior.

`ClassifierExecutionPreparation.test.ts` checks actual nodes for a single raw-State
walk, the separate transformed-wire measurement, no pre-HTTP parse, opt-in diagnostics,
special keys, cumulative budgets, scalar arguments, timer bounds, diagnostic
deadlines, late custom-provider results, compatibility and ID-independent evidence
policy. Existing protocol, snapshot, resource and GraphProcessor tests
remain the behavioral contract, not implementation-source assertions.

### Optional preparation benchmark

From the repository root:

```sh
yarn workspace @valerypopoff/rivet2-core exec node --expose-gc --import tsx scripts/benchmark-classifier-preparation.mts --runs=30
```

Use `--source=<source-directory-or-compiled-core.mjs>` to compare the identical
fixture against an isolated baseline. Run variants sequentially with the same
Node/runtime, dependency set and compiled/source mode. The harness exercises real
Evaluate nodes, synthetic 64/524,288-character Unicode-and-quote structured State,
all three providers and diagnostics on/off. Five warmups precede measured runs;
HTTP is mocked and no actual credentials are read. Explicit GC is outside each
timed sample. It reports p50/p95, maximum observed post-run heap growth and sampled
process RSS; these samples are not a proof of transient allocation high-water or
production server capacity. Module/loader initialization also affects process RSS.

A local Windows/Node 22.22.3 comparison against `dfa655590`, using separately
compiled Core bundles and 30 sequential samples per case, produced the following
large-input results with request diagnostics disabled:

| Provider | p50 before/after (ms) | p95 before/after (ms) | Observed heap growth before/after (MiB) |
| -------- | --------------------- | --------------------- | --------------------------------------- |
| Jev      | 16.51 / 11.26         | 17.33 / 12.14         | 2.60 / 0.83                             |
| Liquid   | 16.75 / 11.91         | 17.72 / 12.34         | 2.60 / 0.83                             |
| OpenAI   | 17.53 / 12.19         | 18.31 / 13.22         | 4.10 / 2.08                             |

Small-input medians remained roughly 0.5 ms. Process RSS ranges were approximately
531–538 MiB before and 536–542 MiB after, dominated by loading the complete Core
bundle/dependencies; do not claim a process-RSS reduction. These are mocked local
execution measurements, not an improvement in external model inference latency.

### Card presentation

Classifier Evaluate begins with the shared collapsible **Model** group containing Provider, Model (including its input-source toggle), API key source and the conditional configured-key-name editor. It is initially expanded like LLM Chat; `defaultOpen` is only the fallback until a section preference is stored. Folding must not write node data or mark the project dirty. Serialized settings, connections and execution behavior are unchanged. UI preferences use the existing debounced, best-effort storage: an immediate reload can lose a recent fold/unfold choice, not project data.

Core coverage checks the editor hierarchy and preservation of authored settings/input connections; App coverage checks preference isolation from Outputs and LLM Chat. The hosted `jev-nodes.spec.ts` and `model-error-behavior.spec.ts` regressions cover folding, Model/API Key input modes, retained credential names, saved data, reload persistence and absence of false dirty indicators. Preference reload coverage waits for its database commit separately from the project save.

Classifier Question and Classifier Evaluate cards must use the shared `LLMNodeBody` React component, never a Markdown approximation. Its 3 px within-section field rhythm and 8 px bordered section boundary are the LLM Chat card contract. `getClassifierQuestionBodySections` and `getClassifierEvaluateBodySections` are Core-owned presentation models consumed by those cards. Keep the Markdown fallback generated from the same fields and section boundaries.

Concatenate fallback block markup directly: a newline between block tags becomes a visible blank row because node bodies use `white-space: pre-wrap`. Do not rely on inline styles or Markdown backslash escaping: the sanitizer removes inline styles and literal backslashes visibly leak into card text. The React card must preserve authored punctuation, including `{{subject}}`, dots, and hyphens, as literal text.

### Structured question authoring

`ClassifierQuestionNode` exposes TypeSafe `EntryType` values without executing user code. Its card has three sections: dimmed **Type** then **ID**, the literal authored question summary, then dimmed **Criteria**. Its **Question type** is the shared `segmented` editor—not a dropdown—with **Noul**, **Choice**, and **Score** in that order and no wrapping; **Question ID** remains its own ordinary field. **Instructions** and **Criteria** are then non-collapsible section headings. Each section begins directly with its type selector, followed by the active value editor—neither carries a duplicate visual label. The selectors remain accessible as **Instructions type** and **Criteria type**. Instructions retain independent Text, List of lines, and Object fields; only the selected field participates in interpolation ports and runtime output. Object fields use the same interpolation and JSON parsing semantics as the Object node and must resolve to a non-array object.

Every Question has one shared **Criteria type** selector immediately before **Criteria**: Text, List of lines, or Object. It chooses the representation for every authored criterion in the active Question type; it is not a per-Score-level setting. Choice keeps compatibility `options: { key, value }[]` storage for Text, while its List and Object forms retain named `choiceCriteria` entries. Names are exact response keys. Score stores ordered `scoreCriteria` entries and applies the shared selector to all of them, producing an ordered 2–10 element provider array. Noul uses the same selected representation for both `true` and `false` criteria and keeps their independent input-port toggles. All inactive representations remain saved, so switching selector types is non-destructive. Old Score criteria with no shared selector retain their per-entry type at execution for backwards compatibility. JSON-template editors provide `defaultValue: '{}'` only for display when legacy data is absent; never write that fallback merely because the editor mounted. Their default height is the shared editor minimum (200 px), not the normal full-height code-editor default.

Choice and Score's complete **Criteria** input-source toggle belongs in the trailing grid column, including for List of lines and Object forms. Their custom editors must not span both columns: doing so makes the toggle wrap onto a new left-aligned row. Noul's individual `true` and `false` toggles are separate controls and retain their local placement.

List-of-lines editors that represent required authored data, including **Instructions**, set `minimumItems: 1` and `reorderable: true`. The generic `StringListEditor` must render a blank first line for older empty data, must not let its final line be deleted, and must not make an initialization write merely to normalize an old graph. Add/edit/delete/reorder are the only persistence events. Criteria lists follow the same minimum-row rule where an empty provider entry would otherwise be invalid.

Noul's List-of-lines criteria stay inside its single **Criteria** group as two plain labeled line editors, `true` and `false`. Do not set `boxed` on those nested string lists: their own static panels make the settings unnecessarily nested while the outer group already supplies the visible boundary.

`EditorDefinitionGroup.presentation: 'section'` renders a semantic, non-collapsible heading with an unboxed child layout; use it when a settings hierarchy needs a title but no persistent panel. Its root styles must use `&.editor-section`, not `.editor-section`: the Emotion stylesheet is attached to that root, so the latter means a descendant selector and silently drops layout and spacing. Sections add a small scaled top margin before their heading, but no extra gap between the heading, type picker, and active editor. Choice and Score must not introduce another outer panel around their criterion lists: the section heading supplies the grouping, while the individual reorderable criterion cards retain their own framing. Score's Text form is the intentional exception: it is a compact sortable list of `Name` text fields rather than Monaco editors or cards. Object templates inside the richer cards likewise have no repeated `Criterion N` label; their card is the visible context. Both `EditorGroup` and top-level `DefaultNodeEditor` must apply a child's `hideIf` before creating a `CodeEditorAiAssistBridge`. The bridge is a real UI shell, so mounting it around an editor that `DefaultNodeEditorField` later hides leaves a parasitic blank row. `NodeCodeEditorWithAiAssist` and `NodeCodeEditorWithGenericAiAssist` repeat that guard at their own boundary so future callers cannot recreate the same defect. This is especially visible when the selected Instructions or Noul Criteria representation has inactive Text/Object code editors before the active form.

The Choice criteria editor is controlled by the current node data. It must commit only explicit add, edit, delete, and reorder actions; a conditional editor mounting after a Question type change must never emit an initialization write from stale local state. The Score criteria editor likewise ignores no-op Monaco callbacks and callbacks delivered after unmount, because submitting its captured full node would otherwise restore `questionType: "score"` after the user selected Choice. Keep the Choice Name and optional Description controls as equal-width, shrinkable columns. The hosted Playwright fixture switches away from Choice and back, then verifies that the persisted node type remains Choice and both columns retain comparable usable widths.

This rule also applies to the shared **Instructions type** control. The common Monaco wrapper must not invoke an outgoing callback merely because a conditionally rendered editor unmounts with unchanged text; that callback has the old node snapshot and can restore `instructionsType: "text"`. It may flush only a genuinely changed value. The debounced node-editor wrapper must cancel queued work and reject late editor callbacks after it unmounts. The hosted fixture verifies Text → List of lines → Object → List of lines without a type reverting.

Noul uses paired `noulTrueCriteria` and `noulFalseCriteria` fields with independent `useNoulTrueCriteriaInput` and `useNoulFalseCriteriaInput` ports. Both descriptions must be present when either is present; both blank omits the optional provider `criteria`. Continue reading `yesMeans`, `noMeans`, and the complete legacy `useCriteriaInput` object so old graphs and their existing `criteria` wires remain executable, but never expose the old **Yes means**/**No means** UI on new editors.

`Classifier Evaluate` follows LLM Chat's opt-in `Outputs` contract: `outputUsage` adds a calculated `totalCost` field to its existing Usage object when the selected provider has static pricing; `outputRequestBody` adds `Request body`, and `outputResponseBody` adds `Response body`. Only the display labels are shortened: port IDs remain `requestBody` and `responseBody`, preserving existing graph connections. For Jev, `totalCost` is USD input tokens × `$0.042 / 1,000,000` plus free output tokens. Keep that accounting projection separate from the response-body diagnostic: the adapter must return the exact post-serialization request JSON it sends and the complete parsed JSON response it validates; it must never return headers, resolved Rivet-managed API keys, or a Rivet-projected substitute for either body. Authored State or question content remains visible by design and must be treated as sensitive when appropriate. The API-compatible adapter serializes once before retrying so every retry sends the same immutable payload and the diagnostic cannot disagree with the wire request. The response-body output represents the successful response, without Rivet's calculated `totalCost`; transport and validation failures remain ordinary node failures rather than manufacturing a successful output.

The final **Error behavior** group mirrors LLM Chat's serialized fields and editor layout: `retryOnNon200`, `retryOnNon200RepeatTimes` (default `1`), and `retryOnNon200CooldownMs` (default `0`). Its opt-in policy retries other non-authentication, non-validation HTTP statuses after the requested fixed cooldown. It does not retry authentication (`401`/`403`) or validation (`400`/`422`) failures. Transport failures and `429`/`529` share an independent budget of two automatic retries; configured retries for other statuses do not replenish it. Mixed error sequences may exceed three requests, but both budgets remain bounded by one Evaluate timeout. Preserve the one serialized request payload across every retry.

Classifier Evaluate exposes **Run failed** and **Run error** only when
`catchRequestFailed` (**Catch all failures**) is explicitly enabled, independently
of `errorOnNon200` (**Fail on non-2XX status code**). Disabling the HTTP-status
failure setting suppresses rejected HTTP requests after retries and excludes
unavailable normal outputs through the standard node-exclusion helper; it does
not create failure ports or format diagnostics that will be discarded. With Catch all
failures enabled, success emits `Run failed: false` and an excluded Run error;
caught failures emit `Run failed: true` and the error text. Explicit graph
cancellation remains uncaught. Keep this classifier-specific port policy separate
from the shared legacy LLM Chat helper defaults. Core tests cover all three
providers and legacy/missing settings; the headless observer toggles both controls
and verifies the live canvas ports.

## Credentials and execution hosts

First-party saved credentials live at `settings.classifierProviders.<providerId>.apiKey`. The app exposes them at **Settings → Classifier**. The node still supports a graph-local API Key input and configurable programmatic/environment names.

**API key source** has three explicit modes. **Automatic** keeps serialized `configured` (and missing-source) behavior for existing graphs: named programmatic values and named environment values take precedence over saved classifier keys. OpenAI's legacy general `openAiKey` is checked after its modern programmatic key and before environment values. **Classifier settings** serializes `classifier-settings` and uses only the selected provider's saved first-party key; missing/blank keys fail without any environment, general OpenAI, input-port, custom-name or legacy-plugin fallback. **Input port** remains strict to the API Key input. Custom credential names are visible only in Automatic and remain saved when another source is selected. UI helper text explains executor-side precedence without displaying secrets or claiming the editor knows a remote executor's environment. Never silently migrate existing graphs to strict saved-key mode.

For Jev, configured lookup order is: named programmatic setting, named `pluginEnv` value, host environment, first-party saved key, then the legacy `pluginSettings.typesafe.typesafeApiKey` compatibility fallback. The fallback must remain read-only compatibility support; new code must not restore a TypeSafe plugin dependency.

Strict Classifier settings lookup requires own data properties at every step (`classifierProviders`, provider ID, and `apiKey`). Inherited keys and accessors fail without executing getters; null-prototype credential maps remain supported. Automatic retains its existing lookup semantics for compatibility.

Evaluate reads only active input ports through `classifierInputDataValue`: both the port and its Rivet `type`/`value` wrapper must use own data properties. Direct State normalization enforces the same wrapper rule. Reject accessors and inherited evidence without executing getters; do not eagerly enumerate input values or inspect unused Model/API Key ports. Check cancellation before resolving credentials.

Liquid uses the same lookup order through the saved first-party key, without a legacy fallback. Provider-scoped custom credential names remain independent when switching between Jev and Liquid.

`resolveProcessSettings` keeps an explicitly supplied `classifierProviders` map ahead of a host fallback map. Hosts can therefore provide a default credential for headless execution without overwriting a saved first-party credential.

Studio Server's hosted environment shim collects the default environment-variable
name of every built-in classifier provider and places any value in `pluginEnv`
before graph execution. This keeps Jev's `TYPESAFE_API_KEY` available in hosted
runs without restoring a plugin-specific environment path.

Both desktop and hosted environment loaders enumerate classifier-provider environment variables independently of plugins. Per-settings-load lookup deduplication ensures a shared name such as `OPENAI_API_KEY` is read once even with an uncached injected environment provider; chat/classifiers/plugins receive the same snapshot value. Hosted OpenAI key normalization keeps modern `openAiApiKey` and legacy `openAiKey` aliases consistent, preferring an explicitly saved modern key. Keep this path in sync with every provider descriptor so Node executor, desktop sidecar, CLI, Studio Server, and remote debugging resolve the same credentials. Browser execution is rejected by the provider policy before credentials or network access.

## Project migration

`normalizeClassifierProject` runs during project deserialization and transforms all graphs and node prefabs:

- `jevChoiceQuestion`, `jevScoreQuestion`, and `jevNoulQuestion` become `classifierQuestion` with `questionType` set to `choice`, `score`, or `noul`.
- `jevEvaluate` becomes `classifierEvaluate` with `provider: "jev"`.
- Default titles are renamed, custom titles are preserved, port IDs and node IDs do not change, and old API-key name overrides become provider-scoped. The same provider-scoping repair applies to the intermediate first-party `classifierEvaluate` format that stored `apiKeyNames` globally: it assigns those names to that node's selected provider (Jev when absent).
- Only the legacy `{ type: "built-in", id: "typesafe" }` project-plugin specification is removed; package or URI plugins with the same ID and all unrelated specifications remain.

The migration must remain idempotent. Apply it at every serialized project ingress and direct object-processing boundary before plugin resolution, including the remote-debugger `set-dynamic-data` upload, which carries an already-objectified project. The app also performs a clone-on-change migration before mounting the editor for browser-persisted `projectState`, the separately persisted active `graphState`, and every inactive-tab snapshot; workspace-host callbacks, their explicit `graphToLoad` override, and snapshot restoration use the same non-mutating helper. This prevents an upgraded app from reviving legacy node types from an old in-memory tab. Do not keep hidden legacy node registrations: the migration is the compatibility boundary.

## Safety and validation

Keep validation responsibilities in their owning modules: `json.ts` provides plain-data validation/snapshot helpers over the single budgeted traversal in `limits.ts`; `limits.ts` also bounds response receipt; `questions.ts` prepares the shared question shape; and `state.ts` normalizes evidence. Provider adapters consume these helpers directly; do not add forwarding exports or duplicate host-specific validators. Resource byte accounting is a conservative preparation budget, not a promised exact wire-size measurement.

`classifier/preparation.ts` owns one Question-node preparation budget, separate from the subsequent Evaluate request timeout: 30 seconds, 32 MiB cumulative authored templates/referenced values/resolved entries, 100,000 tokens per template, and 1,000,000 cooperative work checkpoints. Impossible active Choice/Score cardinalities are rejected before any instruction/criterion interpolation. Referenced JSON values are bounded and copied without invoking getters, iterators, serialization or string-conversion hooks. Text processors check expansion before allocating repeated prefixes; result fragments are bounded before concatenation. JSON templates undergo a quote-aware depth/token scan before `JSON.parse`. Active templates only participate; inactive authored representations stay saved. Ordinary Object/interpolation callers retain their old behavior; optional caller-owned guards are generic, and JSON template quote scanning now walks the authored prefix once instead of once per token. Native bounded operations remain synchronous, not hard-preemptible.

### Model-aware cost accounting

Rates were rechecked against the primary provider documentation on 2026-10-07. Charge the successful response's aggregate `usage.input_tokens` once: do not estimate tokens from text length/base64 bytes, multiply by question count, or add image tokens separately. [Liquid's usage contract](https://docs.liquid.ai/lfm/models/decision-models) already includes image tokens for every question (for example, two questions about a 1024×1024 image include 3,072 image tokens plus text). Jev reports request-level usage. OpenAI Decisions' cache-read, cache-write and output charges are zero; do not import Chat/Responses caching discounts or output rates even if those detail fields are present. Its long-context threshold uses `input_tokens`, not `total_tokens` or output tokens. `ClassifierCredentialsAndPricing.test.ts` exercises these rules through the calculator and real Evaluate nodes, with multi-question text/image evidence, diagnostics, Usage details on/off, tiny fractional USD costs, and both sides of the context threshold.

Core's provider registry owns exact model-pricing groups. Both requested and returned model IDs must belong to the same verified group; do not infer rates from prefixes or treat aliases as proof about a future returned version. [TypeSafe's models](https://docs.typesafe.ai/models) currently document `jev-latest`, `jev-preview` and `jev-1.13.0` together at $0.042/MTok input. Liquid's documented paid `d1` rate is $0.04/MTok input; `d1:free` and unrecognized IDs have unknown pricing here, not assumed paid or zero. [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) prices `gpt-6-luna` input at $0.10/MTok with no output/cache charges; its [model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna) doubles the input rate for the entire request above 272,000 input tokens. Regional/account-specific premiums are not inferred from token usage.

`calculateClassifierUsageCost` receives requested/returned identities and safe successful-response usage. `modelPricing` supports explicit alias groups and long-context rates; the legacy descriptor `pricing` shorthand now applies only when both IDs exactly match `defaultModel`. No identities or unknown pricing returns `undefined`, excluding Cost and omitting Usage.totalCost while preserving Answers/Usage. The same result feeds both outputs and existing GraphProcessor accumulation. Tests cover strict credential selection with conflicting sources, new-node/legacy Automatic behavior, unpriced models, mismatched identities, aliases, threshold boundaries and real graph accounting.

Validate the entire matched pricing entry before choosing a tier: both base/tier rates must be finite and non-negative, and the threshold must be a non-negative safe integer. Invalid metadata produces unknown cost even for zero-token or below-threshold requests; it must not silently fall back to a seemingly valid base price.

Response chunks use intrinsic typed-array byte geometry too: an injected transport cannot underreport bytes through an overridden `byteLength` getter. Question validation applies recursive JSON/resource checks to the complete definition once, then only checks instruction/criterion root kinds instead of rescanning each structured entry. Standalone authored-entry validation still uses the full guard. Root entries remain text/null/objects/arrays, with non-null/nonblank instructions; numbers and booleans remain valid inside structured JSON entries.

`assertClassifierJson` returns its measured byte count and accepts an optional byte cap. Cumulative preparation uses `ClassifierValueBudget` directly across inputs. Validation and resource accounting share one traversal; snapshot preparation additionally copies within that walk, without JSON serialization. Provider JSON uses streaming, fatal UTF-8 decoding: malformed or truncated sequences fail as invalid JSON instead of silently replacing evidence. Malformed successful responses are not retried, including when the non-200 retry policy is enabled.

`classifier/limits.ts` owns Core safety budgets: 32 MiB of expanded request content, 8 MiB of decoded response bytes, depth 64, 100,000 expanded values, 1,000 questions, 1,024 messages, and 4,096 content parts. These are Rivet resource limits, not provider capacity claims. Existing provider/image caps remain stricter where applicable. Preflight inspects own descriptors without invoking getters, counts every repeated occurrence (including shared-reference expansion), accounts for UTF-8 JSON escaping and native-image base64 expansion, and stops before expensive encoding/cloning. Question array flattening has the same work/depth guard, including empty repeated arrays. Preparation checks cancellation and the absolute deadline inside traversal/string scanning and between normalization/serialization steps. Bounded native JSON/base64 operations remain synchronous and cannot be preempted mid-operation; do not claim a hard wall-clock interrupt.

Byte-limit overrides must be positive safe integers and cannot widen Core's cap; invalid limits fail closed. Native image preflight and encoding obtain real buffer/offset/length through intrinsic typed-array getters and use a plain byte view, not graph-authored accessors, methods or iterators. Ordinary Uint8Array and Node Buffer inputs remain supported. Long JPEG metadata/fill-byte scans check preparation deadlines and cancellation periodically, including during bare-base64 detection; those failures must propagate rather than being mistaken for unrecognized text or invalid image content.

Successful responses use a byte-limited stream reader, never `Response.json()`. Content-Length can reject early but cannot bypass the measured decoded-byte cap. UTF-8 decoding preserves chunk boundaries, coalesces tiny chunks, checks the overall deadline on every read, and cancels failed/oversized streams without waiting for cleanup. A quote-aware structure scan bounds depth and parser allocation before `JSON.parse`; parsed responses also obey exact structural work/depth limits before adapter validation. Provider `maxRequestBytes` can tighten but never widen Core's cap; Liquid's stricter cap applies before native-image encoding. Never truncate content, drop questions, or split requests to fit these limits. `ClassifierResourceAndCost.test.ts` exercises real providers/nodes with bounded hostile fixtures and real GraphProcessor cost paths.

Every successful evaluation computes base estimated USD cost independently of `outputUsage` and emits numeric `cost` for GraphProcessor's existing accumulator. `outputUsage` still controls only the optional `Usage.totalCost` projection. Unsafe token counts or unavailable pricing exclude Cost rather than fabricate zero; actual zero-token evaluations emit zero. Graph totals remain the existing sum of available numeric costs, not a guarantee that unpriced activity was free. Retries without successful usage do not manufacture charges; cost reflects the final successful response, not an authoritative provider invoice. Caught failures exclude Cost alongside other normal outputs. Normal, split, mixed-provider and subgraph tests prove exactly-once accumulation, including a retry and both Usage settings.

`classifier/json.ts` is the shared JSON-data validator/snapshot API for structured State, instructions and criteria. It inspects own property descriptors rather than executing getters or array iterators: reject accessors, sparse arrays, non-plain objects, cycles and callable/accessor `toJSON` hooks before serialization. Ordinary string-valued JSON fields named `toJSON` remain valid. `classifier/questions.ts` applies one question-shape contract at the shared preparation boundary; required fields must be own and enumerable so they cannot disappear from the request snapshot. Optional undefined envelope properties (such as absent Noul criteria) remain supported, but undefined structured values do not. Question batch flattening uses array indices, rejects holes/accessors/cycles, and never runs custom iterators. Providers build an ordinary array of individually prepared questions, preventing a batch-level serialization hook from dropping questions. `ClassifierInputSnapshot.test.ts` covers these rules through all three providers and the real Evaluate node, including zero-HTTP rejection and valid JSON preservation.

Questions, state, request maps, and response maps accept exact authored IDs including `__proto__` and `constructor`. Use null-prototype maps, own-property checks, and `Object.defineProperty`; never assign provider-controlled keys through ordinary object assignment.

Multimodal State arrays and assembled-message content use the same indexed array reader as Question batches. Never use a caller-provided iterator or `some`/`forEach` method to decide which evidence or criteria exist: these could hide images or reorder captions. Normalize the actual own array entries, preserving order and rejecting holes/accessors. The reader is incremental and does not copy whole structured datasets just to validate them.

Multimodal message `type`/`message` and native-image `data`/`mediaType` fields also use the shared own-data-property reader in `classifier/json.ts`. Reject getters and inherited evidence fields without executing them. Read message content once; native image encoding captures its validated fields in locals for header inspection and base64 conversion. A getter must not be able to return one image or role during detection and a different value during encoding. Normal Assemble Message/Assemble Prompt outputs remain unchanged. Snapshot tests exercise scalar and mixed-array forms through every provider with zero getter reads and zero HTTP calls on rejection.

Classifier inputs use `splitRunBehavior: 'preserve-array'`. **State** is optional: an unconnected port resolves to `""`; explicitly supplied values pass the structured/multimodal normalization contract above. Flatten only Question values and preserve authored port/array order. All questions share one State in one provider request, apart from retries. High-level provider error summaries do not embed resolved API keys, authorization headers or captured bodies. Diagnostic causes remain intact by design and can contain transport/provider details or malformed-response fragments; do not describe the complete error chain or Run error as redacted. Treat persisted/shared error diagnostics as potentially sensitive.

All API-compatible classifier providers use shape-only response validation: required envelopes/fields, answer types and question IDs, known Choice options, exact probability/legend map keys, and finite JSON-compatible number types. Rivet trusts the provider's numerical contents. Never enforce probability sums or ranges, confidence/Noul ranges, Score bounds, token-count integrality/non-negativity, or numerical relationships; never round, clamp, normalize, or recompute answer values. Legend descriptions are provider-owned content and are not compared with the authored criteria. The response and optional raw diagnostic retain the exact parsed JSON values. Missing fields, wrong types, missing/extra mapped keys and non-representable JSON numbers remain malformed responses. `ClassifierResponseShape.test.ts` covers trusted non-normalized/out-of-range values, malformed shapes, special IDs, and real Evaluate HTTP/failure-control outputs. Optional USD accounting still requires safe non-negative integer token counts: if unavailable, omit `totalCost` without rejecting or altering the successful response or its Usage values.

Adapters derive response-validation questions from the private detached preparation snapshot, not the original graph inputs or public diagnostic. A concurrent branch may mutate shared question objects, IDs, or criteria while a request or retry is pending; these changes must not change the required response shape for the already-sent request. `ClassifierResponseSnapshot.test.ts` verifies both acceptance of the original response and rejection of responses for unsent options, with and without a retry, and preservation of the request diagnostic. The lazy request diagnostic parses the immutable wire separately and cannot mutate this validation snapshot.

Required response fields must be own properties, including envelope fields, answer type/value/maps, and Usage counts. A prototype-provided value cannot stand in for an absent JSON field. `ClassifierResponseShape.test.ts` covers every required field with a local inherited-property fixture (without polluting the global prototype), and checks specific numeric-field diagnostics for both Choice and Score maps. This is structural validation only; it must not restore numerical range or consistency checks.

The same test suite exercises trusted, non-normalized responses through the actual Evaluate node for all 32 combinations of failure controls and optional outputs, after a rate-limit retry and a successful non-200 2XX response. Malformed JSON, question mapping, Choice options, probability maps, Score legends and Usage types must still fail with either HTTP-status toggle setting; Catch all failures converts those failures into excluded normal outputs and Run error, while disabling it propagates the error. Malformed 2XX bodies must never enter the HTTP-status retry policy.

## Required verification

Run `yarn test:style` first, then focused Core classifier/migration tests, affected app tests and builds, and the required headless Studio Server Playwright observer. The browser fixture must load a legacy Jev project without a missing-plugin modal, show the migrated built-in nodes under **Classifier**, and expose the Question type and Provider controls. Finish with documentation-link validation and `git diff --check`.

`ClassifierNodes.test.ts` exercises Liquid through real Question/Evaluate nodes with mixed Choice/Score/Noul batches, text/list/object entries, legacy criteria, the fixed endpoint and Bearer header, default/pinned/input models, isolated credentials and optional accounting/diagnostics. `jev-nodes.spec.ts` additionally switches the hosted inspector between providers, verifies d1's placeholder/default and retained custom credential names, and preserves the legacy project's explicit model until the author clears it. These tests mock the provider boundary; a live Liquid request requires an operator-supplied API key.
