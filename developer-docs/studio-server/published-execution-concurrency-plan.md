# Live published-execution concurrency

Status: implemented locally on November 17, 2026; release acceptance is pending.
No cloud test, production deployment or live configuration change was made for
this feature. The requirements below are retained as the implementation contract.

## Goal and scope

Add **Concurrent runs per execution Pod** to **Settings -> Deployment**. Saving
changes the admission limit on existing execution processes without restarting
them, changing Helm values or deploying images. The feature itself needs one
normal application release before those live adjustments become available.

At the latest verified rollout on November 17, 2026, production had two ready
execution workers with a 32-run limit and 2 CPU / 4 GiB requests each; retained
staging had one worker with a four-run limit and 500m / 1 GiB requests. Preserve
those defaults. This setting changes concurrent accepted published executions,
not CPU/RAM reservations, Pod counts, execution speed or a global throughput
guarantee.

The existing shared gate covers workflow endpoints, published web-app actions
(HTTP and WebSocket) and scheduled published runs. Preserve that scope and their permit lifetimes.
Editor/preview runs and Evaluation concurrency are outside this setting.

## Confirmed implementation seams

| Area                                                                                                              | Behavior before this change                                                                                                                | Consequence                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `published-execution-admission.ts`                                                                                | One lazily created admission object captures environment configuration. It owns active counts, drain state and permits.                    | Update the limit on this object; replacing it would lose ownership of active runs.                              |
| `routes/workflows/execution.ts`, `web-app-http.ts`, `web-app-action-websocket.ts` and `scheduled-runs/runtime.ts` | Each published entry point uses the shared admission instance. WebSocket permits belong to action execution, not the socket's lifetime.    | Exercise all transports; policy refresh or reconnect must not duplicate or release an active permit.            |
| `server.ts`                                                                                                       | Execution admission is currently constructed before app-settings initialization.                                                           | Bind the saved policy after settings initialize and before the process can serve.                               |
| `app-settings/settings-repository.ts`                                                                             | Versioned settings have optimistic concurrency, subscriptions and request-frozen snapshots.                                                | Reuse persistence and subscribe to committed snapshots; admission must not retain an older request snapshot.    |
| `app-settings/managed-settings-store.ts`                                                                          | PostgreSQL changes notify peers; a five-second revision poll also refreshes them. Synchronization failures have an existing health policy. | Reuse this channel and polling; add no per-run database request or new broadcaster.                             |
| Helm `_env.tpl`                                                                                                   | Admission environment variables are currently injected only into execution API workloads.                                                  | The control-plane Settings API cannot infer the deployment default from its own admission configuration.        |
| `execution-autoscaler.mjs`                                                                                        | Demand calculations currently require equal limits within a pool.                                                                          | A normal live update would temporarily block scaling unless convergence is handled explicitly.                  |
| `execution-autoscaler-kubernetes.mjs`                                                                             | Admission samples currently come from per-Pod Prometheus gauges through bounded execs.                                                     | Observe the actual applied policy and capability; a changed environment variable is not proof of a live update. |
| `deployment-status.ts`                                                                                            | The UI's registry describes runtime-library synchronization.                                                                               | A green library status cannot certify that this concurrency setting reached every worker.                       |
| `execution-profile.mjs` and qualification code                                                                    | Helm admission is bound into installation profiles and release evidence.                                                                   | Distinguish deployment defaults from the live override without dropping other drift checks.                     |

Kubernetes does not update a running process's environment when its ConfigMap
changes. This feature must use application settings rather than edit Pod
environment variables. See [Kubernetes ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/).
PostgreSQL notifications are refresh hints, not the authoritative configuration;
connection startup also needs a state read. Preserve the existing polling and
initialization behavior. See [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
and [LISTEN](https://www.postgresql.org/docs/current/sql-listen.html).

## Behavior contract

1. The persisted UI override wins over the deployment default. Without an
   override, the current Helm/Compose value remains authoritative: 32 in this
   production installation and four in its staging installation.
2. A higher limit allows more _new_ admissions after a worker receives it. A
   lower limit never aborts, restarts or replays accepted work. For example, if
   20 runs are active when the limit becomes 16, all 20 may finish, and new work
   is admitted only when the local active count falls below 16.
3. Preserve overload responses, `Retry-After`, no-waiting-queue behavior, permit
   release-once semantics, shutdown/drain state and recording ownership.
4. Saving is durable; application across workers is asynchronous, normally
   promptly through notification, with the existing five-second poll as backup.
   This is not an atomic cluster-wide switch or a five-second outage guarantee.
5. There is no added database, filesystem or peer request on the execution path.
   Each admission reads the current in-memory policy and updates existing counters.
6. New/restarted workers read the saved override before becoming ready. Application
   upgrades and scale-up preserve it. Resetting the override explicitly restores
   the deployment default, rather than storing another copy of that number.
7. Production and staging remain independent. A setting saved in one installation
   must not leak into another through a database restore or test fixture.
8. UI validation and server validation agree on integer values from 1 through
   10,000, the current admission implementation's technical range. Zero is not
   an alternate shutdown mechanism. This range does not certify load capacity.
   Existing Helm profile minimums remain bootstrap/profile constraints, not a
   reason to reject a supported live override of one.

## Implementation sequence

### 1. Add one small settings resource

Create `packages/studio-server-api/src/published-execution-settings.ts`, shared
types in `packages/studio-server-shared/app-settings-types.ts`, and the resource
at `GET`/`PATCH /api/app-settings/published-execution` (also accepting `PUT`) using the existing authenticated
control-plane routing and bounded body parser. Do not add a public execution
configuration endpoint.

Use `VersionedSettingsRepository` and the existing encrypted `app_settings` table.
The persisted value needs only its format version, installation binding,
`maxActiveRunsPerPod: number | null` and update time. `null` means no override.
No new database table, DDL migration, backfill, broker or service is needed.

Bind the override to the stable installation identity already injected as
`RIVET_LEGACY_RESTORE_INSTALLATION` (`namespace/release` in Helm and `docker/project`
in managed Docker). Validate that binding. A foreign installation's stored
override is inapplicable, not authority to resize staging's effective limit.
An explicit destination save binds to the destination installation. A supported
installation missing its identity reports a configuration error rather than
inventing a shared scope.

Return the saved override, deployment default, effective value, source, update
time and resource revision. Expose the deployment default to the control API
through read-only launcher metadata derived from the same Helm/Compose field.
Keep execution-only admission activation separate: passing metadata to the
control plane must not start limiting editor runs. Preserve protection against
Vault/custom environment values shadowing deployment-owned metadata.

Require a resource revision on writes, reuse `ETag`/`If-Match` conflict behavior,
and retain operator authentication. A stale form returns a conflict; it does not
silently overwrite another save. After an uncertain save acknowledgement, read
the resource back before offering a result; do not replay the write automatically.

Register the descriptor wherever settings initialization, export/import, restore
and migration enumerate domains. Older snapshots missing this _new optional_
domain use no override. Keep existing required-domain checks intact. Same-scope
backup/restore preserves a saved override; cross-installation restore requires
an explicit binding decision and otherwise uses the destination's default.

### 2. Make admission updateable in place

Add a narrow limit-update method to the existing admission object. Validate and
copy the new value synchronously, without recreating counters, active permits,
observers or drain state. A repeated identical update is harmless. A settings
refresh must never reopen a draining process.

After app-settings initialization, apply the current saved snapshot and install
one subscription before serving traffic. Consume the snapshot passed to the
subscription; do not re-read an older HTTP `AsyncLocalStorage` snapshot. Close
the initialization/subscription race by subscribing and reconciling the latest
initialized value before readiness. Dispose the subscription through the existing
resource lifecycle, including failed startup.

This control-only domain opts out of eager request snapshot capture. Its
subscription and persistence remain registered, but ordinary executions do not
read or add its value to their settings snapshot. Explicit Settings API reads
still use normal revisioned repository semantics. Existing execution settings
retain their original snapshot behavior.

Update the effective-limit gauge immediately, even on an idle worker. Keep
capacity-crossing diagnostics accurate when limits move. Malformed settings or
failed refreshes must not reset the limit, turn enforcement off or discard active
permits. Use the existing settings synchronization/readiness policy for outages;
accepted work keeps its existing completion and drain behavior.

### 3. Make runtime observations and scaling understand convergence

Keep the current stable Prometheus limit/active-run gauges. Add a bounded,
loopback-only read of a coherent admission-policy snapshot for the existing
controller/operator exec path. The snapshot includes protocol capability,
installation scope, deployment default, applied settings revision, effective
limit, policy source and active/draining state. Reuse the existing internal
process-retirement transport's loopback and capability protections; it must
expose no credentials or arbitrary targets. The browser never receives that
process-local capability.
Do not put changing revision strings on ever-growing gauge series.

Update the maintained exec command/allowlist and its tests together. A worker
without the new read capability retains the legacy fixed-limit observation for
initial upgrade/rollback compatibility. Missing capability is not permission to
accept an unexplained mixed configuration.

For workers with compatible live-policy observations, require consistent
installation/default/mode, fresh identity and synchronization evidence, and
one value for each reported revision. A short mixture of valid revisions may
occur during propagation. During that period:

- continue bounded scale-up using conservative observed capacity (the smallest
  effective limit in the relevant pool) and the existing CPU demand calculation;
- reset low-load stabilization and do not begin a new scale-down retirement;
- preserve and safely observe any already-owned retirement; revalidate actual
  surviving capacity before removal, without reopening or force-killing its target.

Once the pool converges, use its actual uniform limit and restart ordinary
scale-down stabilization. Do not remove the existing guards for mismatched
deployment defaults, foreign owners, unsupported/invalid observations, missing
metrics, physical Pod ceilings or database connection budgets. Apply the same
rules to serial observations, paired pools and candidate-capacity calculations;
using the first Pod's limit is not safe during convergence.

### 4. Integrate the mutable setting with release tooling

Keep Helm's `publishedExecutionAdmission.maxActiveRunsPerPod` and the installation
execution profiles as deployment defaults. A UI save must not patch those values,
Pod templates, protected configuration pointers or release digests.

Audit `execution-profile.mjs`, `execution-pool-resources.mjs`, the qualification
provider, retained-staging preparation, handoff guards and final acceptance for
assumptions that a Pod's environment is its effective limit. Validate bootstrap
identity through the existing source-owned checks, and validate effective capacity
through fresh runtime observations. Record both in diagnostics. Do not discard
the full settings fingerprint or label all differences acceptable runtime drift.

A legitimate live override must survive the next upgrade without requiring a
new image build, edited Helm values or a repeat qualification solely for changing
the number. Safety decisions during an upgrade use the actual observed limit,
not a value sampled once during staging. If an operator changes it during a
handoff, reobserve convergence and capacity before the next destructive step.
Keep the operation's deadline, ownership and accepted-work checks.

Staging retains its own default and override. Qualification records its starting
runtime policy and must not copy production's override, silently clear a user's
staging override, or accidentally turn four-slot staging into 32-slot staging.
Any temporary fixture policy must be explicitly owned and restored with revision
checks; avoid requiring one for the ordinary focused suite.

Older application images cannot implement this setting. Initial release
acceptance must verify all serving execution workers support it before claiming
the feature is available. A rollback to older images uses their documented
startup configuration, preserves the saved setting for a later capable release,
and never pretends that old workers applied it.

### 5. Add the standard Deployment form

Use the existing settings section, number-input, Save/Revert feedback and
`useSettingsFormResource` patterns in `DeploymentStatusSettingsTab.tsx`. Keep the
existing topology/library information intact.

Show **Concurrent runs per execution Pod**, its effective value, whether it uses
the deployment default or a custom value, and an explicit **Use deployment default**
action. Suggested explanatory text:

> Applies to new published endpoint, web-app and scheduled runs on each execution
> Pod. Running work finishes normally. Changes reach workers automatically.

Save feedback means **Saved**, not **Applied to every Pod**. The current library
registry cannot prove the latter. Do not add a new per-worker registry or a
database migration merely to manufacture an all-workers-applied badge. Runtime
observations and focused acceptance establish actual application. If there are
no workers, saving the desired policy is still valid for future workers.

Keep unsaved input stable during the existing five-second Deployment status
refresh. Capture input values before queued React state updates, retain normal
keyboard/focus behavior and show precise validation/conflict errors. Do not
enable editing for a deployment whose enforcement mode cannot honor the setting.

### 6. Prove the complete path locally

Use a compact set of behavior tests rather than duplicate transport scaffolds.

| Test layer                         | Required evidence                                                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission unit tests               | Raise/lower while busy; active count greater than new limit; release once; repeated updates; draining remains closed; unchanged rejection/mode/scheduled behavior; idle metric updates.                                                                        |
| Execution transport tests          | Endpoint HTTP, published web-app HTTP and WebSocket actions, and scheduled published runs all obey the same updated counter. Disconnect/resume does not create a spare permit; editor/preview and Evaluation behavior stay unchanged.                          |
| Settings/API tests                 | Defaults and reset; strict numeric bounds including one; required revision/conflict; auth; uncertain acknowledgement readback; invalid stored content; same-scope restart/restore; foreign-scope isolation; older snapshots missing this domain.               |
| Real PostgreSQL multi-process test | Two independent workers receive a saved change; lost notification converges through polling; restart reads saved policy before readiness; listener disconnect/recovery; database outage never cancels active work or restores a stale default.                 |
| Controller tests                   | Mixed valid revisions permit conservative growth and block new shrink; convergence restarts stabilization; active above limit is valid; unknown/legacy mixed limits still fail; paired handoff and in-flight retirement preserve identity and capacity guards. |
| Local rollout fixtures             | Save, then upgrade; save during handoff; runtime override of one; staging four/production 32 remain independent; immutable bootstrap drift still fails; old/new worker compatibility and rollback preserve data.                                               |
| Playwright                         | Open Deployment, edit/save/reset/reopen, invalid input, stale save, failed save/readback and background refresh while typing. No modal disappearance or focus loss.                                                                                            |
| Performance                        | No per-admission persistence/refresh calls; bounded counters/subscriptions; matched warm endpoint and published web-app fixtures at tiny and larger request sizes, recording p50/p95/p99 and errors.                                                           |

Treat no extra execution-path I/O as a hard architectural condition. Use paired
before/after measurements to detect a reproducible latency regression; do not
claim measured speed or turn a noisy single timing sample into a CI test. Do not
consume the separately approved Code-isolation latency budget for this feature.

Use the existing local PostgreSQL/managed-server harness, controller simulations
and targeted API tests first. Run the required headless UI check through:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe deployment-status.spec.ts
```

Before committing the eventual implementation, read `ci-pre-push.local.md` and
apply only final-diff checks. Run affected build/type/style checks and maintained
rollout source verification once the code is final; broaden only for failures or
unresolved concerns. A fixture test is not a live GKE qualification.

### 7. Release once, then use the live control

Update `deployment-status.md`, `runtime-autoscaling.md`, `resource-sizing.md`,
deployment operations and the owning user Settings documentation to explain
default versus override, propagation and lowering behavior.

After local validation, use the ordinary develop -> main -> immutable images ->
one qualified staging rollout -> production sequence with the relevant operation
approval. Add a small focused staging exercise that saves and verifies limits
on existing workers while accepted work completes. Preserve Pod UID/container
incarnation and check zero restart/redeployment attributable to those saves.
Restore staging's original policy, prove cleanup, and keep its one-worker idle
minimum. Do not add a second full qualification just to exercise the field.

The focused exercise belongs inside the next approved staging attempt, at a
quiet point before its final acceptance:

1. Read and retain the complete original setting and revision. Record the Pod
   UID, restart count and process incarnation, plus the bootstrap default and
   applied policy from the private read-only sample. Require the new capability
   on every serving worker; a legacy metrics fallback cannot certify this feature.
2. Save two, wait through read-only observations for application, then start two
   bounded long-running fixture requests on the staging worker. Save one while
   they are active. Confirm both finish and a third admission gets the ordinary
   overload response; do not retry rejected requests automatically.
3. Raise the limit to two and verify a new request is accepted. Confirm Pod UID,
   process incarnation and restart count did not change during either save.
4. Restore the original override, including `null` if it originally used the
   deployment default, with the latest owned revision. On conflict, stop and
   inspect; never overwrite a different operator's change. Wait for the original
   applied value, verify accepted work and recording completion, and close the
   fixture before final qualification/cleanup. A failed test remains failed.

Do not run this exercise as a separate unapproved cloud attempt or silently add
new qualification claims to an older certificate. The next release includes the
new application code; later changes to this setting need no image build.

Production starts with its current effective value of 32. The operator can then
adjust it through Settings; subsequent adjustments require no build or deployment.
This rollout does not automatically raise production beyond 32 or run a new
representative load test.

## Completion criteria

- A saved adjustment changes admission on independent existing workers without
  Pod replacement, process restart, graph retry or execution-path network I/O.
- Reducing the limit preserves every accepted run and its recording lifecycle.
- Restart, scaling and ordinary upgrades retain the setting; explicit reset
  returns to the correct installation-specific default.
- Autoscaling and rollout handoff remain safe during both convergence and loss
  of observations, without treating arbitrary configuration drift as valid.
- The UI uses standard patterns and reports a durable save truthfully.
- Local correctness, integration, UI and comparative performance evidence pass
  before a cloud attempt; no cloud attempt is authorized by this plan itself.

## Local implementation evidence

- Settings/API, admission, synchronization, restore compatibility, real endpoint
  background completion, recording and retirement checks run in the API suite.
  The new control-only snapshot test protects the execution hot path.
- `test:published-execution-managed` uses isolated PostgreSQL and four independent
  processes. Notification loss, polling, LISTEN disconnect, database outage,
  restart, foreign-installation restore, reset and draining are covered. It found
  two real existing faults: repeated listener errors and idle pooled-connection
  errors could terminate Node. Both now have bounded, non-replaying error handling.
- Autoscaler tests cover mixed revisions, conservative growth, stable-period
  reset, stale policy before a new intent and during a drain, paired capacity,
  actual runtime overrides and retained immutable bootstrap checks. A Linux
  container test exercises the real supervisor/private socket/sample command.
  The ordinary rollout headroom check also uses the smallest verified limit;
  its regression reproduced unsafe first-worker sizing before the repair.
- The required headless `deployment-status.spec.ts` check covers edit, validation,
  save, reset, reopening, stale writes, uncertain acknowledgements, polling and
  focus preservation. It is included in the existing editor CI shard inventory.
- Local evidence and the matched warm HTTP benchmark are under the ignored
  `artifacts/live-execution-policy-20261117/` directory. The benchmark compares
  fixed admission with live policy in the same API implementation, environment
  and routes at 32-byte and 64-KiB inputs. It is not a production load certification.

Final Windows/Node 22 measurements used 1,200 measured requests per mode/case,
150 warmups, and eight alternating batches. All 9,600 measured requests succeeded.
Values below are milliseconds (`p50 / p95 / p99`):

| Route and input | Fixed admission | Live policy |
| --- | --- | --- |
| Endpoint, 32 bytes | 1.512 / 2.460 / 3.005 | 1.406 / 2.258 / 2.864 |
| Web-app action, 32 bytes | 2.456 / 3.445 / 4.305 | 2.232 / 3.206 / 4.018 |
| Endpoint, 64 KiB | 1.630 / 2.734 / 15.109 | 1.627 / 2.730 / 11.358 |
| Web-app action, 64 KiB | 2.896 / 5.303 / 25.620 | 2.998 / 5.755 / 23.621 |

These are local measurements, not a claim of faster execution. The larger
web-app case has a higher aggregate p95 and lower p99, with garbage-collection
pauses in both modes and batch differences in both directions. An additional
same-code, two-process control is preserved in `performance-control.json`.
The hard architectural check is that this domain adds no eager request-snapshot
read or admission-path persistence/network lookup; do not convert these noisy
local timings into a production latency guarantee.

Final source validation passed the maintained rollout-source suites (874 tests,
five platform skips), controller/Helm/Compose/packaging checks (148 tests, two
environment skips), API typechecking, settings/scheduled-run checks (96 tests),
the managed four-process exercise, repository/import boundaries and documentation
links. Earlier complete API/transport checks passed 112 and 132 cases. UI build
and the headless browser check validate the final browser form separately.

Initial feature rollout and the focused staging exercise above remain pending;
local tests do not claim deployed availability or 32-run throughput capacity.

### Follow-up reliability review, November 17

The listener now owns its PostgreSQL connection and observes errors before
`connect`/`LISTEN` complete. Shutdown can close an opening connection, late
initialization cannot restart its poll timer, and events from an old socket
cannot replace or invalidate the successor. Reconnect scheduling uses one
coalesced path. Regressions reproduced both the early-error and opening-connection
shutdown gaps before the repair; they also cover repeated and late socket errors.

The real multi-process test now asserts that notification failure was actually
injected and that a replacement `LISTEN` connection has a new database PID.
Successful fallback polling alone no longer passes the reconnect check. These
checks add no waits or I/O to workflow execution. The legacy and policy-aware
rollout sample commands share the same metrics-fetch implementation.

This review also runs the root CI style/contract command, compiled API build,
settings/restore regressions, the real PostgreSQL exercise and headless Deployment
form checks. It does not replace the first release's approved staging acceptance.

The existing Vault-loading fixture now verifies both four-slot staging and
32-slot production defaults survive a conflicting secret. The full local
Kubernetes CI command passed its API and deployment contracts and Helm renders.
One initial Windows shell invocation failed without useful diagnostics and did
not recur in isolation or the full diagnostic run. That fixture retains its
strict assertions and now reports exit status/stderr with a bounded subprocess;
it does not retry or turn a process failure into a pass.

### Pre-push CI review, November 17

The final diff was checked against the actual Build and Verify Studio Server
commands. Desktop/CLI builds, API build/typechecking, shared-contract checking,
root lint/style, formatting, documentation types, compiled export validation,
300 web tests and eight executor tests pass. The startup/settings/recording
selection passes 106 cases with the CI runtime flag; the separate local-upgrade
scenario verifies the emitted API and old plaintext-settings compatibility.
Sixteen admission/listener regressions also pass under Linux Node 24. The earlier
managed PostgreSQL, Helm/controller and headless Deployment-form evidence remains
applicable. The new managed exercise and browser regression are registered in CI.

A fresh Rust audit caught two newly listed ZIP advisories before pushing. Their
affected paths are absent from the checksum-pinned desktop updater: AES support
is disabled and the extractor uses central-directory entries rather than a
streaming reader. The documented exceptions retain the existing November 30
expiry and exact dependency/sole-consumer checks. No application dependency or
runtime behavior changed for this audit; see the CI documentation for the review.
Hosted runner allocation, signing and future advisory changes still require the
actual GitHub run. No push, cloud test or deployment was performed in this review.
