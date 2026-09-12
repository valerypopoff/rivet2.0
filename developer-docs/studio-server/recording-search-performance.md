# Recording input search performance

## Scope and invariants

Optimization changes request scheduling, metadata-query indexes, and transient process-local work. Recording artifacts, compression, retention, input matching, missing-input semantics, newest-first ordering, and precise PostgreSQL cursor timestamps remain unchanged. Cursors advance through consumed candidates, not completed speculative reads. Errors are not silently converted into non-matches.

The shared scanner batches metadata windows, drains ready ordered decisions, guarantees progress after a budget overrun, and yields between windows. Cache handoff grace is bounded and separate from explicit cancellation. Weighted admission limits simultaneous large reads; compiled workers recover without a permanent inline fallback. No persistent index of extracted inputs or sidecar is introduced.

SQLite creates the composite all-runs and failed-runs metadata indexes when its recording database opens. Managed deployments apply additive schema migration **11** for the equivalent PostgreSQL indexes; earlier migrations and checksums are unchanged. Helm compatibility and release-manifest contracts advance with that migration. The change does not rewrite recordings or introduce new recording row fields. Index creation can take time and locks on a large existing managed database, so run it through the normal migration/release workflow.

Invalidation detaches an in-flight load from new consumers, without interrupting its existing consumers. Only the current load identity may populate the cache; cancelling the last consumer also stops detached work. This replaces per-key generation bookkeeping and prevents stale joins after reset.

The production artifact extractor rejects malformed JSON or a missing recording object with a payload-free error, while a valid recording without captured input remains a cacheable `exists: false` result. A filesystem candidate already removed before its stat check can still be skipped as absent. The scanner handles read and matching failures together, including falsy rejection values, and only surfaces them when their ordered candidate is consumed; speculative matching cannot cause an unhandled rejection.

## Search batching and worker preparation

The browser keeps its initial filtered request at the ordinary page size (20 by default), then requests 100 matches per continuation. Ordinary unfiltered pagination is unchanged. The initial newest-match probe, 150 ms scheduling budget, cancellation and ordered cursors remain authoritative; 100 is a response cap, not a promise to wait for 100 matches.

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

| Worker-byte search | Single window | Multiple windows |
| --- | ---: | ---: |
| Cold HTTP requests | 43 | 3 |
| Cold completion | 1,508 ms | 477 ms |
| Warm HTTP requests | 42 | 2 |
| Warm completion | 650 ms | 65 ms |
| Two cold searches, combined requests | 84 | 6 |
| Two cold searches, completion | 1,299 ms | 311 ms |
| Two cold searches, artifact reads | 1,000 | 1,000 |

Warm searches performed zero artifact reads. Cold first-result timings were 315 ms versus 374 ms in this run: startup/scheduling variance remains visible and this checkpoint does **not** establish faster cold first-result latency. Warm first-result timings were 43 ms versus 25 ms. The newest-match probe remains independently covered by a behavioral test that forbids older reads before returning it.

Actual SQLite query plan: `SEARCH recording_runs USING INDEX idx_recording_runs_workflow_created_at_id (workflow_id=? AND (created_at,id)<(?,?))`. Both all-runs and failed-only query shapes have production-schema regressions. The later multi-window batching refinement reuses these indexes; it requires no migration beyond the metadata-index addition described above.

## Extraction decision

The benchmark-only `json-stream-es` prototype tokenizes/decompresses the entire stream, selects start events/string-table entries, and discards unrelated assets. It is not used by the server. The isolated two-CPU trials measured:

| 16 MiB unrelated content | Full parse | Tokenizer |
| --- | ---: | ---: |
| Repeated-text time | 34 ms | 863 ms |
| Mixed-entropy time | 79 ms | 1,109 ms |
| Repeated-text process peak RSS | 179 MiB | 153 MiB |
| Mixed-entropy process peak RSS | 193 MiB | 171 MiB |

Small 32 KiB artifacts were also slower with tokenization (17–19 ms versus under 1 ms). Retain native full parsing: the measured memory reduction does not justify the latency regression. The prototype would additionally require duplicate-container/invalid-wrapper semantic hardening before production use. Neither these fixtures nor a late string table prove every possible tokenizer will perform poorly.

## Verification and remaining limits

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
- A stopped search with no collected rows displays that results may be incomplete, never the definitive no-matches message reserved for an exhausted search. The HTTP regression checks payload-free malformed-artifact errors and recovery after repair; the browser regression checks their stopped/error presentation.
- PostgreSQL execution-plan timing still needs a representative managed database. Mocked managed tests validate cursor parameters, not planner performance.
- A cold arbitrary-input search still reads and parses candidate artifacts. Weighted admission is an estimate, not a hard decompression/RSS ceiling. One oversized artifact can remain expensive.
- Keep the virtualized UI; do not introduce another client state architecture without a measured browser bottleneck.
