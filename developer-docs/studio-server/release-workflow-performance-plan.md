# Release workflow timing audit and improvement plan

For the successful staging and completed production rollout timing audit on
2026-11-04, see [faster ordinary updates](rolling-update-performance-plan.md).
It separates the one-time bridge from normal releases. Shared frontend/worker
overlap, bounded independent reads, unchanged-proxy provenance/reuse, retained
staging application and the bounded worker-pool handoff are implemented locally.
Concurrent online preparation/final acceptance is prepared in a private adapter
copy. Native tool and recovery regressions are local evidence; faster hosted/GKE
timings still need measurement. Fresh security scans still cover reused digests.

Status: **A–C implemented and locally validated; hosted CI/cache timings, publication and GKE qualification remain open** (2026-11-03). No CI run, paid staging attempt or production deployment was used for the local validation recorded below. This plan complements [production update continuity](production-update-continuity-plan.md).

Revised decision: repair the worker race, run cheap source contracts before expensive work, gate Kind on scans, and add bounded caching/diagnostics within the existing workflows. Then qualify one repaired build under a fresh approval. Admission now runs early inside staging preparation; separate paid preflight operations, new delivery artifacts and shutdown bypasses remain outside this work. Shorter successful hosted workflow durations remain unproven.

The November 4 follow-up repairs the native admission JSON contract and adds
packaged preparation/cleanup checks to the same early job. It also propagates
phase cancellation through readiness polling. The source gate and native checks
passed locally from a fresh source projection without application builds. See the
[preparation contract audit](automated-runtime-qualification.md#local-provider-preparation-contracts)
and [current continuity plan](production-update-continuity-plan.md#preparation-after-repeated-staging-integration-failures).

## Implementation and evidence

The November 5 candidate-smoke failure occurred during a GHCR image pull, before
application tests. Read-only downloads now have a narrow three-attempt transport
retry, shared with the local-upgrade rehearsal; smoke startup uses only the
already downloaded images. The regression runs in the early source gate. This
adds at most 20 seconds of backoff per affected image, without rerunning builds,
tests or writes. See [download handling](../BUILD-AND-CI.md#candidate-image-download-failures).

The same run's 502 contract exposed a checkpoint/sampler race in first-failure
diagnostics. A shared capture promise now covers either detection path and late
in-flight failures, without changing traffic acceptance. Its deterministic real
HTTP regression also runs before expensive work.

The follow-up image run exposed a recycled-port shutdown assertion and missing
hosted-runner disk preparation. Shutdown evidence now identifies the child process,
with a deliberate unrelated-port-reuse regression. Kind runners reclaim only
unused preinstalled SDKs before provisioning; the 20 GiB floor remains unchanged
and reports actual free space. Both contracts fail in the early gate. See
[runner preparation and ownership](../BUILD-AND-CI.md#runner-capacity-and-process-shutdown-fixture-ownership).

The first publication ([PR 236](https://github.com/valerypopoff/rivet2.0/pull/236),
[Build Images 41643584037](https://github.com/valerypopoff/rivet2.0/actions/runs/41643584037))
hit a deployment-contract blocker: a journal-observer test expected no diagnostic
artifact after the rollout. The local follow-up separates journal ordering from
the timing file and moves that source-only contract into the early gate, retaining
its persistence/observer failure checks and the full Kubernetes suite entry.
This follow-up is not a verified image build or provider qualification. No
automatic retry or further cloud operation follows from the repair.

| Item                                 | Implemented behavior / evidence                                                                                                                                                                                                                                                                                                                                                                                                 | Still requires hosted evidence                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A: cooperative worker reconciliation | Live, UID-checked bounded pool; old surge owners and same-image/stale-revision owners are replaced; ceiling and pending/lost-ack recovery regressions pass. The captured-race tests failed before repair.                                                                                                                                                                                                                       | One successful exact-image focused GKE update.                          |
| B: early source gate                 | Shared reusable job and one command; general Build, Studio verification, image builds and direct qualification publication retain the gate. A clean network-disabled Node 24 run, without application outputs or install state, passed dependency installation and all 124 source tests/policy in 24.04 seconds. The affected Linux protocol/regression set and separate source-admission tests passed 247 tests with no skips. | GitHub checkout/dispatch overhead and time to first blocker.            |
| B: scan prerequisites / lane balance | Kind requires successful scans. The unchanged managed Kubernetes check moves from `upgrade` to the shorter `lostAcknowledgement` lane; explicit matrix context, all scenarios and cleanup remain required.                                                                                                                                                                                                                      | Successful new matrix execution and observed critical path.             |
| C: cache                             | GHA v2 actor/janitor scopes with bounded transfers, compatible buildx driver and classic-store `--load`. A disposable local external-cache probe retained the same configuration ID across fresh builders, verified the Docker archive config hash and invalidated changed input (cold 23.0s, fresh-builder cache 4.0s; a tiny fixture, not actor timing).                                                                      | Hosted GHA cold/warm hit rate, transfer cost and actual actor duration. |
| C: progress                          | Per-owner routing/drain/readiness and handoff timing; first failure separated from cleanup. Provider progress uses fixed public labels and does not acknowledge writer closure early.                                                                                                                                                                                                                                           | A provider report from the new source.                                  |
| D: scheduled-disruption triage       | The failing request reused a Pod-bound test port-forward across node drain. The harness now reconnects after readiness; a failing-first local transport regression covers reconnect and uncordon on failure. This is a confirmed harness gap consistent with the captured error, not a claim that all causes of that historical run are proven. Real recovery requests/assertions remain required.                              | The next applicable required/scheduled run.                             |

Replaying the two successful sampled runs with the new lane assignment, their
observed scan completion and a **30-second source-job allowance** projects a
74–78-second reduction in the successful critical path. This includes the new
scan barrier rather than counting the entire 163–183-second moved check as a net
saving. It assumes comparable runners/dispatch and needs hosted confirmation.
A more conservative 60-second source allowance projects 44–48 seconds saved. Actor cache savings are parallel and are not added to either estimate. The larger
immediate benefit is eliminating expensive downstream work after known cheap
failures and the impossible 20-minute candidate wait. This is not evidence that
every successful release or every failed workflow will finish in a few minutes.

The implementation details below remain the acceptance specification. A–C do not
authorize D's publication, a paid test, an automatic retry or production rollout.

## Evidence and method

Read the latest 12 runs of each workflow, job/step timestamps for five representative runs plus the current scheduled failure, three completed job logs, and the already-retained private staging receipts/report. Durations below are elapsed wall time, not sums of parallel jobs. Private configuration, actor exports and raw logs remain ignored local artifacts; only public run links and sanitized aggregates appear here. Initial runner dispatch lag in the detailed runs was a few seconds. This is principally execution time, not an initial GitHub queue problem.

| Workflow/run                                                                                   | Result                                        | Elapsed |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------- | ------: |
| [Build Images 41603453326](https://github.com/valerypopoff/rivet2.0/actions/runs/41603453326)  | Success                                       | 35m 23s |
| [Build Images 41541831641](https://github.com/valerypopoff/rivet2.0/actions/runs/41541831641)  | Success                                       | 31m 19s |
| [Build Images 41599695194](https://github.com/valerypopoff/rivet2.0/actions/runs/41599695194)  | Security failure, subsequently cancelled      | 26m 34s |
| [Release Rivet 41612455458](https://github.com/valerypopoff/rivet2.0/actions/runs/41612455458) | Worker-slot timeout; cleanup passed           | 73m 36s |
| [Release Rivet 41547909287](https://github.com/valerypopoff/rivet2.0/actions/runs/41547909287) | Proxy inventory guard failure; cleanup passed | 50m 18s |

Six successful image runs in the 12-run sample took 31.3–35.4 minutes. Recent failed staging runs varied widely; their duration is not a baseline for successful releases.

## Where Build Images spends its time

The latest successful run's critical chain was approximately:

1. Build four application images concurrently and create the candidate manifest: 5m 26s from workflow creation.
2. Disposable Kind upgrade job: 25m 48s. The recovery scenarios run alongside it, not after it.
3. Assemble HA evidence: 40s.
4. Promote images/manifest: 3m 21s; an anomalously slow checkout alone took 2m 42s. The previous successful promotion job took only 43s.

Actual application build jobs took proxy 43s, executor 3m 10s, web 4m 6s, API 4m 26s. Individual runtime vulnerability scan jobs took 34–45s. API and executor are already amd64-only; proxy/web also build arm64. There is no evidence that removing arm64 or security scans is the main opportunity.

The Kind upgrade job included:

| Step                                         |      Elapsed |
| -------------------------------------------- | -----------: |
| Managed Kubernetes functional gate           |        3m 3s |
| Full HA gate                                 |      18m 23s |
| Kind deletion                                |       1m 59s |
| Cluster creation                             |          49s |
| Other setup, scheduling checks and artifacts | About 1m 34s |

Within the full HA gate, `full-upgrade` alone took 17m 3s. Logs show serial retirement across replicated developer backends, maintenance and execution owners. Browser acceptance for two browser contracts took about 51s combined. Recovery jobs took 17m 42s and 18m 6s overall. Removing only those recovery jobs would save runner work, **not** the critical 25m 48s upgrade job.

Other parallel costs matter after the Kind bottleneck is removed: exact-source qualification image publication took 11m 48s; the final repository verification job finished about 14m 25s after workflow start. Its slowest contract shard spent 11m 6s running tests. Blindly moving Kind to another workflow while retaining every broad verification job as a serial prerequisite would still leave a substantial wait.

### Repeated qualification toolchain builds

The actor publication job took about 12 minutes in all three detailed image runs. Unlike the application image jobs, its plain `docker build` path has no cross-run cache import/export. The current run rebuilt Helm (197s), kubectl (207s) and esbuild (237s), overlapping within about four minutes, then installed dependencies and built the runtime/editor (194s). Exporting the actor image layers took 32s; archives, probes, scans and publication consumed the remaining time.

Application Dockerfiles already place deployment scripts after expensive application compilation. That optimization is implemented; do not propose it as new work. The qualification actor still copies the entire exact-source clone before its application build layer, so every commit invalidates that layer.

### Failure feedback is unnecessarily late

In run 41599695194, API/proxy scans failed at about minute 5½. Kind work continued until the workflow ended at minute 26½. Kind currently depends on application builds and the candidate manifest, not successful scans. Matrix `fail-fast: false` also preserves sibling work. This is approximately 21 minutes of avoidable elapsed time after a definitive release blocker.

## Where staging spends its time

Run 41612455458 reused an already-successful image build; it did not rebuild images. The top-level execution step took 70m 33s. Input/dependency/authentication/setup steps account for only about three minutes overall.

| Phase                                                                               | Approximate elapsed |
| ----------------------------------------------------------------------------------- | ------------------: |
| Workflow input validation, authentication and setup                                 |                  3m |
| Actor scheduling/image startup and predecessor fixture preparation                  |              7m 50s |
| Partial rollout before the blocked candidate-owner wait                             |                 30m |
| Wait for the existing old execution ordinal to become a new candidate               |                 20m |
| Settlement, fixture deletion, cloud absence verification, export and runner removal |             12m 47s |

The ordinary-upgrade report ran from 09:47:47 to 10:37:47 UTC. Approximately 30 minutes preceded its 20-minute timeout. Retained observations show initial bridge preparation/handoff, template replacement and singleton backend replacement during that interval. These subphase boundaries are observations, not individually instrumented exact durations.

The blocked slot was an actual updater defect: the original inventory had two execution owners, but autoscaling created old ordinal 2 before the new template was applied. The updater requested three replicas and waited for ordinal 2 to have the candidate image/revision. `OnDelete` does not replace that existing Pod automatically. Final traffic checks recorded 8,623 workflow samples and 2,946 web samples without failures; the update nevertheless could not complete. There was no final continuity acceptance report.

Cleanup began around 10:38:35. The last fixture Pods exited by the 10:45:51 observation; namespace absence was observed at 10:48:17, and cleanup acceptance at 10:49:19. The workflow finished at 10:50:34. Independent resource absence and lock closure followed. Proxy preStop is 420 seconds, so a substantial part of teardown repeats a production-strength drain delay after accepted-work settlement.

Removing the 20-minute timeout does **not** imply a successful 54-minute qualification: actual execution replacements and the return handoff did not run. No successful focused GKE run exists in this sample from which to promise a normal-release duration.

## Reassessment: corrections to the original proposal

The next implementation should be a bounded repair and feedback improvement, followed by one useful qualification. It should not require a new release architecture before the first successful protected update.

| Gap in the earlier plan                                                              | Revised decision                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start GKE while Build Images is still running                                        | Defer. Current admission requires a completed successful main build, its candidate and promoted manifests, and completed ordinary HA evidence. Overlap would require new admission/publication contracts, not just a `needs` change.                  |
| Promise a 6–8-minute failed workflow after gating scans                              | Distinguish blocker detection, downstream work avoided, and total completion. Scans exposed the sampled blocker around minute 5½ already; parallel repository verification and actor jobs could still run until roughly minutes 14 and 12.            |
| Shorten Kind's shutdown waits as a quick saving                                      | Its HA fixture already uses 5-second preStop/45-second grace. The separate 60-second routing window followed a reproduced 503; accepted-work probes intentionally last 105 seconds. Preserve these until a separately validated timing policy exists. |
| Make caching, selective tests and component delivery one implementation prerequisite | Fix correctness and fast feedback first. Add ordinary cross-run caching within the existing image path. Defer new artifact types, component provenance and change-dependent certification.                                                            |
| Treat the extra execution Pod as merely an impossible readiness wait                 | Repair the reconciliation itself, including all old owners created outside the frozen inventory and final pool verification. A faster error alone does not make the update work.                                                                      |
| Infer successful GKE duration from failed runs                                       | Remove the 20–35-minute promise. No successful focused run in this sample establishes that baseline, and unfinished rollout work would add time after the captured timeout is fixed.                                                                  |
| Accelerate teardown with a new fixture shutdown bypass                               | Retain graceful cleanup and independent absence/lock checks. Measure cleanup separately; a second shutdown protocol is not justified before a successful baseline.                                                                                    |

## Boundaries that stay unchanged

- One repository, the existing Build Images and Release Rivet workflows, and the retained staging cluster/Gateway/certificate. No new repository, persistent runner fleet, release orchestrator or public toolchain image is needed for this tranche.
- Build once; qualify the exact successful build, image digests, chart, source, run attempt and installed predecessor. A published pointer is not proof of what is installed.
- Keep all currently required scans, source-integrity checks, ordinary Kind upgrade/recovery scenarios, and production admission checks. Keep the existing provider distinction between focused ordinary tests and separately configured stress tests.
- Keep complete 300-second responses across the actual worker/proxy replacements, routing/draining/readiness checks, final health, accepted-work settlement and recording/data checks. Do not reduce production timeouts, propagation windows or graceful termination to meet a duration target.
- Keep the first-adoption bridge. Later protected updates use the ordinary path; no manufactured second release or second campaign is a prerequisite.
- No automatic paid retry, workflow-wide cancellation of a running provider operation, forced Pod/finalizer deletion, or production activation is authorized by this performance plan.

## Implementation sequence

### A. Repair the observed updater defect and put its regression first

**Required before another staging attempt.**

1. Reproduce autoscaler growth before template application: inventory says two owners, but old ordinal 2 already exists when the desired replica count becomes three. Assert the old behavior fails the new regression before changing the strategy.
2. Reconcile the live cooperative execution pool against the desired image **and controller revision**. An existing old `OnDelete` Pod is capacity, not a replacement that will update itself. Use the guarded retirement/replacement path; inspect all relevant live ordinals before declaring the workload complete, including growth during the roll. Preserve the journal's original identity/baseline and recovery semantics rather than rewriting them from an unrelated fresh snapshot.
3. Preserve the replica ceiling, UID/incarnation ownership, lease, withdrawal, accepted-work drain and two-other-serving-owner safeguards. Cover the ceiling case without assuming an empty surge slot. If safe replacement capacity is unavailable, stop with an actionable capacity diagnosis while retaining serving owners.
4. Add prompt diagnosis only for states the controller cannot resolve automatically. An old Pod waiting for an explicit `OnDelete` replacement must not consume a 20-minute candidate wait. A terminating owner, a pending valid replacement, an image pull or actual accepted work can still progress; retain their bounded waits. Report workload/Pod, observed versus desired image/revision, elapsed time and blocked condition without credentials or private configuration.
5. Cover old-image and same-image/stale-revision extra owners; growth before and during templates; ceiling/pending capacity; recovery after lost scale, withdrawal or deletion acknowledgements; and final verification that no old serving owner is overlooked. Keep existing no-replay and recovery tests.

Owners: `deploy/studio-server/scripts/lib/ha-rolling-upgrade.mjs`, `lib/ha-kubernetes-rollout.mjs`, their tests and the existing journal/autoscaler seams. Avoid creating a second reconciliation or recovery protocol.

**Acceptance:** the new captured-race regression fails before the repair and passes afterward; safe replacement completes without requiring a nonexistent empty ordinal. Genuine no-capacity cases stop safely, and recoverable pending/terminating cases are not misclassified as fatal.

### B. Add one cheap gate and correct workflow dependencies

**Required before publishing the repaired candidate.**

1. Define one shared source-contract command, using Node 24 and immutable workspace dependencies. Start with the strategy, routing-withdrawal and headroom suites, then include the new race regression and the focused workflow-policy checks. It must not require application compilation, Docker, a browser or GCP. Verify it in a disposable clean checkout without compiled workspace outputs; a warm developer checkout alone does not establish that prerequisite. Do not put the entire 11-minute deployment suite in this gate.
2. Run that command early in applicable PR verification and on the exact Build Images source. Make application builds, qualification-actor compilation and the expensive verification lanes wait for its success. Direct qualification-image publication must also perform the same cheap check before compilation; the parent dependency alone does not cover that manual entry point. Reuse the command rather than duplicating the test selection.
3. Make the Kind matrix wait for successful runtime scans as well as its current inputs. Keep the three scenarios parallel and broad verification parallel with image work after the cheap gate. Do not serialize all repository verification ahead of the images, or add the 12-minute actor job as a prerequisite to local Kind tests that do not consume it.
4. Preserve required status contexts and explicit promotion assertions. A failed/cancelled/skipped prerequisite must not become successful evidence through an `always()` aggregate. Independent diagnostics and cleanup still run when resources have been created. Paid GKE admission already requires the successful build and exact tooling publication; preserve that contract.
5. Extend the existing workflow-contract tests: inject source failure, scan failure, cancellation and skipped prerequisites; assert blocked builds/Kind/promotion as applicable and retained cleanup. Cover push, manual and reusable entry points. Do not add broad automatic retries or a global cancellation mechanism.

Owners: `.github/workflows/studio-server-images.yml`, `studio-server-verify.yml`, `studio-server-publish-qualification-images.yml`, `scripts/checks/check-ci-workflows.mjs`, `scripts/ci/ci-performance.test.mjs` and a small shared command in the existing script/package layout.

**Local feasibility measured during reassessment:** the existing three suites below passed all 105 tests in 4.92 seconds wall time on Windows. This excludes CI checkout/install and does not cover the new missing regression; it establishes that these source contracts need not wait for application images. The source job now permits a five-minute cold checkout within an eight-minute total budget; PR #239 exposed the earlier two-minute limit as shorter than a successful sibling checkout. The 30-second stalled-transfer guard remains in place.

```powershell
node .yarn/releases/yarn-4.17.1.cjs node --test deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs deploy/studio-server/scripts/ha-routing-withdrawal.test.mjs deploy/studio-server/scripts/ha-rollout-headroom.test.mjs
```

**Acceptance:** a deliberately failing source contract prevents all expensive dependents from starting; a failed runtime scan prevents every Kind scenario and promotion. Confirm the dependency graph and failure propagation in contract tests first, then observe the next normal CI run. Target actionable source failures within three minutes including CI setup; measure rather than assume it. These prerequisites may add a short delay to successful runs in exchange for avoiding long failed iterations.

### C. Measure the critical waits and use the existing build cache mechanism

**A bounded performance improvement; not a reason to postpone a ready qualification for a larger redesign.**

1. Reuse `lib/ha-proof-timing.mjs`, existing `[ha-phase]` logs and `scripts/ci/job-timing.mjs`. Add only the missing per-owner and provider subphase timing: templates, withdrawal, active-work drain, replacement readiness, handoffs, teardown and absence verification. Write sanitized elapsed summaries on success **and failure**. Diagnostics must not alter admission or cleanup results.
2. Record the first terminal blocker promptly, separately from cleanup completion and final workflow completion. Use streaming logs for immediate progress and the existing private evidence path for details. A GitHub summary alone is not an early notification while one long command is still running. Do not introduce a new monitoring service or public raw-log artifact.
3. Enable supported external BuildKit caching for actor/janitor builds, keeping the existing Dockerfiles, publication records and local archive/scanner path. The job deliberately disables Docker's containerd image store; use a compatible builder, such as a `docker-container` buildx driver with local image loading, and validate configuration-digest identity before adopting it. Merely adding GHA cache flags to the current default driver is insufficient. See [Docker cache driver requirements](https://docs.docker.com/build/cache/backends/).
4. Keep cache scopes distinct for actor/janitor/platform and trusted publishing contexts. Retain the clean exact-source context and fresh executable/archive/security probes. Export intermediate layers needed to reuse Helm/kubectl/esbuild compilation; bound cache-transfer time, keep credentials out of layers/logs, and let a cache miss use the normal cold build. A cache is an acceleration, not release evidence. Use the documented [GHA cache authentication and scope requirements](https://docs.docker.com/build/cache/backends/gha/).
5. First test cold/warm toolchain reuse within this existing path. Do not create a separately published base image or move the exact Git source overlay merely to obtain the first cache win. Reordering dependency/application layers is optional later work requiring complete-input and source-integrity tests; cross-commit application compilation reuse is not achieved by the first cache change alone.

Owners: `deploy/studio-server/scripts/build-temporary-staging-actor.mjs`, `scripts/build-and-publish-qualification-images.mjs`, the qualification Dockerfiles/publication workflow, `lib/ha-proof-timing.mjs` and existing provider evidence/reporting code.

**Acceptance:** injected cache options select a compatible driver and preserve the published image/archive identity; cold, warm and unavailable-cache paths retain required scans and source admission. On a normal CI publication, measure actual cache hits and total import/export cost. Keep caching only if the warm build benefits; if it threatens publication correctness, ship the repair/fast gate first and defer it. Local tests can validate wiring and invariants; they cannot prove a hosted cross-run cache hit.

The actor's approximately 12-minute build is currently parallel to a longer Kind path. Improving it saves runner work and future bottlenecks; it does **not** by itself halve Build Images. For Kind, the immediate action is to attribute the measured 17-minute upgrade to actual waits. The 60-second routing window in `lib/ha-routing-withdrawal.mjs` and 105-second probes in `lib/ha-release-probes.mjs` protect previously observed behavior. No timing reduction is accepted solely because a shorter fixture passes once.

### D. Publish once, then use one separately approved focused qualification

**The route to the user's rollout goal, not a performance experiment campaign.**

1. Finish A–B, run the affected strategy/adapter, source-admission, workflow/publication and evidence tests locally, and update their owning docs. Include C's safe, bounded improvements if ready; do not make deferred architecture changes a prerequisite. Review the new regressions against the actual failure, not only source-text assertions.
2. Investigate the existing [scheduled run 41623528847](https://github.com/valerypopoff/rivet2.0/actions/runs/41623528847) using retained logs. Its node-drain recovery error (`workflow recovery after execution node drain: fetch failed`) is separate from the worker-slot bug and remains unexplained. Determine whether it reveals a defect in the shared rollout path; fix shared correctness defects before qualification. If limited to the optional disruption scenario, track it separately with its existing status/requirements intact rather than adding disruption to the focused GKE test or silently treating it as passed. Use retained diagnostics and a targeted local regression; do not start another paid campaign to classify it. If shared-path risk remains unresolved, report that uncertainty before requesting a paid test.
3. When publication is separately authorized, commit/review the bounded change and use one exact-source Build Images result. Reuse successful immutable images; do not trigger another image build merely because a staging-only workflow is being dispatched. Existing admission still requires the completed successful build, both manifests, matching tooling and the installed predecessor.
4. Once those gates pass and the user authorizes a fresh allowance, run **one** focused test on retained staging with `deploy_production: false`. Preserve the real 300-second cohorts, the applicable initial bridge, final acceptance, cleanup and independent lock/resource closure. No automatic retry. Report any blocker immediately while safe cleanup continues.
5. Stop and report the qualified/unqualified result, first-blocker time, rollout time, cleanup time and exact build identity. Only a successful qualification plus verified cleanup can support a separately authorized protected production rollout. Live checks and the recovery checkpoint stay in the existing production command. Production is not part of the performance-plan validation.

**Completion for this tranche:** the captured worker race is repaired, cheap failures avoid expensive downstream work, the exact candidate has all existing required build evidence, and one approved staging run produces an honest acceptance/cleanup result. A successful focused run supplies the first usable end-to-end timing baseline. No second manufactured release or additional performance trial is required.

## Timing expectations and decision points

| Measurement                  | Revised expectation                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source-contract feedback     | Current local subset: 105 tests/4.92 seconds. Target CI blocker visibility within 3 minutes including setup; not yet measured there.                                                                                 |
| Runtime-scan feedback        | Sample blocker was already visible near minute 5½. New dependency gating prevents the following approximately 26-minute Kind work from starting; other parallel lanes may still determine final completion.          |
| Successful Build Images      | Observed 31–35 minutes. A cheap gate/scan dependency may initially add latency; actor caching cannot remove the current Kind critical path. Do not promise a 10–15-minute successful build from these changes alone. |
| Failed worker collision      | Repair the collision rather than consuming a 20-minute impossible wait. Other valid capacity/readiness/drain waits retain their own bounds.                                                                          |
| Successful GKE qualification | No measured baseline yet. Record first adoption, ordinary rollout and cleanup separately; do not infer success time by subtracting a timeout from a failed attempt.                                                  |
| Cleanup                      | Current observation was about 13 minutes including export/runner removal. Preserve the protected lifecycle and report it separately from failure detection.                                                          |

After a successful qualification, review the new critical path once. Select a further optimization only if it targets measured recurring time and has a bounded correctness test. Do not combine overlapping savings, tune one unusually slow checkout as though it were routine, or add another paid trial solely to benchmark CI.

## Deferred options and when they would be justified

These are alternatives for a later measured bottleneck, not additional items that must all be implemented:

- **Shorter Kind functional fixture timings:** consider only after attribution shows dominant avoidable waits and a design preserves tests of real withdrawal/draining behavior. Update the certificate semantics/validators together, retain the real provider profile, and use deterministic-clock unit tests for timing edge cases. The current 503 regression rules out simply lowering a constant.
- **Candidate-ready/GKE overlap:** consider only if a successful baseline shows serial certification latency justifies changing admission. Design explicit unpromoted-candidate evidence and final evidence joining, including cancellation/failure and paid-work cleanup. Do not relax the existing `assertRuntimeQualificationBuild` or ordinary-HA assertion merely to start sooner.
- **Selective certification or component image reuse:** consider after measuring how often unchanged components dominate work. Require complete dependency/input classification, conservative full checks for unknown/shared changes, exact component provenance and synchronized manifest/validator policy. Current forced full Build Images verification stays until that design is reviewed.
- **Separate lightweight orchestration artifact:** consider only if ordinary Docker caching still leaves orchestration-only edits expensive enough to justify a new versioned contract. Keep it in the monorepo if introduced; no separate repository is warranted by this audit.
- **Warm runners or fixture cleanup bypass:** consider only against a measured successful baseline, recurring cost and isolation requirements. Existing retained infrastructure already avoids cluster/certificate recreation. Do not add a second shutdown protocol now.

## Primary references

- [Docker cache backends](https://docs.docker.com/build/cache/backends/) and [GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/): explicit cross-run cache and driver requirements.
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): dependency failure propagation and concurrency cancellation.
- [Kubernetes StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/): OnDelete leaves existing Pods unchanged.
- [GKE load-balancer troubleshooting](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing): why NEG removal, drain and shutdown order must remain protected.
