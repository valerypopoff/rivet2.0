# Earlier preparation for HA CI

Status: implemented locally, November 22, 2026. Early preparation is opt-in via
`workflow_dispatch.early_ha_preparation`; normal push, tag and scheduled runs keep
the gated path. No application runtime behavior changes. This document covers
disposable GitHub-hosted Kind tests, not a staging or production deployment.

The workflow and local regression checks are implemented. A full exact-image
Kind certificate and the queue-inclusive hosted timing trials remain required
before enabling the early path by default; local mocks are not that certificate.

## Objective and measured limit

Move candidate-independent preparation off the critical path of `Build Images`
without changing what qualifies a release. Keep one fresh test environment per
scenario and the existing exact-source, scan, recovery and cleanup requirements.

The latest reviewed main run,
[44965926486](https://github.com/valerypopoff/rivet2.0/actions/runs/44965926486),
took 33m36s: 9m38s before HA, 22m16s in the upgrade job, and 1m42s afterward.
The upgrade job spent 2m28s before invoking its HA test command. Some of that
work consumes candidate artifacts and must remain gated. Therefore 2m28s is an
upper bound on preparation savings in that sample, not a promised gain. Its two
recovery jobs took 17m08s and 17m20s. This change alone cannot turn a 34-minute
workflow into a 15-minute workflow.

Main's reviewed source was `9e0506a39`. Develop already has earlier per-image
scanning, narrower image cache inputs and the migration-test split. Establish a
fresh baseline including those changes; do not attribute their gains to this
plan. Keep the source/artifact identities and job timestamps in the comparison.

## Design decisions

1. Start only the **upgrade** scenario early, after the existing successful
   source contracts and change classification. The two recovery scenarios keep
   their native image/manifest/scan prerequisites. This limits speculative
   occupation to one additional runner slot.
2. Preparation and the resulting upgrade test run on the **same runner**. A
   separate preparation job cannot transfer its running Docker/Kind environment
   to another standard GitHub-hosted runner.
3. Extract the current scenario job once into a reusable workflow. Both the early
   upgrade and the ordinary recovery/upgrade paths call that same implementation.
   Do not copy the 200-plus lines of setup, test and cleanup YAML into two jobs.
4. Put a small read-only admission helper between empty-environment preparation
   and candidate use. It checks the exact current run and attempt; it does not
   dispatch workflows, cancel other jobs, publish artifacts or mutate GitHub.
5. Bound the early opportunity to ten minutes from its first step. Before
   admission, pending producers or an unavailable GitHub metadata API can cause
   clean deferral to the ordinary upgrade job. That job retains its native
   prerequisites and 75-minute timeout. This is not a retry: the early path must
   not have consumed the candidate or started any HA test.
6. Commit to the early path only after confirming the required producers and
   pinning the exact artifact ID. From that point, validation, download, fixture,
   test, upload or cleanup failure blocks qualification; there is no fallback.

The existing rule that Kind jobs depend on `scan-images` becomes two explicitly
guarded rules: candidate-independent preparation may run after source validation;
all candidate/predecessor workloads and HA tests still require successful image,
manifest and scan gates. The policy checks enforce this narrow separation. Existing
guards must reject simply deleting `needs` without the replacement admission
and outcome checks.

## Work allowed before admission

On the early upgrade runner, retain the current versions and ownership rules:

- Check out the exact source and set up Node/Yarn.
- Verify disk capacity with the existing allowed-path cleanup.
- Install the immutable dependency set; select the current Kubernetes tools.
- Prepare the pinned browser image, loopback binding and read-only source mount.
- Install the existing pinned Kind version and create the empty four-node
  cluster with its private kubeconfig and ownership receipt.
- Run the unchanged hard-spread scheduling test, which uses synthetic Nodes and
  refuses application workloads in that cluster. Finish its cleanup before
  either candidate admission or successful deferral.

Do not resolve a mutable production pointer, pull/use candidate or predecessor
application images, install application dependencies into the cluster, run a
migration, start a traffic test or emit qualification evidence before admission.
The existing trusted fixture/tool images used for preparation are unchanged.
Do not prewarm application fixtures using an assumed predecessor.

Check the opportunity deadline before starting another preparation operation and
again before candidate admission. Let an already-issued mutation finish or fail
under its existing bound; do not abandon an uncertain `kind create` and declare
successful deferral. A setup failure is an error, not permission to hide it behind
the ordinary path.

## Workflow structure

Implementation owners:

| File | Responsibility |
| --- | --- |
| `.github/workflows/studio-server-images.yml` | Early/ordinary scheduling, explicit fallback condition, final gate wiring and optional manual A/B selector. |
| `.github/workflows/studio-server-ha-scenario.yml` | One reusable scenario job containing existing preparation, admission, test, artifacts and cleanup. `workflow_call` only. |
| `scripts/ci/ha-candidate-admission.mjs` | Bounded exact-run GET polling and candidate validation; injected transport/clock/signal for tests. |
| `scripts/ci/ha-candidate-admission.test.mjs` | Focused admission, timeout, paging, identity and cancellation tests. |
| `scripts/ci/ha-scenario-run.mjs` | Common CI shell: preparation deadline, admitted-path limit, scoped cancellation and child settlement. |
| `scripts/ci/release-workflow-policy.mjs` and its tests | Required DAG/outcome/cleanup checks, with no ignored qualification failures. |
| `scripts/checks/check-ci-workflows.mjs` | Apply those checks to the actual caller and reusable workflow. |

Reuse `deploy/studio-server/scripts/lib/managed-gate-command.mjs` for scoped
command cancellation and child settlement. Do not add another process manager,
certificate format, persistent preparation service or cross-run environment cache.

Use only two scenario execution modes: `early` and `after-gates`; early mode is
valid only for `upgrade`. The reusable workflow returns `proved` or `deferred`
only on successful completion, including cleanup. Failure/cancellation remains
a failed/cancelled job and is not an output enum masquerading as success.

### Preserve the caller contract during extraction

Use a local `./.github/workflows/studio-server-ha-scenario.yml` reference, keeping
the caller and callee on the same commit. Declare the scenario, execution mode
and effective `run_managed_disruption` boolean as explicit, validated inputs.
The caller computes the latter from the existing scheduled/manual conditions;
the callee must not read an undeclared dispatch input and silently select the
lighter managed test. Derive the existing scenario-to-context mapping centrally.

Caller workflow `env` does not propagate to a reusable workflow. Set the current
`IMAGE_NAMESPACE`, candidate tag, manifest paths, pinned browser/version,
loopback binding, kubeconfig and ownership paths explicitly in the callee.
Keep repository/SHA/full ref/run ID/attempt from the caller's `github` context;
verify the API identifies the images workflow, not the extracted workflow file.
Do not introduce mutable repository variables as substitutes for pinned values.

Keep `actions: read`, `contents: read` and `packages: read` on both sides. The
existing `GITHUB_TOKEN` is available to the callee; no `secrets: inherit`, new
cloud credentials or write permission is needed. Preserve caller cancellation
policy without introducing a matching callee concurrency group that cancels
the caller. Put `runs-on` and timeouts inside the callee, where they are supported.

The caller contains:

- An early upgrade job, needing `changes` and `source-contracts`, enabled only
  by the normalized early-preparation selection described below.
- The existing recovery job, now a two-scenario matrix needing the original
  `changes`, `build-and-push`, `release-manifest` and `scan-images` gates.
- An ordinary upgrade job with those same native prerequisites, additionally
  requiring either early preparation deliberately disabled or successful early
  cleanup with an explicit `deferred` result.
- The existing HA evidence assembler, waiting for the applicable upgrade path
  and both recovery scenarios. Preserve its public `managed-kubernetes-release-gate`
  check name and the existing certificate format.

| Early outcome | Ordinary upgrade | Qualification |
| --- | --- | --- |
| Deliberately disabled; early job skipped | Must run with native prerequisites | Require the ordinary upgrade report and both recovery reports. |
| `proved`, cleanup successful | Must be skipped | Require the early upgrade report and both recovery reports. |
| `deferred`, cleanup successful | Must run the complete upgrade | Require its report and both recovery reports. |
| Failed, cancelled, timed out, or missing/invalid outcome | Must not run as a fallback | Block qualification. |

This table applies when the classifier explicitly requires Kind. Preserve the
existing explicitly non-Kind branch if it is ever selected: all HA jobs skip and
no HA certificate is produced. Missing or invalid classification is not that branch.

Skipping the disabled early job must not suppress the ordinary job through
GitHub's implicit dependency-success condition. Use a cancellation-aware
condition with explicit success checks for every native prerequisite and the
exact allowed early result. A failed early job is never equivalent to a skipped,
disabled job. The ordinary path uses its existing current-run artifact download
and manifest validation, without adding the early path's REST polling dependency.

Outputs select the applicable path; they never substitute for a valid scenario
report. Exactly one upgrade report and all three distinct scenario/cluster
identities remain mandatory. Deferral emits diagnostics only, never an HA
scenario report or certificate. Do not overwrite same-name scenario artifacts.

Retain all promotion prerequisites, including repository verification, all image
and scan gates, candidate smoke, complete HA evidence and applicable provider
gates. Include the new upgrade-path results in the assembler's truth table.
Do not make the early job depend on the final assembler/promotion or wait for the
whole workflow to finish: that would create a deadlock.

Current main branch rules prevent deletion and non-fast-forward updates; the
readable ruleset does not add individual scenario status requirements. Recheck
before implementation and preserve any newly required status names without
changing branch rules. The public aggregate remains mandatory in either case.

## Exact-run candidate admission

Take repository, SHA, ref, run ID and attempt from the trusted workflow context.
Use only `actions: read`, `contents: read` and the existing GHCR read permission.
Do not copy an access token, signed download URL or arbitrary API error payload
into outputs or diagnostics.

The helper must:

1. Confirm repository/head repository, source SHA, the images workflow's exact
   path, run ID and current attempt. Reject any changed identity. Bind the full
   caller ref again in the candidate manifest. API `head_branch` is not a full
   ref: do not compare it directly with `refs/heads/...` or fabricate tag
   ownership from it. Preserve push-to-main/staging, tag, manual and scheduled
   contexts without resolving a mutable branch or tag tip.
2. Read jobs for that **specific attempt**, following pagination and checking
   `total_count`. Reject ambiguous matches. A changing/incomplete page snapshot
   remains unconfirmed and is polled again within the existing budget.
3. Require final `success` for `Create candidate release manifest` and each of
   `Scan runtime image (proxy|web|api|executor)`. Preserve structural guards proving
   that these jobs require all successful image producers and source checks.
   A successful step inside a job that subsequently fails is insufficient.
4. Fail promptly on failed/cancelled/skipped required producers, invalid JSON or
   identity mismatches. Once producers finish, allow at most 60 seconds within
   the remaining opportunity for artifact metadata visibility. A confirmed
   missing artifact after that grace is an error, not an older-attempt fallback.
5. Locate exactly one unexpired, nonempty artifact named
   `studio-server-candidate-release-manifest-<run-id>-<attempt>` in that run.
   Verify its repository/run/SHA/ref ownership and pin its immutable artifact ID.
   Artifact metadata does not supply an independent attempt guarantee: combine
   the attempt-specific name, job results and manifest's own evidence binding.
6. Pinning the validated artifact identity commits this runner to the test path;
   check the opportunity deadline immediately before that transition. Preserve
   the existing bounded read-after-upload handling: probe the pinned
   artifact's download endpoint without following/logging its signed redirect;
   retry only its temporary 404 for at most 60 seconds within the admitted-path
   budget. Other download errors fail. No branch-tip, latest-success or older
   artifact fallback is permitted.
   Once the ZIP is ready, recheck the current run/attempt and source identity
   before handing off the pinned ID. Keep the full 60-second visibility window;
   the final metadata read has at most ten additional seconds inside the shell's
   admission allowance. A rerun or cancellation during propagation must fail,
   not start another path.
7. Download the pinned ID through the existing maintained Actions mechanism.
   Set `merge-multiple: true` for the single ID: the pinned action otherwise nests
   ID-selected downloads under the artifact name, unlike its name-selected path.
   Validate the parsed manifest with the existing owner: source/ref/repository,
   `evidence.candidate.runId` and `runAttempt`, canonical digest, image digests,
   chart and recording/schema contracts. Compare any candidate-tag resolution
   with those immutable digests; never replace them with a tag's new contents.
8. Resolve and validate the predecessor only from that admitted manifest. Keep
   its installed-predecessor/publication-head distinction and bootstrap rules.
   Continue through the unchanged scenario binding and certificate validators.

Use a ten-second polling interval, a ten-second request timeout and a 2 MiB
metadata-body limit per response. Page in groups of 100 with at most 1,000 jobs
or artifacts per listing; an exceeded bound fails rather than truncating proof.
Read the attempt's job listing once per poll, not once per image. At most one
runner polls. Read artifact metadata only when the producers are ready.

Before the admission transition, allow at most two consecutive retries for
transport errors, timeouts, 5xx or confirmed rate limits. Honor `Retry-After` and
rate-limit reset headers; never shorten a server-required wait to fit the budget.
This includes numeric and HTTP-date `Retry-After` values on 503 responses.
Rate limits may be 403 or 429; a permission-denied 403 is still a hard failure.
If the wait cannot fit, or transient retries are exhausted, stop polling and
cleanly defer to the native gated path. This preserves ordinary CI availability
without admitting an unchecked candidate. Authentication failures, contradictory
identity/evidence, invalid JSON and explicit producer failure remain errors.
After admission, API/download errors cannot trigger fallback.

Known authorization failures must not become transient failures because their
error body stalls. Discard bodies whose status/headers already determine the
outcome; only read a 403 body when needed to identify a secondary rate limit.

The opportunity deadline also applies when pagination or artifact metadata stays
unconfirmed; it does not allow truncating or guessing evidence. Honor cancellation
during fetch and backoff. Consume or cancel every response body, including
retry/status probes and oversized responses. Record a bounded reason code for
deferral; do not print raw API responses or signed URLs.

For partial GitHub reruns, never borrow a prior attempt's manifest or successful
scan rows. If the attempt cannot supply matching producers/evidence, stop with a
clear instruction to rerun the producer chain or full workflow. This preserves
the existing attempt-bound artifact policy rather than adding implicit reuse.

## Cancellation, cleanup and deadlines

- Keep normal success-dependent job conditions. Never use job-level `always()`
  to keep speculative work alive after cancellation. Use `always()` only on the
  existing bounded cleanup/diagnostic steps and the final fail-closed assembler.
- Handle SIGINT/SIGTERM in the admission helper; abort active requests and waits
  immediately. Cancellation is not deferral and must not start the ordinary job.
- Join or stop outstanding preparation/polling child processes before removing
  their resources or reporting an outcome. Once cleanup or deferral starts,
  late-arriving producer results cannot resume preparation or launch a test.
- Keep the browser container's exact ID and owner-label check, the cluster's
  run/attempt/scenario receipt, private kubeconfig and owned-container cleanup.
  Both successful paths and deferral require successful cleanup. Cleanup failure
  blocks qualification even if the test itself passed.
- Skip the Kind cleanup command only when its creation step was skipped. This
  allows deferral before Yarn/dependency setup without invoking unavailable
  tools. A successful, failed or cancelled creation attempt still reaches the
  existing receipt-based cleanup; uncertain ownership remains an error.
- A partial Kind creation without a confirmed owned-ID receipt remains an error.
  Do not broaden cleanup to name-based pruning or delete another cluster. Capture
  available ownership diagnostics. Abrupt runner loss cannot guarantee in-job
  cleanup; all resources stay on the disposable hosted VM, with no cloud resources.
- Preserve the ordinary 75-minute scenario-job allowance. For the early path,
  record one opportunity deadline in the first step and enforce it across setup
  and polling. Enforce a separate maximum 75-minute admitted-path budget through
  the existing command cancellation support, retaining shorter operation limits.
  An outer 95-minute cap leaves ten minutes for the opportunity and ten for final
  cleanup/post-job work; it must not silently extend the admitted-path budget.
  A timeout is a failure, not deferral. Slow image builds still use the native
  late path rather than receiving a new ten-minute build deadline.
- An already-started early preparation command has a five-minute termination
  bound, while shorter native step limits remain in force. Expiry during a
  command fails the job and settles its children; only expiry between operations
  can cleanly defer. Ordinary gated preparation keeps its existing allowance.
- Admission polling has its own phase, using the remaining original opportunity
  plus at most 70 seconds for ZIP visibility and process settlement. It must not
  inherit the five-minute preparation-command cap or restart the ten-minute
  opportunity. Candidate execution retains its separate admitted-path deadline.
- Do not change the 60-second continuous routing window, 105-second accepted-work
  fixtures, lease timing, retry/non-replay rules, replica counts, node topology,
  scheduling cases, previous/current browser checks or scenario ordering.

## Runner queueing and acceptance of the optimization

Keep one early runner, not three. Recovery jobs remain late. Do not increase
matrix concurrency, buy a runner fleet or create persistent test clusters.
Record time spent preparing, waiting, deferred cleanup, actual tests and final
cleanup separately. Also collect native job creation/start/completion times.

Test a delayed early runner: if producers are already ready when it starts, the
same job validates admission and runs normally. Test the opposite case: producers
remain queued beyond the opportunity, so early cleanup completes and the native
late job waits for them. No waiter may depend on its own completion or that of
the fallback. Under very tight shared capacity, the early waiter may delay a
producer; prove its bounded deferral releases the slot instead of waiting forever.
Do not claim the repository has spare slots without measuring actual queueing.

The ten-minute window is a fixed first bound based on the reviewed ordinary
producer lead time, not a setting to extend until a favorable timing appears.
Include deferral-boundary cases: a candidate arriving while cleanup starts must
use the late path, not launch both tests or re-enter the early path.

Use recorded job durations to model 20- and 40-slot limits and additional
unrelated jobs as stress scenarios; these are not claims about account entitlement.
Simulation can expose deadlocks and pressure but cannot establish hosted queue
timings. Compare full `Build Images`, its parallel `Build`, verification and
applicable desktop workflows, and total concurrent runner work in the real
measurements. Include a saturated-slot case, not only 20/40-slot simulations.
Report each sibling's duration; a faster image job with a slower last required
workflow is not an end-to-end improvement.

## Implementation status

The five implementation steps below are complete, including the source-only local
checks. Full image-backed Kind certification and hosted timing trials remain
pending; they gate default activation rather than this opt-in implementation.

1. Freeze the current test/step inventory and prerequisite graph. Extract the
   shared scenario workflow with only ordinary scheduling first. Prove that all
   existing commands, explicit inputs/env, artifacts, cleanup and gates are still
   selected. Preserve scheduled/manual disruption and optional-provider behavior.
2. Implement/test the admission helper, including exact attempt paging and the
   artifact visibility race. Do not generalize the desktop helper or add a new
   workflow orchestration framework for this one consumer.
3. Add the one early upgrade path and explicit pre-admission deferral. Wire the
   ordinary upgrade and assembler truth table; retain the recovery matrix's
   native prerequisites and the existing promotion guards.
4. Add timing/diagnostic output and update the actual-workflow policy checks,
   their mutation tests and the source-suite selection. The guards must understand
    the separation rather than simply weakening the old scan dependency.
   Add the reusable workflow and admission helper to the image workflow's push
   paths and review `ci-change-policy.mjs`: a later edit to either must exercise
   its owning gates. Keep new source-only tests in `verify-rollout-source.mjs`.
5. Complete source-only local validation before a commit/push or hosted trial.
    Update this plan and `ci-performance.md` with implemented versus measured status.

A manual `early_ha_preparation` boolean starts as an opt-in for same-source A/B
measurements. Ordinary push, tag and scheduled behavior stays gated until the
hosted acceptance criteria pass. Normalize the choice once in `changes` and
validate it as a boolean in the workflow policy. Disabled means skipping the
early job entirely, with no runner allocation or resource creation; the ordinary
job still runs every test. After measurement, a separate reviewed default change
may enable early preparation for normal triggers. The manual selector remains
useful for comparison; it cannot skip any release gate.

## Local validation

Keep tests lean: parameterize outcome/identity mutations, use an injected clock
for long waits, and use a small real child-process/Docker fixture for signals.
The workflow-policy tests clone the actual configuration through the same strict
YAML loader as the repository gate, instead of maintaining a second hand-written
workflow or inspecting JavaScript implementation text. Admission fixtures keep an
independent required-producer list; deriving it from `HA_PRODUCERS` would hide
accidental omissions. Keep protocol/clock cases in the fast fixture and reserve
real HTTP for transport,
body failure, ZIP propagation and cancellation. Bound real-I/O tests and stop
their children in cleanup even when an assertion or test timeout interrupts them.

- Admission: ready, queued/running, upstream failure, cancellation, attempt
  change, wrong repository/SHA/ref/workflow, missing/duplicate/expired/replaced
  artifact, pagination/changing pages and transient pinned-download 404. Cover
  all supported ref/event types, including tag refs and partial reruns.
- Availability: transport timeout/5xx and rate-limited 403/429 defer only before
  admission; permission-denied 403, malformed evidence and explicit failed gates
  fail. Retry deadlines do not reset or truncate server-required waits. The
  ordinary path runs without the new polling API. No unchecked candidate starts.
- Routing: disabled early preparation allocates no early runner; early proof
  succeeds; early defers then late proof succeeds. A genuine test/validation
  failure never starts fallback. Cleanup failure blocks both certification and
  fallback; unexpected skips, missing outputs and duplicate reports are rejected.
- Deadlines: slow setup, a delayed runner, admission at the boundary, a candidate
  arriving during cleanup and the admitted-path timeout. A 95-minute outer cap
  must not turn into permission for 95 minutes of test execution.
- Real cancellation: interrupt while awaiting a response, during backoff, after
  resource creation and during the admission transition. Assert child termination,
  owned cleanup and no late candidate/test start. Partial creation remains held.
- Workflow mutations: reject missing source or scan gates, waiting for overall
  workflow success, permissive `continue-on-error`, missing cleanup, wrong artifact
  identity, non-native fallback prerequisites, or an assembler accepting a missing
  scenario. Catch lost env values, omitted disruption inputs, matching cancellation
  groups, disabled-path skip propagation and unsupported reusable-call keywords.
  Preserve scheduled/optional-provider paths and cancellation semantics.
- Existing HA evidence, source contracts, routing-withdrawal, runner-space and
  cluster-ownership tests remain required. Add the new tests to the actual source
  selector, not only a locally invoked file.
- Run `yarn node scripts/ci/verify-rollout-source.mjs`, the focused new tests,
  `yarn test:style`, `yarn studio-server:verify:test-style`, the YAML policy check
  and actionlint for both workflow files. Run the full disposable Kind proof once
  on the final code, including both recovery scenarios and retained-browser acceptance. Use the
  existing `kubernetes-ha-release-gate.mjs certify` owner and required explicit
  disposable context; do not substitute unit tests for its certificates.
- Run Build's separate image/launcher contract command:
  `yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/proxy-image-contract.test.ts`.
  Its managed-test command assertions follow the reusable scenario workflow; the
  caller must still invoke that workflow. Root style/source checks do not run this
  independent contract suite.

## Hosted validation and completion criteria

Hosted measurements are a later, explicitly authorized step; none were run while
implementing this change. No GKE/staging/prod deployment is required for this CI work.

Run matching complete baseline/early workflows on the same final source, with
the manual selector as the only behavioral difference. Include one warm and one
cold-cache pair, alternate order where practical, and avoid comparing a filtered
summary with a full run. Record the image digests, test inventory, run attempts,
job queues and total runner-seconds; preserve failed trials as failed evidence.

Pin the same installed predecessor with the existing manual input and verify
both trials use the same HA mode and browser contract. A changed predecessor or
bootstrap/mixed-mode switch invalidates the timing pair. Record the separately
validated publication head; do not freeze or bypass its freshness checks.
Keep provider/capacity/evaluation deployment inputs off for these disposable
Kind trials. Normal registry publication remains subject to every existing gate.

Accept only when:

- Every old qualification/safety check passes, and the assembler accepts exactly
  one real upgrade proof plus both independent recovery proofs.
- Both early and deferred paths, producer failure and owned cleanup have direct
  evidence; no uncertain write or test execution was replayed.
- Normal main runs show a repeatable shorter end-to-end image path, with no
  material regression in sibling workflows attributable to occupied slots.
  A warm/cold pair alone is an initial observation; collect more if the effect
  is within queue/runtime variance.
- Saved time comes from preparation overlap. Do not count moved work, skipped
  tests or a shortened propagation/lease window as a speedup.

If queueing or deferral erases the gain, retain the ordinary gated behavior and
document the result instead of expanding speculative concurrency. Only consider
starting the recovery scenarios early after this single-runner design has passed
those gates and a separate measurement justifies the additional slots.

## Local implementation checks

The regression suite exercises real loopback HTTP through the existing
repository-owned GitHub mock, plus controlled clocks for long polling windows.
It covers incomplete or failed producers, exact attempts and artifacts, transient
ZIP visibility, response-body timeouts, rate limits, cancellation and cleanup
outcomes. A Linux-only test runs the actual common shell, cancels its child and
verifies that the process is gone before fresh cleanup proceeds. The workflow
policy also rejects removing gates, losing dispatch inputs, changing the pinned
download layout or accepting a failed/duplicate upgrade path.

Local results and remaining release checks are recorded in
[CI performance](ci-performance.md). The real hosted DAG, exact artifact transfer
and runner queue savings must still be verified on a complete authorized run.

## External contract references

- [GitHub workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)
  explains job-condition reevaluation and the eventual forced-stop limit.
- [GitHub workflow jobs API](https://docs.github.com/en/rest/actions/workflow-jobs)
  provides attempt-specific job reads and pagination.
- [GitHub reusable workflow contracts](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)
  covers caller env isolation, permitted keywords, token scope and cancellation groups.
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
  covers rate-limited 403/429 responses and required backoff.
- [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
  defines server-directed backoff, including 503 responses.
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
  describes shared concurrency and hosted-runner execution limits.
