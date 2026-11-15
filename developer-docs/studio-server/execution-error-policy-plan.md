# Consistent execution errors and diagnostics

Status: reassessed against source `4da42d4d6` on 2026-11-14. Plan only; no runtime
implementation or deployment is included. Deferred by the owner on 2026-11-14;
do not treat this work as a prerequisite for the hosted execution isolation plan.

## Confirmed problem and corrections to the earlier finding

The problem is inconsistent treatment of failures at public transport boundaries.
It is not that every error message must be hidden, or that every execution path
currently leaks details.

| Path                                                                          | Current behavior                                                                                                                                     | Consequence                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| General API, `app.ts:getApiErrorResponse`                                     | Hides unexposed 5xx messages, but accepts arbitrary `status`/`code` properties.                                                                      | A useful starting policy, not a complete safe classifier: an internal driver code can become a public API code.              |
| Published/latest workflow HTTP, `execution.ts:sendWorkflowErrorWithDuration`  | Returns an Error's raw name/message, or stringifies another thrown value. Only `PublishedExecutionAdmissionError` retains its code and retry header. | Internal setup, storage or provider details can reach allowed endpoint callers; known structured errors can lose their code. |
| Web-app HTML/JSON preparation                                                 | Uses the workflow error helper for caught exceptions.                                                                                                | Shares that exposure problem. Normal HTML auth/404 pages are separate, already deliberate responses.                         |
| Web-app HTTP action, `sendWebAppActionErrorWithDuration`                      | Hides ordinary unexpected errors, preserves known action/admission errors, but ignores other `HttpError` status/code/exposure metadata.              | Some safe, explicit 503 errors become generic 500s. This path is already safer than workflow HTTP.                           |
| Accepted web-app socket failure, `webAppSocketGateway.ts:createRunErrorEvent` | Puts the raw error message into `action.failed`; preserves only selected class-based codes.                                                          | A public socket can expose a message hidden by the HTTP action route.                                                        |
| Socket setup rejection                                                        | Converts unexpected setup errors to `action_unavailable`.                                                                                            | Already has a safe fallback; preserve it.                                                                                    |
| Socket live delivery, persisted replay and remote subscriptions               | Multiple modules send events; replay resends stored frames.                                                                                          | Fixing only the initial error formatter would leave other delivery paths, including historical frames, exposed.              |
| Authenticated editor/executor and debugger                                    | Carries detailed graph/node errors and source locations.                                                                                             | This is developer functionality. Do not blanket-redact the internal execution protocol or node error outputs.                |

Request correlation already exists: `request-correlation.ts` installs
`x-rivet-correlation-id`, and CORS exposes it. General API errors log it; workflow
failures after response delivery also log it. Ordinary workflow failure logs and
generic socket error callbacks lack equivalent structured context. Socket action
frames already have `requestId`/`runId`; preserve those rather than inventing a
replacement identifier.

A local diagnostic executed the current formatter declarations with synthetic
errors. An unclassified `PRIVATE_DATABASE_SENTINEL` was hidden by the general API
and web-app HTTP action but returned by workflow HTTP and socket terminal errors.
An explicitly exposed `HttpError(503, ..., code=service_unavailable)` retained its
status/code through the general API, lost its code through workflows, and became
500 through web-app HTTP actions. A synthetic PostgreSQL code `28P01` was exposed
by the general API. These are local formatter observations, not evidence that a
specific production secret has leaked. Full-route and reconnect tests remain
implementation acceptance work.

## Desired contract

- Unknown server/infrastructure failures return a fixed safe message and a
  stable application-owned code: `internal_error` with `Internal server error`.
  A confirmed graph-run failure can use `workflow_execution_failed` with
  `Workflow execution failed.` while preserving its private diagnostic. Never return a raw exception message, stack,
  cause, connection string or driver code by default.
- Explicitly public validation, authorization, publication-version, capacity and
  draining errors retain their approved message, HTTP status, code and headers.
  Audit the existing producers before changing classification.
- Graph execution failures remain useful in authenticated editor/debugger and
  recording views. Public execution failures use a stable safe description;
  graph authors can continue returning deliberate business errors as normal
  workflow outputs. Successful payloads and node error-output handling are outside
  this formatter and must remain unchanged.
- Preserve current wire shapes: workflow HTTP uses nested `error.name/message`,
  general API and web-app HTTP use a string `error`, and socket messages use their
  existing event types and IDs. Share classification, not one forced JSON shape.
- Keep `x-duration-ms`, duration payload behavior, `Retry-After`, connection-close
  handling and known codes such as `revision_mismatch` and `execution_draining`.
- Cancellation, interruption, lost ownership and execution failure remain
  distinct outcomes. A failed or disconnected request must not cause automatic
  graph/action resubmission.
- Use current request/run identifiers for diagnosis. An execution that never
  started must not acquire a fabricated run ID merely to format its error.
  Keep these IDs out of metric labels.
- No database migration, new diagnostic service, success-path storage operation
  or extra network request is required.

## Implementation order

### 1. Freeze the compatibility and exposure inventory

Inspect all error producers reaching the listed helpers, including parser/body
limits, `createHttpError`, published admission, revision mismatch, browser-storage
RPC and worker-transported errors. Record which messages are deliberate public
contracts and which are internal diagnostics. Check both current tests and
consumers of nested versus string error payloads.

Add focused failing tests for the confirmed divergences. Exercise the actual
production app/router, not only the generic test harness: the current
`workflow-api-harness.ts` fallback itself returns raw errors and is not evidence
of production middleware behavior.

Do not rewrite every throw site or add a universal error-class hierarchy. Only
adapt a producer when its public intent cannot otherwise be identified reliably.

### 2. Introduce one small, pure public-error policy

Own it alongside `utils/httpError.ts`, in an API utility that does not import
`app.ts`, routes, storage or Core execution. Accept an unknown error and explicit
execution/transport context; return a bounded descriptor containing safe message,
application code, valid error status and permitted response headers.

Use existing typed/factory-produced application errors as the source of public
intent. Distinguish them from arbitrary thrown objects with `status`, `code` or
`expose` fields; those fields alone are not proof of safe origin. Make any factory
marker and trusted worker serialization explicit, then test their round trip.
Do not expose arbitrary PostgreSQL/Node/provider codes as application codes.

Normalize non-Error throws without calling arbitrary object `toString` methods.
Accept only integer error statuses from 400 through 599 and valid bounded retry
metadata from approved error producers. Preserve explicit approved public 5xx errors;
unknown failures get a fixed fallback. The projection is synchronous and bounded,
with no I/O and no execution retry decision.

Keep reporting separate from formatting. A pure projection must not emit another
log every time the same socket failure is replayed.

### 3. Wire HTTP adapters without changing response contracts

Use the descriptor from the general API middleware, workflow error helper and
web-app action helper. Pass request/context into the workflow helper so ordinary
failure logs can carry the existing correlation ID.

Include HTML/app-JSON preparation catches and authorization-before-body paths.
Keep intentional HTML login/denial rendering and early body/connection safeguards.
Never apply error normalization indiscriminately inside `sendJsonWithDuration`:
that function also sends successful, user-defined workflow outputs.

Preserve the existing nested/string response formats. Add a stable fallback code
only within each established error envelope. Normalize safe retry headers using
the same policy; never add an automatic retry for an already accepted execution.

If headers or a response are already committed, report the failure and retain its
recording/outcome. Do not send a second JSON response or convert a completed 200
response into a fictional transport failure.

### 4. Cover all web-app socket delivery paths

The generic Node gateway must not import Studio Server API modules. Introduce a
small host-supplied error/message projection hook and install the API policy in
`web-app-action-websocket.ts`. Preserve standalone Node-host behavior unless its
public contract is intentionally changed in a separately reviewed step.

Route new terminal failures and rejections through this policy. Also apply the
same pure outbound projection when delivering retained events: local replay,
`webAppRunJournal.ts` broadcasts and `webAppRemoteRunSubscriptions.ts` remote
delivery must all use the gateway's per-instance sender. No global mutable sender
or process-wide policy switch.

Keep sequence numbers, event types, request/run IDs, leases and acknowledgements
unchanged. Do not mutate stored event objects during projection. Historical raw
failure frames need a safe fallback on delivery; they cannot be assumed safe just
because they were previously persisted. This needs no history rewrite or schema
change.

Keep original exceptions available to the existing protected recording and
developer callbacks. Preserve intentional output/state patches and the existing
privacy-bounded response-trace feature; inspect its fields rather than treating
all action data as an exception. Do not redact arbitrary successful graph data.

### 5. Make diagnostics correlated and bounded

Use one reporting helper with the existing correlation ID plus available
requestId/runId, execution surface, phase and bounded project/graph identifiers.
For socket setup failures, use connection/request context; once a run exists, add
its actual IDs. Keep raw URLs/query strings, headers, bodies and configuration
objects out of ordinary logs.

Retain original graph details in current authenticated debugger/recording paths.
For a pre-execution failure without a recording, log a stable failure code, phase,
error category and correlation reference; explicitly review any additional stack
diagnostics instead of dumping arbitrary error objects. Logging failures must not
replace the original outcome or prevent cleanup. Do not create a second recording
writer or diagnostic database to solve this problem.

### 6. Validate and release

Use unit tables for classification and wire adapters, actual local HTTP requests
for route/middleware behavior, and the existing Node socket tests for live,
persisted and cross-owner delivery. Reuse fixtures; no extra GKE diagnostic is
needed to implement the policy.

Run relevant `api-profile`, workflow HTTP/web-app, admission/body handling,
request-correlation, socket gateway/journal/subscription and executor regressions.
Run headless browser checks for safe chat errors, revision mismatch, cancellation,
reconnect and detailed editor errors. Include a compiled API and executor build,
consumer type checks, root style/import checks and generated web-app-client
freshness checks if its reachable sources change.

Update the owning developer docs and any user-facing error-reference behavior.
Deploy later through the normal qualified release. Keep old/new response shapes
compatible during rolling overlap; this plan does not authorize deployment.

## Required acceptance cases

| Case                                                               | Required proof                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Unexpected Error with synthetic credentials/SQL/path sentinels     | No sentinel in public workflow, web-app HTTP or socket failure; stable safe code.                                                   |
| String, null or plain-object throw; malformed status/code metadata | Formatting itself does not throw or produce a success status; no arbitrary stringification or vendor-code leak.                     |
| Approved validation/auth/conflict/explicit public 503              | Correct status, safe message and existing code preserved in each wire shape.                                                        |
| Capacity and draining before invocation                            | Existing 429/503 codes and valid `Retry-After`; no graph invocation.                                                                |
| Failure after accepted execution                                   | No automatic resubmission; truthful failure/unknown/cancellation state and retained private diagnostic evidence.                    |
| Failure after HTTP response or disconnect                          | No second response, no changed successful payload, one correlated diagnostic.                                                       |
| Live, retained and remote socket error delivery                    | Same public policy on every path, unchanged sequence/run IDs, no mutation of history.                                               |
| Legacy stored socket failure containing a sentinel                 | Sanitized on reconnect without rewriting the journal or executing anything.                                                         |
| Editor/node error-output/handled Subgraph failure                  | Detailed authorized developer behavior and existing success/error-output semantics preserved.                                       |
| Identifiers and diagnostics                                        | Existing HTTP header remains readable through CORS; logs join to the same request/run and exclude synthetic request/config secrets. |
| Mixed versions and client handling                                 | Old clients still read existing error fields; new optional codes do not trigger unsafe retries.                                     |
| Latency and resources                                              | No new success-path I/O, queues or registrations; bounded synchronous error projection and unchanged execution-slot release.        |

Completion means these cases pass against the final implementation. Source review
and the formatter diagnostic above establish the problem; they do not constitute
implementation, full transport validation or production qualification.
