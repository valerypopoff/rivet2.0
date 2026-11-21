# HTTP Call response cleanup

Status: implemented and locally validated, November 20, 2026. Baseline: `5e105dd05` on `develop`.
No deployment or production test is part of this change.

## Objective

Release HTTP response bodies that the HTTP Call node will not return to its caller. Preserve ordinary outputs, error metadata, retry decisions, cancellation, and successful-run latency across the server, desktop/CLI Node executor, and browser executor.

This is a Core node repair. It requires no server feature flag, database change, new service, global HTTP dispatcher, or change to the live execution-concurrency setting.

## Confirmed behavior and assumptions

- [HttpCallNode.ts](../../packages/core/src/model/nodes/HttpCallNode.ts) replaces a non-200 response during retry without consuming or cancelling its body. It also throws for a final non-2XX response before reading its body. The catch setting can turn that exception into error outputs, but does not release the body.
- The local loopback reproduction returned `503`, `503`, then `200`. The node returned `ok` while the two deliberately unfinished error responses were still open. This proves missing cleanup for that case; it does not prove every completed error response leaks a socket or explain the earlier production incident.
- A status and its headers are available before the body finishes. Existing retry history and failure-output metadata do not require those discarded bodies.
- The retry condition is intentionally **status is not exactly 200**. Final error handling separately uses **not 2XX**. Existing tests cover retrying 201 and returning the final non-200 body when fail-on-non-2XX is disabled. Keep both rules unchanged.
- An HTTP failure response is not always disposable: with fail-on-non-2XX disabled, the last response is ordinary node output. Keep it readable and return its text, JSON or binary output normally.
- `body.cancel()` can throw, reject, or stay pending. A local `ReadableStream` probe confirmed that discard can start while its returned promise remains pending. Never turn cleanup into another unbounded wait or replace the node's original result with a cleanup error.
- A local Node 24 probe showed that completed `text()`/`blob()` reads leave the stream used and locked. A used body alone does not prove a partial read has finished; relinquish ownership only after the awaited read succeeds.
- A second native Fetch probe confirmed that aborting a body read and receiving a truncated response both left a locked stream but closed the server-side response. Do not try to acquire another reader in those cases. Repeat those real-transport checks in the regression suite; a locked stream alone is not evidence that cleanup succeeded.
- Undecorated native Fetch returns a fresh response body. A custom Fetch implementation can return a pre-locked or cloned/teed body. The node cannot steal another reader or close another owner's clone. Cancellation must be attempted on the available body it owns; it does not guarantee release of an independently retained branch.
- No-body responses require two separate checks. Cleanup must tolerate `body === null`, but the existing output parser can still reject an empty response declared as JSON. A local HEAD probe returned empty text without JSON headers and the existing `SyntaxError` with JSON headers. Preserve both outcomes; do not silently convert empty JSON to `{}` or `null`.
- Cancelling a reply does not undo the remote request. Preserve the configured retries, including for POST, without adding retries or treating cancellation as proof that a remote mutation did not happen.

The [Undici guidance](https://github.com/nodejs/undici#garbage-collection) requires consuming or cancelling unused bodies. The [Streams Standard](https://streams.spec.whatwg.org/#rs-cancel) describes cancellation, its asynchronous completion, and locked-stream rejection. Core's classifier provider already uses guarded, nonblocking cancellation; use that idiom without expanding this repair into a provider refactor.

## Scope and invariants

| Preserve         | Required behavior                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Request          | Same URL, method, request body, headers, credentials/default Fetch options and context signal               |
| Retry            | Same count normalization, status test, cooldown, request order and network-error behavior                   |
| Outputs          | Same port IDs, scalar/array shapes, header order and attempt order, text, JSON and binary values            |
| Errors           | Same primary error, cause, caught-failure outputs and terminal failure metadata                             |
| Cancellation     | Workflow abort still stops Fetch/cooldown; discarding one reply does not abort the workflow or another call |
| Successful calls | No added request, full-body copy, drain, timer, or awaited cleanup operation                                |
| Persistence      | Same recording schema and existing playback; no migration or backfill                                       |

Do not change HTTP timeout policy, response-size limits, retry-on-201 behavior, error exposure, connection pooling, recording serialization, or execution isolation in this patch.

## Implementation sequence

### 1. Add failing lifecycle coverage first

Use the existing four HTTP Call suites under `packages/core/test/model/nodes/` for output and retry contracts. Add one focused `HttpCallNode.lifecycle.test.ts` for stream ownership and the native HTTP fixture, keeping that fixture in one place. Reuse `HttpCallNode.testUtils.ts`; do not duplicate a node implementation or assert source text. Verify that ordinary Core test discovery and CI shards include the new file.

First reproduce an unused body on retry and on fail-on-status with real `Response`/`ReadableStream` objects. Assert the underlying source's cancellation callback, not only whether an optional method exists. Include a held-open real HTTP response so this cannot pass solely because a mock behaves differently from Fetch.

### 2. Add one local response owner

Inside `HttpCallNodeImpl.process`, keep one optional reference to the currently owned response.

- Record ownership immediately after `fetch()` resolves, before retry-history collection or other callbacks can throw.
- Keep the normal response variable used by current output-building code; avoid restructuring the retry/output pipeline.
- Provide one small release operation that takes the owned response and clears ownership **before** asking its body to cancel. Retry cleanup and terminal cleanup then share one ownership rule; no collection of responses or separate cleanup queue is needed.
- Keep the helper private to this node. No reusable lifecycle framework, new exported Core API, or provider-file move is needed.
- Use only the existing Fetch/Web Streams interfaces. Do not add Node-specific stream imports, a per-attempt abort-controller hierarchy, or a new cancellation timer.

### 3. Release only when the body will be discarded

- When the existing retry loop chooses another attempt, release the current response **before the cooldown**. Do not retain the reply for the whole cooldown. The next attempt becomes the new owner.
- After a final `text()` read succeeds, relinquish ownership: the network body has been consumed. JSON parsing follows as it does today.
- After a final `blob()` read succeeds, relinquish ownership before the subsequent Blob-to-array conversion. That conversion no longer owns an HTTP body.
- Use a single terminal `finally` cleanup for any still-owned response. This covers fail-on-status, caught errors, abort during cooldown/read, metadata/failure-output callbacks that throw, and other early exits.
- An allowed final non-2XX response follows the normal body-reading path. It is not cancelled merely because its status is an error.

### 4. Keep cleanup nonblocking and subordinate to the original result

The release operation should:

1. Return immediately when no response/body remains.
2. Guard a locked stream without acquiring or releasing somebody else's reader. Do not skip an otherwise cancellable body merely because `bodyUsed` is true.
3. Request `body.cancel()` synchronously for an available body.
4. Attach a rejection handler immediately; catch synchronous cleanup errors too.
5. Never await a potentially stalled cancellation promise, start a drain/read-to-EOF, add a cleanup retry, or replace the original node outcome.

Successful reads clear ownership, so the finalizer is a synchronous no-op on the ordinary success path. Do not pass workflow payloads or original exceptions as cancellation reasons. Keep cleanup diagnostics out of this patch: abort-related cleanup rejection must not generate a log flood during overload.

Cancellation initiation precedes the next attempt. The remote socket's actual close event can arrive later; do not promise synchronous remote closure or assert that ordering in tests. A synchronous throw, rejected cancellation or foreign locked stream remains best-effort cleanup; it must not be reported as confirmed resource release.

## Validation matrix

| Scenario                             | Assertions                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 503 → 503 → 200                      | Both unused bodies receive one discard request; final body stays readable; exactly three HTTP attempts and unchanged history               |
| Non-200 with a cooldown              | Discard starts before the cooldown; abort during cooldown makes no subsequent HTTP attempt                                                 |
| Exhausted retry with fail-on-status  | Earlier and final unused bodies released; status/header history and primary error unchanged                                                |
| Caught final HTTP failure            | Cleanup also happens when the error becomes normal caught-failure outputs                                                                  |
| Final non-2XX is allowed             | Earlier attempts discarded; final body returned unchanged, including binary output                                                         |
| 201/204 and HEAD/no-body responses   | Existing retry/status rules preserved; cleanup handles null; empty JSON retains its existing parse failure                                 |
| Successful text, JSON and binary     | Exact existing outputs; final body consumed, not cancelled early; workflow signal remains untouched                                        |
| Network rejection before headers     | No response cleanup is attempted; same network error and retry behavior                                                                    |
| Failure after headers                | Ownership is captured before attempt-history enumeration or failure callbacks can throw; errors and already-consumed bodies stay unchanged |
| Cleanup throws/rejects/stays pending | No unhandled rejection, added HTTP attempt or hang; success/error result still settles                                                     |
| Pre-locked custom response           | No attempt to acquire or steal its reader; original result/error preserved                                                                 |
| Two concurrent nodes                 | Discard in one invocation cannot cancel the other invocation or a shared workflow signal                                                   |

Keep the matrix compact: extend existing output tests where possible, and use a small case table for empty/error cleanup shapes rather than cloning every setting combination. Supply a fresh Response for each attempt. Restore global Fetch after each test and keep tests that replace it serial within their file. Use controlled clocks/events for cooldown and pending-cleanup tests; do not rely on short real sleeps.

### Real transport proof

Run against a disposable loopback Node HTTP server, without external endpoints or production data:

- Send 503 headers and a partial body; deliberately do not finish it. Retry to a successful 200. Assert the discarded server responses close after the node initiates cleanup, while the final output is still correct.
- Exercise a final held-open non-2XX with fail-on-status enabled, both caught and thrown.
- Exercise a body-read abort and a truncated body. Prove server-side release, rather than assuming a locked stream can be cancelled directly.
- Track unfinished responses separately from harmless idle keep-alive connections. Do not require all successful connections to close.
- Await observable close/abort events with bounded test deadlines. Assert before fixture teardown, without forced garbage collection or a test-only abort that would close the very response being checked. Only then close remaining owned servers/sockets in `finally` so a failing assertion cannot hang CI.
- Demonstrate that the regression fails on the baseline and passes after the repair.

## Performance and integration checks

Preserve the absence of additional asynchronous work on successful calls. Benchmark a warmed baseline and candidate with the same pinned Node version, workload and local server. Use text/JSON/binary responses, small and larger payloads, alternating repeated blocks, and a 32-call concurrent case. Keep raw timing/error/resource samples. Apply the existing small-run 1 ms added-p95 guard and investigate any consistent larger-payload regression separately; a noisy single sample is not proof of improvement or regression.

Verify which source/build each test process imports. A package import can use an older compiled Core build even after editing `src`. Run the source regressions against the edited source, and build/identify both package variants explicitly for packaged checks. Keep baseline and candidate in separate fresh processes and finish their owned HTTP fixtures between runs; otherwise abandoned baseline replies and its global connection pool can contaminate the candidate. Do not switch source or artifacts underneath a running benchmark.

For retries, verify exact request counts and prompt release under a burst of failures. Do not judge the repair only by latency: fewer retained unfinished replies is the main acceptance condition. Cancelling an incomplete HTTP/1 response can sacrifice reuse of that connection, so avoid assertions that require a particular socket count or claim all error-path traffic becomes faster.

Ordered local verification, using the repository's pinned Node/Yarn:

```powershell
yarn workspace @valerypopoff/rivet2-core exec tsx --test test/model/nodes/HttpCallNode.editors.test.ts test/model/nodes/HttpCallNode.responses.test.ts test/model/nodes/HttpCallNode.retry.test.ts test/model/nodes/HttpCallNode.failureOutputs.test.ts test/model/nodes/HttpCallNode.lifecycle.test.ts
yarn workspace @valerypopoff/rivet2-core build
yarn workspace @valerypopoff/rivet2-node check:web-app-client
```

If the maintained client artifact check reports drift caused by the Core change, regenerate with `yarn workspace @valerypopoff/rivet2-node build:web-app-client`, review that generated diff, and rerun its check. Do not hand-edit generated output.

Run the full Core suite before delivery, plus existing API workflow and web-app execution suites. Core ships to multiple consumers: build the Node and app workspaces, and run the API typecheck/build for consumer compatibility. Run root `yarn test:style` before final lint/typechecks because it rebuilds shared assets. Check file/import boundaries and use the relevant CI notes during commit preparation.

Run the existing browser regression against freshly built editor assets:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
# Set PLAYWRIGHT_BASE_URL to the running local server when needed.
yarn studio-server:ui:observe http-call-failure-headers.spec.ts
```

Keep the assertions for all retry headers and the terminal error in both compact and full output views. Extend this existing browser fixture with one narrowly matched Fetch/ReadableStream probe that observes discarded-body cancellation in the actual browser realm. Preserve normal Fetch for other URLs; do not add another browser harness or duplicate the full Node transport matrix. No Kubernetes rehearsal is needed for this Core-only change.

## Documentation and delivery

- Update `developer-docs/CORE-ENGINE.md` with the HTTP node's ownership and cleanup rule.
- Update the HTTP Call user guide only with observable behavior: same retry/output policy, discarded replies released. Do not add transport implementation details to node controls.
- Link this repair from the existing HTTP callback-capacity plan without presenting it as a substitute for the receiving application's capacity fix.
- Record completed checks and measured limits here. Only update the Git-ignored CI notes for a new repeatable failure with an actionable prevention check.
- Inspect generated artifacts, final diff and staged files before a separately requested commit. No version bump, push or deployment is part of this implementation.

## Completion criteria

- [x] The two original leak paths fail regression tests on the baseline and pass with the fix.
- [x] Every available discarded body receives one explicit cancellation request; native transport tests prove resource release, while foreign-reader/cleanup failures are handled without claiming success.
- [x] Success and allowed-error bodies remain readable, and empty-JSON behavior is unchanged.
- [x] Cleanup failure or delay cannot mask the original result, add retries or prolong a run.
- [x] Retry/cooldown/status semantics, error metadata and all output formats remain compatible.
- [x] Independent calls and workflow cancellation remain isolated.
- [x] Real transport assertions prove release before test teardown, without relying on GC.
- [x] Successful-path performance and cross-consumer/browser checks pass.
- [x] Developer/user documentation and the implementation record reflect what was actually verified.

## Planning validation

Current code, existing tests, the prior loopback reproduction and fresh Node 24 stream-lifecycle probes were reviewed. They confirmed null-body handling, used/locked states after successful and failed reads, a pending cancellation promise, native connection closure after read abort/truncation, and the existing HEAD/empty-JSON error. Reassessment tightened the distinction between initiating cleanup and proving release, added source/build and connection-pool isolation to validation, and made the browser cancellation check concrete. These probes established the policy; the completed implementation checks follow.

## Implementation and local results

`HttpCallNodeImpl.process` now owns one response, cancels discarded bodies before
retry cooldown and in its finalizer, and clears ownership after a successful body
read. Cleanup neither awaits cancellation nor acquires another reader. No new
request, storage operation, timeout, dependency or public setting was introduced.

- The retry and caught/uncaught final-error regressions fail against the baseline.
  The native loopback test also fails its closure deadline on the baseline for
  retries and both terminal-error modes; those same assertions pass with the fix.
- During initial implementation, all 2,229 Core tests passed. Two temporary CJS-build fixtures initially hit the
  Windows sandbox's directory-read restriction; both passed unchanged when rerun
  outside that restriction. The lifecycle suite includes null and partially used
  bodies, foreign readers, throwing/rejected/pending cancellation, failed metadata
  callbacks, body-read abort/truncation, and shared-signal isolation.
- All 49 endpoint/web-app execution integration tests passed. Core ESM/CJS, Node,
  API and desktop builds passed; the hosted editor was freshly built too. The
  generated web-app client freshness check and root `test:style` passed.
- Headless Playwright passed against that fresh editor build. The same browser
  test verifies exactly three body cancellations and all retry headers in compact
  and full output. Its previously ambient API bootstrap dependency was replaced
  with the existing `mockHostedEditorBootstrap` fixture; no live API is needed.
- An independent loopback burst of 32 calls, each receiving three unfinished 503
  responses, left **96 unfinished replies** on the baseline and **zero** after the
  fix. All 96 candidate replies closed before teardown. No forced GC or abort of
  the workflow was used to obtain this result.

Successful-call timings used Node 24.22.3 and separate baseline/candidate processes
with source hashes, alternating order and retained raw samples. Three paired
blocks covered text, JSON and binary, 64-byte and 256-KiB payloads, serial calls and
32 concurrent calls. Short blocks exposed isolated timing spikes, so the affected
cases were repeated independently. The 32-way small-binary check additionally
used 2,048 warm-up calls and 4,096 measured calls per process; its three candidate
p95 differences were -0.24, -2.94 and -0.29 ms. The other stabilized small-case
comparisons stayed below +0.44 ms, inside the agreed +1 ms budget. Larger-payload
rechecks showed no consistent regression. These are local HTTP-node measurements,
not a production throughput or latency guarantee.

Local receipts and scripts are in the ignored `.data/http-response-cleanup/`
directory. The runtime limitation remains explicit: a foreign locked stream or
failed custom cancellation is best effort, not proof of remote resource release.
No cloud test or deployment was performed.

### Focused test review

The final focused suite contains 60 tests, with duplicated caught-retry coverage
removed and the separate retired-output-name test replaced by a complete output
contract assertion. The test labelled non-2XX now actually returns 503 rather
than 201. Binary output checks include zero and non-UTF-8 bytes, and body-read
failure uses a real errored stream instead of a partial Response-shaped object.
Browser CORS failures share a small case table with full failure-output checks.

The stream fixture now counts calls to `cancel()` itself, because repeating
`cancel()` on an already-closed stream does not call its underlying cancellation
callback again. This catches duplicate cleanup reliably and removes the separate
counter in the pending-cancellation/network-failure test. Real transport checks
assert closure rather than depending on Node's internal post-read lock state.
Their abort case enables caught errors, and failed fixtures settle their runs
only after the release assertions, preventing leaked work or late rejections.
The fixture stops accepting connections before closing existing sockets. A
controlled-clock test covers both abort propagation and discard before cooldown,
replacing the older overlapping timing-based check. A pending-cancellation test
also verifies that a later network failure neither waits for nor repeats cleanup.
The browser check reads cancellation evidence from the node's own frame rather
than evaluating every unrelated frame.

All 60 tests passed locally in about four seconds; headless Playwright passed
against the existing fresh editor build. Six temporary runtime mutations were
each caught: missing retry cleanup, missing final cleanup, duplicate cleanup,
blocking cancellation, swallowed abort, and incorrectly rejecting an allowed 503. Mutation sources and receipts stay in the ignored local evidence directory;
application code and its measured performance remain unchanged by this review.
