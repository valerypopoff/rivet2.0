# Bounded waiting for HTTP request bodies

Status: implemented locally November 20, 2026; not deployed. The design below records the invariants and validation gates for the bounded queue and decoded-size handoff. The validation record at the end distinguishes measured behavior from production capacity.

## Outcome

Absorb short bursts of otherwise valid HTTP requests when reader slots are briefly occupied, without weakening input-memory protection or delaying requests when capacity is available. Keep the live **Concurrent runs per execution replica** setting and its meaning unchanged.

The request path becomes:

```text
Existing authorization / preflight
  -> reject invalid input metadata or insufficient byte capacity
  -> immediate body admission when capacity is available
  -> otherwise a bounded, short wait for a reader slot
  -> existing bounded receipt and parsing
  -> existing route handler and execution admission
```

This is independent of the [Storyteller callback-capacity repair](http-callback-capacity-plan.md). A body-admission rejection happens before a workflow starts; it does not explain the outgoing HTTP failure inside the previously investigated recording.

## Evidence and boundaries

The [controller and middleware](../../packages/studio-server-api/src/middleware/body-admission.ts) share a process-wide limit of four concurrent body readers and 1 GiB of body reservations. A reader slot is held while receiving, decompressing, and parsing input. It is released before the handler runs. The input's byte reservation can remain held until the handler finishes, including after a client disconnect.

The request-body receive deadline is 120 seconds by default. A compressed or unknown-length body reserves the route's full decoded size allowance. An uncompressed body with a known length reserves its declared bytes. These are input-accounting bounds, not an exact bound on the expanded JavaScript heap.

Before this change, the conservative full-size reservation remained until the handler finished. For a 100 MiB route, ten tiny compressed inputs could therefore retain almost the entire 1 GiB budget while their workflows ran. Queueing alone would only postpone those rejections. Successful decoding/parsing now reduces that reservation to the verified decoded byte length, matching the accounting already used for known-length uncompressed input. Those actual bytes remain reserved until the handler settles.

On November 20, a local Node 24.22.3 HTTP fixture used the actual `createJsonBodyParser`, actual async-handler ownership, persistent HTTP connections, and a harmless asynchronous handler. It excluded graph execution and the published-run gate to isolate body intake.

| Input and burst size                                      | Requests | HTTP 200 | Body-capacity HTTP 503 |
| --------------------------------------------------------- | -------: | -------: | ---------------------: |
| Small uncompressed JSON, 32 at once                       |      640 |      640 |                      0 |
| Small uncompressed JSON, 64 at once                       |      640 |      640 |                      0 |
| 64 KiB uncompressed JSON, 32 at once                      |      192 |      192 |                      0 |
| 1 MiB uncompressed JSON, 16 at once                       |       48 |       48 |                      0 |
| Small gzip JSON, 32 at once                               |      192 |       24 |                    168 |
| Small JSON split into two writes 100 ms apart, 32 at once |       64 |        8 |                     56 |

Holding four two-byte uploads after their first byte also reproduced a fifth-request 503 in approximately 1 ms. Finishing those uploads released admission; the next request succeeded. All 19 existing body-admission tests passed.

These observations establish the short-burst problem and current cleanup behavior. They do not certify production throughput, predict these exact percentages on another machine, or show a general four-workflow limit.

## Initial policy

Use explicit code constants, with narrow constructor/options injection for tests. Introduce no environment flag, new settings UI, database state, or cluster-wide queue.

| Limit                                 |        Initial value | Meaning                                                      |
| ------------------------------------- | -------------------: | ------------------------------------------------------------ |
| Active body readers                   |         4, unchanged | Receiving/decompressing/parsing bodies                       |
| Active and retained body reservations |     1 GiB, unchanged | Existing decoded-input accounting                            |
| Waiting requests                      |       64 per process | Metadata and paused request streams awaiting a reservation   |
| Maximum admission wait                |             1 second | Bounds added waiting before body reading begins              |
| Total receive deadline                | Existing 120 seconds | Starts at the body middleware and includes admission waiting |

These are the implemented defaults. They are independent of the published-run setting. A larger run limit does not authorize unlimited pending uploads. The queue absorbs short bursts; it is not a promise to retain every request during sustained overload or while four clients indefinitely withhold their bodies.

Do not add a minimum delay or a new asynchronous scheduling hop to uncontended admission. Queue only a shortage of reader slots. A full byte budget, a body that cannot fit the available byte budget, or an impossible size keeps its immediate rejection. A full waiting queue also rejects excess requests immediately. This avoids turning memory held by long-running workflows into a second waiting problem.

## Ownership and invariants

1. Each request has at most one queue entry, one granted reservation, and one terminal outcome.
2. Waiting requests own no active-reader slot or decoded-body reservation. They do retain a connection and bounded queue metadata, so their count and duration must remain capped.
3. Waiting never attaches a body accumulator, starts decompression, invokes a route handler, or starts a workflow.
4. Admission atomically acquires both a reader slot and its existing byte reservation. A request cannot take one resource while waiting for the other.
5. Reader-slot admission attempts are FIFO. New arrivals cannot bypass eligible waiting requests. Recheck byte capacity at grant time; if the head no longer fits, reject that entry with the existing capacity error and continue to the next entry. Do not hold a free reader slot while waiting for a large memory reservation, and do not add a second priority scheduler.
6. Successful parsing releases the reader slot and hands the verified remaining byte reservation to the current handler-ownership mechanism. It does not hold the reader while the graph executes.
7. Abort, timeout, response close, parser failure, and successful completion release their own resources exactly once. A decompressor must actually close before its active reservation is recycled, as today.
8. Use monotonic elapsed time for admission expiry. Check deadlines again before granting a reservation, even if an event-loop delay postponed the timeout callback.
9. Preserve the originating request's settings snapshot and asynchronous context through the queue. Preserve authorization, request correlation, route limits, publication checks, response shapes, and accepted-work retirement ownership.

## Implementation sequence

### 1. Keep policy and queue ownership in the existing controller

Work in [body-admission.ts](../../packages/studio-server-api/src/middleware/body-admission.ts). Retain the synchronous uncontended reservation path. Add the smallest controller-owned waiting mechanism needed for the saturated path; do not introduce a generic scheduler or semaphore package.

- Capture the validated route limit and reservation requirement once, before waiting. A later settings change must not silently alter the queued request's limit.
- Keep declared-size validation before capacity decisions, preserving the current immediate 413 behavior. Preserve existing media/encoding validation order and response contracts.
- Keep insufficient byte capacity as immediate 503, both on arrival and on a queued entry's admission attempt. Waiting entries reserve no future byte capacity; they must be rechecked atomically when a reader becomes available.
- Stop treating a temporary lack of capacity as a final rejection inside the immediate reservation helper. Record a rejection only if the request is actually rejected, not when it merely joins the queue.
- Use one acquisition path that returns a reservation immediately when possible and a native promise only when waiting is necessary. Keep reservation creation private to this path and the queue drain; avoid competing public admission methods or a callback scheduler.
- Bound the queue at 64 entries. Use one request-owned cancellation signal across queued admission and active receipt, with phase-specific timeout handling. Install cancellation before making an entry eligible to run.
- Validate injected queue limits and wait durations at construction. An invalid/non-finite value must not become an unbounded queue or a silently different timer.
- Remove cancelled/expired entries promptly so they neither consume queue capacity nor block the head.
- When a reader slot is released or a queue entry is cancelled/expires, schedule one bounded queue drain. Use an event-driven wake-up; add no periodic polling. Avoid recursively entering another parser from inside a release callback. No separate wait-for-memory mechanism is needed.
- Each drain grants up to the currently available slots, checks both budgets and deadlines, and removes entries before resolving their native promises. Do not invoke parsers or route callbacks directly from the releasing request's context. A cancellation racing a grant must either prevent the grant or release the granted reservation exactly once.

Update actual callers and focused tests if a helper signature changes. Keep constructor injection limited to policy/clock controls needed by tests; add no production strategy interface or unused compatibility layer.

### 2. Connect waiting to the route-local parser middleware

Keep [body-parsers.ts](../../packages/studio-server-api/src/middleware/body-parsers.ts) as the existing thin route-parser factory. Put lifecycle handling beside the current middleware instead of duplicating it in endpoint, web-app, and settings routes.

- Keep every queue behind that route's existing authentication/preflight. Do not install a global body parser or move payload work ahead of authorization.
- On temporary reader-slot saturation, pause the incoming request and queue its admission. Do not collect chunks or create a gzip/deflate decoder until admission is granted.
- On grant, recheck cancellation and deadlines, attach the existing bounded reader, and resume through that reader's current stream path. Do not resume earlier and lose bytes.
- Preserve JSON primitives, charset handling, supported `application/*+json` media types, forms, gzip/deflate, chunked bodies, and routes with no body. Already-parsed requests keep their bypass.
- Preserve the existing `markBodyReceived` handoff. Do not move a request-body deadline into graph execution.

Attach the queued promise's success/error continuations in the originating request's context before returning from middleware. The controller may resolve it from another request, but parser startup and `next()` must still observe the waiting request's `AsyncLocalStorage` settings snapshot. Do not use `enterWith`, disable the snapshot, or run the queued route directly in a shared drain callback. A local Node 24 probe confirmed that a stored callback invoked by a releasing request sees the releaser's context, while a native promise continuation attached by the waiting request retains its own context. This is also covered by [Node's context-propagation guidance](https://nodejs.org/api/async_context.html#troubleshooting-context-loss).

Before and after the wait, check both the incoming request's aborted/destroyed state and whether the response has already finished/closed. `req.complete` alone is not cancellation: all bytes may have arrived in buffers while the paused body still needs parsing. An already-finished response must remove its queue entry without sending another response or calling the route.

Pausing is backpressure, not a claim of zero memory use. Node retains some stream/socket data; [Node's stream documentation](https://nodejs.org/api/stream.html#readablepause) explicitly describes buffering while paused. Verify queued large/slow uploads with heap, external-memory, RSS, and Linux container-memory measurements. Count and wait bounds remain required even when streams are paused.

In [body-reader.ts](../../packages/studio-server-api/src/middleware/body-reader.ts), return the already-counted decoded byte length after successful finite parsing and buffer cleanup. Pass it through the existing body-received callback; do not traverse, stringify, or clone the parsed input to measure it again. The callback may store an optional verified length, but must not release memory on its own: existing custom parsers may signal receipt before their parsing/validation finishes. Commit the shrink only in the successful parser-settlement path.

- Finalize the retained byte count once. Accept only a nonnegative safe integer no greater than the charged amount; it may release unused bytes, never admit an unreserved increase. Repeating the same successful finalization is harmless; conflicting or invalid reports must not reduce the charge and must settle the affected request through the existing error/cleanup path.
- Keep the original conservative charge through receiving, decompression, and JSON/form parsing. Shrink only after that work succeeds and its temporary chunk buffers are released.
- Shrink compressed/unknown-length reservations to actual decoded bytes, not their smaller compressed wire size. A compressed expansion close to the route limit must still occupy that decoded budget.
- Keep the remaining actual-byte reservation until the existing handler owner releases it. Completion/abort must subtract the remaining amount exactly once, not the original full allowance.
- Release the reader slot after successful settlement as today, waking the queue with the corrected byte accounting already in place. There is no separate memory-wait queue to wake.
- A custom/injected parser that does not report a trustworthy decoded length retains its conservative charge. Preserve that fallback for existing tests and callers rather than guessing zero.

Decoded-byte accounting is still not a hard heap/RSS limit. Parsing creates strings and objects, buffers may await garbage collection, and active workflows retain other data. Match the existing known-length input accounting and verify whole-process memory under repeated bursts; do not describe the 1 GiB counter as proof that total memory cannot exceed 1 GiB.

### 3. Make timeout and cancellation outcomes explicit

Use the current HTTP error policy and response-owned connection cleanup.

| Event                                          | Required result                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Queue full                                     | Immediate 503, `body_capacity_exhausted`, `Retry-After: 1`                      |
| Insufficient byte capacity at arrival or grant | Immediate 503 with the same capacity code; do not wait for handler-held memory  |
| One-second admission wait expires              | 503 with the same existing capacity code and retry guidance                     |
| Existing receive deadline expires first        | Existing 408, `body_receive_timeout`                                            |
| Declared body too large                        | Existing immediate 413, `body_too_large`                                        |
| Client disconnects while waiting               | Remove entry, detach timers/listeners, never run its parser or handler          |
| Parser fails after admission                   | Existing parser error, with reservation cleanup after reader/decoder settlement |
| Capacity becomes available before expiry       | Admit once; the handler runs normally after successful parsing                  |

Start the receive deadline when the request enters body middleware. Admission waiting consumes that deadline; receiving must not start a fresh 120-second allowance after waiting. For test/custom shorter receive deadlines, whichever deadline expires first determines the result. Timers must be removed after their phase ends.

Define the handoff precisely: at or beyond the queue deadline, expiry wins over a new grant. Before that deadline, granting the reservation ends queue waiting and disarms its timer; a late queue-timeout callback cannot cancel active receipt. The overall receive timer remains active. Recheck its remaining time before parser startup. If response completion or cancellation already won, cleanup takes precedence and no handler starts.

Keep Node's independent transport receive timeout and [ordinary-versus-restore receive policy](../../packages/studio-server-api/src/legacy-restore/receive-deadline.ts) unchanged. The queue must not extend server/transport deadlines or become attached to streaming restore uploads that do not use this body parser. Node closing an incomplete request must trigger the same queue cleanup, even when it supplies the terminal response itself.

Reuse `closeResponseConnectionAfterFlush` for terminal pre-body responses. Preserve useful error delivery before closing an unconsumed upload. Do not close the socket directly from a response hook or retry the HTTP request internally.

### 4. Preserve retirement and handler ownership

Review [request-work.ts](../../packages/studio-server-api/src/request-work.ts), [asyncHandler.ts](../../packages/studio-server-api/src/utils/asyncHandler.ts), and [shutdown-deadline.ts](../../packages/studio-server-api/src/shutdown-deadline.ts) at their actual handoffs.

- Queued requests already passed the server's accepted-request barrier. Reuse that ownership until they are rejected/closed or handed to their existing parser/handler lifecycle.
- A disconnected queued request must not later start work and must not keep retirement waiting after cleanup.
- Queued cancellation has no decoder or body-processing task to settle; remove its entry, listeners, and timers synchronously before notifying its promise. Do not add a second accepted-work counter or shutdown registry for waiting requests.
- Keep the server's existing shutdown deadline and published-execution draining behavior. A queued request does not own a published-run permit.
- A long-running graph retains body bytes through its handler as today, while its reader slot is free for subsequent requests.

Only change these adjacent files if tests demonstrate that the queue needs a missing ownership handoff.

### 5. Make overload distinguishable with small metrics changes

Extend the existing snapshot and [metrics](../../packages/studio-server-api/src/metrics.ts), preserving the current metric names and meanings.

- Add waiting-request count and queue limit gauges.
- Add a bounded-label admission-wait duration observation and outcomes sufficient to distinguish admission, wait expiry, cancellation, and a full queue.
- Count `rivet_http_body_admission_rejections_total` only for actual rejections. A recovered transient saturation is not a rejection.
- Keep request IDs, endpoint names, payloads, and user identifiers out of metric labels.
- Continue returning the existing public error code; use internal metrics to distinguish full-queue rejection from admission-wait expiry.

Do not add a new UI, telemetry service, or per-request log stream for this change.

### 6. Add focused regressions and update existing assertions

Use [body-admission.test.ts](../../packages/studio-server-api/src/tests/body-admission.test.ts) as the owning suite. Keep current size, encoding, abort, connection-reuse, and retained-body tests. Update the current immediate-saturation test to exercise an actually full queue or expired wait, while retaining its health-response assertion.

Use held request streams and observed state transitions to synchronize tests. Use existing Node test clock facilities for pure deadline tests where practical. Avoid guessing progress from tiny sleeps, performance assertions in ordinary CI, or a new general-purpose clock framework.

Required coverage:

| Area                            | Essential cases                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast path                       | Available capacity admits immediately; no queue entry; unchanged result                                                                                                                       |
| Queued success                  | Four held readers, fifth waits, release one, fifth completes exactly once                                                                                                                     |
| FIFO and combined budgets       | New arrivals do not bypass eligible waiters; byte capacity is checked again at grant; a large entry that cannot fit is rejected without blocking smaller entries; impossible sizes never wait |
| Full queue                      | Small injected queue cap produces immediate explicit 503; health remains responsive                                                                                                           |
| Deadlines                       | Wait expiry; earlier receive expiry; grant at deadline; delayed timer callback cannot admit an expired entry                                                                                  |
| Cancellation                    | Disconnect or response finish before enqueue, while queued, and racing a grant; no parser/handler invocation after terminal state                                                             |
| Active cleanup                  | Decoder close precedes reservation release; malformed/truncated gzip and body overflow recover all capacity                                                                                   |
| Accurate post-parse reservation | Small compressed/chunked inputs release unused allowance but retain actual decoded bytes; invalid/missing lengths never under-account; repeated shrink/release cannot underflow               |
| Early receipt signal            | A parser that reports receipt and then keeps validating retains its full charge until successful settlement; an eventual error cannot publish a reduced successful reservation                |
| Ownership                       | Active graph does not hold a reader; body bytes remain accounted after response close until handler settlement                                                                                |
| Request context                 | Two waiters retain different real app-settings snapshots and correlation IDs when a third request releases capacity; no callback runs under the releasing request's snapshot                  |
| Retirement                      | Actual accepted-work barrier sees waiting requests; queued disconnect/expiry releases it; shutdown remains bounded                                                                            |
| HTTP behavior                   | Response code/header preserved; rejected connection cannot be reused; no duplicate response or socket reset caused by cleanup                                                                 |
| Route isolation                 | Unauthorized input never queues; existing preflight order, captured route limits, JSON/forms, and no-body behavior remain intact                                                              |
| Metrics                         | Queue gauges return to zero; only terminal rejection increments the rejection counter                                                                                                         |

Extend existing [metrics tests](../../packages/studio-server-api/src/tests/metrics.test.ts) and [shutdown HTTP tests](../../packages/studio-server-api/src/tests/shutdown-http.test.ts) only for their new seams. Reuse the real [settings snapshot](../../packages/studio-server-api/src/app-settings/settings-repository.ts) helpers in the context test. Do not duplicate the body-controller state machine in those suites.

### 7. Validate bursts, memory, and latency separately from unit tests

Repeat the measured intake-only fixture before/after on the same machine and Node version. Keep the client in a separate process for the performance comparison. Reuse production middleware and a harmless handler; do not generate real provider calls or mutate production projects.

Required local acceptance:

1. The previously failing 32-request small-gzip and 100 ms split-body bursts complete with zero body-capacity rejection when the queue and deadlines can accommodate them. Also hold all 32 harmless handlers behind a test barrier until every input is admitted: success must not depend on earlier workflows ending quickly and releasing their full-size reservations. Release the barrier promptly after observing admission; do not sleep for a simulated long workflow.
2. The 32/64-request complete uncompressed cases retain success and the uncontended synchronous admission path. Measure paired warm latency and CPU; investigate an added p95 above 1 ms rather than hiding it in aggregate averages.
3. Exercise overload beyond four active readers plus 64 queued requests. Excess work gets prompt 503, queue bounds hold, health remains responsive, and all state returns to zero.
4. Hold queued requests while clients attempt large uploads. Compare queues of 8, 32, and 64 entries at the same active-reader load. Measure application heap/external bytes and container memory, prove no queued decompression/body accumulation, and verify memory plateaus at fixed queue size. Include repeated fill/cancel/refill cycles. If not, correct backpressure or reduce the proposed queue limit before release. Do not use forced garbage collection to make the acceptance result pass.
5. Exercise full retained-byte capacity, slow senders, client disconnects, invalid compressed input, and repeated saturation/recovery. No leaked entries, timers, listeners, readers, or byte reservations are acceptable.
6. Run the same focused workload in a local Linux container with production-like CPU/RAM constraints. Windows results alone do not qualify Linux memory or scheduling behavior.
7. Separately exercise the real published route with execution admission enabled. Distinguish the intended 32-run gate's responses from body-capacity responses. The intake-only 64-request fixture does not promise 64 accepted workflows on a 32-run replica.
8. Repeat representative queued gzip and split-upload cases through the shipped nginx proxy, using its actual buffering settings. Cover HTTP keep-alive/pipelining, supported `Expect: 100-continue` behavior, client upload continuation after rejection, and disconnects. Do not alter proxy buffering or invent a proxy that manufactures nicer error responses for the test.

For the small-request latency gate, retain at least three paired baseline/change blocks on the same runtime and resource profile after warmup. Define the sample count and accepted noise before looking at the results. Keep per-block results and p95 values; an unexplained persistent regression above the 1 ms investigation threshold blocks acceptance. Keep overloaded requests out of the uncontended-latency comparison and report their wait/rejection latencies separately.

Keep larger latency/memory experiments outside ordinary CI; retain a small deterministic gzip/queued-admission regression in CI. Store fixture parameters, source revision, Node version, raw counts and latency samples with the local results.

### 8. Documentation, checks, and delivery

Update [access and routing](access-and-routing.md) and [development guidance](development.md) with implemented limits, the queue's ownership/deadline rules, and the distinction from published-run concurrency. Update the relevant CI note only if this work exposes a repeatable pitfall with a concrete prevention check.

From the repository root, the focused implementation check starts with:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/body-admission.test.ts src/tests/metrics.test.ts src/tests/shutdown-http.test.ts src/tests/shutdown-deadline.test.ts src/tests/api-profile.test.ts src/tests/published-execution-admission.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api build
node scripts/checks/check-doc-links.mjs
git diff --check
```

Use the checkout's provisioned Node/Yarn entry points. Run the normal API test manifest after focused checks pass, along with the changed-package type/lint checks required by the existing CI. Keep the existing test-manifest registration if tests remain in their current files.

Because the shared intake serves browser-facing API routes too, run the required routine headless check after implementation:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe
```

No Kubernetes rehearsal is needed merely to change this in-process queue. A later ordinary release can validate the same HTTP scenarios in staging before promotion. There is no database migration or environment activation switch. Rolling replicas may temporarily have old immediate-rejection behavior; clients must continue to handle the existing 503 contract during that transition.

This plan authorizes no deployment, cloud load test, concurrency-setting change, or commit/push by itself.

## Completion criteria

- [x] The prior small compressed and split-upload failures are reproduced before the change and pass within the supported waiting policy afterward.
- [x] Four active readers, current decoded-byte limits, and handler byte ownership remain enforced.
- [x] Queue count, waiting duration, buffered-memory behavior, and all cleanup paths are validated.
- [x] Uncontended requests keep immediate admission and meet the latency gate.
- [x] Existing authentication, payload, error, health, retirement, and published-run contracts remain intact.
- [x] Metrics distinguish absorbed bursts from actual overload without leaking payload information.
- [x] The full relevant test sweep is reviewed, failures are resolved and rechecked, and final affected tests, Linux validation, headless UI smoke, and documentation checks pass.
- [x] Delivery notes clearly separate this HTTP intake change from Storyteller callback isolation.

## Local implementation and validation — November 20, 2026

The controller owns waiting, grants, cancellation, and admission metrics. The existing middleware owns the receive deadline and response lifecycle. The existing body reader reports its decoded count after successful finite parsing and buffer cleanup. No endpoint-specific queue, settings field, background service, or new shutdown registry was added. Native promise continuations preserve each waiting request's asynchronous context.

Validation compares the working tree with baseline `df80ab02b`; it does not claim production capacity or promise admission under sustained overload. Disposable local fixtures and raw results are in `.data/http-body-proof/` (Git-ignored). No production data or provider calls were used.

### Functional checks

- The final affected API run passed **155 tests**, including body admission, metrics, real settings snapshots, API profile/authentication boundaries, published admission, shutdown, and the complete filesystem workflow/web-app execution suites. A dedicated grant/response-finish race also verifies that already-granted bytes are released without parsing or invoking a handler.
- Thirty-two small gzip bodies and thirty-two split uploads entered held handlers before any handler completed. This verifies that success does not rely on earlier workflows releasing their conservative reservations. All counters returned to zero after completion and cancellation.
- The real published HTTP route, using an isolated filesystem project and an enforced 32-run gate, returned 32 expected `429 execution_capacity_exceeded` responses while its permits were held, then 32 successful gzip responses after release. No body-capacity rejection occurred. This does not change execution concurrency.
- A disposable local Linux API/proxy pair used the shipped `vm-edge-proxy.conf` unchanged. Gzip, split uploads, `Expect: 100-continue`, keep-alive and pipelined requests passed, as did a large upload rejected after preflight. Four active uploads plus 64 waiters held the cap; the next two requests received `503` and `Retry-After: 1`. Disconnecting them cleared every reader, queue entry, and reservation.
- API compilation and scoped TypeScript-aware lint passed. Headless `studio-server:ui:observe hosted-dashboard-contracts.spec.ts --grep 'hosted dialogs render'` passed against the authenticated local server. This is a browser regression smoke, not a cloud qualification.

### Latency and memory

The Linux comparison used Node **24.22.1**, **2 CPU / 4 GiB**, separate client/server processes, warm-up, and three alternating baseline/change blocks. An initial 500/150/30-sample run had inconsistent large-input p95, including one 3.23 ms increase, so the final check increased sample counts rather than discarding that result. Each final block sent 1,000 small, 300 roughly 64 KiB, and 200 roughly 1 MiB requests. The initial run is retained in `results-linux-first-final.json`; final individual samples and server CPU measurements are in `results-linux.json`.

| Uncontended small-input p95 | Baseline |  Changed |
| --------------------------- | -------: | -------: |
| Block 1                     | 0.485 ms | 0.418 ms |
| Block 2                     | 0.275 ms | 0.232 ms |
| Block 3                     | 0.274 ms | 0.249 ms |

The final small-input p95 stayed below baseline in all three blocks; earlier small-input comparisons also stayed within the 1 ms investigation threshold. For roughly 64 KiB inputs the final maximum increase was 0.052 ms. The final 1 MiB p95 was lower in all three blocks (3.833/3.744/3.238 ms versus 3.948/3.814/3.724 ms), as was server CPU for that size. CPU for other sizes varied without a consistent increase. These local measurements do not establish production latency or throughput.

The same constrained container tested queues of 8, 32, and 64 requests over three fill/cancel cycles each. Four active clients withheld their upload; queued clients attempted full 2 MiB uploads. At 64 waiters the final largest observed added process RSS was **7.8 MiB**, external memory **8.24 MiB**, and container memory **9.1 MiB**. Memory plateaued while the queue was held; no forced garbage collection was used. Every cycle ended with zero active readers, zero waiters, and zero reserved bytes. Pausing therefore limits user-space buffering in this fixture; it does not mean waiting sockets are free or turn decoded-byte accounting into a hard heap limit.

The full API sweep ran **1,950 tests**: 1,942 passed, six skipped, and two failed. One failure exposed a real connection-close race after web-app preflight. The new early rejection path could close a large in-flight upload before its client received the `413`. The parser now waits for the existing discard to complete or reach its 250 ms deadline, then forwards the error in the original async context. No successful request waits on this path. The new regression reproduced the reset before the repair; all 155 affected tests and the proxy regression pass afterward.

The other failure was the Windows process-tree termination test running without permission to stop its owned descendant; its six-test file passed with normal process permissions. That existing environment constraint did not require an application change. Compilation, scoped lint, file/import checks, both test-style guards, documentation links, and headless browser smoke passed. No cloud test or deployment was performed.

### Follow-up code review

The review reproduced and repaired two further gaps: a declared oversized body incremented the rejection counter in both the controller and middleware, and unsupported media types bypassed the bounded-discard path. All body-parser errors now share one forwarding helper, including errors detected before admission. Size-rejection metrics have one owner at middleware settlement. The existing regressions now assert one count for each declared/chunked/compressed rejection and exercise large in-flight uploads with invalid size, encoding, and media type. The successful-request path, queue limits, and execution admission are unchanged.

The follow-up validation passed 168 API tests, compilation, scoped lint, and headless browser smoke. The Linux proxy fixture now explicitly matches the shipped 100 MiB default and verifies API JSON error codes; its prior implicit nginx 1 MiB limit could intercept the size-error probe before the API. Gzip/split bursts, `100-continue`, pipelining, all three large-upload rejection cases, queue overflow, and disconnect cleanup passed through that corrected fixture.

### Adjacent rejection-path review

Large requests to missing published/latest web apps reproduced the same connection reset outside the parser. Authentication and preflight denials now share `sendRejectedBodyResponse`, which waits for the existing bounded discard, preserves request context, and sends only while the response is open. The final API error formatter and filesystem HTTP test harness use the same transport path. Existing status codes, error bodies, authorization order, and successful execution remain unchanged. Noop preparation calls on HTML-only branches were removed. The response helper also catches a failed writer, reports it on the server, and closes that connection without an unhandled rejection.

The adjacent review passed 177 affected API tests, including real published/latest endpoint and web-app denials with large malformed input, and focused context/disconnect/failed-writer regressions. The Linux proxy check also verifies large authentication and not-found replies in addition to body rejections and burst recovery. Compilation, scoped lint, headless UI smoke, and documentation checks passed. Successful requests still take the same admission/execution path; no rejection callback or additional wait is added to them.

### Holistic performance assessment

The change improves burst reliability within the measured workload. It does not promise that every request is faster: reader saturation can add up to one second of admission waiting, rejected uploads can spend up to 250 ms in bounded discard, and queued connections retain memory. The four-reader limit, one-GiB decoded-byte budget, and separate published-execution limit remain enforced. Decoded-byte accounting is not a limit on the entire graph's heap usage.

This review also reproduced a deadline-order bug: when both timers were delayed, a later receive deadline could override an earlier admission expiry. Both grant-time checks and receive-timer cancellation now preserve whichever deadline expired first. The regression covers each order, the exact boundary, and a delayed receive signal.

Fresh intake-only Linux measurements against `df80ab02b` are in `.data/http-body-proof/results-holistic-linux.json`. In three paired blocks, the largest added p95 was 0.032 ms for small inputs, 0.124 ms for roughly 64 KiB, and 0.232 ms for roughly 1 MiB. Gzip and split-body bursts admitted all 32 requests, versus four successes and 28 body-capacity rejections before the change. In repeated 64-waiter fill/cancel cycles, added process RSS peaked around 8 MiB and container memory around 10 MiB; every cycle released all readers and reservations.

The real published HTTP endpoint was measured separately using a verified input/output echo graph, enforced 32-run admission, warmed filesystem storage, and separate client/server processes. Baseline source files and changed source files ran against the same dependencies. Recording persistence was disabled to isolate this change; no external services were called. The Linux container had 2 CPU / 4 GiB and Node 24.22.1. Each of three final alternating blocks made 1,000 requests of each size after warm-up:

| Endpoint request | Baseline p95, ms | Changed p95, ms |
| ---------------- | ---------------- | --------------- |
| Small, block 1   | 1.043            | 1.147           |
| Small, block 2   | 1.154            | 1.260           |
| Small, block 3   | 1.223            | 1.058           |
| 64 KiB, block 1  | 1.326            | 1.544           |
| 64 KiB, block 2  | 1.995            | 1.610           |
| 64 KiB, block 3  | 1.365            | 1.273           |

The maximum added endpoint p95 was 0.106 ms for small requests and 0.218 ms for 64 KiB, within the small-request 1 ms investigation threshold. Aggregate endpoint CPU was close for small requests and lower for 64 KiB in that run; this is evidence against a material steady-state regression, not proof of production capacity. Shorter Windows and Linux samples were noisy, particularly for larger replies, so they were retained and followed by the larger warmed sample rather than presented as conclusive. Raw samples are in `endpoint-perf-linux.json`, with earlier Linux and Windows results retained alongside it.

Production still requires the ordinary staging workload check with real graphs, recording persistence, managed storage, and external services. Accepting requests that previously failed naturally creates more real work; this change does not establish that 32 arbitrary graphs fit a replica's CPU or RAM.

After the deadline repair, all 183 affected API tests passed. API compilation, scoped TypeScript-aware lint, documentation formatting/links, test-style and file/import checks also passed. The rebuilt Linux proxy fixture passed 32-request gzip, split-body and `100-continue` bursts, pipelining, large-upload rejection responses, full-queue overload, and disconnect cleanup. The required headless dashboard browser smoke passed. These local checks did not modify or qualify staging or production.

### Test suite review

The owning suite now shares the existing HTTP-server fixture and uses one bounded HTTP client helper that handles response errors and closes deliberately unfinished uploads. Duplicate media-type, encoding and receipt checks were merged into stronger cases. The shared-discard test uses a controlled clock instead of a 350 ms sleep; the real delayed-response socket case remains because it verifies transport behavior. Shutdown observes actual queue admission and then advances the expiry clock, avoiding a busy poll against a short real deadline. Burst and settings-context cases use a longer test-only wait limit; a separate deterministic test verifies the production defaults at 64 waiters and the 999/1000 ms boundary.

The 41-test admission/shutdown group passed three consecutive runs (about 2.1 seconds per run locally). Temporary source copies with three deliberately broken behaviors all caused their corresponding assertions to fail: not cancelling the receive deadline on receipt, duplicating in-flight discard cleanup, and letting a later receive deadline override an earlier queue expiry. These negative checks are local evidence under `.data/http-body-proof/`, not a new CI framework. Production code was unchanged during this test review.

The final related API sweep passed all 184 tests. API compilation, scoped lint, both test-style checks, documentation formatting/links, and file/import checks also passed.
