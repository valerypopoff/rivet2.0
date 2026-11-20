# Published endpoint admission before project preparation

Status: implemented and verified locally, November 20, 2026. No deployment or live
configuration change. This records the implementation and its preservation requirements.

## Problem and boundary

Published HTTP requests previously loaded the executable project before checking
the shared execution gate. Even at full capacity, public requests performed their
required fresh metadata lookup, loaded missing revision/release artifacts, and
constructed mutable project state before returning `429`.

The fix moves only expensive preparation behind admission. Authentication, body
limits, endpoint existence and public/internal access retain their current order.
The required fresh public metadata lookup remains before admission: this change
does not eliminate overload pressure on the database or guarantee a particular
production throughput.

Cold preparation now occupies an execution slot instead of running outside the
limit. A cold burst can therefore have fewer graphs actively executing while
projects load, but it cannot create an additional unbounded preparation workload
behind a full execution gate. Database capacity, external API capacity and the
memory used by running graphs still need their own workload validation.

## Request flow and ownership

1. Validate/authenticate the endpoint before receiving its JSON body, as before.
2. Parse with the existing body-reader queue, size and byte-reservation limits.
   Waiting/receiving an upload owns no execution permit.
3. Resolve a request-local `WorkflowPublishedExecutionTarget`: current access
   metadata and a deferred `load()` operation. Missing/private public targets
   return the same `404`, even when execution capacity is full.
4. Acquire the existing shared published permit. Saturation still returns `429`,
   `error.code: execution_capacity_exceeded`, and `Retry-After: 1`; draining still
   returns `503`. Rejection never calls `load()`.
5. Track accepted HTTP work before loading project/release artifacts, constructing
   mutable per-run state, and creating the processor. Recheck the loaded result's
   existence/access because storage invalidation can cause a reload.
6. Retain the permit and shutdown registration through preparation, the complete
   run and its background tail, preserving early-response/recording semantics.
   Release both on every exit, including failed preparation and construction.

The existing UI-adjustable limit now includes accepted project preparation. The
gate, live-setting subscription, other published surfaces, body admission, latest
editor runs and recording persistence are unchanged. There is no new execution
queue, database schema, environment flag, service or automatic graph retry.

## Storage seams

`WorkflowExecutionSources.resolvePublishedExecutionTarget` is separate from the
existing full-project loader; other callers keep that API. Targets own no lock,
worker lease or background operation when discarded and are not durable handles.
The compatibility facade selects the same installation-owned repository.

- **Managed PostgreSQL:** split the existing endpoint resolver before revision or
  frozen-release artifact loading. Public lookups still bypass the pointer cache
  and pre-change in-flight loads. Normal accepted requests reuse the resolved
  revision/pointer, adding no database lookup or object read. Existing bounded
  invalidation retries, immutable artifact caches and per-run cloning remain.
  Cacheable internal lookups share one in-flight metadata read per endpoint and
  invalidation generation. Sharing ends when that lookup settles, including
  failure, without starting artifacts. Existing full-source sharing retains its
  longer lifetime for callers requesting complete definitions. Fresh public
  lookups bypass both forms of sharing to preserve committed access checks.
  Admitted cacheable targets join the existing full-source owner for their
  endpoint/generation, including requests arriving after an earlier metadata
  lookup finished. They share source loading and bounded invalidation retries.
  Existing full-source owners/retry continuations use the private `load(false)`
  path to avoid joining their own promise. Fresh public loads never join older
  source work, even before invalidation notification. Settled source entries are
  removed, including failures; each caller receives its own mutable project and
  dataset state. Observed invalidation is checked
  before artifact loading, after successful loading and on loading failure,
  including frozen-release manifest reads. A known unpublish can therefore return
  not-found without first depending on retired artifacts. Only read-only
  preparation is retried; the graph is never resubmitted by this mechanism.
- **SQLite:** resolve only metadata and immutable artifact references in the
  catalog, then load/verify them after admission. Direct and worker-backed modes
  use the same catalog operations, cache and post-I/O state-change check. The
  worker exchanges a serializable target, not callbacks or cache instances.
- **Legacy filesystem:** separate cached routing lookup from materialization.
  Each phase holds its own existing storage-read lease; discarded targets retain
  none. Loading revalidates routing and preserves missing-root recovery, stale
  pointer fallback and not-found behavior. A concurrently changed bypass target
  fails closed instead of executing under stale access metadata.
  Immediate full loads retain their caller's read lease and skip redundant
  routing revalidation; deferred targets always revalidate under their new lease.

## Local verification

Use the pinned Node/Yarn runtime. Focused tests:

```powershell
yarn test:style
yarn workspace @valerypopoff/rivet-studio-server-api build
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/workflow-published-admission.test.ts src/tests/managed-execution-service.test.ts src/tests/managed-execution-invalidation.test.ts src/tests/filesystem-execution-cache.test.ts src/tests/sqlite-workflow-backend.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/workflow-async-response.test.ts src/tests/published-execution-admission.test.ts src/tests/active-http-executions.test.ts src/tests/web-app-policy-lookup.test.ts src/tests/workflow-storage-services.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/body-admission.test.ts src/tests/shutdown-http.test.ts src/tests/server-resource-lifecycle.test.ts
```

Run dependency-rebuilding checks such as `test:style` separately from API tests:
they regenerate Core's ESM output, which running test processes also import.

The final local review passed the API build, root style checks and all 244 tests
in these two selections (197 execution/storage tests and 47 body/shutdown/resource
lifecycle tests). The new HTTP regression is included in the default API test
manifest and therefore runs in CI. These results do not replace CI or
representative staging qualification of the built images.

The HTTP regression holds 32 permits and sends 64 excess requests, asserting
`429`, retry guidance and zero deferred loads. It also checks pre-admission
authentication/private/not-found responses; live-limit changes during held
preparation; shutdown counts; preparation failure/disappearance/access changes;
processor-construction failure; shutdown abort during preparation; draining;
and continued internal access. Existing async
HTTP tests verify that foreground output does not release background ownership.

Managed-service tests assert zero cold reads or warm clones during lookup, one
fresh metadata lookup per ordinary public request, no second query on load,
deferred frozen-release access, and invalidation races in both phases. Metadata
lookup-sharing tests additionally prove 32 cold internal requests make one query,
that public freshness and new invalidation generations cannot join stale work,
and that a failed shared lookup permits recovery on the next request. Further
source-sharing tests additionally compare 32 full/deferred/staggered loads through
an access-change race: all need two metadata lookups, one artifact read and 32
independent projects. They cover unavailable artifacts before/during unpublish,
retired frozen-release manifest reads, failed/settled load cleanup, and fresh
public source isolation while an older revision is still loading. Filesystem
immediate-load tests retain the original two-settings-stat budget (index plus
pointer), while deferred-load tests still catch access/unpublish changes. SQLite
tests resolve targets with the artifact directory temporarily unavailable in
both direct and serving-worker modes, then verify execution preparation and
concurrent access/unpublish checks. Filesystem tests cover deferred reads and
access/unpublish changes, with existing cache/root-recovery coverage retained.

Performance validation compares the committed and changed real HTTP route and
processor locally, with the same fake managed database/blob I/O, warmed projects,
and recording disabled. Check accepted latency for both tiny and 1 MiB projects;
also count rejected materializations and ordinary metadata/artifact operations.
These fixtures isolate request-ordering overhead; they are not a cloud load test
or a measurement of production database latency.

Measured against `c1600cd76` on the same local Node 24.22.3 runtime, alternating
old/new samples to reduce process and warmup bias:

| Warm accepted path | Samples per variant | Previous p95 | Changed p95 |
| --- | ---: | ---: | ---: |
| Managed HTTP, tiny project | 3,000 | 0.996 ms | 0.974 ms |
| Managed HTTP, 1 MiB project | 3,000 | 1.396 ms | 1.400 ms |
| SQLite direct preparation, tiny project | 1,000 | 0.256 ms | 0.241 ms |
| SQLite direct preparation, 1 MiB project | 1,000 | 0.650 ms | 0.658 ms |
| SQLite worker preparation, tiny project | 1,000 | 0.535 ms | 0.699 ms |
| SQLite worker preparation, 1 MiB project | 1,000 | 1.620 ms | 1.870 ms |

Managed HTTP figures were refreshed after the adjacent invalidation review; SQLite
figures are from the original validation. Small differences in these local
latencies do not establish a production speedup.

Managed accepted requests retained exactly one fresh metadata lookup and one
project materialization per request, with zero warm blob reads. For 64 rejected
requests at a full 32-slot gate, materializations fell from 64 to zero; metadata
lookups stayed at 64. SQLite worker mode pays for one additional metadata-only
worker exchange; its local p95 increase was 0.16–0.25 ms. These measurements bound
the observed local overhead, not all workload sizes or production tail latency.
Scratch benchmark fixtures/results are under the ignored
`.data/overload-admission-review/` directory, outside the ordinary test suite.
