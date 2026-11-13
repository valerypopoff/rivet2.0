# Editor executor recovery: implementation and release plan

Status: implemented and validated locally, 2026-11-13. Staging qualification and
production deployment remain separate release steps through the normal pipeline.

## Implementation decisions and validation

`ExecutorSessionProtocol` owns the shared, exhaustive delivery policy and bounded
chunk/receipt primitives. `DebuggerSessionDelivery` owns the v2 server writer and
retention; `ExecutorSessionV2` owns browser reassembly and completed dataset
replies. `DebuggerSessions` remains the capability/owner authority. The existing
v1 path and managed latest-debugger protocol are separate and compatible.

| Resource                    | Implemented bound                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Diagnostic history          | Existing 8 MiB / 8,192 events per session, 32 MiB across sessions                                                      |
| Diagnostic frame            | Less than 64 KiB after projection; large authored values are omitted before full serialization                         |
| Writer backpressure         | Pause above 1 MiB; resume below 256 KiB; at most 32 frames per scheduled batch                                         |
| Reliable functional payload | 100 MiB of UTF-8 JSON per item, matching the ordinary `ws` message ceiling                                             |
| Retained reliable payloads  | 256 MiB / 4,096 items per session; 512 MiB across a server or browser process                                          |
| Incoming chunk assemblies   | Reserve the declared byte total from the same 512-MiB process budget; release on completion, reset, expiry or disposal |
| Emergency failure reserve   | 256 KiB / 128 entries per server session, 16 MiB across the server                                                     |
| New run admission           | At most 32 unsettled requests, with item/byte headroom for outcomes                                                    |
| Incomplete transfer         | One per direction/session; 60-second absolute expiry; reset on transport replacement                                   |
| Detached settled session    | Existing 30-minute idle retention, with an actual expiry timer; retained active work is excluded                       |
| Browser dataset operations  | At most 256 pending/completed operations per session; reply shares reliable byte limits                                |
| Server dataset waiter       | 120 seconds, then explicit rejection and listener cleanup; no write retry                                              |

These are encoded-payload budgets, not a hard JavaScript heap limit. A temporary
string/parse representation also uses memory. The old diagnostic limits never
provided a large-result delivery guarantee; v2 adds a separately bounded one.
Published browser-storage RPC's 256-MiB value / 512-MiB action limits are separate
and unchanged. The reproduced 51-MiB connection total was diagnostic traffic,
not evidence of a 51-MiB chat answer.

Chunks declare delivery ID, index/count and exact UTF-8 byte total. Boundaries
preserve surrogate pairs. Only a consumed reliable item is acknowledged;
duplicates acknowledge its ID without applying it again. A valid old diagnostic
cursor receives an explicit gap and the retained tail. Unannounced gaps, foreign
capabilities and protocol changes still fail closed. ACKs never acknowledge a
diagnostic cursor or authorize a new run.

The diagnostic queue uses bounded projection and oldest-first trimming rather
than an additional per-node coalescing cache. This keeps invocation ordering in
one place and passes the overload case without growing another identity map.
Removing repeated authored project/graph/node bodies does not itself mark the
run partial: recordings already store the project separately. The marker is
reserved for missing observed values/events, so large projects with small run
values still produce complete recordings. Normalized progress is preserved.
The same paced writer handles live delivery and replay. Functional outcomes,
storage patches, prompts, pause/resume and dataset requests are not trimmed.
Storage patches retain their original ordering before outputs. Oversized results
produce a retained typed error with known execution status; an undeliverable
prompt also stops its waiting processor. A successful early response remains
successful if observation of subsequent background work is lost.

An abort announcement does not settle the request: the phase remains active
while nodes unwind, until `done` or `error`. Recovery lists all affected requests
before `executor-session-ready`, using batches of at most 32 identities. The
initial phase snapshot shares that identity allowance so even heavily escaped
request IDs keep control frames below 64 KiB. There is no 256-request truncation.
Incoming transfer reservations and outgoing retained replies share the process
budget in both directions; simultaneous partial transfers cannot each consume
an independent 100-MiB allowance outside that budget.

The editor marks missing evidence partial, excludes it from freeze/preload and
complete-recording claims, and clears only the affected unfinished displays on
permanent loss. Run Activity distinguishes **Outcome unknown** from a real
execution failure. Active and inactive project projection preserve ownership
and later-run boundaries.

Local acceptance includes the normal-limit 52-MiB diagnostic producer over real
WebSockets, eviction/reconnect, slow live/replay writers, exact Unicode output,
lost receipts, offline dataset completion, transfer expiry, bounded rejection,
old/new protocol admission and the actual React preview hook. The real executor
retirement suite covers non-resumable, v1 and v2 owners through paused work,
reconnect and terminal cleanup. The headless hosted preview uses the actual
editor with a deterministic socket peer; the real-socket and executor tests
exercise the server separately. This is not a claim of a production network
test. See the local validation summary below for final commands/results.

### Local validation, 2026-11-13

- Shared chunk/receipt tests pass, including exact Unicode, a 65-MiB payload,
  malformed chunks, premature ACKs and an absolute transfer deadline.
- Node debugger/web-app regression suites pass (211 cases), plus the added
  projection and delivered-history regressions. Evicting already received
  history does not mark a live run partial; a resume behind that interval does.
  A post-serialization size check also handles custom value serializers.
  The real-socket tests produce 52 MiB of diagnostic
  source values, return exact functional results once and recover an evicted
  diagnostic prefix. Slow-writer tests hold the socket above its high-water
  mark during both live delivery and replay, then verify receipt releases bytes.
- App executor/snapshot/frozen-value suites pass (305 cases), with focused
  follow-up coverage of inactive partial completion and omitted frozen values.
- The real executor retirement suite passes for legacy, v1 and v2 (three cases).
  It exercises a real pending prompt, pause, disconnect/resume, duplicate run
  rejection and settlement. Build Node before this suite; otherwise its package
  import can test stale compiled transport code.
- Hosted web unit/production suites pass (253 + 39 cases).
- The complete headless `hosted-executor-origin.spec.ts` passes: 21 cases in
  about 2.7 minutes, including preview recording/recovery, storage replay, owner discovery and
  switching to Browser. Its CI duration hint is updated; test discovery remains
  unchanged. Do not edit/rebuild shared source during this browser run: hot
  reload invalidates its connection-count assertions. One earlier run was
  discarded for that reason, then the whole suite passed against fixed source.
- App/Node TypeScript and affected ESLint checks pass. Root `test:style`, test
  style, file-tree, documentation-link and diff-whitespace checks pass.
- Core, Node, native Windows app-executor, App and CLI package builds pass. Core's
  build also verifies the published ESM/CommonJS export surfaces. The App build
  is checked separately from the browser tests to avoid hot reload during them.

The remaining acceptance is release-only: publish matching application/executor
packages, qualify them through the existing staging path, then verify the
reported preview in production after the approved rollout. No cloud test or
deployment has been performed for this implementation.

### Follow-up code review

Regression tests reproduced and fixed premature settlement after `abort`,
unaccounted concurrent chunk assemblies, and oversized/incomplete recovery
notices after 256 requests. Notice batching replaces the separate gap flag;
session disposal also clears phase and notice metadata. Existing run/result
identities and v1 compatibility are unchanged. A retained delivery failure for
`graphOutputsReady` also preserves its `outputs-ready` phase; it does not report
background execution as completed. Shared-protocol, Node recovery, App recovery,
and legacy/v1/v2 retirement regressions pass, along with App type checking,
affected lint, test-style and documentation checks. Both headless preview and
dataset reconnect journeys pass. No cloud test or deployment was started.

The adjacent-lifecycle review also rejects expired socket handles through one
live-session lookup used by admission, retention, delivery and receipts. Expiry
clears the old replay/run metadata; a late callback cannot recreate a ledger or
consume the process budget after its capability has been removed. A valid
retained logical handle still works across physical socket replacement.

Both browser receipts and dataset replies use one guarded socket writer. If a
send throws, it suspends the writer and closes that physical transport so the
existing reconnect path can resend the same delivery IDs. It never invokes the
dataset operation again. Failure to close is a terminal observation failure.
Tests cover throwing sends, single result consumption and single dataset writes,
plus rejection of expired v1/v2 handles and normal retained-owner recovery.
The headless preview also injects a failed result receipt: the same accepted run
reconnects, returns one chat message, and completes without a second execution.
Fault injection patches the active routed WebSocket after bootstrap, since the
browser test runner installs its own transport during page initialization.
Focused Node/App suites, legacy/v1/v2 retirement, the browser journeys, type/lint
checks and CI test-discovery checks pass after these changes.

## 1. Outcome and evidence

An editor web-app action must receive its real result even when live debugging
produces much more data than the browser can display. A temporary connection gap
must resume the same accepted work. Missing debugging history must not by itself
make the result unavailable or restart the graph. An unrecoverable connection
must leave an honest, non-spinning editor state.

The investigation established:

- Production showed an executor WebSocket closing after about 51 MiB of traffic,
  followed by rejected reconnects for roughly a minute. The byte count is the
  connection total, not a measured individual message.
- A local real-WebSocket reproduction using `DebuggerSessions` and its current
  limits reproduced server termination, close code 1006 and HTTP 403 on resume
  after a large diagnostic burst. This requires neither a rollout nor an AI API.
- A separate actual-hook reproduction confirmed that failed recovery rejects
  the waiting preview result and clears the root running flag, but leaves a
  node's stored display status as `running`.
- Production logs do not identify the original close reason, exact resume
  cursor or largest frame. Backpressure/history loss is the leading explanation,
  not proof that every similar error has that cause. Authentication failure,
  ownership loss and process replacement must remain distinct diagnoses.

Keep raw logs, private project snapshots, identifiers and credentials in ignored
artifacts. Use synthetic projects in committed tests.

### Scope and non-goals

Repair the hosted editor executor transport and its consumers. Cover ordinary
Node execution, preview actions, Evaluations, dataset bridging, user-input
prompts and recording consumers that share it. Preserve Browser execution,
desktop/legacy executors, standalone Remote Debugger and published web-app
behavior. A test of one adapter is not proof for all of them.

Do not rewrite the graph scheduler, move code into another repository, introduce
a database migration, create a new service, switch preview to published project
contents, raise Kubernetes reservations, or replace the deployment workflow.
Do not solve overload by unlimited buffers, longer retries or replaying `run`.

## 2. Contracts that must hold

1. **One accepted execution.** Request identity remains scoped to its original
   logical session and owner. Reconnect and receipt acknowledgement cannot
   invoke a graph, tool, dataset mutation or user answer a second time.
2. **Separate result from diagnostics.** Real graph outputs, browser-storage
   patches, execution settlement and outstanding functional requests cannot be
   evicted by node previews, trace messages or repeated partial outputs.
3. **Early result is not settlement.** `graphOutputsReady` may complete a chat
   response while background execution continues. Keep the cancellation,
   recording and accepted-work owner until actual terminal settlement.
4. **Preserve values.** Diagnostic truncation never changes graph execution,
   returned outputs, stored values, saved projects, frozen inputs or exports.
   A truncated preview must not be usable as a complete frozen/replayed value.
5. **Honest recovery.** A missing display interval is marked partial. An unknown
   server outcome is not labelled succeeded, failed or cancelled without proof.
   Local observation stopping does not prove the remote processor stopped.
6. **Bound every buffer.** Count encoded bytes and entries, including pending
   writes, replay history, retained results, incomplete transfers and dataset
   replies. Per-session limits also need a process-wide bound and cleanup.
7. **Preserve ownership.** Stale sockets, old generations and replaced project
   tabs cannot clear or populate newer runs. Results may still settle an accepted
   caller after its source tab changes, without painting another tab's canvas.
8. **No security downgrade.** Keep authentication, capability validation, owner
   routing and cross-project/session isolation. No token, prompt, raw value or
   result payload belongs in operational logs.

## 3. Implementation sequence

### Step 1 — Preserve the reproductions and expose the actual failure reason

Owning files:

- `packages/node/test/debuggerSessions.test.ts`
- `packages/app/src/hooks/executorSessionResume.test.ts`
- `packages/app/src/hooks/useRemoteExecutor.test.tsx`
- `packages/node/src/debuggerSessions.ts`, `debugger.ts`
- `packages/app/src/hooks/executorSession.ts`

Turn the ignored burst diagnostic into a deterministic real-socket regression.
Retain a small-budget version for rapid state-machine tests and one representative
greater-than-50-MiB integration case with normal defaults. Use known payloads,
bounded deadlines and actual completion events, not sleeps or source assertions.
Promote the actual-hook cleanup reproduction with an ordinary Code node and the
same options as preview chat.

Give resume failures a small typed reason set: identity/protocol mismatch,
unannounced sequence gap, recovery deadline, superseded observer, unavailable
owner/session, reliable-retention limit and invalid transfer. Keep the cause
through the pending result rejection. Record close code and elapsed recovery
time. Server diagnostics additionally record message kind, encoded byte count,
buffer/history occupancy and rejected-cursor range; omit payloads and capability
tokens. HTTP rejection alone must not be reported as confirmed history eviction.

This instrumentation is local code work, not a prerequisite for another blind
production reproduction. The already demonstrated defects can be fixed locally.

Completion: regressions demonstrate today's lost result and stale node state;
small control cases demonstrate successful recovery and exactly one `run`.

### Step 2 — Define a narrowly versioned reliable-result contract

Owning files:

- `packages/core/src/model/ExecutorProtocol.ts` or a focused adjacent protocol module
- `packages/node/src/debuggerSessions.ts`, `debugger.ts`
- `packages/app/src/hooks/executorSession.ts`, `executorSessionTransport.ts`
- `packages/app-executor/bin/executor.mts`

Add an executor-session v2 contract. This is separate from the existing managed
latest-debugger protocol; do not change that protocol or reuse its version fields.
The old executor v1 expects contiguous complete replay, so silently allowing gaps
under v1 is incompatible.

For new sessions, the new client offers v2 and v1; the server selects a mutually
supported version and acknowledges it before accepting commands. Resume retains
the original capability, protocol and owner. An existing v2 session cannot silently
downgrade or start anew against a v1 owner. Mixed-version behavior is tested before
release; the v1 path keeps its existing semantics.

Keep two bounded responsibilities inside the existing session owner:

- A rolling diagnostic history, whose old detail may be discarded.
- A reliable pending-operation/result ledger, which diagnostics cannot evict.

The ledger uses session/request identities and contains accepted/running,
outputs-ready and settled states, actual output payloads, storage patches and
outstanding functional messages. Do not confuse `acceptRun` deduplication with
proof that a processor started or finished. Register accepted work before async
preparation, report preparation failures, and record the result before publishing
it. Keep the ledger consistent with `retain`/release and retirement ownership.

Reliable delivery has its own monotonic receipt sequence and acknowledgement.
Keep unacknowledged outcomes across transport replacement. A client acknowledges
only after validation and request handling; replayed delivery does not call result,
storage or trace callbacks twice. Do not mistake a socket send callback for a
client receipt. A lost acknowledgement is harmless and can be sent again.

Define validated shared types for the following v2 frames; these names are the
implementation contract unless an existing equivalent is reused explicitly:

| Frame                      | Minimum contract                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executor-session`         | Negotiated protocol and original capability; sent before any session data.                                                                        |
| `executor-session-state`   | Bounded accepted-request identities and known phases, plus the diagnostic replay baseline. No fabricated graph events.                            |
| `executor-diagnostics-gap` | Explicit unavailable diagnostic interval and new baseline, scoped to the authenticated session.                                                   |
| `executor-reliable`        | Stable delivery ID, request/operation ID, kind and validated payload or bounded transfer descriptor.                                              |
| `executor-receipt`         | Acknowledges one delivered reliable item in that session; duplicate receipts are harmless and unknown/future receipts cannot release other items. |
| `executor-session-ready`   | Recovery installation has completed; normal command admission may resume.                                                                         |

Keep diagnostic and reliable cursors separate. A diagnostic baseline change must
not acknowledge a result or dataset operation. Browser-to-server execution and
control commands keep their existing policy: do not add a general automatic
command retry queue. Dataset reply retransmission is allowed only for its exact
already-completed operation, with receiver deduplication.

#### Explicit message classification

| Traffic                                                             | Required treatment                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node input/output previews, partial snapshots, code console, trace  | Size-bounded diagnostic detail; coalesce or omit with an explicit partial-history indication.                                                                          |
| Root identity/start and execution phase                             | Retain compact authoritative request state so a missing history prefix cannot hide the active run. Do not require another full project upload to reconstruct it.       |
| Actual graph outputs, root errors/settlement, browser-storage patch | Reliable request outcome. Apply the storage patch before exposing successful outputs. Never substitute a diagnostic placeholder.                                       |
| `graphOutputsReady` followed by background work                     | Deliver the response once and retain separate running/settled state and cancellation ownership.                                                                        |
| Dataset requests/replies and user-input prompts                     | Reliable pending operations with stable identities; never discard or blindly repeat them.                                                                              |
| Progress                                                            | Preserve its normalized message/percent semantics; only superseded state snapshots may be coalesced. Do not treat arbitrary future append-style events as replaceable. |
| Accounting, response inspection and recording detail                | Preserve complete data when present; mark omitted evidence partial/unavailable. Never claim complete cost or replay history after dropping its inputs.                 |

Reject unclassified new message kinds in protocol tests until their delivery policy
is explicit. Keep the classification near the transport owner, not copied into
each UI component.

#### Payload and retention limits

Keep the existing 8-MiB session / 32-MiB aggregate diagnostic-history limits as
initial ceilings. Start the writer with a 1-MiB socket high-water mark and a
256-KiB low-water mark; treat these as testable starting values, not performance
claims. Prevent a single diagnostic frame from exceeding 64 KiB after encoding.

Reliable outcomes need a separate, explicit byte/count/TTL budget. Before fixing
its defaults, inventory the existing supported output, upload and dataset limits
and measure the synthetic reproduction's actual result size separately from its
debug traffic. No new lower functional-payload limit may be introduced unnoticed.
Record the selected defaults and measured headroom in this document before Step 3.
This is a required implementation decision, not permission to ship an unbounded
cache or guess that 51 MiB was the size of a returned chat answer.

For a functional payload larger than a socket frame, use bounded chunked transfer
with declared total size, transfer identity, ordered chunks and exact reassembly.
Reuse compatible existing transfer/validation primitives rather than creating a
second universal RPC system. Count wire-encoded size; do not split UTF-16 strings
by accident. Validate before allocation and cancel incomplete transfers on expiry
or owner replacement. Large genuine results must still return intact.

Admission stops new work before exhausting reliable retention; active or
unacknowledged outcomes are not evicted to admit a new request. If a result itself
cannot fit a documented hard limit, retain a small typed result-unavailable
outcome and its known execution status. Never leave the caller waiting or report
a known completed execution as an unknown disconnect. This exceptional path is
not acceptable for the reported use case or existing supported result fixtures.

Active work is never expired as an idle session. Release acknowledged payloads
promptly; retain settled unacknowledged outcomes for a documented bounded window
(start from the current 30-minute idle retention). Expiry must have a distinct
outcome-unavailable response and must not authorize starting the request again.
The guarantee is recovery while the same owner retains the session, not durable
execution recovery after a process dies or the whole browser reloads.

### Step 3 — Bound delivery and resume after diagnostic history loss

Owning files:

- `packages/node/src/debuggerSessions.ts`
- `packages/node/src/debuggerTransport.ts`, `debuggerPayloadSanitizer.ts`
- `packages/node/src/debuggerProcessorAttachments.ts`
- `packages/app/src/hooks/executorSession.ts`, `executorSessionTransport.ts`

Introduce one session-owned writer used for both live and replay delivery. The
current replay loop also sends everything synchronously; fixing only live sends
would recreate the overload during recovery.

- Drain in bounded batches and yield to socket/heartbeat/control work. Prioritize
  reliable messages. Pause below the high-water threshold rather than terminating
  a healthy session because display events arrived in a burst.
- Bound pending diagnostics before enqueueing. Coalesce unsent partial snapshots
  by request/root/graph/node/process/port or split-item identity as appropriate.
  Distinct invocations and final node results must not overwrite each other.
- Trim large diagnostic values before expensive full serialization. Do not clone
  the complete project into every event. Preserve identity and terminal metadata,
  and use an explicit unavailable/truncated representation for omitted detail.
- Do not store the same large serialized payload separately in multiple queues.
  Count shared storage once and release it when all owners release it.
- On v2 resume with a valid owner but an expired diagnostic cursor, send an
  explicit bounded history-reset/gap frame, authoritative request phases,
  outstanding reliable operations/results and the retained diagnostic tail.
  The client marks its lost interval partial and advances only to the advertised
  baseline. An unexplained gap or foreign identity still fails validation.
- Ready is acknowledged only after the recovery boundary is installed. Keep the
  existing total recovery deadline; ongoing packets cannot extend it forever.
- If the client remains completely unresponsive, bounded disconnection is still
  allowed. It must not destroy the reliable outcome or create a retry loop for a
  session known to be irrecoverable.

Completion: the normal-limit burst case returns the exact result once, stays
within queue bounds, and recovers after an intentionally lost diagnostic prefix.

### Step 4 — Integrate results, dataset operations and cleanup in the editor

Owning files:

- `packages/app/src/hooks/useRemoteExecutor.ts`
- `packages/app/src/hooks/executorSessionPendingExecutions.ts`
- `packages/app/src/hooks/remoteExecutorRunRequest.ts`, `executorSessionRunReadiness.ts`
- `packages/app/src/hooks/executorSessionDatasetBridge.ts`
- `packages/node/src/native/DebuggerDatasetProvider.ts`
- `packages/app/src/hooks/projectExecutionSnapshotEvents.ts`, `useGraphExecutionEvents.ts`
- `packages/app/src/hooks/projectExecutionSnapshotRouting.ts`
- Relevant Run Activity and recording consumers

Resolve preview promises from the reliable outcome under v2, not whichever
diagnostic terminal survives the ring. Reconcile duplicates, late delivery,
cancelled callers and closed/replaced tabs. Preserve the original project's
callback ownership. Do not weaken pre-send binding checks just to support resume;
post-acceptance controls bind to the surviving logical session rather than its
old physical socket.
Mark a delivery as being consumed before invoking external callbacks. A callback
throw must be isolated and surfaced once, not make a later replay apply the same
storage mutation again. Acknowledge its handled outcome with that local failure
recorded; preserve the server's separately known execution status.

Dataset operations need particular care: the current provider holds unresolved
listeners, and the browser executes incoming writes. Retain outstanding requests
separately, deduplicate an in-flight/completed browser operation by logical
session and request identity, resend its completed reply rather than its mutation,
and release that cache on confirmed consumption or terminal expiry. A permanent
failure must settle waiting provider promises; duplicate/missing replies cannot
hang a processor forever. Do not add automatic dataset-write retries. Preserve
the legacy provider contract outside the versioned transport.

For terminal observation loss, add an explicit snapshot transition that stops
only the affected unfinished node/process/graph displays. Use existing interrupted
or unknown presentation; keep real completed/error results and unrelated roots.
Record observation loss separately from server outcome, rather than presenting a
synthetic server cancellation. Reuse this transition for active and inactive tabs.
Cover disposal, failed resume, owner loss and project replacement without letting
an old disconnect erase a later run. If a result was already returned before loss
of the background tail, preserve that successful response and its known status.

An optional brief partial-details notice is appropriate when diagnostic history
was lost. Do not show the current fatal chat error if a reliable result can still
arrive. Actual owner loss remains an honest outcome-unknown error, with no automatic
resubmission. Do not invent additional modal workflows for this recovery.

### Step 5 — Local validation and regression gates

Use real runtime boundaries as well as state-machine tests. A fake WebSocket
test alone does not reproduce kernel buffering or the current server termination.

| Case                                                                                  | Required result                                                                                      |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Normal chat, Node graph and early-output chat                                         | Exact outputs and storage patch; one graph execution; tail settles separately.                       |
| Greater-than-50-MiB diagnostic burst, including one oversized node value              | Bounded queues; complete functional result; no overload-driven loss of that result.                  |
| Slow reader and burst during replay                                                   | Writer yields and bounds memory; replay does not flood the replacement socket.                       |
| Disconnect after acceptance, during outputs and during result acknowledgement         | Same request/owner resumes; callback and mutations occur once; no second `run`.                      |
| Diagnostic ring eviction, including aggregate pressure from other sessions            | Explicit partial history; result, pending prompt and dataset reply remain available.                 |
| Large real result and large storage/dataset transfer                                  | Exact values after reassembly; declared limits and malformed chunks enforced; no placeholder result. |
| Dataset write finishes while offline; reply or acknowledgement lost                   | Exactly one write; retained reply settles the original server waiter.                                |
| User input while offline                                                              | Same pending prompt and one answer, with correct request/process owner.                              |
| Authentication failure, wrong capability, stale socket, protocol downgrade            | Rejected without cross-session data, replay or an infinite recovery loop.                            |
| Permanent owner loss and genuine processor failure                                    | Correct distinct outcome; no spinning nodes, no fabricated success/cancellation.                     |
| Active/inactive tabs, same-ID replacement, later run, standalone debugger             | Only the correct lifetime is updated; late cleanup cannot affect another run.                        |
| Recording, response inspection and LLM/Decision AI costs                              | Complete data stays complete; omitted evidence is marked partial, never treated as zero.             |
| Repeated connect/run/disconnect/dispose cycles                                        | Ledger, dataset listeners, buffers, timers and transferred payloads return to bounded baseline.      |
| New client/old server; old client/new server; new/new; live v1 session during upgrade | Expected negotiation and preserved old-session behavior; no silent owner/protocol change.            |
| Published web app, Browser executor and desktop Node                                  | Existing behavior and result fidelity unchanged.                                                     |

Add the burst and recovery cases to existing Node/App test owners; keep normal
limits in the integration test and reduced limits only in fast unit cases. Add a
headless preview-chat browser case exercising the real editor and local executor,
with mocked external model calls. Assert UI response, node cleanup, request count,
storage behavior and errors, not just a ready socket. Count produced, queued and
delivered bytes to prove the test reached the intended overload condition.
Use seeded payloads and account for compression if enabled; a large repeated
string by itself is not proof of large wire/backpressure load.

Use existing `hosted-executor-origin.spec.ts`, web-app and execution suites where
possible. Register any new test files in package scripts and CI shards, measure
new suite weight, and update the explicit CI inventory if it changes.

Representative commands (adjust only for the final registered test names):

```powershell
# Root style checks can rebuild Core: finish them before consumer checks.
yarn test:style
yarn check:file-tree
yarn studio-server:verify:test-style

yarn workspace @valerypopoff/rivet2-node exec tsx --test test/debuggerSessions.test.ts
yarn workspace @valerypopoff/rivet-app run test:files src/hooks/executorSessionResume.test.ts src/hooks/useRemoteExecutor.test.tsx src/hooks/useRunUiGraphAction.test.ts
yarn studio-server:verify:executor-retirement
yarn workspace @valerypopoff/rivet-studio-server-web run test

yarn workspace @valerypopoff/rivet2-core run build
yarn workspace @valerypopoff/rivet2-node run build
yarn workspace @valerypopoff/rivet-app-executor run build
yarn workspace @valerypopoff/rivet-app exec tsc --noEmit
yarn workspace @valerypopoff/rivet-app run build
yarn workspace @valerypopoff/rivet2-cli run build

$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4318'
yarn studio-server:ui:observe hosted-executor-origin.spec.ts

node scripts/checks/check-doc-links.mjs
git diff --check
```

Run affected lint and the complete affected protocol/session suites as well.
Inspect browser artifacts on failure. Do not run builds that mutate shared Core
outputs concurrently with checks consuming them. Store actual results, final
budgets and measured memory/queue behavior; do not label planned checks passed.

### Step 6 — Documentation and controlled release

Update this plan, [App architecture](../APP-ARCHITECTURE.md),
[Editor bridge](editor-bridge.md), [Server architecture](architecture.md), and
protocol comments with the final wire contract, partial-history behavior,
retention limits and failure reasons. Add user documentation only for visible
behavior; keep transport machinery out of ordinary chat instructions.

After local completion, use the existing develop/main CI and image publication
flow. This change affects the application and executor, not only rollout tooling;
qualify the matching images. Verify mixed-version compatibility before accepting
the release. Do not borrow earlier tooling-only qualification for this change.

Run one focused check on retained staging through the real proxy/owner route:
normal preview chat, the synthetic burst, a temporary connection gap, dataset
reply recovery and published-endpoint regression. Use the normal rollout gate
where required; do not create a second cluster or repeat unrelated diagnostics.
Cloud activation and spending approval belong to that later release step.

Only after staging succeeds, deploy through the normal production process and
check the reported web app with appropriate input. Observe precise failure
reasons, response completion, duplicate-run count and buffer pressure. A fresh
session gets v2; in-flight v1 sessions finish on their original compatible owner.

Rollback must not silently reopen an accepted v2 run on a v1 owner. Drain/settle
active v2 sessions before removing their owner where possible; otherwise report
owner loss explicitly. A new session after rollback may negotiate v1, with the
known old limitation documented. Do not bypass release checks or automatically
repeat a failed cloud attempt.

## 4. Completion criteria and stop conditions

The fix is complete only when the real-socket burst and actual preview action
return exact results once, diagnostic loss is recoverable and explicit, dataset
operations do not repeat, and permanent loss leaves no falsely running node.
Both early-result/background-settlement and mixed-version tests must pass.

Stop before release if any functional message is still stored only in evictable
diagnostic history; any accepted mutation is replayed; a truncation marker can
become executable/frozen data; memory is bounded only by dropping unacknowledged
results; real result limits are smaller than the supported fixtures; or an old
client/server pairing fails without a deliberate compatibility policy.

Local success proves the implementation, not a production fix already deployed.
The first production disconnect's exact cause remains an incident-observation
question until the new reason diagnostics confirm it. Fix the demonstrated
overload and stale-display paths without hiding that distinction.
