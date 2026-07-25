# Reducing Owned LOC With Libraries

## Purpose And Decision Standard

This document evaluates places where Rivet owns infrastructure that a maintained
library could replace. The standard is deliberately stricter than "a library
exists":

- supported behavior and persisted data must remain unchanged;
- Browser, detached Tauri, internal Node, remote Node, and published package
  boundaries must remain compatible where the current code supports them;
- the replacement must reduce meaningful production ownership, not merely move
  a small helper behind a dependency;
- adapters, build configuration, tests, and dependency/security maintenance
  count against the benefit;
- a bug fix or standards correction is not described as a behavior-neutral
  refactor.

LOC estimates below are physical production-source lines in the current
checkout. Test and documentation lines are called out separately. Dependency
source is not counted as repository LOC, but its bundle, compatibility, and
supply-chain costs are still part of the decision.

## Reassessed Verdict

| Candidate                                 | Verdict                                       |     Credible production LOC saving | Functionality-neutral?                                      |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------: | ----------------------------------------------------------- |
| IndexedDB wrappers -> `idb`               | **Recommended, after deleting one dead hook** | 60-115 live LOC, plus 102 dead LOC | Yes, with migration and timing constraints                  |
| Custom SSE parser -> `eventsource-parser` | **Conditional protocol-hardening project**    |                          15-25 LOC | No, not for every currently accepted malformed stream       |
| Vendored FNV-1a -> `@sindresorhus/fnv1a`  | **Keep vendored for now**                     |     70-85 LOC if specially bundled | Possible, but packaging and compatibility costs outweigh it |
| Model-catalog cache -> TanStack Query     | **Defer**                                     |                          20-60 LOC | Not without retaining current global/session semantics      |
| OpenAI Files fetches -> OpenAI SDK        | **Do not pursue for LOC**                     |             approximately 0-20 LOC | Not by default                                              |
| Debounce hooks -> `ahooks`                | **Keep current hooks**                        |                  30-60 LOC at best | Difficult; unmount and changing-wait semantics differ       |
| Color parser/contrast -> `tinycolor2`     | **Do not pursue**                             |                          40-60 LOC | Only with a strict adapter that erodes the benefit          |

The only clear behavior-preserving library migration in this list is `idb`.
The SSE parser remains a good engineering target if Rivet explicitly accepts
standards-correct SSE behavior as a small protocol change. The other candidates
should not currently be justified as safe LOC reductions.

---

## 1. IndexedDB Wrappers -> `idb`

### Current Ownership

The live IndexedDB implementations are:

- [`packages/app/src/state/storage/indexedDB.ts`](packages/app/src/state/storage/indexedDB.ts)
  - `jotai-store`, version 1, object store `state`;
- [`packages/app/src/hooks/useStaticDataDatabase.ts`](packages/app/src/hooks/useStaticDataDatabase.ts)
  - `rivet_static_data`, version 2, object store `data`;
- [`packages/app/src/io/BrowserDatasetProvider.ts`](packages/app/src/io/BrowserDatasetProvider.ts)
  - `datasets`, version 2, object stores `datasets` and `data`.

The former `packages/app/src/hooks/useIndexedDb.ts` was not imported anywhere
in the repository. Its 102 lines were deleted as dead code before attributing
any saving to `idb`.

The live code repeatedly wraps `IDBOpenDBRequest` and `IDBRequest` callbacks in
Promises. `BrowserDatasetProvider` also opens a new database connection for
most operations and does not close those connections.

[`idb`](https://github.com/jakearchibald/idb) is a close wrapper over the native
IndexedDB API. It provides typed schemas, `openDB`, Promise-returning requests,
transaction completion, blocked/version-change callbacks, and access to the
underlying native objects through `unwrap`.

### Functionality-Preservation Assessment

This migration can preserve behavior, but only if it retains all existing
storage identities and does not silently redesign the schemas:

- database names, versions, object-store names, keys, and stored values stay
  byte/structured-clone compatible;
- opening an existing version-1 or version-2 database must not run an
  unnecessary upgrade;
- `IndexedDBStorage.getItem` must continue returning `null` for a missing key;
- `useStaticDataDatabase.insert` must keep `add` semantics, including rejection
  when the key already exists; replacing it with `put` would change behavior;
- dataset metadata iteration order and the in-memory dataset cache behavior
  must remain unchanged;
- `BrowserDatasetProvider.getDatasetDatabase()` is a public class method even
  though current in-repository callers are internal. Either preserve its
  `Promise<IDBDatabase>` contract with `unwrap()` or deliberately make the
  method private in a separately reviewed API change;
- request-completion versus transaction-completion timing must be chosen
  intentionally. `idb` database shortcuts may wait for transaction completion,
  while several current methods resolve when the individual request succeeds.
  Use explicit `tx.store` requests where exact timing matters;
- preserve existing transaction boundaries. In particular, do not make
  `deleteDataset` atomic across both stores merely because `idb` makes a
  multi-store transaction convenient, and keep `importDatasetsForProject` in
  its existing multi-store transaction;
- preserve mutation order: dataset methods currently update the in-memory cache
  before persisting, so a failed write can leave memory ahead of IndexedDB.
  Changing that recovery behavior belongs in a separate change.

The app is the correct package boundary for this dependency. Core and Node
executors do not need `idb`.

### Credible Benefit

Current live storage code is 424 physical lines. Most dataset business logic
must remain, so the library does not replace all of it.

Expected production reduction:

- `IndexedDBStorage`: approximately 25-35 lines;
- `useStaticDataDatabase`: approximately 30-40 lines;
- `BrowserDatasetProvider`: approximately 35-55 lines;
- typed shared `DBSchema` declarations and connection helpers add
  approximately 15-30 lines.

The three gross reductions total 90-130 lines. After subtracting the new shared
schema/helper ownership, the credible net saving for live code is **60-115
production lines**.

Deleting the unused `useIndexedDb.ts` is an independent **102-line** cleanup.
Together, production code should fall by approximately **160-215 lines**.
Migration tests and documentation will likely add 120-220 lines, so total
repository LOC could range from an increase of roughly 60 lines to a reduction
of roughly 95 lines. The stronger benefit is one tested persistence
abstraction and explicit connection lifecycle, not merely the net total.

### Specific Risks

- **Persistent-data loss:** a wrong version, store name, key path, or upgrade
  callback can make existing local projects or datasets appear empty.
- **Changed duplicate-key behavior:** replacing `add` with `put` would turn an
  existing error into an overwrite.
- **Changed completion timing:** awaiting `tx.done` is stronger than awaiting
  one request and may change when callers observe completion or failure.
- **Connection-lifetime changes:** sharing one connection fixes repeated opens,
  but a connection that does not close on `versionchange` can block future
  upgrades across tabs or detached windows.
- **Transaction-boundary changes:** combining currently separate dataset writes
  into one transaction changes partial-failure behavior, while splitting the
  existing import transaction weakens its current grouping.
- **Memory/database divergence:** reordering in-memory mutations after writes
  would improve one failure case but would be a product behavior change, not
  part of this migration.
- **React lifecycle changes:** the current hooks open on mount; a module-level
  connection cache changes ownership and cleanup. Prefer an explicit shared
  database owner rather than an accidental module singleton.
- **Detached/web preview isolation:** browser origin and WebView ownership must
  remain the same; the library must not introduce a different storage scope.
- **Test-environment false confidence:** a mock that does not model upgrade,
  transaction, and structured-clone behavior can miss the only dangerous
  failures in this migration.

### Required Verification

- Add an IndexedDB-capable test environment such as `fake-indexeddb`.
- Create databases with the exact old schemas, insert representative records,
  then open and mutate them through the new implementation.
- Test missing values, duplicate `add`, delete, clear, multi-store import,
  transaction failure, blocked upgrades, `versionchange`, and connection close.
- Verify the desktop editor, detached Tauri paths that mount app providers, and
  browser-hosted `RivetAppHost` manually because they can use different
  browser/WebView storage owners. The generated published web-app runtime does
  not import these app-only IndexedDB modules and is not part of this migration.
- Run app tests, app build, lint, and `git diff --check`.

### Recommendation

**Proceed.** First delete the unused generic hook in a small cleanup. Then
migrate one database at a time, starting with `IndexedDBStorage`, and keep the
database names and schemas frozen through migration tests.

---

## 2. Custom SSE Parsing -> `eventsource-parser`

### Current Ownership

[`packages/core/src/utils/fetchEventSource.ts`](packages/core/src/utils/fetchEventSource.ts)
currently owns:

1. POST-capable `fetch` with arbitrary headers and body;
2. a raw response branch for non-SSE error/fallback JSON;
3. cancellation and a timeout around each awaited parsed item;
4. UTF-8 decoding and line buffering;
5. recognition of `event: ` and `data: ` lines.

It is used only by the legacy OpenAI-compatible and Anthropic streaming paths:

- [`packages/core/src/utils/openai.ts`](packages/core/src/utils/openai.ts);
- [`packages/core/src/plugins/anthropic/anthropic.ts`](packages/core/src/plugins/anthropic/anthropic.ts).

[`eventsource-parser`](https://www.npmjs.com/package/eventsource-parser) is
transport-neutral and supports Browser and Node runtimes. Version 3 has both ESM
and CJS exports and is already present transitively in the lockfile, but core
must still declare it directly before importing it. Rivet documents Node 20 as
its supported runtime, which satisfies the library's Node 18 minimum.

### What The Library Should And Should Not Replace

It is a solid owner for UTF-8-decoded SSE field parsing. It must **not** replace
the whole `fetchEventSource` abstraction:

- keep POST requests, headers, body, and custom endpoint support;
- keep the `EventSourceResponse` wrapper and raw-response fallback;
- keep Rivet's abort and timeout ownership;
- use `createParser` behind a small TransformStream adapter;
- do not adopt a full `EventSource` client, because those clients commonly own
  GET/reconnect behavior that is wrong for LLM POST streams.

### Functionality-Preservation Assessment

This is **not a literal behavior-neutral drop-in**.

The current code is a selected-line tokenizer rather than an SSE record parser:

- it recognizes only `data: ` and `event: ` with a literal space;
- it emits an event marker immediately when that line ends;
- it emits every data line independently;
- it splits only on LF and collapses consecutive LF characters;
- it emits a final unterminated recognized line at EOF;
- each emitted marker/data line resets Rivet's read timeout.

A standards parser:

- accepts `data:` without a space;
- supports LF, CRLF, and bare CR;
- waits for a blank record terminator;
- joins multiple data fields with `\n`;
- ignores comments and understands standard fields;
- strips a leading BOM;
- normally emits only complete events.

An adapter can preserve normal OpenAI/Anthropic output ordering by enqueueing
`[event-name]` and then the data. It can call `parser.feed('\n\n')` at EOF to
dispatch a provider's final record without a blank terminator, and it can split
multiline parsed data back into individual values if exact legacy output is
required. It cannot simultaneously use record-level parsing and preserve every
timing/acceptance quirk of the old tokenizer.

Therefore:

- for well-formed, single-line provider events, behavior can remain equivalent;
- malformed, multiline, BOM-prefixed, space-less, CR-only, or very slowly
  completed records can behave differently;
- those differences are generally standards corrections, but they must be
  accepted as such rather than labeled "no functionality change."

### Credible Benefit

The custom parsing portion is approximately 46 production lines.
A parser adapter, EOF handling, import, and output compatibility logic will
still require approximately 20-30 lines.

Credible production saving: **15-25 lines**.

The required characterization suite will likely add 100-180 test lines, so
total repository LOC will probably increase by approximately 80-180 lines after
the dependency/configuration and documentation changes. The real benefits are:

- standards-correct chunk and line-boundary handling;
- maintained coverage for subtle SSE grammar;
- lower risk of future custom-provider fragmentation bugs.

This is not a strong project if LOC reduction is the primary goal.

### Specific Risks

- **Timeout semantics:** waiting for a complete SSE record can stop an
  `event:` line from resetting the timeout before its data arrives.
- **Multiline data semantics:** joining or re-splitting data can alter payloads
  for providers that intentionally use several `data:` fields.
- **EOF semantics:** `reset({ consume: true })` alone does not necessarily
  dispatch a buffered event; EOF behavior needs an explicit tested strategy.
- **Fallback buffering:** `Response.body.tee()` leaves the raw fallback branch
  unread during a successful long stream. Replacing the parser does not fix
  that and must not accidentally worsen it.
- **Custom provider compatibility:** OpenAI-compatible endpoints may rely on
  non-standard output that the current permissive/accidental tokenizer happens
  to accept.
- **Event-only records:** the library dispatches events around data records,
  while the current tokenizer can emit an event marker without data.
- **Error behavior:** library parse errors must not replace Rivet's existing
  provider JSON errors with less useful generic parser errors.
- **Dependency drift:** because this is a protocol boundary, upgrades should be
  reviewed rather than accepted blindly through a broad range.

### Required Verification

Characterize and decide the expected result for:

- LF, CRLF, and bare CR;
- UTF-8 characters split between byte chunks;
- fields and large JSON records split between chunks;
- multiple `data:` lines;
- comments, BOM, `id`, `retry`, and unknown fields;
- `data:` with and without a space;
- named events and marker/data order;
- `[DONE]`;
- no final blank line and no final newline;
- event-only records;
- fallback JSON and non-2xx responses;
- abort, stalled timeout, and a record whose header and body arrive far apart.

Then run the legacy OpenAI-compatible and Anthropic streaming tests in Browser
and Node execution.

### Recommendation

**Keep as a conditional protocol-hardening project, not as a pure LOC
refactor.** It is a solid target if Rivet explicitly chooses standards-correct
SSE behavior for supported providers. If absolutely no edge-case behavior may
change, keep the current parser and strengthen its tests instead.

---

## 3. Vendored FNV-1a -> `@sindresorhus/fnv1a`

### Current Ownership

[`packages/core/src/vendor/fnv1a.js`](packages/core/src/vendor/fnv1a.js) is a
95-line licensed copy of `@sindresorhus/fnv1a` 3.x with local JSDoc types. It is
used synchronously by
[`ExecutionRecorder.ts`](packages/core/src/recording/ExecutionRecorder.ts) to
derive keys for long strings in serialized recording version 1.

The current upstream package implementation is effectively the same algorithm
and API. That fact alone does not make the dependency swap free.

### Checked Packaging Assumption

`@sindresorhus/fnv1a` 3.1.0 is ESM-only. Rivet's ESM build can import it, but
the core CJS build sets `packages: 'external'`. A direct import would therefore
be emitted as a CJS `require()` of an ESM-only dependency and can break
`@valerypopoff/rivet2-core` consumers.

Using the older CommonJS 2.x package is not equivalent. Its public API and
Unicode implementation differ, including behavior around problematic Unicode
input. The compatible 3.x implementation would need to be explicitly bundled
into the CJS artifact through a reviewed build exception.

### Credible Benefit

Deleting the vendored file saves 95 production lines. A direct import,
manifest entry, CJS bundle exception, and comments explaining that exception
would add approximately 10-25 lines.

Credible production saving: **70-85 lines**.

Golden recording/hash tests add approximately 25-50 lines. Total repository
saving would therefore be modest. Runtime/bundle code is not meaningfully
smaller: the same algorithm is merely sourced from a package.

### Specific Risks

- **Published CJS breakage:** externalizing an ESM-only dependency makes
  `require('@valerypopoff/rivet2-core')` fail at runtime.
- **Recording compatibility:** any hash difference changes `$STRING:<hash>`
  keys in serialized recordings and can break deterministic fixtures or
  interoperability.
- **Unicode differences:** downgrading to the CommonJS 2.x line is not a safe
  workaround.
- **Dependency-update drift:** a routine dependency update must never silently
  change the persisted recording hash contract.
- **Build-policy complexity:** a one-package bundling exception makes the core
  CJS build less uniform and must be maintained alongside existing ESM/CJS
  aliases.
- **Supply-chain tradeoff:** the current implementation is tiny, licensed,
  stable, and already copied from upstream; a dependency adds audit/update
  surface without adding capabilities.

### Required Verification If Reconsidered

- Pin the exact 3.x version initially.
- Explicitly bundle it in the CJS artifact.
- Test ESM import and CJS `require` from packed artifacts.
- Add ASCII, Unicode, lone-surrogate, `Uint8Array`, and existing serialized
  recording golden tests.
- Compare hashes against the current vendored implementation before deletion.

### Recommendation

**Keep the vendored implementation.** It is transparent and intentionally
stabilizes a persisted hash contract. Reconsider only if the project adopts a
general "no vendored third-party source" policy; LOC alone does not justify the
packaging exception. Independently, correct the local JSDoc return annotation
from `string` to `bigint` and add golden recording hashes; those are small
maintainability fixes and do not require a dependency migration.

---

## 4. Model-Catalog Cache And Service -> TanStack Query

### Current Ownership

The model catalog uses:

- a Promise cache and secret-safe key in
  [`chatV2ModelCatalog.ts`](packages/app/src/utils/chatV2ModelCatalog.ts);
- per-consumer refresh status and subscriptions in
  [`chatV2ModelCatalogService.ts`](packages/app/src/utils/chatV2ModelCatalogService.ts);
- model editor, settings, loader-prefetch, and asynchronous UI-context
  consumers.

TanStack Query is already a direct app dependency, and `RivetAppHost` provides
a QueryClient. It can own Promise deduplication, query caching, prefetching, and
invalidation.

### Functionality-Preservation Assessment

The original proposal assumed the custom cache could be replaced directly by
the host QueryClient. That is not behavior-neutral:

- the current cache is module-global, while a default `RivetAppHost`
  QueryClient is host-scoped;
- callers may provide their own QueryClient with different default retry,
  stale, garbage-collection, focus, and reconnect policies;
- the current settings page and node editor keep separate refresh-status
  sessions even when they share provider credentials;
- the asynchronous `RivetUIContext.getChatModelOptions` path is not itself a
  React query consumer;
- clearing or replacing a host QueryClient currently does not clear model
  discovery.

Using one dedicated module-level QueryClient and passing it explicitly could
preserve the global cache, but then Rivet still owns separate status state and
does not benefit from the host's provider. Moving refresh state into local
components can preserve the UI, but distributes the workflow again.

The recent refactor history also records an intentional decision to keep this
workflow as a small module-level cache/status owner rather than extract a
broader framework.

### Credible Benefit

Most of the 343-line catalog file is provider request and normalization logic
that TanStack Query cannot replace. Only cache/deduplication/invalidation and
the 91-line session service are in scope.

After adding:

- query-key/options builders;
- explicit no-retry/no-refetch/infinite-stale policy;
- local or retained per-consumer status handling;
- non-hook `fetchQuery`/prefetch adapters;

the credible production reduction is only **20-60 lines**, not 70-120.
Tests will remain similar in size or grow. The main possible benefit is using a
familiar cache API, not a substantial ownership reduction.

### Specific Risks

- **Cross-host behavior changes:** moving from one module-global cache to
  host-scoped clients changes request deduplication and credential-cache
  lifetime.
- **Host-default leakage:** retries or automatic refetch can cause unexpected
  provider requests and credential usage.
- **Status coupling:** one query state can make refresh activity in Settings
  appear in a node editor, unlike the current session keys.
- **Secret exposure:** raw API keys must never appear in query keys, devtools,
  logs, or serialized cache state.
- **Fallback semantics:** provider failures currently resolve to built-in model
  options plus status; throwing query errors would change UI behavior.
- **Garbage collection:** default query GC can discard a cache that currently
  lives for the module lifetime.
- **User-supplied QueryClient behavior:** host applications can clear or
  configure their QueryClient in ways Rivet does not control.
- **Refactor churn:** this would revisit a recently simplified and documented
  ownership boundary for a small net gain.

### Recommendation

**Defer.** The current implementation is small, explicit, tested, and preserves
specialized status semantics. Reconsider if model discovery expands into more
providers, pagination, scheduled refresh, or broader server-state workflows
that genuinely need TanStack Query.

---

## 5. OpenAI Files Nodes -> Existing OpenAI SDK

### Current Ownership

These nodes manually call the OpenAI Files API:

- [`UploadFileNode.ts`](packages/core/src/plugins/openai/nodes/UploadFileNode.ts);
- [`ListOpenAIFilesNode.ts`](packages/core/src/plugins/openai/nodes/ListOpenAIFilesNode.ts);
- [`GetOpenAIFileNode.ts`](packages/core/src/plugins/openai/nodes/GetOpenAIFileNode.ts).

Core already depends on `openai` 4.28.4, but there is no shared OpenAI client
factory for these nodes. `OpenAIEmbeddingGenerator` constructs its own client
with `dangerouslyAllowBrowser: true`.

### Functionality-Preservation Assessment

The SDK can perform `files.create`, `files.list`, and `files.retrieve`, but it
does not reproduce the current transport behavior automatically:

- the installed SDK defaults to two retries, while the current raw `fetch`
  attempts once;
- the installed SDK applies a 10-minute timeout, while the current raw request
  has no Rivet-owned timeout;
- multipart filename handling for an unnamed `Blob` must be compared;
- SDK errors differ from `handleOpenAIError` and can change the text and
  attached provider body shown to users;
- 404 must remain a `control-flow-excluded` output for Get File;
- organization-header omission/empty-value behavior must remain compatible;
- browser execution requires the explicit dangerous-browser option;
- the node's purpose values must remain accepted even where SDK types or newer
  APIs have evolved.

Normalizing all of these behaviors requires a shared client factory and an
error adapter. Those are useful only if several more OpenAI nodes will share
them.

### Credible Benefit

The three files total 411 lines, but nearly all node definitions, editors,
ports, and output shaping remain. Only their process-level request boilerplate
is replaceable.

After adding client construction, browser configuration, retry policy, and
error/404 normalization, the credible net production change is approximately
**0 to -20 lines**. Tests will add more lines than this saves.

### Specific Risks

- **Automatic retry side effects:** upload or list requests may be repeated
  where raw fetch currently attempts once.
- **Changed error contract:** SDK exceptions can hide or reformat the original
  provider response that Rivet intentionally surfaces.
- **Upload-body differences:** Blob/File names and multipart headers can change
  provider-visible behavior.
- **Browser compatibility:** omitting `dangerouslyAllowBrowser` breaks the
  current Browser executor path; enabling it must remain an explicit Rivet
  decision.
- **SDK-version coupling:** a Files-node refactor becomes tied to an old SDK
  major while other OpenAI surfaces are moving independently.
- **False reuse claim:** without a real shared client owner, each node merely
  replaces a short fetch block with a short SDK block.

### Recommendation

**Do not pursue as a LOC refactor.** Consider a shared OpenAI transport/client
only as part of a larger, separately planned OpenAI API modernization with a
defined retry, timeout, browser, and error contract.

---

## 6. Custom Debounce Hooks -> Existing `ahooks`

### Current Ownership

Custom commit behavior exists in:

- [`StringEditor.tsx`](packages/app/src/components/editors/StringEditor.tsx);
- [`NodeMetadataEditor.tsx`](packages/app/src/components/nodeEditor/NodeMetadataEditor.tsx).

The app already depends on `ahooks` and uses `useDebounceFn` elsewhere.

### Checked Semantic Assumptions

The two custom hooks are not generic duplicates:

- `StringEditor` can receive a changing debounce duration, applies a new
  duration to subsequent commits while an already scheduled timer keeps its
  original deadline, uses `undefined` as its no-pending sentinel, flushes on
  blur/Enter/Escape, cancels stale external values, and flushes on unmount;
- metadata editing uses a fixed duration, commits or restores pre-edit values,
  cancels on node changes, and cancels rather than flushes on unmount.

`ahooks` 3.9.7 constructs the debounced function once, so a changed `wait`
option is not applied automatically. It also registers an unmount cleanup that
cancels the debounced function. A later caller cleanup cannot blindly rely on
`flush()` to preserve `StringEditor`'s flush-on-unmount contract because effect
cleanup ordering becomes part of correctness.

A safe shared wrapper would still need explicit pending-value ownership,
changing-wait handling, flush/cancel policy, and lifecycle tests. At that point
the timer itself is the only meaningful code delegated to `ahooks`.

### Credible Benefit

The two local debounce owners contain roughly 110 lines. A sufficiently
explicit shared adapter would still require approximately 50-80 lines plus
small call-site changes.

Credible production reduction: **30-60 lines**. Regression tests for both
lifecycle policies will likely add 80-140 lines, increasing total repository
LOC.

### Specific Risks

- **Lost final edit:** library unmount cancellation can run before Rivet's
  desired flush.
- **Stale debounce duration:** `useDebounceFn` does not rebuild automatically
  when `wait` changes.
- **Wrong cancel policy:** metadata must not flush a pending edit after a node
  switch or cancelled edit.
- **Pending-value semantics:** the current string hook uses `undefined` as its
  no-pending sentinel even though its callback type allows `undefined`; a
  generalized wrapper must not silently turn that type-level possibility into
  new runtime commit behavior.
- **Callback freshness:** delayed commits must call the newest callback without
  rescheduling old values.
- **Escape/blur double commits:** composing Atlaskit events with library flush
  behavior can commit the same edit twice.
- **Abstraction opacity:** a small shared hook can make the distinct editor
  policies harder, rather than easier, to review.

### Recommendation

**Keep the current explicit hooks.** They encode different product behavior and
were recently documented. Reconsider only if at least one more editor needs the
same commit lifecycle and a shared Rivet hook can expose `flush-on-unmount`
versus `cancel-on-unmount` as explicit policy.

---

## 7. Color Parsing And Contrast -> `tinycolor2`

### Current Ownership

[`packages/app/src/utils/colorContrast.ts`](packages/app/src/utils/colorContrast.ts)
is 102 lines and has focused tests. It intentionally accepts only:

- 3- or 6-digit hex literals;
- numeric `rgb(...)` and `rgba(...)`;
- clamped/rounded RGB channels.

It rejects CSS variables and other CSS color syntax, then calculates WCAG
relative luminance and selects black or white.

`tinycolor2` is present transitively through `react-color`, but Rivet would need
to declare it directly before importing it.

### Functionality-Preservation Assessment

`tinycolor2` accepts substantially more color formats and has its own parsing,
rounding, alpha, and invalid-input semantics. Using it directly would broaden
Rivet's accepted input contract. Preserving behavior requires keeping the
current admission regexes and verifying numeric rounding/clamping before
delegating contrast calculation.

That strict adapter retains much of the code the dependency was supposed to
replace.

### Credible Benefit

A strict parser/normalization adapter plus direct dependency and type ownership
would save approximately **40-60 production lines**, not the full 102.
Existing tests must remain and should add parity vectors for boundary values.

### Specific Risks

- **Accepted-format expansion:** named colors, alpha hex, percentages, HSL, or
  other formats could start influencing UI themes where Rivet currently falls
  back.
- **Rounding/clamping changes:** decimal and out-of-range RGB channels may
  produce a different foreground choice near a contrast boundary.
- **Alpha handling:** the current code ignores the alpha channel; a library may
  composite or preserve it differently.
- **Transitive-dependency assumption:** relying on `react-color` to keep
  installing `tinycolor2` violates package ownership; direct use requires a
  direct dependency.
- **Maintenance inversion:** a stable, tested 102-line utility may be easier to
  audit than a library plus a compatibility adapter.

### Recommendation

**Do not pursue.** The current utility is small, security-insensitive, focused,
and transparent. A library provides more capability than Rivet wants and does
not eliminate enough policy code.

---

## Rejected Broader Substitutions

- **Official Pinecone SDK:** the
  [official TypeScript SDK](https://sdk.pinecone.io/typescript/) explicitly
  targets server-side use and Node 20+, which does not match the
  provider-neutral Knowledge Store's Browser and Node executor parity. Raw
  provider transport remains justified.
- **Socket.IO for web-app WebSockets:** Rivet's significant ownership is
  action journaling, leases, resume semantics, and execution identity—not
  WebSocket framing.
- **Mustache for interpolation:** Rivet's interpolation language includes
  graph/context lookup, processing pipelines, escaped tokens, and editor token
  spans. Mustache is not semantically equivalent.
- **Simple-git for revision discovery:** it assumes a Node child-process
  boundary that does not match browser/Tauri ownership.
- **Preact for the generated hosted renderer:** this is an architectural
  migration, not a behavior-neutral dependency substitution.
- **An SSE encoder package:** Rivet's encoding side is too small for a
  dependency to reduce ownership.

## Recommended Work Order

1. **Delete the unused `useIndexedDb.ts`.** This is the safest immediate
   102-line reduction and needs no library.
2. **Migrate live IndexedDB owners to `idb`, one database at a time.** Require
   legacy-schema migration tests before each owner changes.
3. **Decide SSE compatibility policy explicitly.** If standards-correct edge
   cases are acceptable, replace only the parser and treat it as protocol
   hardening. Otherwise leave it custom and expand its tests.
4. **Do not schedule the remaining substitutions for LOC reduction.** Revisit
   them only when a larger feature creates enough repeated ownership to change
   their cost/benefit result.

## Final Conclusion

The original list contained useful leads, but it overstated both the amount of
replaceable code and the behavior neutrality of several migrations.

- `idb` is solid and worth implementing with careful persistent-data tests.
- `eventsource-parser` is technically solid, but the migration intentionally
  changes edge-case SSE semantics and saves little production code.
- the FNV package swap introduces a published CJS packaging exception;
- TanStack Query does not directly preserve current global and per-session
  model-catalog behavior;
- the OpenAI SDK does not preserve raw-fetch retry, timeout, upload, and error
  contracts for free;
- `ahooks` does not directly preserve the two editor lifecycle policies;
- `tinycolor2` broadens a deliberately narrow color contract.

That leaves one recommended library migration, one conditional protocol
hardening project, and one immediate no-library cleanup. This is a smaller list,
but every retained item has a credible benefit and an explicit compatibility
boundary.

## Implementation Result

Implemented on 2026-07-25:

- deleted the unused `useIndexedDb.ts`;
- migrated the three live app IndexedDB owners to the direct app dependency
  `idb` without changing database names, versions, stores, keys, duplicate-add
  behavior, transaction boundaries, mutation order, or request-completion
  timing;
- added `fake-indexeddb` legacy-schema and behavior tests, including protection
  of the public native dataset-database contract;
- retained the custom SSE tokenizer and expanded its compatibility tests,
  because replacing it would not satisfy the stated functionality-neutral
  requirement;
- retained the vendored FNV-1a implementation, corrected its JSDoc return type,
  and added hash plus serialized-recording golden tests;
- left all rejected and deferred substitutions unchanged.
