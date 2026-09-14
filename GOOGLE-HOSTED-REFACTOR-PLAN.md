# Share Google Generative AI implementation with the hosted editor

## Status and objective

**IMPLEMENTED AND VERIFIED — the shared browser-safe leaf, narrow hosted
adapter, catalog compatibility projection, resolver boundary, and all planned
regression/acceptance coverage are complete. Post-refactor hardening also
scopes Vertex credentials per SDK client and legacy Chat caches per
project/execution.**

Plan reassessment: the production ownership change is complete and no duplicate
browser-compatible stream or catalog implementation remains.  Explicit
catalog/request/chunk fixtures, compiled CJS provider execution, the standalone
App alias boundary, Vite's real resolver and production dependency audit, full
Core regression suite, and four Browser cases all pass.  The Browser cases were
also rerun against an isolated current-source production image, rather than
treating a development-server pass as proof of the production Rollup path.

The historical pre-extraction collector was intentionally not retained merely
for a second test implementation.  Its committed baseline and explicit expected
fixtures remain the characterization source; all current public facades are
tested against those independent values.  This is historical process evidence,
not an open runtime or compatibility gap.

Replace the duplicated browser-compatible Google catalogs, types, and Generative AI streaming code with one Core-owned implementation. Keep the hosted override as an explicit compatibility adapter. Preserve execution behavior, catalog differences, SDK resolution, error behavior, and the browser exclusion of Vertex dependencies.

This addresses the Google hosted-override refactoring candidate discussed in the review. The objective is fewer independent implementations to maintain, with an estimated 140–180 fewer production lines. Correctness and readable ownership take precedence over the estimate.

Baseline: `b8456088aa2575deff51e34d57ca48bbc95fb0f7`.

| Production file | Physical lines, including blanks and comments |
| --- | ---: |
| `packages/core/src/plugins/google/google.ts` | 280 |
| `packages/studio-server-web/overrides/core/plugins/google/google.ts` | 233 |
| Total | 513 |

At planning time, the working tree contains a user-owned deletion of `GRAPH-PORT-RENAME-REFACTOR-PLAN.md`. Preserve that deletion and any other unrelated changes. Do not restore or include them as implementation work.

No dependency upgrade, pricing correction, model addition/removal, schema migration, version bump, commit, or push is part of this implementation plan.

## 1. Current behavior and import ownership

Read these files before implementation:

- [Core Google module](packages/core/src/plugins/google/google.ts).
- [Hosted Google override](packages/studio-server-web/overrides/core/plugins/google/google.ts).
- [Legacy ChatGoogleNode](packages/core/src/plugins/google/nodes/ChatGoogleNode.ts).
- [LLM Chat model registry](packages/core/src/model/chat-v2/modelRegistry.ts).
- [Hosted Vite configuration](packages/studio-server-web/vite.config.ts) and [browser aliases](packages/studio-server-web/vite-aliases.ts).
- [App Vite configuration](packages/app/vite.config.ts).
- [Hosted Vertex shim](packages/studio-server-web/shims/google-cloud-vertexai.ts) and [App Vertex stub](packages/app/src/utils/browser/vertexAiBrowserStub.ts).
- [Existing Google tests](packages/core/test/plugins/google/nodes/ChatGoogleNode.test.ts).
- [Studio Server development guidance](developer-docs/studio-server/development.md), especially browser overrides, current-checkout verification, and production custom builds.

The live paths are different:

| Consumer | Current owner | Required final behavior |
| --- | --- | --- |
| Core/Node legacy Google API-key execution | Core `google.ts` | Shared Generative AI stream with Core's current SDK resolution |
| Core/Node application-credential execution | Core `streamChatCompletions` | Existing dynamic Vertex import and implementation |
| Hosted Browser legacy ChatGoogleNode | Importer-scoped hosted override | Shared stream, hosted catalog compatibility, exact hosted unsupported-Vertex error |
| Hosted LLM Chat model registry | Core `google.ts`, not the override | Gemini 1.5 models remain unpriced |
| Standalone App browser build | Core module plus App Vertex stub | Existing App-specific rejection behavior |

The hosted resolver currently intercepts only `../google.js` or `../google.ts` imported by Core's `ChatGoogleNode.ts`. It is not a universal replacement of Core's Google module. Preserve this scope: broadening it could change newer LLM Chat pricing or send that registry a conflicting `pricing: 'unpriced'` plus `cost` record, which its initializer rejects.

Core declares `@google/genai ^1.52.0`; the hosted workspace declares `^0.12.0`. Core also declares Vertex `^1.12.0`, while the hosted workspace declares `^0.1.3`. The hosted Vite resolver explicitly selects the wrapper's `@google/genai/dist/web/index.mjs` for workspace-source imports. Record the actual lockfile versions and resolved paths before extraction. Moving the importing source file must not silently upgrade the hosted SDK or switch it to a Node entrypoint.

The current lockfile resolves GenAI to **1.52.0 for Core and 0.12.0 for hosted web**, and Vertex to **1.12.0 and 0.1.3**, respectively. Keep these resolutions unchanged. A direct Node import of the hosted adapter after extraction resolves the leaf's SDK from Core; it does not reproduce hosted Vite behavior. Use direct imports for catalog/type tests and an explicit SDK substitute for unit characterization; prove the real hosted SDK through Vite and browser HTTP tests.

## 2. Compatibility contract to capture before moving code

### Catalogs and public module exports

- Preserve model IDs, insertion order, display names, maximum tokens, numeric rates, and option-array order.
- Core's `gemini-1.5-pro` and `gemini-1.5-flash` have `pricing: 'unpriced'` and no `cost` property.
- The hosted legacy catalog has `{ prompt: 0, completion: 0 }` costs for those two entries and no `pricing` property. Preserve this discrepancy explicitly; this refactor must not decide which price is correct.
- Deprecated `gemini-pro` and `gemini-pro-vision` retain `NaN` rates in both environments. Use deep assertions and `Number.isNaN`; JSON serialization alone converts `NaN` to `null` and cannot prove compatibility.
- Preserve Core's existing named exports through `google.ts`. Keep `getVertexGenerativeModelOptions` in that facade and its current instruction configuration.
- Preserve the hosted export surface used by its callers. Its `ChatCompletionOptions` currently omits `systemPrompt`, whereas Core's version includes it. A shared Core type may be projected with `Omit<..., 'systemPrompt'>` in the hosted adapter to retain this difference. Do not accidentally remove `systemPrompt` from Core's Vertex path.
- Keep model keys as literal unions. Avoid widening catalogs into a generic string index or weakening SDK event types to `any`.

### Generative AI request and iteration

The shared function must remain an async generator with the same named arguments and return shape. Capture the following before extraction:

1. No SDK import, client creation, or request occurs until iteration starts.
2. Construct `GoogleGenAI` with `{ apiKey }`, once per generator execution.
3. Pass `model`, `contents`, and `config` exactly as today: system instruction, maximum output tokens, temperature, topP, topK, tools, the same AbortSignal, thinking budget, and copied additional headers.
4. Preserve fields whose values are `undefined`, the always-created `thinkingConfig`, and `httpOptions.headers`. Avoid cleanup that changes the SDK request shape.
5. Read `chunk.functionCalls` and the first candidate's first part text. Do not concatenate additional candidates/parts or introduce usage accounting.
6. Preserve the runtime finish reason unchanged through a type assertion. SDK finish reasons need not use the spelling of the current local union; do not add a mapping or normalization.
7. Yield only if completion is truthy or `function_calls` is truthy. This includes an empty function-call array, and excludes empty-text-only and finish-only chunks. Retain explicit `undefined` properties in yielded objects.
8. Preserve SDK rejection/error identity, partial-output ordering, forwarding of the SDK signal, and underlying iterator cleanup when the consumer stops early. Forwarding a signal does not prove both installed SDK versions honor it. Characterize real hosted cancellation first; any existing ignored-abort or late-result problem is a separate behavior change, not permission to add cancellation machinery to this extraction.
9. Do not add retries, buffering, signal listeners, cancellation policies, timers, logging, or caching to the shared layer. Those remain with current owners.

### Vertex behavior

Keep Core's Vertex implementation unchanged apart from imports/types required by the extraction:

- Dynamic import of `@google-cloud/vertexai` remains deferred until iteration; its CJS compatibility rationale still applies.
- Preserve project/location construction, system instruction, and generation configuration. Supply the configured credential-file path through the individual Vertex client's `googleAuthOptions.keyFilename`; never mutate `GOOGLE_APPLICATION_CREDENTIALS`, because concurrent graph runs must keep their own configured identity.
- Preserve current text/abort checks, empty-response error (`No chunks received.`), and behavior when a non-text chunk appears. Do not improve these semantics inside this refactor.
- Hosted credential execution keeps the exact current error text and rejects when the generator is advanced, with no SDK construction, network request, or credential/environment side effect.
- The hosted shim and standalone App stub have different existing error messages; do not unify them as incidental cleanup.

## 3. Proposed implementation

### Shared browser-compatible module

Create `packages/core/src/plugins/google/googleGenerativeAi.ts` as a leaf module containing:

- Existing common catalogs and option arrays, using Core's canonical catalog values.
- Existing common model and streaming types, plus browser-safe `ChatCompletionOptions` if shared with the hosted projection. It contains plain strings and GenAI content types, not Vertex SDK types.
- The existing `streamGenerativeAi` implementation.

Its runtime dependency is the current dynamic `@google/genai` import. Type imports use `import type`. It must not import Core's root index, the Google plugin/node, the model registry, `google.ts`, Vertex, Google auth, or Node built-ins. This prevents cycles and a reverse dependency on the platform-specific facade.

Prefer a single small leaf over separate catalog/type/request/mapper modules. No factory framework, injectable production SDK registry, generic model merger, or configurable streaming pipeline is needed.

### Core facade

Keep `packages/core/src/plugins/google/google.ts` at the existing path. Explicitly re-export its existing shared exports from the leaf and import required types locally for the retained Vertex functions. Preserve `getVertexGenerativeModelOptions` and `streamChatCompletions` here.

Do not add a new public package subpath solely for the hosted wrapper: it already consumes workspace source. Verify existing Core ESM/CJS build and declaration generation handle the new internal module.

### Hosted adapter

Keep the current override file and importer-scoped resolver. Import shared browser-compatible values directly from the new leaf using the repository's source-import convention; calculate the relative path from the actual file location. Do not import through Core's package root or `google.ts`.

The adapter should contain only:

- Explicit re-exports of shared functions, types, deprecated catalog, and compatible option arrays.
- A `generativeAiGoogleModels` object built from the shared catalog with two explicit legacy replacements preserving maxTokens/displayName and zero costs. Remove `pricing` from those replacements rather than spreading it alongside `cost`. Preserve insertion order and the original hosted entry shape.
- The hosted `ChatCompletionOptions` compatibility projection if necessary.
- A short async-generator `streamChatCompletions` with the same typed parameter and exact unsupported error. A named unused `_options` parameter can replace the current destructuring and repeated `void` statements if lint allows it; verify lazy rejection.

The option-array labels/order are identical today, so reuse the common arrays after characterization proves that. Do not retain duplicate mapping code merely to keep the file shape similar.

The Core leaf is treated as immutable catalog data by these consumers. Inspect for mutations before sharing object references, and assert constructing the hosted compatibility catalog leaves Core's catalog unchanged. Do not add freezing as a new runtime behavior.

## 4. Risk assessment and required evidence

| Risk | Severity / likelihood | Required protection and test |
| --- | --- | --- |
| Vertex/auth Node packages enter the hosted browser graph | High / medium | Real Vite build graph inspection over all emitted chunks, including lazy chunks; fail for actual Vertex and transitive auth implementations, allow named local stubs |
| Moved import changes hosted GenAI version or browser entry | High / medium | Record resolved SDK path/version before and after for dev and production; inspect real resolver output and exercise actual hosted SDK against controlled HTTP |
| Catalog overlay changes newer LLM Chat pricing or crashes registry import | High / medium | Assert both facade catalogs and hosted actual legacy-node versus registry resolution; unpriced registry models must remain cost-absent |
| Lost configuration, instructions, tools, headers, or thinking budget | High / medium | Exact request characterization against a controlled SDK boundary and real-SDK HTTP capture |
| Missing/reordered chunks, changed finish-only handling, tool-only output | High / medium | Explicit mixed-chunk fixtures and node-level accumulated output checks |
| Abort or early iterator return leaks work or changes error propagation | High / medium | Deferred iterator, controlled abort, iterator-finally counter, partial-then-error tests, real browser stop case |
| Core Vertex or CJS loading regresses | High / low-medium | Existing instruction tests, fake Vertex boundary, compiled ESM/CJS smoke in separate processes |
| Type widening hides an SDK incompatibility | Medium / medium | Core declarations, App typecheck, explicit hosted adapter typecheck; test both workspace SDK type resolutions |
| Resolver scope broadens or creates a cycle | High / low-medium | Real resolver positive/negative cases plus production module graph; shared leaf never resolves to the override |
| Reported line saving ignores new files/adapters | Low / medium | Count all modified production files and new helpers using physical lines; report tests/docs separately |

Security scope: use synthetic credentials in every fixture; prohibit real provider egress. Never capture real API keys in reports. This extraction does not fix existing credential-environment ownership or pricing problems; record any discovered defect separately with evidence.

## 5. Characterization and regression tests

### A. Pure catalog and type contracts

Add Core tests beside the existing Google suite, and a hosted test under `packages/studio-server-web/tests/`. Test explicit expected values captured from the baseline, not values produced by the new helper:

- Full ordered model keys, option arrays, names, limits, and rates for both formats.
- Exact legacy `pricing`/`cost` property presence, NaN deprecated costs, and hosted construction not mutating Core.
- Core's normal model registry imports successfully and reports Gemini 1.5 costs as absent, including in the hosted build path.
- Existing exported types/functions remain importable. Add compile-time contracts for stream options, chunk shape, literal model keys, hosted option projection, and Core Vertex `systemPrompt`.

### B. Stream characterization

Use `node:module.registerHooks`, already used by `packages/studio-server-web/tests/editor-bridge-contract.test.ts`, to substitute the bare SDK import with a test fixture. Install hooks before importing or advancing the generator and retain them until iteration finishes; deregister in `finally`. Run loader/environment-mutating tests in isolated child processes to avoid module-cache and global-state interference. Verify the configured CI Node version supports the existing hook API; do not introduce an experimental module-mocking requirement. Share one fixture and explicit expected dataset across Core and hosted facade tests. Do not change production APIs to inject test dependencies.

Run the same explicit fixture through the old Core and hosted functions before replacement, then the final public facades. Cover:

- Generator created but not advanced: no initialization.
- Complete and minimal options, zero numeric values, undefined optional fields, empty headers, and custom headers.
- Plain text; tool-only; mixed text/tools; empty tools array; no candidates; empty candidates; multiple candidates/parts; empty text; finish-only chunk.
- Request failure on the first `next()` call, iterator failure after one yielded chunk, and no chunks. Construction alone cannot cause a request failure because it is lazy. Assert exact error identity and yielded output so the GenAI empty-stream behavior is not confused with Vertex's explicit empty-stream error.
- AbortSignal identity and pre-aborted signal forwarded unchanged; abort after a partial result through a controlled SDK fixture.
- Consumer early return disposes the underlying async iterator once; no late values are delivered.
- Independent concurrent calls retain their own model, API key, options, and chunks.

Keep expected chunk objects explicit, including undefined fields and order. Do not retain copies of the old production algorithms or source-extraction assertions as permanent tests.

### C. Vertex and node integration

- Retain and run `ChatGoogleNode.test.ts` for system/developer instruction handling and Vertex model configuration.
- Add a controlled Vertex fixture asserting lazy import, project/location, credential assignment, model config, streamed text, abort/non-text termination, and empty response error. Run environment-mutating fixtures in isolated child processes or restore state reliably and avoid concurrency with other credential tests.
- Test hosted unsupported Vertex by creating the generator and advancing it; assert exact rejection, no SDK calls, and no request to Google.
- Exercise the actual legacy node with an API key: instructions, partial output, final text, function calls, and forwarded headers. Preserve its cache/retry ownership; disable cache for fixtures and choose deterministic non-retryable failures or controlled retry behavior.
- Include API-key precedence when both credential styles are configured, missing-configuration validation, and the existing no-API-key tool-calling rejection.

## 6. Prove browser dependency isolation

Alias regex tests alone and successful compilation are insufficient.

1. Add resolver tests using Vite's actual configured plugin container for the ChatGoogleNode import, model registry import, shared-leaf import, and unrelated Google-named imports. Use real importer paths and supported `.js`/`.ts` spellings. Confirm the narrow existing override scope.
2. Use a test/build-only Rollup observer to inspect resolved module IDs and emitted chunk module lists from the real hosted configuration. Include dynamic imports and external imports. Normalize Windows separators and Yarn PnP/zip paths.
3. Assert the GenAI implementation resolves to the hosted workspace's web entry, and the shared leaf occurs as a single resolved module. Assert no actual `@google-cloud/vertexai`, `google-auth-library`, or their Node credential transport implementation is bundled or left as a runtime external browser import. Permit the local Vertex shim; do not fail merely because its diagnostic text contains `VertexAI`.
4. Check compiled output for unresolved Node built-in imports attributable to this path. If unrelated pre-existing browser shims exist, establish a narrow baseline and retain explicit allowed local shims; do not suppress all Node-module findings.
5. Exercise the standalone App build with its existing Vertex stub, and verify Node/Core still resolves the actual Vertex package. A global alias would invalidate this separation.
6. Retain a bounded machine-readable artifact listing resolved Google SDK paths/versions and forbidden-package findings. Run assertions in CI so future importer changes cannot silently bypass the boundary.

Register new hosted tests in its explicit package test list. If a dedicated bundle verification command is needed, wire it into the existing hosted build/verification workflow and CI change classification. Do not add a test file that no default command executes.

Keep this to one build observer/harness consuming the real Vite config, not a second hand-maintained resolver or a general dependency-audit system. Use its build output for the production browser run as well. Before adding CI configuration, check whether existing scripts already run the changed command. Register pure tests in the existing hosted test list; attach the artifact boundary assertion to the existing hosted build gate. Playwright remains in the repository's browser runner rather than the pure unit-test list. Record the exact CI/local command for each new check.

## 7. Browser and production acceptance

Add `google-generative-ai.spec.ts` under `packages/studio-server-web/playwright-observe/`, using existing hosted-project fixtures. Use a synthetic Google API key and a loopback HTTP fixture that emits protocol-valid streaming events through separate `response.write` calls. Reuse the local-provider server pattern in `evaluation-metrics.spec.ts`. Redirect only matching Google SDK requests to this fixture in the test browser's fetch transport, preserving request options and AbortSignal; leave SDK request creation and stream parsing real. Handle test-origin CORS/preflight explicitly. Assert request URL/method/body/headers without recording credentials and fail unexpected provider requests. A complete `route.fulfill` body or `route.fetch` followed by fulfillment is insufficient to prove incremental delivery.

Provide explicit fixture controls for first chunk, next chunk, finish, connection failure, and cleanup. Wait for a visible partial output before releasing the final event; configure the existing throttle setting appropriately so the first chunk is observable. Release or close every pending response and server in teardown, including after failure. Abort tests must not depend on a stalled response eventually timing out.

Run a graph containing the legacy Google Chat node in **Browser** execution, not the newer LLM Chat node or Node executor. Verify:

- Model selection and unchanged option order; system instruction and output text reach the right fields.
- At least one partial output is visible before final completion, followed by exact final text.
- A function-call response reaches the node's existing function output correctly.
- A controlled non-retryable request failure surfaces the existing node error. Test partial-then-error identity at the stream boundary; do not repeat every low-level error case in the browser.
- Stop during a pending response has the same observed behavior as the baseline with the real hosted SDK. Assert no additional accepted output if baseline establishes that guarantee; otherwise record the limitation and prove extraction does not change it.
- Credentials-only rejection is tested directly at the Vite-resolved adapter boundary for exact text and no network. Exercise the node's credential validation through controlled node tests. Do not wait through the real node's ten randomized retries merely to reproduce the same unsupported error in a browser.
- Importing and using the newer LLM Chat registry remains successful with its unpriced legacy entries.

Use deferred provider responses and observable state, not arbitrary sleeps. Run against the checkout's built hosted app as well as a dev-server resolver smoke; dev optimization and production Rollup resolution can differ. Record which target each check exercised. Mocking the stream function itself cannot prove the real hosted SDK path.

The development guide requests `yarn studio-server:prod:custom` for hosted overrides. Use an isolated fixture configuration and current-source images, without replacing a running user stack. If this cannot run, report it as pending production-image verification; do not claim that a dev-server browser pass covers it. No Kubernetes rehearsal is required for this refactor.

The launcher can select existing `compose`/`ops` volumes automatically. Before invoking it, resolve the fixture env-file mechanism and explicitly set a unique `RIVET_STUDIO_SERVER_COMPOSE_PROJECT`, non-conflicting ports, fresh fixture storage, and synthetic settings. A unique project name alone does not isolate bind mounts. Inspect resolved Compose configuration first. Keep this as a local image acceptance check, not a new full-stack CI deployment job for a three-module refactor.

## 8. Implementation sequence and verification gates

- [x] **DONE:** Record HEAD, status, physical-line counts, consumer inventory, actual SDK lockfile versions, and resolved browser paths.
- [x] **DONE:** Run `yarn test:style`, focused Google/node/model-registry tests, and the full Core suite. The final fixtures cover complete/minimal request shapes, empty headers, chunk filtering, errors, cancellation, iterator disposal, and concurrent calls.
- [x] **DONE:** Extract the leaf and convert Core to a facade. Controlled Vertex fixtures cover lazy loading, configuration, empty/non-text/aborted streams; compiled CJS tests execute both API-key and Vertex provider paths.
- [x] **DONE:** Replace the hosted duplicate with explicit compatibility entries and the unsupported adapter. Core and hosted tests assert every catalog entry and retain the two documented zero-cost legacy differences.
- [x] **DONE:** Verify actual resolver behavior and build dependency graphs. Plugin-container tests prove the importer-scoped redirect; the production audit proves the legacy node imports the adapter, the leaf uses hosted GenAI's web entry, and no real Vertex/auth or Node built-ins enter the graph.
- [x] **DONE:** Run node-level integration and focused Browser scenarios against current source/build. The legacy node's Browser execution covers partial/final text, function output, deterministic 4xx failure, and stop-without-late-output.
- [x] **DONE:** Update canonical developer documentation and wire the hosted typecheck, resolver tests, and dependency audit into existing default verification entrypoints.
- [x] **DONE:** Build Core ESM/CJS/declarations, App, and hosted web. The standalone-App test proves its Vertex stub stays browser-only while Node/Core resolves the real Vertex package.
- [x] **DONE:** Build current-source production images in an isolated Compose project, verify temporary mount isolation and health, and rerun all four Browser cases against that production image. Review the final diff, check documentation links, and measure the final production delta.
- [x] **DONE:** Harden adjacent legacy execution seams: Vertex credentials are client-scoped, and legacy OpenAI/Anthropic/Google Chat cache entries use host-owned scope, opaque credential/header-aware identities, cloned outputs, and no tool-capable replay.

Known entrypoints (add the proposed tests to existing manifests before relying on them):

```powershell
yarn test:style
yarn workspace @valerypopoff/rivet2-core build
yarn workspace @valerypopoff/rivet2-core lint
yarn workspace @valerypopoff/rivet-app build
yarn workspace @valerypopoff/rivet-studio-server-web build
yarn studio-server:verify:web-pure
yarn studio-server:verify:host-compatibility
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe google-generative-ai.spec.ts
node scripts/checks/check-doc-links.mjs
git diff --check
```

Run focused Core tests using the repository runner and confirmed discovery pattern; include the Google node suite and affected model-registry tests. Then run the full Core suite as the shared runtime regression gate. Hosted Vite build does not substitute for TypeScript checking of the override: use an explicit typecheck contract that includes it. Test compiled CJS loading in a fresh process, since source ESM tests cannot prove deferred CJS imports.

Concretely, retain `packages/core/test/plugins/google/nodes/ChatGoogleNode.test.ts` and `packages/core/test/model/chat-v2/modelRegistry.test.ts`. Hosted web has no package-level `tsconfig.json` today: add a narrow test-only typecheck configuration for the leaf/adapter contracts, with its own command in the existing verification path, rather than attempting to typecheck the entire hosted editor as incidental work. Shared SDK types resolve from Core; a separate assignment contract against hosted SDK parameter types checks structural compatibility with 0.12.0. Additional properties accepted through structural typing do not prove runtime support, so retain actual browser request/abort characterization.

Core's CJS bundle exposes the Core package surface, not necessarily these internal named helpers. Verify ESM helpers from their emitted module and exercise the exported Google plugin/node through `dist/cjs/bundle.cjs` in a subprocess with SDK hooks. Import-only smoke is insufficient: advance the API-key and Vertex execution paths with controlled responses. Do not add public helper exports solely to make CJS tests easier.

Inspect `artifacts/playwright/` for browser failures. Report fixture startup, build failures, and behavior assertion failures separately. Required checks that did not execute remain open checklist items.

## 9. Documentation, measurement, and completion

Update `developer-docs/studio-server/development.md` with the shared leaf's ownership, importer-specific override, two legacy catalog exceptions, SDK/browser-entry contract, bundle verification command, and focused browser scenario. Update the relevant Core/plugin architecture guidance and link to that explanation rather than duplicating it. User documentation is unchanged because the intended behavior is unchanged.

Measure all production changes against the recorded commit, including the new leaf, both facades, and any changed runtime/build adapters. Report build/test-only verification tooling separately rather than disguising it as production savings. Count physical lines consistently with `ReadAllLines(...).Length` and `@(git show "<commit>:<path>").Count`; PowerShell `Measure-Object -Line` excludes empty lines. Report any nonempty-line count as a separate metric.

Completion requires all of the following:

- One Generative AI streaming implementation and one common catalog/type owner; only the two documented hosted pricing differences remain local.
- Baseline request/chunk/error/catalog characterization passes through both final facades.
- Core Vertex behavior, system instructions, and compiled ESM/CJS behavior pass.
- Real hosted build graph excludes actual Vertex/auth dependencies and retains the same GenAI web SDK version/path; resolver scope remains unchanged.
- Actual hosted Browser node execution passes partial/final/tool/non-retryable-failure and baseline cancellation checks; the Vite-resolved adapter rejects Vertex without network access. Production build evidence is recorded.
- New tests are reachable from default CI commands, docs describe final ownership, and the measured production reduction is reported honestly.

If a risky check fails, retain or restore the affected adapter while investigating; do not delete the working duplicate and mark the refactor complete without its replacement evidence. Keep the implementation reviewable as extraction, hosted adoption, and verification/docs stages. Commit or rollout decisions require a later user request.

Distinguish a newly introduced regression from an independently reproduced baseline defect. Baseline defects do not authorize hidden behavior fixes or SDK upgrades; document their exact reproduction and keep the affected compatibility assertion explicit. A missing required build/browser check remains pending verification, while optional repeated runs are unnecessary once the same final artifact has passed. Finish with one evidence table mapping each required gate to its command, result, and artifact; do not leave overlapping checklists with conflicting completion status.

## Verification completion

All implementation and verification work listed in this plan is complete.
The pre-extraction implementation is identified by the baseline commit and is
not retained as executable duplicate test code. Current fixtures instead carry
the independently written expected catalog, request, and stream values. That
keeps the historical comparison auditable without reintroducing a second
production-like implementation.

## Implementation evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Shared ownership and catalog compatibility | Passed | `googleGenerativeAi.ts` is the sole shared catalog/type/stream owner. The Core facade retains Vertex; the hosted adapter retains only the two documented zero-cost legacy entries. Core and hosted suites assert every catalog entry, property shape, `NaN`, unpriced-versus-zero-cost semantics, and immutability. |
| Core stream, Vertex, and legacy-cache regression | Passed | `yarn workspace @valerypopoff/rivet2-core exec tsx --test test/model/LegacyChatEditorCache.test.ts test/plugins/google/googleGenerativeAi.test.ts test/plugins/google/nodes/ChatGoogleNode.test.ts test/plugins/anthropic/nodes/ChatAnthropicNode.test.ts` — 22 tests passed. It includes controlled compiled-CJS API-key/Vertex execution plus credential-scoped legacy-cache and tool-replay coverage. `yarn test:core` also completed successfully. |
| Source/style and hosted contracts | Passed | `yarn test:style`; `yarn workspace @valerypopoff/rivet2-core run lint`; `yarn studio-server:verify:web-pure` — 82 tests passed; and `node scripts/checks/check-doc-links.mjs` all passed. |
| Browser dependency boundary | Passed | The default hosted production build runs the adapter typecheck and writes `artifacts/studio-server-web/google-browser-dependency-audit.json`: the legacy node imports the adapter, the reachable leaf uses hosted `@google/genai`'s web entry, and no real Vertex/auth or Node built-ins are present. Vite plugin-container tests cover both positive and negative resolver cases; the standalone-App test proves the stub/Core split. |
| Browser execution | Passed | `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, `yarn studio-server:ui:observe google-generative-ai.spec.ts` — 5 passed. It drives the legacy Google node through Browser execution and covers partial/final text, function output, deterministic 4xx failure, retryable rate-limit recovery, and cancellation without a late output. |
| Isolated production image acceptance | Passed | `yarn studio-server:prod:custom` built proxy, web, API, and executor images from the checkout in the dedicated `rivet-google-hosted-refactor` project. Temporary artifact mounts were verified, proxy returned `200`, API readiness was `ready`, and the same four-case Browser suite passed against `http://127.0.0.1:18081`. The temporary containers, network, volumes, images, env file, and fixture storage were removed afterward. |
| Documentation and final measurement | Passed | `developer-docs/CORE-ENGINE.md` and `developer-docs/studio-server/development.md` describe ownership, non-retryable provider errors, credential isolation, legacy-cache safety, and verification. The two duplicate facades were 513 physical lines at the baseline and the two facades plus shared leaf are now 326: **187 lines removed**. The Vite dependency observer adds 89 build-verification lines, which is reported separately rather than counted as runtime sharing savings. |
