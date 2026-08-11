# LLM Profile Suspension

## Purpose

An `LLM Profile` can configure automatic suspension, which temporarily removes
a failing provider configuration from an LLM Chat fallback chain. This is a
host-activated cross-run reliability policy, not another request retry. Rivet
Studio Server activates it automatically; another host must explicitly supply
an `llmProfileHealthStore`. Without that store the complete LLM profile
suspension policy is inert, including its provider deadlines.

When activated:

- ordinary retryable non-200 failures still use the normal per-request retry
  policy before fallback;
- each configured first-output or stream-inactivity deadline applies to the
  current provider call immediately: reaching it abandons that call and moves
  to the next fallback candidate even while the circuit is still closed;
- when a candidate ends, one logical successful, failed, or ignored result is
  recorded against the resolved profile configuration. Ordinary non-200
  failures end after their configured physical-request retries; a deadline ends
  the candidate immediately;
- after the configured number of failed results inside the rolling failure
  window, later runs suspend that profile and move directly to the next profile;
- after the suspension duration, the store admits one recovery attempt;
- a successful recovery attempt resumes the profile, while a failed attempt
  suspends it again.

If every candidate in a fallback chain is currently suspended, LLM Chat fails
immediately with the recorded suspension decisions; it does not try a suspended
profile as a last resort. Deployments that require an always eligible final
fallback should leave automatic suspension disabled on that last profile.

Configuration and response-validation errors do not count toward suspension.
Graph cancellation is also ignored. The attempt trace records reliability
checks, timeouts, skips, and reliability-service failures so fallback behavior remains
inspectable.

## LLM Profile settings

The `LLM profile suspension` section belongs to the `LLM Profile` node. It is
not available on inline LLM Chat configuration.

| Setting                    | Default | Meaning                                                                     |
| -------------------------- | ------: | --------------------------------------------------------------------------- |
| Automatic suspension       |     Off | Enables automatic suspension for this resolved profile.                     |
| Useful output wait time    |  30 sec | Maximum wait for a non-stream response or the first useful streamed output. |
| Stream inactivity timeout  |  30 sec | Maximum gap between useful streamed response events.                        |
| Failures before suspension |       3 | Failed or timed-out results needed inside the rolling window.               |
| Failure window             | 300 sec | Rolling interval used to count failed or timed-out results.                 |
| Suspension duration        | 300 sec | Time the profile is skipped before one recovery attempt is allowed.         |

Reliability controls are presented in whole seconds. Rivet continues storing
their values internally as milliseconds, so existing projects and the public
runtime contract remain unchanged. Standalone Rivet still authors and
serializes these settings, but does not apply them.

The deadline and failures-before-suspension setting answer different questions.
For example, a 10-second first-output deadline with a threshold of 2 abandons
the first slow call at 10 seconds and records one failure, but leaves the
profile available. A
second failed logical attempt inside the configured failure window suspends the
profile; only subsequent requests are skipped for the suspension duration.
Existing reliability history is intentionally retained when the policy is
edited. In Rivet Studio Server, use Project Settings > LLM reliability > Clear
all history when testing should begin from an empty history.

The identity includes the executing project, source LLM Profile node, provider,
model, Custom API mode, and a SHA-256 configuration fingerprint. The fingerprint
covers provider routing and authentication inputs, including the effective
project-wide Chat headers plus profile headers after case-insensitive merging
(profile headers win). Credential and header values never appear in the key.
Provider, model, Custom API, base URL, routing-header, or credential changes
rotate the identity. Generation parameters and breaker-policy edits retain it.
Serialized/imported profile values are rebound to the current executing project
while preserving an existing source profile-node ID.

## Runtime store contract

`RivetLLMProfileHealthStore` is the host seam for circuit state. Its gate,
finish, lease-renewal, reset, and list operations must be atomic. In particular,
only one process may acquire a half-open probe for the same identity at a time.
That requirement matters for multi-process servers and Kubernetes replicas;
ordinary read-then-write key/value storage is not sufficient.
Implementations must also reject an attempt to reuse one opaque health key for
a different project scope. The process-local reference store and the Studio
Server durable stores enforce the same rule so project-scoped listing and reset
cannot be bypassed by a malformed or stale identity.

When no host store is supplied, core does not apply suspension checks and does
not apply first-output or stream-inactivity deadlines from LLM profile
suspension. Standalone
Browser, Node, editor, and headless runs therefore retain ordinary LLM fallback
behavior and no cross-run suspension history. The exported in-memory implementation
is a reference store for tests and explicit custom-host integrations; Rivet
does not install it implicitly.

Hosted editors may pass a shared implementation through
`RivetAppHost.providers.llmProfileHealthStore`. Browser-mode graph runs forward
that store through `ProcessContext`. Supplying only an administration provider
does not activate execution health. Rivet never silently creates an unrelated
process-local health record.

Node-mode editor runs execute in `app-executor`, so the store object cannot be
sent over the editor WebSocket. A hosted executor must start through
`startAppExecutor({ createProcessorOptions })` from
`packages/app-executor/bin/executorHost.mts` and return its request-scoped
`llmProfileHealthStore` there. Rivet-owned graph, debugger, input, registry,
Stored Value, and event options override overlapping callback values. The
standalone desktop sidecar still starts from `executor.mts` with its existing
defaults.

## Host administration

The app provider surface also accepts `llmProfileHealthAdmin`. It is a
permissioned editor-facing list/reset API, separate from the atomic execution
store so a custom browser host can implement administration over HTTP without
exposing database operations directly. A host-supplied execution store does not
implicitly expose administration. Standalone Rivet supplies neither provider,
so it has no LLM reliability management section.

Rivet Studio Server owns its operational UI outside the embedded editor. Its
Project Settings > LLM reliability tab shows only profiles that are currently
suspended. Profiles that are available or running a recovery attempt stay
hidden because they are not currently suspended. The tab maps retained profile
node IDs back to graph/node names and can clear one visible profile's history
and resume it, or clear history for the whole project. Project-wide listing and
clearing use the store's first-class
`list({ projectId })` and atomic `reset({ projectId })` operations rather than
deriving a key prefix or issuing one reset per returned row.

Clearing history atomically deletes the complete failure, suspension, and
recovery-attempt record for the selected profile or project. A late result from
a request admitted before clearing cannot recreate that deleted history.
Clearing history never changes saved node settings and does not cancel requests
already in progress. Project-wide clearing also deletes available records hidden from the operational
suspension list.

## Observability

`llmProfileAttempt` is a first-class process event. It carries exact root,
graph, node, and process identity plus profile index, lifecycle stage, outcome,
circuit disposition/state, timeout kind, and retry time where applicable. The
event crosses the Node executor protocol, debugger transport,
recording/replay, and response-trace collector. This matters for an open-circuit
skip because no physical provider call exists from which the UI could infer it.

Run Activity attaches these decisions to the owning LLM Chat invocation and
shows suspension skips, unavailable reliability-service errors, first-output/stream
inactivity timeouts, and reliability updates in chronological order beside physical
model calls. Response Inspector exposes the same records in its **LLM profile
attempts** section. Older recordings remain loadable; their additive profile
attempt collection is simply absent.

## Host responsibilities

A durable implementation owns concurrency, tenancy, authorization, clock use,
cleanup, and retention. For Kubernetes, all replicas that can execute the same
project/profile identities must use the same atomic backend. The health store
is operational state and must not be serialized into `.rivet-project` files,
browser snapshots, recordings, or node outputs.
