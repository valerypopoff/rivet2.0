# Fast graph-reference checks: delivery plan and operating contract

Status: implemented and validated locally (2026-11-09). Hosted CI/image
publication, deployment and production backfill remain pending. This source
change does not authorize or perform cloud activation.

## Delivery checklist

- [x] Extract versioned reference summaries from the final saved project payload.
- [x] Attach summaries atomically to managed revisions, including creation,
  saves, copies, imports, bundle operations and dataset-ownership revisions.
- [x] Add the nullable schema-19 expansion and retain predecessor compatibility.
- [x] Read active references in one database snapshot without project downloads.
- [x] Bound admission, pool waiting, SQL execution, cancellation and output size.
- [x] Provide explicit, resumable backfill and useful partial-result diagnostics.
- [x] Register unit tests and the PostgreSQL regression in existing CI lanes.
- [x] Validate locally with PostgreSQL, browser checks and schema compatibility.
- [ ] Publish the commit and pass hosted CI and exact-image release checks.
- [ ] Deploy through the existing approved staging/production release process.
- [ ] Run the separately authorized production backfill, verify current coverage
  and measure representative live requests. Local timings do not close this item.

## Goal and scope

Managed GCP graph-deletion reviews should normally complete within seconds.
The local acceptance targets are complete-response p95 at most two seconds and
p99 at most five seconds, including the first request in a fresh API process.
Database/network outages return bounded service errors rather than starting a
full-project scan. These are acceptance targets, not unconditional wall-clock
or production latency guarantees.

Optimize managed storage first. SQLite and legacy filesystem storage retain
existing scans and cancellation rules. Both graph-filtered POST and whole-project
GET retain their authentication and advisory contracts. Deletion remains an
explicit user choice; the index does not execute graphs or prohibit saves.

The original managed request performed a serial scan of current project blobs,
with per-caller SQL reads and a 30-second budget checked only between callers.
An in-flight read could outlast that budget. The replacement stores small facts
at save time and filters matching facts in PostgreSQL at review time.

## Revision summaries and saves

`project-reference-summary.ts` uses Core's existing graph-call and bundle-call
traversals. It preserves explicit target versions, prefab semantics, disabled
calls, graph/node locations and legacy `Project.references` dependencies.
The two traversals serve different purposes and are extracted independently:

- `graphCalls: null` makes graph details unavailable without erasing valid
  project-level targets.
- `projectTargets: null` makes the project-level check incomplete without
  invalidating valid graph-call locations. Missing Library definitions, for
  example, are skipped by graph inspection but fail strict bundle traversal.
- Stored `state: complete` describes the parsed summary container. A request
  must also validate the component it uses. Failed parsing/identity, failure of
  both traversals, or exhaustion of the 4 MiB summary bound produces an explicit
  invalid marker, never an empty complete list.

Preserve a validated project ID even on an invalid extraction marker. Incoming
checks validate the target's saved identity, not its outgoing dependencies;
broken calls in the target cannot invalidate correctly checked callers. Missing
or mismatched target identities still make the review incomplete.

PostgreSQL JSONB cannot represent NUL or unpaired UTF-16 surrogates. Validate
summary fields before attachment: unsupported text makes its component unavailable
instead of failing a previously permitted save. Normal emoji and literal
backslash escape text remain valid. The original project artifact is preserved.
Parser errors and project contents must not appear in diagnostics.

`managed/revision-factory.ts` parses once for stats and references during revision
preparation. It includes the summary in the same `insertRevision` SQL statement
used by every managed writer. The caller's existing transaction commits the
revision, summary and active pointer together. No second metadata write or new
remote upload is introduced. The filesystem revision-hash contract is unchanged.
Publication and restore can select an existing revision; an old unindexed
revision becomes incomplete coverage until explicitly repaired.

Schema 19 adds nullable `workflow_revisions.reference_summary`. Migration 1 and
all released migration checksums remain unchanged. Old writers can still insert
NULL summaries. Helm serving bounds use the current schema, 19, rather than the
rollback-compatible floor, 17. The reviewed forward behavioral matrix covers
17-to-18 and 18-to-19; it does not automatically certify other transitions.

The 18-to-19 probe tests bounded DDL contention, preserved rows, both image-owned
revision writers and peer reads. Old readers require the release process's
explicit successor-schema window. Do not manually alter migration history or
infer exact-image compatibility from additive SQL alone.

## Managed lookup and UI behavior

`managed/reference-index.ts` joins the target, active pointers, revision summaries,
coverage and matching edges in one SQL statement snapshot. It includes saved
drafts, the current endpoint publication and current web-app publications.
Archived revisions and transitive callers are excluded. Shared revisions retain
all active source roles. Current catalog names, paths and publication labels are
read from metadata rather than copied into each summary.

Only matching edges leave PostgreSQL. `checkedProjects` counts other projects
whose relevant active summaries are valid; it is not a count of matching edges
or attempted reads. Known matches survive other missing/invalid sources.
Completeness requires expected versions/identities, the requested component and
untruncated results. There is no synchronous managed fallback to blob scanning.

The common managed budget is five seconds, including backend acquisition.
Reference requests admit at most two checks per process; the pool helper also
bounds pending acquisitions and retains a slot until a late lease is returned.
An owned client uses transaction-local statement timeouts and is discarded on
cancellation or an uncertain query outcome. No automatic database retry extends
the request budget. The legacy full-scan mutex does not serialize indexed reads.

Responses have at most 1,000 reference sites and a 2 MiB SQL matching-row budget.
Limit exhaustion reports `result-limit`; it cannot become a complete negative.
Optional coverage diagnostics distinguish missing, outdated and invalid summaries.
Service failures remain HTTP errors without fabricated zero coverage counts.

The host forwards counts and reasons to the graph-deletion modal and project
Danger zone. Retry repeats the cheap lookup, not backfill. Cancel remains usable,
late responses are ignored, and unsaved open-project references are merged.
Known references or incomplete checks retain the explicit Delete anyway choice.
The shared 35-second UI watchdog remains for unchanged filesystem/SQLite and
third-party hosts; managed failures normally return through the shorter budget.

Completeness describes committed revision facts at the database snapshot, not a
new integrity probe of every GCS object or a lock against subsequent saves.
Immutable artifact keys, integrity-checked reads and supported repair procedures
are prerequisites. A repair that replaces revision contents must invalidate or
rebuild its summary. General object damage belongs to storage health checks.

## Operating the backfill

This runbook is not authorization to run against production.

1. Deploy the schema-19 expansion through the existing release procedure before
   starting new writers. Missing summaries produce immediate partial reviews;
   neither API startup nor Delete Graph waits for a backfill.
2. Use a separate bounded operator process/job with the installation's existing
   database-write and project-artifact-read configuration. The command verifies
   schema and migration-target readiness. It does not migrate schema, inventory
   Kubernetes, rewrite artifacts or create a permanent service.
3. In a configured operator workspace, run:

   ```sh
   yarn studio-server:workflow-references:backfill --max-revisions 1000 --max-seconds 600
   ```

   The API image's compiled entry point is
   `packages/studio-server-api/dist/studio-server-api/src/scripts/backfill-project-references.js`,
   with the same flags. The processing limit is 1-3,600 seconds and the revision
   limit is 1-10,000. Schema verification precedes the processing budget; give an
   operator Job an overall deadline as well.
4. Processing is serial with batches of 25 identities by default. Existing
   artifact integrity/decompression and 100 MiB size bounds apply. Blob reads
   receive the abort signal. Only distinct currently active revisions are
   candidates; archived history is not bulk-indexed. Each revision is attempted
   once per invocation, even after a read failure. Active pointers are re-read
   between batches and coverage is recomputed at the end.
5. Each update checks revision ID, workflow ID, exact blob key, active membership
   and the previously observed JSONB summary. Preserve the old value as PostgreSQL
   text: decoding and re-encoding in JavaScript would conflate JSON `null` with
   SQL NULL and round large numbers, making valid repairs silently skip rows.
   Deleted/inactive rows and concurrent replacements are skipped. Newer extractor
   versions are never downgraded. Invalid current-version summaries require a
   corrected save or reviewed repair/extractor-version change, not endless retries.
6. The JSON report contains attempted/updated counts, sanitized attempt failures
   and distinct active-revision coverage. Exit 0 means full current coverage;
   exit 2 means current gaps; exit 1 means the command stopped. Earlier read
   failures remain reported but do not invalidate success when another writer
   has already repaired or retired that revision. Active gaps still fail.
7. After interruption or an uncertain SQL acknowledgement, inspect and rerun
   explicitly: committed summaries are skipped. Failed writes are not replayed
   automatically. Finish upgrading old writers, then repeat bounded repair if
   their NULL inserts or a restored old revision left coverage missing.

Backfill's combined coverage requires both components. An individual graph or
project review can be complete when only its own component is ready. Index
coverage is advisory metadata readiness, not a storage-health certificate.

## Local validation and evidence

Run focused checks from the repository root with Yarn 4:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/project-references.test.ts src/tests/project-reference-summary.test.ts src/tests/managed-reference-query.test.ts src/tests/managed-revision-factory.test.ts src/tests/managed-workflow-schema-migrations.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:references-managed
yarn workspace @valerypopoff/rivet-studio-server-api exec tsc --noEmit
yarn workspace @valerypopoff/rivet-app exec tsc --noEmit
yarn node --test scripts/ci/api-test-shards.test.mjs
```

The unit tests are registered in the API manifest. The PostgreSQL regression runs
in the existing managed CI lane after schema verification, with no new CI job or
GCP resources. Local validation does not claim hosted CI has passed.

The integration owns and removes a loopback-only `postgres:16.8-alpine` container
and never accepts a production database URL. Its 322-project fixture includes
64,000 unrelated calls, active publication roles and 10,000 archived revisions.
It checks scanner parity, atomic revision visibility, missing/outdated/invalid
summaries, independent traversal failures, NUL-containing artifact saves and
backfill, target-only outgoing errors, rename labels, restored history, result
count/byte bounds, cancellation and connection cleanup. It also reproduces JSON
`null`/large-number comparisons and a failed read concurrent with a successful
peer repair, without weakening the update fence or adding retries.

Representative local HTTP measurements: 100 requests, p95 79 ms, p99 84 ms,
maximum 86 ms; the first request in a fresh Node process was 84 ms. PostgreSQL
used the existing revision primary key, with zero blob reads or application
summary cache. The database had one CPU and a 512 MiB memory limit. On a 200-node
fixture, 50 metadata samples per path measured p95 17 ms for stats alone and
18 ms for stats with summaries. This is not a claim of zero allocation/storage overhead.

The HTTP harness includes lookup, PostgreSQL and JSON consumption, with warm
local database/OS caches. It is not a GCP or complete hosted authentication/proxy
benchmark. No speculative JSONB index was added.

The local schema gate passed fresh installation, real 18-to-19 rolling expansion,
lock-timeout/no-retry behavior, preserved rows, earlier folder/namespace migrations
and structural create/copy/upload/import paths. A separate historical-source
check passed schema-18/current writer overlap and cross-reads; that is not exact
release-image qualification.

Headless `graph-deletion-references.spec.ts` checks known callers, partial
reasons/counts, Retry, Delete anyway, Cancel/late results and unsaved callers.
Use the normal observe runner with `PLAYWRIGHT_HEADLESS=1` and
`PLAYWRIGHT_SLOW_MO=0`. Production activation and live latency verification remain
unchecked delivery items above.
