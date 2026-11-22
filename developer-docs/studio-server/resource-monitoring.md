# Built-in resource monitoring

Available in Settings → CPU and RAM monitoring.

## Contract

Settings → CPU and RAM monitoring observes execution and editor/dashboard replicas without
changing resource reservations, replica counts or admission limits. Supported
launchers enable one API-owned sampler per container. Child executors do not
start another sampler. PostgreSQL stores seven days of minute buckets; MinIO,
external agents, Docker socket access and cloud credentials are not involved.

This read-only tab sits immediately after Deployment. It fetches history only
while selected and cancels its browser polling and pending request when the user
leaves it. It does not depend on loading deployment topology or concurrency
settings. Background collection continues when the tab or settings modal is closed.

Container counters come from the process's own cgroup v1/v2 membership and mount
mapping. Bare processes and containers without readable counters use explicitly
labelled process CPU/RSS. Never substitute host capacity for a reservation.
Container charged memory, estimated working set and process RSS remain separate
definitions. Kernel memory high-water values are lifetime observations, not
selected-period peaks. Restart/OOM counts remain unavailable without a platform
source; cgroup memory-limit events are not Kubernetes restart counts.

CPU is a cumulative-time delta over monotonic elapsed time. Counter resets and
long sampling gaps have no CPU estimate. Each process incarnation has a fresh
identity; old histories survive replacement. Minute buckets retain aligned
observations, duration-weighted sums and mergeable distributions. Period p95 is
derived from the merged distribution, never an average of percentiles. Pool
peaks use contemporaneous samples, never sums of individual historical maxima.
Pool totals describe reporting instances, not an authoritative Pod inventory.

### UI terminology

- A **monitoring session** is one monitored server-process lifetime, identified
  internally by its incarnation UUID. A process restart creates a new session
  even if its replica/Pod name is reused; earlier sessions remain in history.
- The summary counts sessions with samples within the freshness threshold and
  histories available across all views for the requested period. It does not claim current liveness or
  a complete replica/Pod inventory. Omitted sessions remain an explicit warning.
  The omitted-session warning, cross-view session summary and explanation appear below the charts,
  immediately above the session detail cards.
- **Execution replicas** and **Editor and dashboard replicas** identify the
  roles represented by totals. **Resource view** uses the shared segmented
  switcher with one button per role and measurement scope, normally these two
  choices. Container totals keep **Execution replicas** before **Editor and
  dashboard replicas**; process-only choices follow in the same role order. API
  ordering and period changes cannot reorder available choices. The switcher
  supports keyboard activation, indicates the selected button and
  wraps within narrow panels. Individual sessions and
  restarts do not add duplicate buttons; their detail cards appear
  below the selected role's charts and statistics. Container and process-only
  scopes remain separate; process-only choices explicitly say **Server process
  only (RSS)**. Combined servers belong to execution totals, matching the history
  query, and remain labelled as combined servers on their detail cards.
  The latest total identifies how many sessions contributed to that observation.
  Period choices (**1 hour**, **24 hours**, **7 days**) use the same segmented
  switcher. Its selected button shows the shared loading spinner while history
  is requested; role changes show it during deferred chart rendering. The visual
  spinner replaces the label only after 150 ms of continuous loading, avoiding
  flashes on fast updates. Completion or cancellation removes the pending
  animation, and a subsequent load starts a fresh delay. Accessible busy state
  updates immediately. Labels and button widths stay stable, and other choices
  remain available during loading.
  Retained controls, statistics and charts stay in place while requests are
  pending. The selected button provides loading feedback without inserting a
  temporary status paragraph above the content. Omitted-session warnings stay
  with session details rather than moving the resource controls when a response arrives.
  A retry retains the previous refresh error until a response succeeds, so starting
  another request does not briefly clear a known failure or collapse its message.
  Cancelled or failed requests cannot leave a spinner active or replace a newer
  selection. Background polling retains its existing interval and cancellation.
  If live session readings have arrived before historical totals are available,
  the group remains selectable with its detail cards and an explicit status;
  the UI does not invent aggregate statistics or chart values. A selection that
  disappears after a period change falls back to an available group.
- Missing requests/limits say **Not reported**, not **Not configured**. The
  telemetry schema cannot distinguish an unset allocation from missing metadata.
  Older observations say **No recent samples** while their history remains usable.
- **Container RAM usage** is cgroup charged memory, including child processes
  and filesystem cache. **Server process RAM (RSS)** is resident memory for the
  reporting process and excludes its children. **Container lifetime RAM peak**
  is explicitly separate from the selected period's highest observed sample.
- CPU help defines `1000m = 1 CPU core`. Approximate p95 is explained in terms
  of sampled time; its duration weighting and histogram approximation are unchanged.
- CPU and RAM tooltips show the hovered observation's local date and time along
  with its metric, using theme colors with readable contrast. Charts reuse the
  current view during a role switch so the control feedback can render before
  the new charts; unchanged charts are memoized rather than redrawn for loading
  indicators.

Presentation labels do not alter report identities, retention, statistics, API
field names or workflow execution behavior.

### UI follow-up plan and completion (2026-11-22)

- [x] Show a readable local timestamp and metric in both chart tooltips.
- [x] Use the shared segmented control for periods and resource views, keeping
      dimensions stable and showing a spinner only after 150 ms of loading.
- [x] Keep resource choices in a canonical order and retain charts while a period
      request or deferred role render is pending. Preserve cancellation, timeouts
      and the existing 30-second polling interval without extra role-switch requests.
- [x] Keep session counts, explanations and omission warnings beside the session
      cards. Remove temporary loading paragraphs that shift controls and charts;
      retain known errors while a retry is pending.
- [x] Let wrapped settings tabs grow with symmetric padding, preserving desktop
      rail scrolling and the shared narrow-layout scroller.
- [x] Validate the final production web build and focused headless journeys locally.

The period-loading regression reproduced a 42px shift before the fix. The updated
`deployment-status.spec.ts` verifies stable positions during pending requests,
cancellation and retries, canonical order despite reordered responses, readable
tooltips, the 149/151-ms spinner boundary and desktop/narrow navigation. Its two
tests and the adjacent trusted-client settings journey passed against the final
build. Formatting, documentation links, import boundaries and Studio Server test
style checks also passed. These UI-only changes leave the schema, backend, rollout
configuration and production recompression unchanged.

## Automatic startup and ownership

`container-server-config.mjs` enables both API roles for all six supported
dev/staging/prod × local/external-storage commands. Helm's `rivet.env.apiWorkload`
does the same for control and execution containers, including the single-machine
chart shape. There is no monitoring service, RBAC addition or operator credential.
The protected `RIVET_DEPLOYMENT_RESOURCE_MONITORING` JSON contains the internal
report URL, generic instance name and any known allocation. Vault dotenv loading
cannot replace it. Normal source-only API use without that installation metadata
does not opt into container accounting.

`resource-monitoring/runtime.ts` starts after ordinary storage/startup work and
reuses the managed PostgreSQL registry's existing pool on the control role.
The API process owns sampling; child executors and temporary overlap-maintenance
processes skip it. Drain/dispose stops its timers and aborts a pending HTTP report
without waiting for telemetry. A new API incarnation gets a new UUID even when
the Pod/container name is reused.

Linux discovery resolves `/proc/self/cgroup` against `/proc/self/mountinfo`.
Cgroup v1 uses `cpuacct.usage` and `memory.usage_in_bytes`; v2 uses `cpu.stat` and
`memory.current`. These cover the container's child executors. Missing optional
working-set/peak/quota counters remain unknown. Failure to find readable primary
counters at startup selects Node process CPU/RSS, explicitly excluding children.
Subsequent read failures leave gaps; they never mix a different scope into an
existing incarnation. Bare processes never guess a host cgroup.

Helm reads the actual container's requests through the downward API, with explicit
millicore/byte divisors. Limit references are emitted only for declared limits;
otherwise Kubernetes can substitute node capacity. Compose has no default
reservations. A readable kernel quota/limit may supply a limit, never a request.

## Reporting, history and bounds

- Sample on shared five-second wall-clock boundaries, with monotonic elapsed time
  for CPU. Missed ticks do not queue. At most one sample per five-second slot.
  Redundant ticks in the same slot leave the last accepted CPU baseline intact
  and do not count as dropped observations. Backward wall-clock movement and read
  failures still invalidate the baseline.
- Report approximately every 30 seconds with one request in flight, a five-second
  HTTP deadline and failure backoff capped at two minutes. Keep at most six minute
  buckets per collector; evictions increment a dropped-observation count.
- `POST /internal/resource-monitoring` checks existing executor authentication
  before reading its bounded 128-KiB JSON body. It validates the installation,
  identity, timestamps, finite values and unique sample slots, then projects only
  allowed telemetry fields. HTTP 202 acknowledges buffering, not durable storage.
- The control hub retains at most 128 reporting incarnations and writes at most
  32 per batch. New reports cannot starve another worker. One SQL statement updates
  each instance and its minute buckets atomically; revisions make replays safe.
  Minute histograms retain weighted sums and observed maxima, reducing repeated
  long-range work without averaging percentiles. Boundary minutes use clipped
  sample durations. Raw observations remain available for aligned pool peaks.
- Additive schema **21** creates `resource_monitoring_instances` and
  `resource_monitoring_minutes` through the ordinary migration owner. There is
  no request-time DDL. An old reader's execution data is unchanged.
- Cleanup removes at most 500 expired minute rows and 100 expired incarnation rows
  per minute. Reads exclude observations outside seven days immediately; physical
  deletion can catch up gradually after downtime. Cleanup failures are logged and
  retried on their own interval; they never back off successful metric writes.
- `GET /api/deployment-status/resources?period=1h|24h|7d` uses the existing operator
  authentication. Each control process caches/coalesces each period for 30 seconds,
  including failures. Browsers do not poll workers. Reads return at most 64 recent
  incarnation histories and 338 chart points per series. The omitted-history count
  is a lower bound because the same incarnation may be outside the database window
  and present in the live cache. Pool member counts belong to the same timestamp
  as the displayed observation; current reporting counts are shown separately.
  All telemetry SQL has a five-second statement deadline, a one-second lock
  deadline, and a six-second client deadline. The read budget covers the normal
  maximum of seven execution workers plus a control reporter over seven days;
  a three-second deadline rejected this valid local workload. An unconfirmed rollback discards
  its connection rather than returning uncertain state to the shared pool.
  Transaction-local JIT/scratch settings avoid compilation and unnecessary spills;
  `work_mem` is 16 MiB per PostgreSQL operation, not a global database change.

Charts separate container totals from process-only totals, and control from
execution pools. Chart averages use 1-minute / 5-minute / 30-minute bins for
1h / 24h / 7d; period statistics retain the individual observed peaks. Missing
chart intervals are null. A lone numeric chart point is drawn as a dot. Pool statistics require all
known participating incarnations in the same slot, sample timestamps within one
second, and normal 4.5–5.5 second intervals. Partial slots remain incomplete;
independent historical maxima are never summed. A reporting count is not a
desired/ready Pod count. More than 64 histories can require a narrower time range.

Pool chart bins average only complete raw slots. A bin's `complete: false` means
some slots were incomplete, not that its numeric averages are invalid. The UI
plots those valid averages and preserves null gaps when no complete slot exists.
The latest pool observation is a raw slot: its incomplete CPU/RAM totals remain
unavailable. Neither chart rendering nor same-slot timer handling relaxes the
membership, timestamp or interval checks on raw pool observations.

Current values include their last sample time; after 90 seconds they are stale.
The browser refreshes every 30 seconds and aborts a read after ten seconds;
displayed timestamps continue aging even when a response never arrives. Switching
periods or a failed refresh retains existing data while showing its actual age.
The first sample has no CPU rate yet. An initial memory gauge can still contribute an observed peak even
when its elapsed-time coverage is unknown. Active runs come from the admission
snapshot, not its cumulative accepted counter. Disabled admission does not track
active permits, so its active-run count is unavailable rather than zero. A run limit is shown only in
`enforce` mode; observation-only/disabled admission and control-only roles do not
claim an enforced limit. Captured kernel memory high-water values have cgroup lifetime scope.
They are separate from the selected period's highest observed sample.

## Failure isolation

Telemetry starts after normal startup and never participates in workflow
admission, readiness or the accepted-work shutdown deadline. Failure drops
bounded observations and leaves visible gaps; it never queues graph execution.
There is no telemetry database, disk or network operation in a workflow handler.
An unavailable database preserves cached/live observations with a warning. A
control crash can lose an acknowledged but not-yet-written telemetry batch; this
best-effort monitoring never replays a workflow or changes its outcome. Retained
database history survives application replacement.
Installation scope reuses the existing opaque deployment/restore ID exactly,
including legacy punctuation and case. It is not interpreted as a path. The
shared validator bounds its length and rejects empty or NUL-containing values.

## Release preparation

The ordinary rollout migration advances schema 20 to 21 before starting the
candidate. Both tables are additive; schema-20 readers can continue serving
against schema 21. Fresh-install Helm compatibility defaults also select 21;
the release runner supplies the reviewed mixed-version window during upgrades.
The local compatibility check uses a cached schema-20 image
and the candidate image, with no API source overlays, and exercises writes and
cross-reads from both versions.

When changing the schema version, run `yarn studio-server:verify:kubernetes` as
well as the migration checks. Its actual Helm renders assert that migration Jobs,
serving compatibility bounds and release manifests agree with the API version.

Render the intended installation values before release. The separate production
(2 CPU / 4 GiB, 32 runs) and staging (500m / 1 GiB, 4 runs) profiles retain their
own settings; telemetry reads each container's admitted requests and declared
limits. It does not change worker counts, reservations or admission policy.

Include the installation's private recovery adapter in the normal release
readiness review: it must validate the actual installed schema and the candidate
checkpoint with the matching source-owned verifier. Schema-specific adapters may
need updating; widening a version assertion is not validation. Follow
[checkpoint schema preparation](./deployment-operations.md#keep-the-checkpoint-schema-current).
Telemetry tables have no application-table foreign keys and remain outside the
legacy application restore's destructive table list.

## Local validation and performance

The implementation plan is covered by counter/sampler/authentication/cache unit
tests, the real PostgreSQL integration, launcher/Helm tests, the real API image
and `deployment-status.spec.ts` in the headless observe runner. The migration
fixture covers 20→21 compatibility, lock contention and preserved execution data.
The optional cached-image check tests only the declared predecessor/candidate
pair. It must not reuse that same pair for a different historical transition.
The review also exercises blocked telemetry writes/cleanup, shared-connection
reuse after timeout, read-cache omission counts and disabled/observe admission.
The maintained migration, reference-index and production-cutover suites verify
that the additive schema preserves existing storage and release behavior.
The normal generated local-storage services have been started and restarted:
exactly one cgroup reporter per API container, old and new incarnation histories,
actual authenticated history reads, and unset reservations were verified.

Repeatable focused commands (run from the repository):

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/resource-monitoring.test.ts src/tests/managed-workflow-schema-migrations.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:resource-monitoring-managed
yarn workspace @valerypopoff/rivet-studio-server-api exec tsx src/tests/resource-monitoring-managed.integration.ts --measure --workers=8
yarn node deploy/studio-server/scripts/verify-managed-workflow-schema.mjs
```

For UI checks set `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, and use
`yarn studio-server:ui:observe deployment-status.spec.ts` with an isolated preview.

Performance acceptance budgets: collector below 10 millicores, bounded telemetry
buffers, small-run added p95 below 1 ms, and no repeatable throughput regression
above 3%. Large-payload and concurrent measurements must be reported separately,
with noise and cold starts visible. These are budgets, not zero-overhead claims.
Local measurement artifacts live under `artifacts/resource-monitoring-20261117/`.
The controlled HTTP fixture uses a 10-ms mock provider, 32-byte/64-KiB payloads,
durable recording, and concurrency 1/8/32. Its main run persisted all **4,658**
recordings before cleanup and confirmed that a telemetry-table outage did not
stop endpoint execution. Small-payload p95 changed by -0.31 / -0.05 / -1.78 ms
at those concurrency levels; those differences are noise, not a speedup claim.

Separate-process large-payload comparisons showed larger differences, so a
second check alternated monitoring in the **same warmed process**, excluding
diagnostic IPC from HTTP timing. Across eight pairs per case, 64-KiB p95 changed
from **57.84 to 58.38 ms** at concurrency 8 and **110.95 to 101.46 ms** at 32.
Mean per-round throughput changed by approximately **+0.9% / -1.4%**. All
**3,272** crossover recordings persisted. This isolates incremental monitoring
cost more closely; it does not prove identical performance across arbitrary
process placement, GC state or production workloads. The raw comparisons are
retained alongside the crossover results.

A deliberately larger 512-request burst exceeded recording capacity even in
the monitoring-disabled baseline. That result was excluded from the latency
comparison; the retained evidence records why. Normal benchmark phases use
bounded 96-request bursts and wait for their recordings before the next phase.

The Linux container-counter probe measured 391 microseconds CPU per read, or
approximately **0.08m** at five-second sampling. Its 1,000-read stress loop grew
RSS by 8.8 MiB; that is allocator behavior under compressed stress, not a
steady-state retained-memory measurement. The final review with eight reporters
and a full seven days of samples measured about **34 ms / 542 ms / 3.72 s** for
1h / 24h / 7d cold queries on the local Docker fixture. The initial three-second
deadline rejected that valid larger pool; the five-second deadline passes it
while retaining the one-second lock bound. A slower/busier database can still hit the bounded timeout;
the UI then retains available data with an error rather than inventing values.
An additional forced-GC retention diagnostic measured about **49 KiB** for a
six-minute collector buffer and **1.32 MiB** for the control hub's 128-incarnation
buffer. Its largest collector report was **11 KiB**, below the 128-KiB request
limit. These are retained JavaScript allocations, not whole-process RSS and not
a reason to run forced GC in production.

These are local implementation checks, not GCP sizing or 32-run capacity
qualification. Kubernetes metadata rendering is verified locally; no cloud
deployment, production load or resource change was performed.

References: [cgroup v2](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
[cgroup v1 CPU accounting](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v1/cpuacct.html),
[cgroup v1 memory](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v1/memory.html),
[Node process counters](https://nodejs.org/api/process.html).
