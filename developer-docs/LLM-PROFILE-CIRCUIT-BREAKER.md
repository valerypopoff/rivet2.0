# LLM Profile Circuit Breaker

## Purpose

An `LLM Profile` can opt into a circuit breaker that temporarily removes an
unhealthy provider configuration from an LLM Chat fallback chain. This is a
cross-run reliability policy, not another request retry:

- the normal per-request retry policy still runs first;
- after that candidate exhausts its configured physical request retries, one
  logical healthy, unhealthy, or ignored candidate outcome is recorded against
  the resolved profile configuration;
- after the configured number of unhealthy outcomes inside the rolling failure
  window, later runs skip that profile and move directly to the next profile;
- after the suspension duration, the store admits one half-open recovery probe;
- a healthy probe closes the circuit, while an unhealthy probe opens it again.

If every candidate in a fallback chain is currently denied by its health gate,
LLM Chat fails immediately with the recorded circuit decisions; it does not
bypass an open circuit as a last resort. Deployments that require an always
eligible final fallback should leave the circuit breaker disabled on that last
profile.

Configuration and response-validation errors do not make a provider unhealthy.
Graph cancellation is also ignored. The attempt trace records health-gate,
timeout, skip, and health-store failures so fallback behavior remains
inspectable.

## LLM Profile settings

The `Reliability` section belongs to the `LLM Profile` node. It is not available
on inline LLM Chat configuration.

| Setting                            | Default | Meaning                                                                     |
| ---------------------------------- | ------: | --------------------------------------------------------------------------- |
| Temporarily skip unhealthy profile |     Off | Enables the circuit breaker for this resolved profile.                      |
| First output timeout               |  30 sec | Maximum wait for a non-stream response or the first useful streamed output. |
| Stream inactivity timeout          |  30 sec | Maximum gap between useful streamed response events.                        |
| Failure threshold                  |       3 | Unhealthy outcomes needed inside the rolling window.                        |
| Failure window                     | 300 sec | Rolling interval used to count unhealthy outcomes.                          |
| Suspension duration                | 300 sec | Time an open profile is skipped before one recovery probe is allowed.       |

Reliability controls are presented in whole seconds. Rivet continues storing
and applying their values internally as milliseconds, so existing projects and
the public runtime contract remain unchanged.

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

When no host store is supplied, core uses one process-local
`InMemoryRivetLLMProfileHealthStore`. The normal desktop/browser editor injects
that same renderer singleton into Browser runs, so Project Settings can inspect
and reset the state used by those runs. Process-local state is intentionally
lost when the process or page reloads and is not shared between replicas. The
standalone Node executor is a different process and keeps its own fallback
singleton; the renderer's local Project Settings adapter does not administer
that sidecar state. Hosts that require one manageable state across Browser and
Node execution must inject a shared backend into both paths.

Hosted editors pass a shared implementation through
`RivetAppHost.providers.llmProfileHealthStore`. Browser-mode graph runs forward
that store through `ProcessContext`. A host that exposes shared health
administration without a matching Browser execution store receives an explicit
unavailable-store adapter. Circuit-breaker operations then follow the runtime's
fail-open policy: the provider request continues unprotected and the
profile-attempt trace records the store failure. Rivet never silently creates
an unrelated process-local health record.

Node-mode editor runs execute in `app-executor`, so the store object cannot be
sent over the editor WebSocket. A hosted executor must start through
`startAppExecutor({ createProcessorOptions })` from
`packages/app-executor/bin/executorHost.mts` and return its request-scoped
`llmProfileHealthStore` there. Rivet-owned graph, debugger, input, registry,
Stored Value, and event options override overlapping callback values. The
standalone desktop sidecar still starts from `executor.mts` with its existing
defaults.

## Project Settings administration

The app provider surface also accepts `llmProfileHealthAdmin`. It is a
permissioned editor-facing list/reset API, separate from the atomic execution
store so a browser host can implement it over HTTP without exposing database
operations directly. Project Settings shows only records whose identity belongs
to the open project, maps retained profile node IDs back to graph/node names,
and can reset one identity or the whole project. Project-wide listing and reset
must use the store's first-class `list({ projectId })` and atomic
`reset({ projectId })` operations rather than deriving a key prefix or issuing
one reset per returned row. Resetting health makes profiles eligible again; it
never changes saved node settings and does not cancel requests already in
progress.

The standalone editor supplies a local admin adapter for the default in-memory
Browser store. When Node execution is selected, Project Settings disables that
adapter and explains that the sidecar owns separate process-local state; it
never pretends to reset the Node executor. Embedded hosts may replace it. A
host-supplied execution store does not
implicitly expose administration; the host must also provide
`llmProfileHealthAdmin` if Project Settings should show the management section.
If a host deliberately omits the admin provider, the section is hidden and
automatic cooldown and recovery continue without it. If a host supplies shared
administration but omits the matching Browser execution store, Browser runs
continue under fail-open behavior and expose the misconfiguration in LLM
profile-attempt diagnostics rather than writing unrelated process-local state.

## Observability

`llmProfileAttempt` is a first-class process event. It carries exact root,
graph, node, and process identity plus profile index, lifecycle stage, outcome,
circuit disposition/state, timeout kind, and retry time where applicable. The
event crosses the Node executor protocol, debugger transport,
recording/replay, and response-trace collector. This matters for an open-circuit
skip because no physical provider call exists from which the UI could infer it.

Run Activity attaches these decisions to the owning LLM Chat invocation and
shows circuit-gate skips, fail-open health-store errors, first-output/stream
inactivity timeouts, and health updates in chronological order beside physical
model calls. Response Inspector exposes the same records in its **LLM profile
attempts** section. Older recordings remain loadable; their additive profile
attempt collection is simply absent.

## Host responsibilities

A durable implementation owns concurrency, tenancy, authorization, clock use,
cleanup, and retention. For Kubernetes, all replicas that can execute the same
project/profile identities must use the same atomic backend. The health store
is operational state and must not be serialized into `.rivet-project` files,
browser snapshots, recordings, or node outputs.
