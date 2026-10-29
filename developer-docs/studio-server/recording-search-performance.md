# Recording input search performance

## Authored price estimates

LLM Chat/Decision AI run in Inline mode and their separate Profile nodes optionally carry flat `tokenPricing` rates in
USD per million tokens. Physical-call accounting applies the active inline/profile configuration's
rates to provider-reported usage before the run-owned ledger receives the amount.
Manual rates override built-in/provider monetary estimates; absent overrides
preserve existing behavior. Cache rates require reported cache breakdowns (the
current Decision AI contracts have none). Missing usage is not free usage.
Statistics/storage aggregate the resulting snapshots unchanged, including bundle
children and failed attempts. Editing a profile cannot reprice old recordings.
These are still estimates, not invoices. No additional migration is needed for
profile settings; rates are authored project data, not a new statistics column.
The real cost-statistics browser fixture mixes inline and separate-profile rates across
three bundle members and displays the persisted total after reload. Its teardown
settles browser routing before stopping the API and always closes disposable
storage even when an earlier cleanup step fails.

## SQL-backed browsing and statistics

SQLite plus local immutable files and PostgreSQL plus S3 share the same read-path rule: catalog requests query metadata; object bodies are fetched only when their contents are needed. The existing recordings picker uses SQL counts/latest timestamps and compact project summaries. It must not rebuild the workflow tree or hydrate project/publication artifacts.

Run statistics now use `recording-statistics-sql.ts` for both SQL engines:

- Target catalogs return one row per logical target, with SQL counts and the newest timestamp/project label. Stable web-app graph/component IDs, legacy route-only targets, and latest non-null historical labels retain the shared builder semantics. Equal timestamps use recording ID descending to select the newest representative consistently in both backends.
- Metrics push workflow/target, selected time range and run kind into SQL and return only the compact duration/status/identity projection. SQLite uses the existing workflow/created-at expression index. Exact median/p95 interpolation, status exclusions and chart buckets remain in the existing shared builder; they are not approximated.
- A run-owned ledger observes supported LLM and Decision AI calls directly, including nested projects and background work, before display-event filtering. Stable call identities prevent duplicate observations from inflating totals. The terminal root recording stores the known USD amount and complete, partial or unknown status; do not sum child recording totals into the root a second time. Legacy nodes without complete attempt observations produce partial or unknown evidence. Estimates cover instrumented calls, not arbitrary external calls from user code or plugins, and are not provider invoices.
- Cost aggregation counts complete, partial and unknown evidence separately, preserves genuine zero, and averages only complete estimates. The shared **Include failed runs** and **Include runs with warnings** filters select one included population for duration metrics, costs, coverage and both charts. Outcome counts come from the matching population; only included categories' cards are displayed when either optional outcome is enabled. Older recordings have unknown costs; there is no backfill. PostgreSQL schema 18 adds nullable `workflow_recordings.cost_json`; filesystem and SQLite catalogs retain equivalent optional metadata. Migration/restore must preserve it. The release still needs the normal database migration and compatibility checks before deployment.
- The Run statistics modal shows the known subtotal and complete-only average without a separate complete/partial/unknown count line. **Cost over time** always plots both USD series with distinct colors and a legend; it has no metric switcher. Partial-only buckets still plot the known subtotal while the unavailable average remains a gap, with an explanatory message. Missing fields from an older server display an unavailable message; unknown buckets never become zero-valued points. Statistics include retained recordings only, and disabled, lost or expired recordings cannot be represented.
- **Duration** and **Cost** are separate bordered panels inside the common scrolling area. Shared outcome filters sit beside Period/Version in the common controls. The summary below them is one line: **N runs, Date 1 to Date 2**, counting the included population. The target is already in its selector; do not repeat its title, a run-outcomes heading or included/excluded prose. Both toggles off hides the entire outcome-card region. Enabling errors shows Succeeded/Errors; enabling warnings shows Succeeded/Warnings; enabling both shows all three. Percentages use the included population as denominator (success + enabled errors/warnings). A zero included denominator displays a dash rather than a fabricated percentage. Browser coverage exercises all four toggle combinations and asserts absence of excluded cards, not only their percentage text.
- Each panel owns its independent **By day / By week** grouping control, initially **By day**; no **Auto** option is exposed. Period, target, version and outcome filters remain shared; changing a grouping does not change the other panel's selection. The modal sends one query with `aggregation` (duration) and optional `costAggregation` (cost). The backend reads the matching metadata once, then computes both charts and totals from that same population; recording arrival or retention cannot produce cross-request snapshot drift. Equal groupings also reuse their in-memory bucket partition. Omitting `costAggregation` preserves existing callers' shared grouping behavior. Both fields use the same validated enum; no schema migration or response-shape change is needed. Query-key/abort guards still reject stale responses. Grouping choices persist across period and target changes within the mounted modal.
- The shared summary displays only **N runs, Date 1 to Date 2**; do not add a second cost-coverage count line. Coverage remains in API metadata and still governs subtotal/average calculations, incomplete-cost warnings and unavailable states. Shared outcome checkboxes are vertically centered against the Period/Version switchers, not their labels. Browser regressions compare the actual checkbox and switcher centers and verify the summary remains single-line content across all cost states. Grouping controls sit at the top right of their respective panels and wrap within them at narrow widths. Duration-specific definitions and cost-specific estimate explanations stay in their panels. Retain scrolling at narrow widths; do not reintroduce a single surrounding bordered box or panel-local outcome filters.
- The selected **Workflow endpoint** scopes every outcome, duration, cost, coverage count and chart to that workflow's root recordings in the selected period/version. An endpoint target is identified by immutable workflow ID, so renaming its route retains its history. Referenced-project calls contribute inside that root's accounting; their separate child recordings, editor runs and web-app actions do not enter endpoint statistics. Changing targets hides the previous target's metrics while the new request is pending. Browser coverage switches between distinct cost/coverage fixtures to verify this boundary.
- Neither path reads recording, replay, dataset or project artifacts. SQLite validates the projected metadata, and aggregate counts are checked before entering the response builder. Artifact integrity remains the responsibility of artifact readers and verification, not a reason to download every object for a count.
- All statistics backends exclude `runKind: editor` independently of execution-surface metadata. Missing or conflicting surface fields must not turn a local editor replay into an endpoint or web-app run.
- This bounds response materialization by targets for catalogs and by matching runs for metrics. Catalog window aggregates still scan relevant metadata; exact percentiles still require the selected durations. This is not a constant-time analytics store or a guarantee of production latency.

### Cost accounting ownership and extension contract

`GraphInvocationState` creates a fresh `RunCostLedger` identity set for each root invocation. Project calls create scopes sharing that set; ordinary same-project graph calls, async branches, streaming watches and continuations inherit the current scope. `GraphProcessor` captures the caller ledger at child construction independently of lifecycle-parent rewiring, then creates a fresh scope on each called-project invocation. Explicit project reentry starts a fresh scope even when its project ID matches; do not use project IDs alone to accumulate calls. Node contexts capture the specific scope, so late observers cannot write into a later invocation reusing the processor. LLM Chat physical attempts use `callId`; Decision AI physical attempts use their trace `eventId`. The shared set ignores repeated identities across all scopes, counts retries as distinct attempts and never reads authored graph cost outputs. Cached editor results do not represent a new provider call.

Model-call, profile-attempt, LLM-output-snapshot and tool-call callbacks also capture their original root/graph invocation IDs as immutable values. Late accounting still belongs to the captured ledger and original host observer, but process-event forwarding is fenced by those IDs. Never stamp a retained callback with a reused processor's current identity: that can inject an old call/page into a newer recording and Run Activity even when the new run's cost ledger is correct. Accepted events still get fresh metadata objects, not a mutable object shared across observations. The regression holds a new invocation open, delivers all four kinds of old callback, and verifies its event stream, recording and subtotal stay clean. Previously finalized recording summaries remain immutable; a late observation is not a backfill.

`ExecutionSession` waits for physical completion before reading the summary and disposing the processor. Web-app WebSocket actions acknowledge cancellation immediately, but finalize their recording separately after physical completion. Finalization is bounded by five seconds; a deadline or shutdown flush keeps the observed subtotal as partial (never complete) if execution is still running. Unreadable accounting remains unknown. The finalizer is idempotent, so a late completion cannot create another recording or update a timed-out snapshot. Serving and persistence failures must not be hidden by rerunning a request.

`GraphProcessor.getRunCostSnapshot()` includes the root's pending lifecycle in coverage. Before any finished priced attempt, an unsettled run is unknown—not an invented $0 subtotal. An explicitly observed zero-priced attempt can contribute a partial $0 subtotal while other work remains pending. Only after physical completion can a zero-call invocation be complete at $0. The ledger retains this distinction without extra stored metadata or an additional attempt-tracking registry.

The ledger retains physical-call identities only for deduplication, not a second collection of per-call amounts or a reverse index of completed project scopes. Each accepted observation updates inclusive LLM, Decision AI and total summaries in its scope and ancestors. Both root and subtree totals preserve physical-observation addition order; do not derive the total by adding family subtotals, which can change floating-point results. Reads are constant-time snapshots, not scans of unrelated branches' calls. Observation work is proportional to project-call depth. Rates are never recalculated here, and child graph outputs are never summed into accounting. Coverage flags distinguish absent/unknown evidence from an explicitly observed zero; missing evidence marks that scope and its ancestors, never siblings. Unclassified missing evidence marks both families. Do not infer missing-call counts from those flags. Observations are append-only and first-identity-wins; a future correction/repricing mechanism would need an explicit contract, not mutation of retained snapshots.

The Debug **AI Cost** node reads `InternalProcessContext.getRunCostBreakdown`, a read-only closure over the current project-invocation view captured by the observation callbacks. In A → B → C, B's node includes B + C, C's includes C, and A's includes all three; repeated/parallel B calls stay separate. Same-project graph helpers share B's view, including work before the helper began. Never resolve the reader through a processor's later current run, recompute prices or add Subgraph outputs. It defines no inputs. Enable the standard **Conditional node** setting to expose `$if` when ordering is needed; connect branch outputs to **Did Run**, then its **Ran** output to `$if` to wait for several branches without treating zero/false/empty results as false conditions. Do not add a separate trigger or custom scheduling policy. Observations after the snapshot can increase its subtree subtotal. Unknown category amounts remain excluded, partial amounts remain known subtotals with a node warning, and empty categories are genuine zero-so-far. This live read does not pass the root's `isRunning` flag to the final-summary coverage calculation: unfinished/future work is explicitly outside this point-in-time snapshot. `GraphProcessor.getRunCostSnapshot()` deliberately remains the full root summary used by recording finalization and Run statistics, not the node's scoped read. Stored summary formats and aggregate/statistics queries are unchanged.

AI Cost's activity descriptor selects `totalCost` for the Run Activity preview rather than the first (LLM-only) output. It remains a generic reader, not a model call: its output must not add another charge to activity accounting or recordings. The actual registry/resolver regression uses a Decision-AI-only subtotal to guard against a misleading zero preview.

An entirely unknown total remains `control-flow-excluded` and previews as **Not ran**, not JavaScript `undefined` or an unrelated category's zero. The reader fixtures also serialize real recordings and replay both priced and unpriced results under both schedulers: output amounts/types and warnings must survive, while replay must not execute providers or add new spend to the live ledger.

Complete means every observed supported AI attempt is priced, including a genuine zero-call or zero-usage run. Partial retains a known subtotal with missing attempt/price evidence. Unknown has no reliable subtotal. Legacy Chat, Chat Loop, Google, Anthropic, Hugging Face and embedding nodes lacking the physical-attempt contract cannot claim complete estimates; any valid positive legacy cost is only a partial subtotal. Arbitrary external calls from Code/plugin nodes remain outside the instrumented scope. A new AI integration must provide physical-attempt observations (including failure/usage evidence), stable attempt identity and honest unknown pricing before it can contribute complete accounting. Never adapt it by summing Subgraph outputs.

Storage readers and statistics aggregation share `readWorkflowRunCost` as the metadata-validity contract. Do not duplicate status/amount validation in aggregators: malformed, negative or non-finite amounts remain unknown, while explicit zero remains a real estimate. Coverage counts and complete-only averages are calculated after this normalization.

Rate-based pricing shares `isReportedTokenCount` across LLM catalog rates, explicit
prices and Decision AI: counts must be nonnegative safe integers. Fractional,
negative or unsafe values remain unpriced instead of entering a complete dollar
estimate. An explicit provider-reported monetary amount (OpenRouter) remains
independent of token-count availability/validity; genuine reported zero is valid.
The pricing regression exercises both input/output validation and that monetary
precedence, while the statistics regressions verify independent chart boundaries
through the real HTTP validator and both SQL engines.

Cancellation and cost coverage are independent. If a physical LLM response has already returned usage before cancellation arrives during diagnostic finalization, keep that usage (including OpenRouter's reported cost) in the aborted-attempt observation. The graph must still abort, with no retry or success result. Usage that never arrived remains unknown; do not wait indefinitely for late usage or reopen a finalized recording. `chatV2Pipeline.test.ts` covers this race in generate and stream modes for token-priced and provider-priced calls.

All time buckets use root execution start time, not individual provider call times or recording-save time. Early-response runs become visible only when the final recording is retained; background work can therefore add a completed recording to an earlier start-time bucket. Old recordings remain unknown and stored estimates are not recomputed when model prices change.

Verification:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/recording-statistics-sql.test.ts src/tests/managed-recordings.test.ts src/tests/sqlite-workflow-backend.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:statistics-managed
yarn workspace @valerypopoff/rivet-studio-server-api test:migration-managed
PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe run-statistics-modal.spec.ts run-cost-statistics.spec.ts
```

The second command starts and removes its own isolated PostgreSQL container (Docker required). Both engines execute identical mixed-target fixtures and compare exact results with the shared in-memory baseline. SQLite checks its actual query plan. PostgreSQL additionally inspects `EXPLAIN (ANALYZE, BUFFERS)` for the real statistics projection against 50,000 unrelated history rows, requiring the existing workflow index to select only the two target rows while preserving partial/unknown cost metadata. This establishes semantic parity and compact query boundaries, not S3/network latency, a production execution-plan benchmark or a constant-time query for a large selected target.

The migration/restore fixtures carry nonzero partial cost evidence from filesystem storage and explicit unknown evidence from live SQLite into managed storage. The live SQLite test also reads the migrated summary back explicitly: unknown must remain unknown, not become free usage. Recording-backend unit tests separately cover complete/nonzero and genuine-zero metadata.

The real `run-cost-statistics.spec.ts` scenario starts its own exact-owned PostgreSQL/MinIO containers and local HTTP provider fixture, runs a mixed LLM Chat + Decision AI bundle A -> background B -> C, checks complete/partial and failed-run evidence via the statistics API, then checks the real UI and reload. The fixture verifies that LLM calls actually use streamed provider responses. The ordinary workflow HTTP endpoint returns JSON; it has no separate SSE response mode to qualify. The same scenario checks nonzero published HTTP/WebSocket web-app actions and cancellation while a child provider request is held after paid root calls have finished. It requires Docker and a local hosted web preview; it never accepts a deployment storage address. Four smaller modal scenarios cover available, partial-only, unknown and missing-server capability without Docker; a fifth checks independent grouping, target switching and shared-filter alignment. The UI retains one run-count/period summary rather than repeating API coverage counts. Both spec files are required by the balanced browser CI selection, with an inclusion regression. Neither lane makes paid provider requests or certifies provider invoices/GKE behavior.

Core accounting coverage is concentrated in existing suites rather than a second harness:

- `RunCostLedger.test.ts`: duplicate observations, known/unknown evidence, honest zero and overflow.
- `ClassifierResourceAndCost.test.ts`: nested A -> B -> C with two parallel calls to B (five physical calls total), independent concurrent roots and processor reuse.
- `GraphProcessor.asyncBranches.test.ts`: foreground and background observations at the actual output-ready/completion boundary, independently of authored cost outputs.
- `chat-v2/openRouter.test.ts`: physical retry/streaming observations, editor cache reuse and repeated recording replay without new provider calls or accounting charges.

These are local implementation gates. Release validation still requires normal CI, schema-18 migration approval and the ordinary deployment checks; local evidence does not establish production or GKE qualification.

The statistics details panel owns vertical scrolling at every width. Do not switch it to `overflow: visible` under a responsive breakpoint while the shell/body hide overflow: the second chart's cost controls become unreachable. The available-cost browser scenario resizes to tablet and phone widths, uses actual mouse-wheel input to reach Cost's grouping controls, and checks label fit. Programmatic scrolling resets the starting position and then reaches the bottom separately to check both series' legends.

The broader read-path audit also leaves two explicit profiling candidates: SQLite readiness performs full `quick_check`/foreign-key checks on the catalog, and structural/publication mutations still capture full history snapshots for CAS. Both can become costly as metadata/history grows. This patch does not throttle integrity checks or replace mutation consistency proofs just to improve a nominal timing. Evaluation run lists also intentionally return complete run documents under their current API contract; introducing summary pagination there is a separate API/UI change. Production measurements should distinguish these costs from the now metadata-only browsing paths.

## Local synthetic history previews

For a manual statistics preview, synthetic historical copies may be added to an
explicitly verified **dev/local-storage** installation. That launcher uses local
PostgreSQL and MinIO, not the compatibility SQLite catalog. Guard both Compose
identity and the actual database/object-store addresses; never seed production.

Use new recording IDs and correlation IDs, and visibly mark the endpoint-at-run
label as synthetic. Vary timestamps, daily run counts, durations and stored cost
summaries without executing providers or changing authored model prices. Exact
original-row hashes should remain unchanged. Immutable replay artifacts can be
shared through their existing descriptors: managed cleanup checks all live
references before deleting an object. Such a copy replays the original event
stream, not a newly observed AI call; it is a **chart preview**, not runtime
accounting or provider-billing evidence.

Inspect retention first. Old demo rows or an exceeded endpoint/byte limit can
trigger cleanup, including of real recordings. Preserve the prior settings and
their revision, increase only the needed local limits with the ordinary
conditional settings API, and keep an exact batch-ID/recording-ID receipt for
later removal. Do not blindly replay an uncertain insert or restore settings over
a subsequent user edit. No recording-format or statistics-aggregation change is
needed for this data-only operation.

Keep re-verification independent of temporary container files: the durable host
receipt supplies the exact expected rows and original hashes. Check each row,
including replay references and correlation identity, rather than accepting a
matching aggregate (swapped costs can preserve a total). Confirm shared artifact
reachability and compare API totals/complete-only averages with the same stable
SQL population. Allow new genuine recordings without weakening checks on the
captured originals. Give each browser/audit run its own output directory so a
previous success file cannot fail a valid rerun or masquerade as fresh evidence.

## All-workflow scope

The icon-only **Refresh run recordings** button follows the modal title. It starts
a new controller reset generation, using the same initial state as an explicit
close/reopen: Any workflow, All outcomes, page 1, 20 roots per page, no input filter
and collapsed families. The dialog and backdrop remain mounted, so refresh does
not restart their opening animations or lose focus. Resetting cancels the old
catalog/run/search/child requests and fences late results, including a refresh
during initial loading; the catalog effect depends explicitly on this generation.
It does not reload the editor or replay writes. Dismissing via the backdrop still
retains the existing session as before. Persistent input-path history is untouched.
Refresh is disabled while opening or deleting a recording; it remains available
during reads and after read failures. Browser regressions check request renewal,
search replacement, reset defaults, stale catalog rejection, stable dialog identity
and icon placement.

The workflow-details card (name, status, endpoint and project path) is rendered only for an individual workflow. Any omits the entire card, including its heading; the runs panel and filters remain visible. Browser coverage checks both the default Any view and switching from a workflow back to Any.

At widths up to 720 px, the modal body owns vertical scrolling and its content uses natural height. The recording list still has a bounded, independently scrollable viewport for virtualization. Do not constrain the outer layout and hide overflow here: adding the workflow card or filter form would clip pagination. A narrow-screen browser regression uses actual mouse-wheel scrolling to verify controls remain reachable in both scopes with the filter form open.

The catalog may supply aggregate `totals` independently of its selectable workflow summaries. Legacy storage includes retained recordings whose project file was removed outside Rivet. The Any badge, status counters, and input-search progress use these totals rather than counting only current tree entries. Responses without totals retain the summed-workflow fallback; managed and SQLite authorities enforce recording/project ownership. All-workflow queries preserve each recording's real workflow ID.

The Run recordings workflow selector starts with **Any**, selected by default and available even when its workflow catalog is empty. Status filters, ordinary pagination, progressive input search, replay and deletion work in this scope as well as for an individual workflow. Switching scope resets pagination and cancels obsolete searches; deleting the last recording of a removed catalog entry returns to Any.

The controller initializes and resets its selection to the empty all-workflow scope. Explicitly closing the modal starts a fresh session on Any when reopened; a temporary dismissal retains the existing search and selection. The browser regression `a fresh session defaults to Any after closing a workflow-specific view` protects this default independently of option ordering.

Catalog counters are snapshots, not pagination or search authorities. Clamp an out-of-range page only after its runs response has loaded; never use catalog estimates while that request is pending. Search progress uses the scanner's cumulative analyzed count, expanding the estimate if needed and reconciling it on completion instead of inventing analyzed runs from stale totals. Deletion stops an active search immediately, even if the mutation fails; retained matches remain available and Apply can retry. Browser regressions cover counts growing/shrinking since catalog load, Any pagination beyond the old catalog's last page, and failed deletion during a held continuation.

`GET /api/workflows/recordings/runs` uses the same backend query path as `/recordings/workflows/:workflowId/runs`, with an empty workflow ID representing the all-workflow query scope (never a persisted recording owner). All three storage backends omit the workflow restriction while retaining status filtering and stable newest-first `(created_at, recording_id)` ordering. Each returned run keeps its actual workflow ID. Input continuations bind to this scope and cannot be reused in a single-workflow search. Do not implement Any by concatenating independently paginated workflow responses: that breaks global ordering, pagination and bounded search.

## Scope and invariants

Current input searches select only non-Subgraph root recordings, including legacy rows without execution-surface metadata. Their `scopeCounts`, progress and matches exclude children. Ordinary modal browsing uses `groupByRoot=true` to paginate top-level families, not individual children. Expanding an entry uses the separate authenticated metadata-only `GET /api/workflows/recordings/:recordingId/sub-runs` route, without input or status predicates. Child pages are checked for identity, ownership, progress and consistent totals before publishing a complete family. See [Development](./development.md#collapsible-recording-families) for context groups and pagination invariants. Catalog/status summary counts still include retained recordings; they must not replace authoritative family-page or root-search totals. Flat API browsing without the grouping flag is unchanged.

Optimization changes request scheduling, metadata-query indexes, and transient process-local work. Recording artifacts, compression, retention, input matching, missing-input semantics, newest-first ordering, and precise PostgreSQL cursor timestamps remain unchanged. Cursors advance through consumed candidates, not completed speculative reads. Errors are not silently converted into non-matches.

The shared scanner batches metadata windows, drains ready ordered decisions, guarantees progress after a budget overrun, and yields between windows. Cache handoff grace is bounded and separate from explicit cancellation. Weighted admission limits simultaneous large reads; compiled workers recover without a permanent inline fallback. No persistent index of extracted inputs or sidecar is introduced.

SQLite creates the composite all-runs and failed-runs metadata indexes when its recording database opens. Managed deployments apply additive schema migration **11** for the equivalent PostgreSQL indexes; earlier migrations and checksums are unchanged. Helm compatibility and release-manifest contracts advance with that migration. The change does not rewrite recordings or introduce new recording row fields. Index creation can take time and locks on a large existing managed database, so run it through the normal migration/release workflow.

Invalidation detaches an in-flight load from new consumers, without interrupting its existing consumers. Only the current load identity may populate the cache; cancelling the last consumer also stops detached work. This replaces per-key generation bookkeeping and prevents stale joins after reset.

The production artifact extractor rejects malformed JSON or a missing recording object with a payload-free error, while a valid recording without captured input remains a cacheable `exists: false` result. A filesystem candidate already removed before its stat check can still be skipped as absent. The scanner handles read and matching failures together, including falsy rejection values, and only surfaces them when their ordered candidate is consumed; speculative matching cannot cause an unhandled rejection.

## Search batching and worker preparation

The browser keeps its initial filtered request at the ordinary page size (20 by default), then requests 100 matches per continuation. This search batching is independent of the top-level family pagination used by ordinary browsing. The initial newest-match probe, 150 ms scheduling budget, cancellation and ordered cursors remain authoritative; 100 is a response cap, not a promise to wait for 100 matches.

After an authorized recordings-catalog request successfully loads its metadata, the API prepares one idle extraction worker without reading any recording artifacts or delaying the response. Repeated catalog requests do not allocate more workers. A direct search still initializes lazily. Preparation failures do not fail the catalog; search-time bounded recovery remains responsible for reporting unavailable workers. Shutdown disposes prepared workers too. This trades one idle worker's memory for hiding startup during the time between opening the catalog and searching, not for faster artifact decompression.

## Cache capacity and diagnostics

`RIVET_RECORDING_INPUT_CACHE_MAX_MIB` configures completed-input retention **per API process**, default 32, integer range 0–512; 0 disables completed retention while preserving shared in-flight loads. Invalid values fail at process initialization. The entry-count limit (16,384), individual-input limit (1 MiB), and five-minute TTL remain unchanged. This budget excludes keys, worker heaps, decoding and transient buffers; it is not a process RSS limit. Compose production/dev forward the setting from the launcher environment or `.env`; restart/recreate the API to apply it. Managed Helm installations can supply it through the chart's existing `env` map. Account for each replica and leave memory for execution before increasing it.

With metrics enabled, `rivet_recording_input_cache_events_total{event}` counts `hit`, `miss`, `shared`, `load`, `evicted`, `expired`, and `oversized`. A shared lookup is also a miss; load counts actual admitted loads, not consumers. `rivet_recording_input_extraction_seconds{stage}` observes `decode`, `parse`, and `queue_transfer` durations. These are fixed-cardinality aggregates: never label by input, filter, recording key or project. Observer failures cannot change search results. The cache's diagnostic snapshot additionally supplies current entry/byte and active/queued load counts for benchmarks; counters are cumulative, so compare phase snapshots.

A repeated newest-first scan exceeding retention can evict all remaining older entries before reaching them. It is therefore not necessarily a warm-cache scan. Diagnose capacity, TTL and oversized rejection separately rather than increasing all limits or eagerly warming on persistence.

## Reproducing measurements

The benchmark defaults to the current browser policy: 20 rows on the initial request, 100 on continuations. Pass `--page-size 20` explicitly to reproduce the earlier continuation policy. `firstPageMs` measures when one search has collected the initial page size; concurrent searches are not combined to reach that threshold.

Build the API, then run:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api run build
yarn workspace @valerypopoff/rivet-studio-server-api run recording-input:benchmark --scenario sparse --recordings 1000 --payload-kib 32 --http-latency-ms 10 --extraction-kib 16384
```

Repeat with `recent`, `dense`, and `absent`. `--read-latency-ms` models slower storage. Run on a two-CPU VM/container or restrict processor affinity; the report records `availableCpus`. Do not compare trials while rebuilding packages or running heavy unrelated tests. Reports are generated under `artifacts/benchmarks/`.

Use `--initial-page-size 20 --page-size 100` for current browser behavior. `--input-kib` varies captured input independently of unrelated `--payload-kib` content; entropy alternates between repeated text and deterministic mixed characters. `--cache-mib`, `--cache-entry-kib`, `--cache-ttl-ms`, and `--repeat-delay-ms` control benchmark-only retention options without changing the deployed singleton. Exercise working sets below/above capacity, inputs above the entry limit, expiry, and the included concurrent scans. Reports include all these parameters, cache snapshots, and a native-V8 versus level-1-DEFLATE retained-input microbenchmark. The compression comparison is diagnostic, not a second production cache implementation. Worker-preparation measurements explicitly model 250 ms of catalog-to-search lead time and exclude that lead time from extraction latency.

Example capacity trial: `--scenario sparse --recordings 600 --payload-kib 1 --input-kib 64 --page-size 100 --cache-mib 32 --http-latency-ms 30 --extraction-kib 32`; repeat with `--cache-mib 64`. For entry rejection use `--recordings 12 --input-kib 1100`; for expiry use `--recordings 20 --input-kib 16 --cache-ttl-ms 10 --repeat-delay-ms 20`.

The HTTP adapter exercises the real SQLite query/scanner/cache but excludes application authentication and remote transport. The single-window comparison includes current worker/cancellation fixes: it is not a historical checkout. Search RSS is process-wide sampled memory, while extraction comparisons run in isolated child processes and report OS high-water RSS. Metrics are diagnostic, not CI wall-clock thresholds.

## Follow-up measurements — 2026-09-12

The final two-CPU dense trials compare an unchanged initial 20-row request followed by 20- versus 100-row continuations: reports `recording-input-search-1789216401618.json` and `recording-input-search-1789216453668.json`, 1,000 matches, 1 KiB unrelated payload, 30 ms simulated request latency. Warm completion fell from 2,026 to 518 ms and requests from 51 to 11; cold completion fell from 2,556 to 807 ms. Cold first-result latency was 216/240 ms and warm first-result latency 43/45 ms; the improvement is in collecting the remaining results, not proof of faster initial discovery. Compiled scanner assertions verified identical ordered IDs. Wall-clock trials are illustrative, not CI thresholds or production guarantees.

Two-CPU affinity, Node 22.22.3, 600 recordings with 64 KiB captured inputs and 1 KiB unrelated content, sparse matches, 30 ms simulated HTTP latency: reports `recording-input-search-1789216187338.json` (32 MiB) and `recording-input-search-1789216216373.json` (64 MiB). At 32 MiB, the repeat scan loaded all 600 artifacts and completed in 351 ms. At 64 MiB it loaded zero and completed in 114 ms. Cold completion was 526/557 ms respectively: a larger cache does not make the first scan faster.

The retained-input compression probe reduced a 65,573-byte value to 345 bytes (repeated text) or 53,727 bytes (mixed entropy). In the 32 MiB trial, encoding cost 0.23/1.04 ms and decoded hits cost 0.036/0.167 ms versus 0.022/0.023 ms without compression. Keep native V8 retention for now: the memory/CPU tradeoff depends on content, and a bounded memory knob is simpler than adding asynchronous compression, cancellation and admission ownership to every large cache entry. These synthetic measurements are not proof that compression could never help another workload.

Worker preparation in that trial reduced tiny-input extraction from 195 ms to 0.45 ms after an explicit 250 ms catalog lead. It shifts startup work earlier; it does not remove it or guarantee readiness when a search immediately follows catalog opening.

Additional compiled two-CPU trials exercised TTL expiry (`recording-input-search-1789216477426.json`: 20 inputs, 16 KiB, 10 ms TTL, 20 ms repeat delay) and oversized inputs (`recording-input-search-1789216486804.json`: 12 inputs, 1,100 KiB, 1 MiB entry limit). Both preserved matching/order while reporting repeat loads and the appropriate expiry/oversized counters. Increasing total cache capacity alone cannot fix expiry or entry-size rejection.

## Measured checkpoint — 2026-09-12

Node 22.22.3, two-CPU affinity, 1,000 recordings, alternating compressibility, 32 KiB unrelated payloads, 20 sparse matches, 10 ms simulated request latency. Report: `recording-input-search-1789204894305.json`.

| Worker-byte search                   | Single window | Multiple windows |
| ------------------------------------ | ------------: | ---------------: |
| Cold HTTP requests                   |            43 |                3 |
| Cold completion                      |      1,508 ms |           477 ms |
| Warm HTTP requests                   |            42 |                2 |
| Warm completion                      |        650 ms |            65 ms |
| Two cold searches, combined requests |            84 |                6 |
| Two cold searches, completion        |      1,299 ms |           311 ms |
| Two cold searches, artifact reads    |         1,000 |            1,000 |

Warm searches performed zero artifact reads. Cold first-result timings were 315 ms versus 374 ms in this run: startup/scheduling variance remains visible and this checkpoint does **not** establish faster cold first-result latency. Warm first-result timings were 43 ms versus 25 ms. The newest-match probe remains independently covered by a behavioral test that forbids older reads before returning it.

Actual SQLite query plan: `SEARCH recording_runs USING INDEX idx_recording_runs_workflow_created_at_id (workflow_id=? AND (created_at,id)<(?,?))`. Both all-runs and failed-only query shapes have production-schema regressions. The later multi-window batching refinement reuses these indexes; it requires no migration beyond the metadata-index addition described above.

## Extraction decision

The benchmark-only `json-stream-es` prototype tokenizes/decompresses the entire stream, selects start events/string-table entries, and discards unrelated assets. It is not used by the server. The isolated two-CPU trials measured:

| 16 MiB unrelated content       | Full parse | Tokenizer |
| ------------------------------ | ---------: | --------: |
| Repeated-text time             |      34 ms |    863 ms |
| Mixed-entropy time             |      79 ms |  1,109 ms |
| Repeated-text process peak RSS |    179 MiB |   153 MiB |
| Mixed-entropy process peak RSS |    193 MiB |   171 MiB |

Small 32 KiB artifacts were also slower with tokenization (17–19 ms versus under 1 ms). Retain native full parsing: the measured memory reduction does not justify the latency regression. The prototype would additionally require duplicate-container/invalid-wrapper semantic hardening before production use. Neither these fixtures nor a late string table prove every possible tokenizer will perform poorly.

## Verification and remaining limits

Focused editor tests import Core through its compiled package exports. After a
Core node/registry change, run
`yarn workspace @valerypopoff/rivet2-core run build:esm` before the editor's
`test:files` command; otherwise a stale local build can report an unknown node.
The ordinary root App test runner already owns this prerequisite. Do not bypass
the package boundary with source-only imports to hide a stale build.

Focused regression commands for all-workflow browsing, input search and statistics:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/managed-recordings.test.ts src/tests/sqlite-workflow-backend.test.ts src/tests/recording-input-query-plan.test.ts src/tests/recording-input-filter.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:files --test-name-pattern="all-workflow recordings" src/tests/workflow-recordings-http.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/recording-statistics.test.ts src/tests/recording-statistics-sql.test.ts src/tests/workflow-recordings-http.test.ts
```

For the Debug AI Cost reader, run `yarn exec tsx --test packages/core/test/model/AICostNode.test.ts packages/core/test/model/RunCostLedger.test.ts`. The real-processor fixtures cross repeated, parallel A → B → C project calls under both schedulers, check each project's subtree independently and the unchanged root total against recording accounting, and verify same-project helpers, explicit project reentry, invocation reuse, duplicate observations and concurrent-root isolation. Gated calls prove an earlier snapshot stays detached when a later call finishes with priced or unknown usage; the terminal summary still includes pending-work coverage. Scoped ledger tests check that missing-price evidence propagates to ancestors but not siblings. An independent ordered-call reference model verifies every scope/family snapshot, including pending coverage, after each mixed observation, guarding the incremental summaries against rounding, zero/unknown and cross-scope deduplication drift. With the local editor running, `yarn studio-server:ui:observe graph-call-path-node.spec.ts` verifies Debug-menu discovery, the three output labels, subtree scope text, icon, documentation link and an executed node's actual Run Activity row. These fixtures make no paid provider calls.

With the development server running, set `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`, then run `yarn studio-server:ui:observe run-recordings-modal.spec.ts`. This covers Any defaults, global pagination/filtering/deletion, retained recordings without a catalog project, stale counters, cancellation races, refresh without backdrop remounting, and narrow-screen control visibility. Use `PLAYWRIGHT_BASE_URL` if the server is not at the runner's default URL.

`run-statistics-modal.spec.ts` checks independent chart grouping through a single
request plus target/outcome scoping. `recording-playback-history.spec.ts` checks
repeated playback, status colors and frame geometry with and without pinned Data
Bus rows. These controlled browser fixtures do not constitute provider or
production qualification.

- Deterministic tests cover dense pagination (1,000 matches in 51 requests), sparse multi-window batching, budget expiry before admission, ready-result draining, cancellation, memory admission, handoff reuse/expiry, and worker recovery.
- Compiled worker tests require an API build; they do not rely on the source-mode inline extractor.
- The extractor makes the single transfer-buffer copy at worker dispatch. Storage providers return stable bytes without an extra defensive full-artifact copy; the extractor never detaches provider-owned or pooled memory. Text-only providers remain supported, and the in-memory store preserves exact text reads without a UTF-8 round trip.
- Browser checks cover replacement searches, progressive append/scroll position, viewport resizing, deletion, and close cancellation through `yarn studio-server:ui:observe`.
- The recordings modal supplies a definite viewport-relative height: a virtualized list has no intrinsic content height and otherwise collapses before its first measurement. Browser assertions use the search count for complete results, not the number of mounted virtual rows.
- Row indexes are established in the layout phase before child measurements. Appends retain existing measurements; viewport-width changes and replaced row content invalidate cached heights, including offscreen rows.
- Deletion callbacks own the view/request generation in which they started. Completion or failure cannot overwrite a replacement search, page, workflow selection, or closed session. If deletion removes the last row on a page, the ordinary page effect performs the replacement fetch rather than a second request in the delete callback.
- Only one deletion may be pending within a view: row actions are disabled and the controller also rejects duplicate invocation. Changing the view releases this UI ownership, not the server-side deletion. A late response must not clear a newer deletion's loading state or report its error in the new view.
- Cache invalidation detaches active loads rather than cancelling consumers that still need them. Only the current load identity can populate the completed cache, in either completion order; failed replacements cannot revive stale results. Invalidation cancels unclaimed pagination-grace work immediately.
- Adversarial coverage uses gated loads and HTTP responses for repeated cache resets, shared-consumer cancellation, stale successes/failures, workflow switching, modal reopening, and overlapping deletion lifetimes. Speculative read/matching failures (including falsy rejections) are handled immediately but surfaced only at their consumed cursor position. An error beyond a returned page cannot retroactively fail that page.
- Malformed JSON, missing recording envelopes, and corrupt gzip are reportable extraction failures, not cacheable non-matches. Compiled-worker tests run a valid recording and a valid no-input recording after each failure to verify recovery; historic low-level extraction compatibility is unchanged.
- Managed encoded sources carry the immutable descriptor's `decodedBytes` into the worker. Gunzip enforces this limit and the result must match it exactly. Legacy sources without an authoritative decoded-size contract remain supported; compressed/uncompressed catalog accounting is not treated as an integrity descriptor. Invalid UTF-8 artifact bytes fail explicitly rather than being replaced and parsed as a non-match. The worker keeps prior BOM handling, and byte ownership/transfer and serialized text-provider contracts are unchanged.
- A stopped search with no collected rows displays that results may be incomplete, never the definitive no-matches message reserved for an exhausted search. The HTTP regression checks payload-free malformed-artifact errors and recovery after repair; the browser regression checks their stopped/error presentation.
- PostgreSQL execution-plan timing still needs a representative managed database. Mocked managed tests validate cursor parameters, not planner performance.
- A cold arbitrary-input search still reads and parses candidate artifacts. Weighted admission is an estimate, not a hard decompression/RSS ceiling. One oversized artifact can remain expensive.
- Keep the virtualized UI; do not introduce another client state architecture without a measured browser bottleneck.
