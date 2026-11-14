# Hosted execution isolation plan

Status: Gate A development tooling built on committed prototype `8854c24d9`,
2026-11-14. [Local results](./hosted-execution-isolation-gate-a.md) record passing
functional checks and historical measurements against a strict no-regression
constraint. The user subsequently accepted up to 1 ms added p95 for small runs,
with large-request regressions separately bounded and tested. No serving path,
default, deployment or cloud resource has changed. Production supervisor/service
integration below remains planned and gated; this is not completed isolation.
The local review also verifies prepared-action tail ownership through response
encoding/delivery failures and bounded pool replacement. These functional checks
do not establish latency or capacity; the separately fingerprinted comparisons
in the results document cover only their local workloads.
Benchmark acceptance also waits for root/capture settlement and cleanup, with a
real late-failure and controller-disconnect regression. Foreground response timing
remains separate from acceptance of the complete fixture run.
Fast input/limit contracts now run in normal API CI. Real-worker checks remain
opt-in, use controlled gates and avoid an unused final replacement; their local
results do not substitute for the production gateway/debugger integration below.

## Implementation reconciliation

The original blocking issue is **not resolved in serving code**. The entries below
describe implementation, not permission to enable an unqualified mode.

| Plan area                   | Current state                                                                     | Remaining work                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Local whole-root prototype  | Implemented for generated graphs, all Code-family call sites and prepared actions | Complete the real-fixture and lifecycle/capability gates                                                                                   |
| Performance and capacity    | Local paced fixtures meet the accepted additive p95 limits                        | Complete real-fixture latency and concurrency/RSS qualification before choosing production lifecycle or slot count                         |
| Supervisor and readiness    | Prototype pool only                                                               | API-owned startup/readiness, leases, bounded controls, drain and metrics                                                                   |
| Shared service adapters     | Local host-store seam proves root context and in-flight write ownership only      | Production settings/authorization, references, datasets, stored values, knowledge/profile health, and remaining parent-operation tracking  |
| Durable recording ownership | Existing serving owner is unchanged                                               | Stable root/child IDs, asynchronous parent admission and bounded capture handoff, with execution outcome separate from replay availability |
| Hosted surface integration  | Not implemented                                                                   | Published/latest HTTP, HTTP and socket actions/preview, schedules, Evaluations and actual debugger controls/reconnect                      |
| Release evidence            | Local prototype only                                                              | Full integration/failure tests, packaged loading/capacity, then separately authorized staging/release                                      |

The local host-store seam has its own MessagePort and exposes only typed get/set
operations, at most 64 in flight per root. Retained root scopes are bounded by
the pool's worker-plus-queue capacity, including writes left after worker exit.
It restores the accepting parent
request context, fences new calls on cancellation and retains accepted IO through
worker exit/drain without replay. A real prepared-action fixture proves this;
it is not connected to a production store, gateway or durable execution owner.

All five hosted surfaces still instantiate their actual processors locally. In
particular, the socket gateway still uses Node's real prepared action; the local
prepared-action fixture does not exercise that production gateway. The proposed
`src/hosted-execution/` supervisor directory does not exist yet.

The accepted latency limit is **up to 1 ms added p95 for small runs**. Freeze the
separate large-request limit before measuring: the local 8 MiB fixture uses
**at most 5 ms added p95**. This latter number is an engineering bound, not a
user-specified value. It does not authorize larger production inputs or a change
to admission policy. Report large payload size and latency independently; passing
small fixtures cannot hide a large-input regression. Historical median-only or
maximum-throughput results do not establish acceptance under the new limits.

Compare the paths at the same offered rate: the local single-outstanding-request
comparison caps arrivals at 100 requests/s for small fixtures and 10 requests/s for
the large fixture, with no catch-up bursts. Measure request latency without the
intentional delay between requests. Use at least 200 observations per path and
nearest-rank p95; the maintained 100-request/three-block command gives 300.
Zero-delay saturation measurements remain a separate diagnostic. This is a
workload latency check, not proof of concurrent serving capacity or integration.

## Goal and boundaries

Keep authored hosted Code-family JavaScript off the serving API event loop.
A blocked root must remain cancellable from the parent; independent roots on
other available workers must progress. Finite resources cannot promise spare CPU
or zero queueing at saturation. Preserve fast normal execution and existing
within-run semantics, costs, recordings, debugger controls and rolling-update drain.

The candidate is **whole-root execution in a Node worker thread inside an
existing API Pod**, with at most one active root per thread. GraphProcessor,
Code runner, intermediate values and capture stay together. This avoids copying
every Code/Expression invocation and preserves within-run functions and object
identity. A lease includes nested graphs and post-response work.

Keep transport, durable execution ownership, database/storage services and
persistence in their current parent owners. No new service, broker, database
schema, graph scheduler, durable run state machine or arbitrary-object RPC.

The public-error policy and change-audit findings are deferred. The separately
known mutable managed-library activation bug is not bundled into this plan.
Do not advertise isolation as a fix for that bug or require its full directory
rewrite before prototyping. Preserve existing SQLite release guarantees and fix
only newly demonstrated isolation dependencies within this scope.

## Facts rechecked

| Fact                                                                                                                                                                 | Consequence                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Hosted `ManagedCodeRunner` invokes AsyncFunction directly; a local 250 ms loop delayed a 20 ms timer until 251 ms                                                    | Blocking is demonstrated locally, not attributed to a particular production incident                                    |
| Code, legacy Code and Expression request `includeRivet`; JS list callbacks have another runner call                                                                  | All four call sites must execute off the serving thread                                                                 |
| The sidecar worker runner sends Rivet-capable code back to its current thread and destroys other workers per invocation                                              | It is not a compatible API replacement; its warm-spare count is not a total active-worker bound                         |
| Current runner allows observable mutations, class instances and function-valued intermediate `any`                                                                   | Per-node messaging is not transparently equivalent; whole-root compatibility still needs real graph tests               |
| HTTP actions create their processor in API `execution.ts`; socket actions use Node `prepareRivetWebAppAction` and expose the processor through `onProcessorPrepared` | Changing the shared hosted-options factory alone misses a live execution path                                           |
| `ExecutionSession` calls synchronous `beginRunEvidence`; root/child evidence share `activeEvidenceOwners`                                                            | Keep that owner in the parent; synchronous registration cannot be replaced with a blocking async round trip             |
| App Settings snapshots use AsyncLocalStorage; authorization can intentionally read outside them                                                                      | Explicitly preserve pinned execution settings and fresh authorization as different policies across the boundary         |
| Chart admission defaults to disabled, despite a displayed maximum of four                                                                                            | Four threads cannot be assumed to preserve current capacity; installed policy and representative load remain unverified |
| Production API image pins Node 24.22.1; local audit used Node 22                                                                                                     | Validate the emitted worker in the maintained Linux image too                                                           |

Node workers clone messages and do not preserve every JavaScript object. They
also share process-wide failure risks: heap limits do not cap external buffers
or total RSS. Use the [pinned worker documentation](https://nodejs.org/download/release/v24.22.1/docs/api/worker_threads.html).
This is accidental-blocking protection, not hostile-code sandboxing or immunity
to native crashes/process-wide out-of-memory.

## Gate A: prove the smallest execution seam and freeze the design

Do this before migrating every surface.

1. Build one local prototype around the existing graph engine. Exercise one HTTP
   root and one actual prepared WebSocket action, with recording, browser storage
   and controls. Start with generated deterministic fixtures, then the sanitized
   `.fixtures/graph-fixture.rivet-project`. Verify no paid/production calls first.
2. Inventory actual GraphProcessor access by the web-app and debugger owners.
   Extract the smallest execution-driver seam they need. Do not construct a fake
   GraphProcessor, copy action-binding logic or invent generic callback RPC.
   If a small seam cannot preserve those consumers, stop and revise the boundary.
   Verify required plugin/registry loading through the existing Node loader;
   a programmatically constructed parent registry cannot be cloned as functions.
3. Compare reusable warm threads with retirement after each root in that same
   prototype. Prefer measured reuse, with a fresh processor/session and per-root
   cleanup. Retire after forced cancellation, crash or unconfirmed cleanup.
   Choose one lifecycle before integration, not two automatic product strategies.
   Graph settlement does not prove arbitrary timers/unawaited work ended; test
   those cases. Retirement can stop work that currently continues after a
   response. Reuse can retain globals/package state. Surface these differences;
   do not claim transparent cleanup or build a general async-resource tracker.
4. Establish the data/service boundary below. In particular prove ordinary output
   encoding, evidence handoff, browser storage and debugger attachment before
   treating the handle as sufficient.
5. Benchmark paired direct/isolated runs at the same offered load, resources,
   runtime and source. Freeze fixtures, sample method and measurement noise from
   repeated direct baselines first. Report absolute/percentage median and p95,
   total CPU, throughput, queue time, foreground time and tail/handoff time.
   Include startup, cache hit rates and background worker replenishment. Use
   interleaved independent process runs; noisy evidence is inconclusive, not a
   pass or permission to widen tolerance after seeing a regression.
6. Measure process RSS deltas at zero/one/multiple threads, queued payloads,
   active roots and recording capture, with per-isolate heap statistics separately.
   RSS inside a thread is process-wide; do not add it as worker-local memory.
   See [Node memory measurements](https://nodejs.org/download/release/v24.22.1/docs/api/process.html#processmemoryusage).
   Include long async waits, paused roots and post-response tails: they retain
   slots despite low CPU.

**Gate A deliverable:** one recorded choice of boundary/lifecycle, measured
latency/throughput/memory results, and exact worker/admission/queue/limit settings.
No repeatable normal-run regression beyond the frozen additive p95 limits is accepted.
A prototype does not prove production speed or sizing until this evidence exists.

Determine effective Pod resources and admission mode before choosing numbers.
Do not silently reduce accepted concurrency, enable a disabled gate, increase
reservations or hide a slowdown with unlimited threads. A constrained
Pod-equivalent local envelope can precede a read-only installation check; label
which evidence is still missing. If neither lifecycle passes, stop locally.
This gate is not authority to keep expanding the execution system until it works.

## Implementation contracts

### 1. Bounded parent supervisor

Add API-owned modules under `src/hosted-execution/` for entry, protocol, leases
and narrow adapters. Keep GraphProcessor/Code implementations in Core/Node.

- One root owns a thread through foreground completion, graph settlement and
  accounted handoff. Preserve parallel branches inside that root.
- Reconcile one explicit admission budget per runtime profile. Gate A chooses
  immediate admission or one bounded queue; avoid hidden queues in every layer.
  Bound active/warming/terminating threads, queued roots and retained bytes.
  Define queue expiry and cancellation before invocation, with fresh owner/lease
  validation before dispatch.
- Prewarm before advertising isolated execution ready. Specify minimum usable
  capacity, bootstrap failure behavior and saturation responses. Busy healthy
  threads must not cause readiness flapping or confuse liveness with capacity.
- Use root ID, lease generation and monotonic message sequence where needed.
  Track transient phases: leased -> dispatched -> started -> optional foreground
  -> graph-settled -> handoff/parent operations accounted -> reusable/retired.
  Missing a start acknowledgement does not prove execution never happened.
- Isolate control delivery from bulk recording/debugger payloads. Bound per-turn
  parent work, messages and console output. Backpressure cannot silently discard
  authoritative results or block cancellation behind a large artifact.
- Fail an affected root once. Never replay accepted graph execution because its
  thread, output or acknowledgement was lost. Bounded replacement/backoff applies
  only to empty worker capacity, not business executions.
- Count a terminating thread until confirmed exit. For a native operation that
  cannot terminate, fence that slot and report degraded capacity. Do not claim the
  current server already has an automatic recovery mechanism for this new failure,
  or kill unrelated healthy roots as an implicit recovery step.

### 2. Data and service ownership

| Inside the execution thread                                                              | Parent-owned                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| GraphProcessor, Code/Rivet namespace, interpolation, tokenization and provider execution | HTTP/WebSocket transport, authentication and live authorization           |
| Per-root environment/configuration data, graph globals and intermediate objects          | Existing settings repositories and root admission/durable owners          |
| Recorder/serializer, action state patches and response trace                             | Evidence owner/repository and persistence queues                          |
| Reconstructed immutable datasets/browser storage snapshot when applicable                | Existing shared SQL/S3 services and parent-owned store operations         |
| Actual graph debugger attachment/event formatting and prepared action driver             | Socket clients, routing, durable event publication and control provenance |

Preserve require/fetch/process/console/Rivet and node source/error locations.
Verify the actual required Node capabilities: thread `process.chdir`/umask-setting
restrictions and thread-local `process.exit` differ from the current process.
Do not claim arbitrary Node code is fully equivalent or proxy process-global
mutations back to the parent. A required incompatible capability blocks Gate A
until the behavior or boundary is explicitly resolved.
Keep require preparation lazy and at most once per root. Reused threads must
refresh per-root settings and active package identity; prewarming is not a
settings or library authority. Within-root values stay local; cross-root package
singletons were never durable storage and their changed sharing must be reviewed,
not emulated by an arbitrary shared heap.

Construct local runtime objects from data where possible; do not make every
tokenizer, dataset or browser-store read an RPC. Explicit adapters cover existing
parent-owned reference/subgraph/catalog IO, host stored values, knowledge
connections, profile-health and needed external callbacks such as web-app status.
No thread may accidentally start SQL pools, LISTEN sessions, schema migration,
maintenance or parent singleton backends. Authored provider/network clients may
exist in the thread; account for their cleanup and memory.

Carry the accepted execution settings explicitly and restore the intended parent
request context around adapter calls. Keep fresh authorization/ownership checks
fresh. Prewarmed `process.env` or a cloned repository Map is not that contract.

Encode final outputs at their existing external serialization boundary inside the
thread, before sending portable results/bytes. Plain cloning can change Date,
Buffer, getters, custom `toJSON` and undefined behavior or reject functions that
JSON would omit. Preserve existing response mapping, duration fields, action
state/storage patches and error code/source details through narrow codecs.
Do not globally JSON-convert intermediate values, run authored serialization on
the API thread or change the separately deferred public-error policy.

### 3. Execution versus parent operations

Track each parent adapter request before invoking it, with its root/generation.
After cancellation, reject new requests; account for calls already sent. Thread
exit does not cancel a parent SQL write or prove it did not commit. Never replay
such a write because its reply was lost. Pending operations remain in the drain
inventory even if their execution thread exits; do not let their replies reach
a later root on a reused thread. Preserve known/unknown outcomes with existing
storage owners rather than creating another durable operation coordinator.

Propagate explicit cancellation, ownership loss, relevant lease expiry and forced
shutdown. Do not newly kill accepted work on an ordinary HTTP disconnect or early
success response. Keep each surface's existing policy.

Before activation, specify applicable root deadlines, queue deadlines and the
cooperative-abort/forced-termination bound. Command timeout, proxy read timeout,
Code wall time and CPU accounting are different policies. The accepted
300-second product-request protection target is not a global deadline for editor,
Evaluation or scheduled roots; debugger pauses and async Code need explicit
treatment. There is no basis here for inventing a short universal Code timeout.
A forced interrupt may end the entire root; do not promise branch preemption.

On drain, stop new admissions but keep accepted roots' controls/adapters alive.
Account for roots already queued: finish under the existing grace or close as not
invoked, without silently losing an accepted occurrence. Dispose execution
consumers before their storage/settings dependencies. Treat thread exit, graph
settlement, parent IO settlement and recording handoff as distinct facts.

### 4. Evidence and capture

Keep the recorder with the real processor. Use ExecutionSession where already
used; socket prepared actions keep their established hooks through the driver
seam. Do not introduce a duplicate recorder or force every public Node consumer
onto a new session architecture.

Parent `beginRunEvidence`, its repository and `activeEvidenceOwners` remain the
single root/child owner. Allocate stable identities before dispatch; enqueue
registration asynchronously without a database or extra worker round trip before
invocation. Worker sessions report facts and capture payloads rather than creating
another durable owner or trying to turn the synchronous begin hook into async RPC.

Keep foreground responses independent of bookkeeping/uploads. Before reuse or
retirement, acknowledge bounded root/child capture handoffs in parent memory,
not database completion. Account for child captures before releasing their root
association. Full queues or unconfirmed transfers yield truthful unavailable
evidence, not indefinite worker retention or an unbounded artifact backlog.
Do not move large recording serialization back onto the parent to free a slot.

Preserve a terminal execution outcome once acknowledged. Losing a later recording
means known success/failure with unavailable evidence; losing the thread before
terminal proof may mean unknown outcome. Cost completeness is independent:
preserve known partial totals, never invent a zero bill. Retain current stable
IDs, nested relationships, disabled-recording behavior and persistence recovery.

## Integration order and concrete owners

1. Prove the endpoint and prepared-action driver seams at Gate A.
2. Add bounded supervisor/adapters and the chosen lifecycle behind an explicit
   startup-owned mode. No automatic fallback or redispatch on failure.
3. Integrate all hosted surfaces through those seams:

| Surface                          | Owning entry points / behavior to preserve                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published/latest HTTP            | API `execution.ts`, `hosted-processor.ts`, `hosted-runtime-policy.ts`: early output and full settlement                                                                            |
| HTTP web-app actions             | API `execution.ts:runRecordedWebAppAction` and `web-app-execution.ts`: selected graph, patches, capture                                                                            |
| Socket actions / managed preview | API `web-app-action-websocket.ts`; Node `webAppSocketGateway.ts`, `webAppHandler.ts:prepareRivetWebAppAction`: preparation/disposal, status, browser storage, resume and recording |
| Schedules                        | API `scheduled-runs/runner.ts`: existing fenced occurrence ownership                                                                                                               |
| Hosted Evaluations               | API `evaluation-runs/hosted-execution.ts`: metrics, attempts, artifacts and trial cancellation                                                                                     |

The prepared-action driver retains the existing local implementation for other
Node/Desktop consumers. Do not duplicate binding, hook, patch or response-trace
rules. An abandoned preparation releases capacity without invoking its graph.

`RivetDebuggerServer.attach` requires a real GraphProcessor. Attach and format
events alongside it; bridge the existing authenticated event/control contract to
parent sockets. Preserve run-scoped pause/resume, abort, user input, preload,
managed latest prompts and reconnect semantics. Do not transfer a debugger object
or attach it to a fake processor. API mode does not automatically isolate the
separate desktop/editor sidecar; document and preserve that scope.

Update `server.ts` resource lifecycle, existing metrics and the affected runtime/
recording owners. Operational metrics use finite outcome categories; root IDs
belong in existing correlated diagnostics, not new high-cardinality labels.

## Verification and completion

Use real threads and small deterministic behavioral tests. Reuse existing suites;
do not duplicate the graph engine tests or use source text as isolation evidence.

- Infinite loop and post-await infinite loop in an independently bounded child
  test harness: API liveness/cancel and a short root on another available thread
  work; the bad thread is terminated and physically reclaimed.
- Whole graph parity: all Code-family paths, nested Rivet execution, shared
  mutations, functions/classes, binary aliases, globals and source/error locations.
- Real response codecs: Date/custom JSON, undefined/cycles/errors, patches and
  duration fields; response encoding failure does not falsify graph outcome.
- Root reuse/retirement: fresh configuration and callback ownership, detached
  timers, unawaited work and package globals; record actual lifecycle differences.
- Queue/capacity bounds; queued cancel/owner expiry; startup failure; no implicit
  admission-policy change; slow provider waits and paused roots.
- Cancellation/result races, stale messages, parent write in flight, no replay,
  bulk-message pressure and accepted post-response work during drain.
- Known terminal versus lost recording, partial costs, child capture, disabled
  recording and saturated persistence; no duplicate SQL/settings owners.
- Actual web-app socket/browser storage, debugger prompts/controls/reconnect,
  schedules and hosted Evaluation execution.
- Emitted worker entry, managed require and supported native dependency in the
  maintained Node-24 Linux image, plus source startup without main-thread fallback.

Benchmark no-Code, trivial Code, many sequential Expressions, parallel branches,
the sanitized real fixture, async Code and large payloads, with recording on/off.
Separate first-request/warm/burst results and include total CPU/RSS under realistic
Pod-equivalent constraints. Local microbenchmarks do not prove deployment capacity.

Useful existing suites: `managed-code-runner.test.ts`,
`hosted-runtime-policy.test.ts`, `scheduled-run-execution.test.ts`,
`hosted-evaluation-execution.test.ts`, lifecycle, web-app handler/gateway and
debugger tests. Add actual isolated-runtime integration/benchmark entry points;
the current legacy/optimized benchmark does not already test isolation.

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run build
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/managed-code-runner.test.ts src/tests/hosted-runtime-policy.test.ts src/tests/scheduled-run-execution.test.ts src/tests/hosted-evaluation-execution.test.ts src/tests/server-resource-lifecycle.test.ts
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- --runs 50 --warmups 10
node scripts/checks/check-doc-links.mjs
```

Run relevant Core/Node tests and normal CI checks for the final diff. Browser
execution changes require the repo's headless `studio-server:ui:observe` check;
documentation alone requires links/formatting, not browser or Kubernetes rehearsal.
Read the optional ignored CI notes before publishing.

Only after Gate A, full local parity/failure tests, packaged loading and capacity
evidence pass: normal publication, then one separately authorized staging
qualification and the authorized production release. Measure real latency and
memory; preserve the existing qualification/cleanup process. No new cloud attempt
is authorized by this plan.

Completion means no authored hosted Code on the API event loop, working explicit
abort/drain, latency within the accepted limits, unchanged useful
recordings/cost/debugger behavior and coverage of every listed hosted surface.
Until the prototype settles lifecycle, sizing and budgets, this plan is ready for
local investigation and is not a claim of production readiness.
