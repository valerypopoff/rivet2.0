# GitHub Actions performance

Optimize measured critical paths without dropping coverage, weakening release
gates or reusing an unverified build from another commit. Standard GitHub-hosted
runners for public repositories are free; these changes need no paid runner.
Branch targeting, signing and protected deployment safeguards remain unchanged.

Measure elapsed time from the push to the last required workflow completion,
including runner queues and prerequisites. Parallel job durations must not be
added together. Local compiler timings establish cache behavior, not an
end-to-end CI speedup; compare the hosted critical path before making that claim.
For reference, main Build Images `44965926486` took 33m36s: 9m38s before the
longest HA lane, 22m16s in that lane and 1m42s for final assembly/promotion.
Its other HA lanes took about 17 minutes each. Optimizing only the longest lane
therefore saves at most about five minutes before another becomes critical.
Keep the full real-time routing-withdrawal, accepted-work and recovery proofs;
look for independent preparation and duplicated work around them, rather than
reducing their protection windows or assuming a faster compiler halves the run.

## Current priorities: November 22, 2026

Use this ranking for new performance work; later sections retain earlier evidence
and procedures, including proposals that have since been measured or superseded.

The baseline [full verification](https://github.com/valerypopoff/rivet2.0/actions/runs/45048439797)
passed all 19 jobs and 396 browser cases in **18m46s**. Its managed-storage lane
took **13m25s**, including **8m07s** in VM-to-managed migration verification.
The slowest browser job took **10m29s**; the gateway lane took **9m50s**. These
are parallel job times, not durations to add together. The source/build path
finished about 5m12s after the workflow started.

**Implemented and verified on GitHub: the complete VM-migration integration suite
has its own required parallel job, alongside the other managed-storage checks.**
It owns its temporary roots, PostgreSQL and MinIO containers, environment and
cleanup. It does not require the preceding managed tests' data. Preserve the existing serial order
inside `workflow-storage-migration-managed.integration.ts`: its negative cases,
idempotent retries, source mutations, rollback checks and supervised restores
deliberately share fixture state.

`studio-server-verify.yml` now has four deployment-contract lanes: `managed`,
`migration`, `deployment` and `gateway`, with up to four separate standard runners.
They retain the same source/build prerequisites, verified exact-commit artifact,
20-minute job limits and fail-fast-disabled behavior. The existing final status
requires the entire matrix, including the migration job.

The migration job checks its compiled schema CLI, serving API and executor bundle
before running the unchanged, complete integration entry through the pinned Yarn
CLI. This avoids the redundant API rebuild in `test:migration-managed`. That
ordinary local build-and-test command remains unchanged; so do the fixture's
fresh child processes, internal ordering, resource limits and cleanup. Missing
or empty compiled artifacts fail before test infrastructure starts. The reduced
`--supervised-restore-only` feedback mode is not used by CI.

`assertParallelMigrationVerification` guards lane membership, concurrency,
artifact-verification ordering, exactly one complete migration invocation and
the final required result. Regression mutations cover omitted prerequisites,
serialization, skipped/filtered/duplicated commands and ignored failures.

Local validation passed the unchanged complete migration suite through the new
CI command, including both supervised restores. The independent PostgreSQL
schema suite also passed while migration was running. Missing/empty runtime
artifacts and failed/cancelled/skipped final results were rejected. All ten
workflow-policy tests, `yarn test:style` and actionlint passed; the fixture cleaned
up its containers without changing the existing local development stack.

Hosted validation on `d10faabc9` passed both workflows on their first attempts:
20 Studio Server jobs, 17 Build jobs and all 396 browser cases. The migration
log confirms the complete copy/retry/verification fixture and both supervised
restore variants; CI did not use the reduced feedback mode.

| Workflow | Previous full run | After the split | Observed reduction |
| --- | --- | --- | --- |
| Studio Server verification | [18m46s](https://github.com/valerypopoff/rivet2.0/actions/runs/45048439797) | [16m10s](https://github.com/valerypopoff/rivet2.0/actions/runs/45052324511) | 2m36s (13.9%) |
| Build | [10m17s](https://github.com/valerypopoff/rivet2.0/actions/runs/45048208040) | [9m33s](https://github.com/valerypopoff/rivet2.0/actions/runs/45052324608) | 44s (7.1%) |

These timings run from workflow creation through the last job's completion,
including setup, artifact transfers and runner queueing. The Studio baseline
was a full manual run on `0c4461315`; its preceding filtered push skipped heavy
verification and is not a comparable baseline. This is one before/after pair,
not a guaranteed saving on every push. Build was not the optimization target;
its timing difference can reflect runner/cache variation.

The managed/migration section fell from 13m25s to 7m55s, including the new
migration job's 37-second later start. Managed checks took 3m40s; the separate
migration job took 7m18s, with 6m42s in the complete integration step. The slowest
browser job now took 10m40s and determined the overall finish. Further migration
optimization alone will not shorten that browser-bound path. Profile the
remaining browser work before increasing its runner count.

Summed Studio job time fell from 109m21s to 101m50s; Build increased from 41m11s
to 45m17s. These sums describe concurrent runner work, not wall-clock durations
or billed minutes. Preserve full coverage and compare both measures in future
experiments. Exact job metadata and migration logs are in ignored
`artifacts/ci-migration-split-20261122/hosted/`.

The migration harness also repeatedly launches the CLI through Yarn/tsx, and
logs show roughly ten-second intervals between many child results. That is a
profiling lead, not proof that TypeScript translation dominates. A small local
Windows invalid-command startup probe measured median source startup **7.74s**
and compiled startup **8.56s** (three launches each). Simply switching to compiled
JavaScript has **no demonstrated startup benefit**; do not count it as a saving
or replace process-isolation tests with in-process calls. Profile imports and
startup separately if that work is pursued later. Evidence is in ignored
`artifacts/ci-critical-path-20261122/`.

The [Intel-on-Apple-Silicon experiment](https://github.com/valerypopoff/rivet2.0/actions/runs/45047306470)
passed signing, notarization and native Intel checks with matched Rust/Xcode/SDK
versions. Its warm rebuild was 108s versus 170s on Intel, but the additional
native verification cost 203s. Removing intentional warm-ups gives an estimated
checked path of 8m02s versus 7m43s, excluding queueing. Keep the normal native
release runners; this did not establish an overall warm-path speedup.

For **main**, `Build Images` invokes this same verification with `force: true`,
so it can benefit from a shorter verification lane. However, the reviewed main
33m36s baseline used source `9e0506a39`, before the current develop optimizations;
its 22m16s HA lane was longer than verification. Do not claim a three-minute
main workflow saving from this split. At the next approved merge, measure the
updated image/HA path first, then target independent cluster/image preparation
and repeated setup if they remain dominant. Preserve actual drain, routing and
recovery observation windows. Bundler replacement and additional browser
parallelism are lower priorities until a current critical path justifies them.

The next main optimization is implemented locally in
[earlier HA CI preparation](ha-ci-early-preparation-plan.md). The shared
`studio-server-ha-scenario.yml` keeps one upgrade proof and both recovery proofs.
Only the upgrade runner can prepare early, with exact-run admission and clean
fallback before admission; recovery runners keep their native prerequisites.
`workflow_dispatch.early_ha_preparation` defaults to false, so normal runs retain
the gated schedule. Enable the default only after measuring the complete path
and sibling queues. No hosted speedup or full exact-image certificate is claimed.

Admission has a ten-minute opportunity distinct from the five-minute setup-command
cap. It verifies the current run and attempt again after pinned ZIP propagation;
failed gates, authorization failures and post-admission errors block qualification.
Server-directed backoff cannot extend the opportunity. Pre-admission deferral
requires owned cleanup; skipped cluster creation needs no cluster cleanup, while
attempted creation always does. No HA test or uncertain operation is replayed.

Local validation on November 22 passed all 922 release-source tests and all 25
final focused admission/policy tests in a disposable four-CPU Linux container.
The independent HA evidence and retained-application checks passed 60 cases.
Actionlint, workflow policy, formatting, root and Studio Server test-style gates,
file-tree checks and documentation-link checks passed. The publication-identity
fixture freezes its clock so manifest work cannot
age its synthetic janitor heartbeat. No application runtime code changed.

The admission and workflow-policy test cleanup removed 121 lines. Policy mutations
use the actual YAML; producer expectations remain independent of the implementation.
Transport stalls, authorization-body failures, ZIP propagation, rerun races,
deadlines and real child cancellation retain coverage. Local mutation checks
rejected omission of each of the five required producer jobs. These checks do not
replace full image-backed Kind certification or queue-inclusive hosted timing
trials; both remain required before default activation.

The first develop pushes exposed stale image/launcher (`45060256869`) and
repository-structure (`45060581836`) guards: they searched the caller for commands
and per-scenario artifact names moved into the reusable workflow. Both now check
the call and their original guarantees in the owning workflow, including the
`inputs.scenario`/run/attempt artifact binding. Their source restrictions cover
caller and callee. Run Build's separate `proxy-image-contract.test.ts` command and
`yarn studio-server:verify:repo-structure` alongside root style/source checks when
extracting workflow steps; those checks do not select these independent guards.

## Local pre-push recurrence checklist

Keep repeatable CI findings in `developer-docs/studio-server/ci-pre-push.local.md`.
The root ignore rule keeps its contents out of Git; `AGENTS.md` asks agents to
consult it during commit preparation and before a later push when inputs change.
Each finding should identify its scope, cause and concrete prevention check.
Keep unresolved findings explicit, merge duplicates, and omit incident timelines,
one-off errors and credentials. Apply only checks relevant to the final diff;
separate local pre-push checks from later exact-image/hosted-runner checks and
authorized release readiness. Use failed-test summaries and job/attempt metadata
to distinguish real failures from expected negative-test errors, downstream
refusals and unstarted jobs. This is a local preparation aid, not another CI gate
or cloud-test requirement.

For workflow YAML changes, also run [actionlint](https://github.com/rhysd/actionlint)
on the changed files before pushing, alongside the repository's workflow policy
check. YAML parsing does not validate GitHub expression-context availability.
The cache-isolation repair in `3c8dbba1a` passed the YAML/policy checks but GitHub
rejected `runner.temp` in job-level `env`. Local actionlint 1.7.12 reproduced the
same error. Resolve `$RUNNER_TEMP` inside a step and export through `$GITHUB_ENV`;
do not rely on a step-only expression context while defining the job.
For the expression/type check alone, use `actionlint -shellcheck= -pyflakes=`
with the changed workflow paths. Keep shell/Python validation separate when
those bodies change; disabling their external lint integrations does not disable
GitHub-expression checks.

The pinned-Yarn API shard smoke test accepts both TAP and spec-reporter summary
prefixes. Node's default reporter can vary with the output stream; a successful
selected shard must report a nonzero passing count, zero failures and exit zero,
without invoking the intentionally broken global Yarn shim. A reporter-prefix
difference alone must not fail this check.

The JavaScript security audit must also run before pushes even when manifests
and the lockfile are unchanged: registry advisories can change independently of
the source. `test:style`, an immutable install and Rust audit do not query npm's
current findings. A failed security gate also blocks exact-commit desktop
publication after successful compilation. The developer release tracks
`security/dependency-audit-exceptions.json` in its push paths so an audit-policy
repair can start publication for the corrected commit.

Refresh Rust's audit too, even for CI-only changes. The November 22 push found
new `RUSTSEC-2026-0592` in the unchanged desktop lockfile: `url` through 2.5.8
can overflow the process stack while resolving nested `blob:` origins. The
lockfile now selects patched `url` 2.5.9 and its required `form_urlencoded` 1.2.3.
No advisory exception was added. Validate both the unfiltered audit through
`check-rust-audit-exceptions.mjs --audit-report` and the configured
`cargo audit --no-fetch` from `packages/app/src-tauri`; a policy-only check does
not detect new findings in the live database.

After moving a file imported by the Studio Server consolidation, update its
reviewed successor in `verify-migration-ledger.mjs`, regenerate
`source-file-ledger.json` and run `studio-server:verify:migration-ledger`.
The November 22 context-menu move keeps project-summary behavior in
`WorkflowProjectSummary.tsx`; its ledger entry retains the original
`ActiveProjectSection.tsx` migration blob and records that current successor.
Repository style checks alone do not exercise this historical-source contract.

Desktop frontend handoff also checks the exact artifact's ZIP endpoint before
returning its ID. In run `45039671659`, GitHub listed a newly uploaded artifact
but its download returned 404 less than a second later. The listing alone is
insufficient evidence of immediate download availability. Poll only that 404,
for up to one minute within the existing overall deadline, and keep validating
the same Build SHA, run, attempt and artifact ID. Permission/server errors and
changed identities still fail; redirects are inspected without being followed.
The local GitHub contract covers delayed availability, permanent absence and
identity changes. Actual transfer still requires a successful hosted run.

Browser fixtures must follow the current UI ownership. After moving project
details into the context-menu header, the bundle-deletion survivor check opens
that menu before asserting Save availability; it still verifies the surviving
project ID, graph and dirty state. Settings padding checks explicitly constrain
the tab's width to exercise wrapped text across native fonts, then restore it.
They keep the production height/padding rules and the two-line assertions.

The November 18, 2026 withdrawal of the
[`picomatch` advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
removed finding `1247710` from the npm audit feed. The audit rejected the
unused exception and the entry was removed. `security:audit` also runs
`scripts/checks/check-runtime-glob-scope.mjs`, covered by the regression suite.
This static owner check traverses the actual Yarn
execution dependency graph, following production/optional/peer edges while
excluding workspace development tools, and rejects either glob package in the
SDK, CLI, App Executor or Studio Server execution paths. The web production
server uses Node built-ins and compiled assets; its Vite/ESLint build dependencies
are build-time dependencies. API/executor packaging removes the unused glob
packages only from owned runtime
copies, including workspace-local nested modules. Builders and managed library
releases remain intact; see [container policy](container-security.md#runtime-glob-packages-november-18-2026).
The main-only qualification actor applies the same omission after compilation;
its prepared probes and Playwright runner are covered by the dependency-scope gate.
Inventory global npm/pnpm bundles too: the workspace lock does not describe them.
Their Linux images omit only the hash-reviewed Windows node-gyp discovery parser,
while final-image installation/native-build probes preserve Linux functionality.
Review dependency ownership again when the execution graph changes.

## Image scan and compilation boundaries

Runtime-image builds scan their own completed immutable image immediately,
including reused proxy images. The existing `scan-images` matrix then verifies
those per-service/run/attempt artifacts against the final release manifest.
It recomputes assessments from sanitized inventories, checks scanner and source
identity, complete platform coverage, freshness and the unchanged High/Critical
policy. Missing, failed or mismatched evidence blocks qualification and promotion.
Both scanning and verification scripts are explicit Build Images push inputs.
No scan result from another release or workflow attempt substitutes for this gate.

API/executor `runtime-build` stages copy only Core, Node and their wrapper build
inputs before compiling the shared SDK. The web `hosted-dependencies` stage does
the same for Core and Evaluations. Consumers still receive the complete source
checkout before their own compilation and runtime packaging. This preserves
development targets and existing source resolution while keeping unrelated
application or rollout edits out of the expensive shared compilation cache key.
Dependency installation continues to depend on the complete workspace manifests,
lockfile, vendored Yarn and package-manager checks.

Keep external cache `mode=max` until a controlled cold/source/dependency-change
comparison establishes a better total cost. Docker's [cache modes](https://docs.docker.com/build/cache/backends/)
export different intermediate layers; a shorter export alone is not a faster
sequence of builds. Local BuildKit measurements and input-invalidation evidence
do not establish hosted GHA transfer costs or total workflow savings.

The November 22 local comparison built the original and revised web, API and
executor builder stages, then changed an unrelated package source input. Shared
compilation was reused by the revised stages. Single repeat-build observations
were web 80.2s to 66.4s, API 36.8s to 23.5s, and executor 26.2s to 12.9s. Initial
priming durations are not comparable cold-build measurements. All 3,786 checked
compiled/staged files matched byte-for-byte between the original and revised
builds. These are builder-output checks, not final-image scan qualification.

A separate disposable-builder pilot exercised fresh cache imports and a harmless
root-manifest input change. Both configurations rebuilt after the manifest change.
Its cache-only `min` and `max` exports had identical manifests and byte counts
(1,039,790,081 bytes each), so their elapsed times do not compare distinct policies
or justify changing GHA exports. Use an actual image/registry export and inspect
cache identities before drawing that conclusion in a future experiment.

Local validation passed the scan/policy tests on Windows and offline unprivileged
Linux, the 26 source image/launcher contracts, repository-wide `test:style`, Studio
Server test-style checks and five headless dashboard/dialog cases against the
actual compiled web output. Temporary container builders and the UI container
were removed; the existing development stack and build cache were preserved.
Evidence is under ignored `artifacts/ci-early-scans-20261122/`. Hosted timings and
exact-image scans remain the next normal CI run's responsibility.

## Rollout and chart contracts

The required deployment-command job starts after the source contracts pass, in
parallel with Studio compilation. It runs the complete `deployment-command.test.mjs`
file with the pinned Kubernetes tools and an immutable source-only Yarn install.
The post-build deployment job passes `--exclude-deployment-command` to avoid
repeating those journeys. For local verification, use `yarn studio-server:verify:kubernetes`
without arguments to run both groups. The final Studio verification requires both
jobs on applicable pushes, including when Build Images invokes the workflow.

Deployment-command tests compile their Helm/kubectl stand-in once per suite with
the existing esbuild dependency. Helper processes run that self-contained file
with the fixture clock preload, avoiding repeated Yarn loader initialization.
Each scenario retains its own state, locks and receipts. The deployment CLI
continues to run from the scenario's source checkout with normal Yarn resolution;
the real Helm binary still renders and validates the charts. The suite removes
its compiled helper during cleanup. Compare complete suite timings with identical
test selection and concurrency when changing this boundary.

The workflow policy rejects conditional or tolerated deployment-command tests,
filtered test selection and a missing final job result. Its failure-mutation tests
cover the early job as well as its source prerequisite. The fixture boundary test
checks that both simulated tools inherit the clock and caller-supplied environment,
while ordinary adapter children also retain the caller's Node preloads.

The November 22 commit preparation passed the complete 31-test deployment-command
suite with the cached pinned Helm and Node 24, plus the repository-wide
`test:style` checks. This is local coverage evidence; hosted job duration and
workflow success still require the next GitHub run.

Changes to release selection, editor topology or chart validation need both
`yarn studio-server:verify:production-cutover` and
`yarn studio-server:verify:kubernetes` with pinned Helm. The rollout source
suite covers a smaller set of tests. These commands use local fixtures and Helm
renders. Release selection tests verify that source, chart or checkout drift is
rejected before publishing deployment artifacts. Helm rejection tests check the
required controller without hard-coding the list of supported topologies.

## Schema and browser fixture contracts

The shared Docker launcher dotenv contract keeps a closed inventory of documented
inputs. Adding an option must update that inventory and verify the normalized
value reaches both API roles in the generated Compose model, including defaults,
explicit overrides and invalid values across all six launch modes. The durable
recording switch is covered by `container-server.test.mjs`; its explicit false
value must survive projection without changing storage identity. Kubernetes
defaults and opt-out behavior remain covered by `server-launch-mode.test.mjs`.
Run both files when changing shared launcher options rather than accepting a
documentation-only declaration or loosening the inventory assertion.

The release-manifest schema reader is tested against isolated source files with
different current/rollback versions, including invalid contracts. Do not pin that
parser test to the repository's current schema number. The reference-index
integration keeps its historical schema-18 starting point and verifies every
registered pending migration, including reference indexing at schema 19. Expected
upgrades derive from that baseline rather than a fixed single-element list.
After a schema change, run `studio-server:verify:production-cutover` and the API's
`test:references-managed` and `test:migration-managed`, alongside the schema-specific
unit tests. New application tables and DML triggers must also update the closed
legacy-restore inventory. Schema 20's recording-evidence table and exact deletion
trigger are included; altered/custom triggers and external dependencies still
fail before deletion. The real restore fixture verifies evidence-row clearing
and preservation of unrelated SQL/S3 data.

Negative migration scenarios restore their deliberately corrupt source state
immediately, before any later valid-copy scenario. In particular, the legacy
`active-release` marker used to prove frozen-source rejection must be removed
before the SQLite runtime archive is created. Production's ambiguous-layout
rejection stays strict; a later scenario must not inherit test-only corruption.
Supervised restore checks resolve each role's verified runtime-library snapshot
and load the fixture package. They must not assume a mutable `current/` directory
or set an obsolete require-root override after immutable releases are adopted.

Bundle submenu ordering has consumers in both `bundle-merge.spec.ts` and
`bundle-comparison.spec.ts`; keep both assertions aligned with the shared menu.
Cross-project navigation fixtures use coherent saved titles, tree names and
filenames. Contradictory metadata repeatedly simulated remote renames, stacking
notifications over the editor and intercepting the drag's mouse-down. The
navigation test verifies no unexpected rename notices and waits for title
actionability before its real mouse gesture. Movement, unsaved-state and history
assertions remain required; hiding toasts or forcing the gesture is not a repair.

Local-upgrade containment guards compare exact bigint device/inode identities.
The guard regression supplies distinct large inode IDs that collide as Numbers,
then a true source/control alias. This keeps Windows verification meaningful
without relaxing the source-root exclusion used by the container runtime.

Main's exact-image HA browser probe uses the same executor protocol semantics as
the editor: `executor-session` identifies a resumed session;
`executor-session-ready` separately ends replay. Protocol 2 omits the resume flag
from the ready frame. Keep both protocols in `ha-release-gate.test.mjs`; preserve
the original-socket closure and resumed-session checks. A successful image build
does not establish promotion when this main-only gate fails.

The HA proof observes retained edits through the editor's dirty project tab,
not through Save-button visibility. Current Save lives in the project context
menu, while an older retained browser can still have sidebar Save. At the actual
save step, use the existing button when visible or open the named project's
context menu; close that overlay before further editor interactions. The proof
still verifies the saved bytes through the API and a second recorded execution.
`ha-browser-contracts.spec.ts` exercises both Save locations and project-scoped
recording selection. Keep these local browser checks before running main's
exact-image HA gate; a develop browser success alone does not exercise that gate.

## Browser shard budget and hosted variability

[Verify Studio Server 43434671248, editor shard 3](https://github.com/valerypopoff/rivet2.0/actions/runs/43434671248/job/131919256700)
hit the 12-minute test-step limit after 93 of 95 cases passed. There was no
assertion failure; the remaining two cases did not finish before cancellation.
The deployment-contract lane, including the repaired Linux supervisor fixture,
passed. This was a separate scheduling failure.

The earlier [editor shard 2](https://github.com/valerypopoff/rivet2.0/actions/runs/43429991232/job/131903541756)
passed in 11m17s, leaving too little margin for hosted-runner variation. Refreshing
weights from only the latest run would not account for that variation. Use the
higher total case time per file from both runs, rounded up to five seconds;
parallel files contribute their total case work, not their shorter wall time.
The earlier completed run also supplies the two cases interrupted in the later
run. These measurements are scheduling estimates, not runtime guarantees.

The November 22, 2026 local inventory has 396 cases in 42 selected specs, in four
independent jobs with two browser workers each. The authoritative selection and
weights live in [editor-test-shards.mjs](../../scripts/ci/editor-test-shards.mjs).
Weights now use the highest total per-file case work from successful hosted runs
`44964153448`, `45041549860` and `45045691893`, rounded up to five seconds.
The renamed `ha-browser-contracts.spec.ts` adds the two Save checks; its 25-second
hint retains headroom over their complete measured file work. Current combined
work estimates are 1,075-1,080 seconds per shard, not measured elapsed times. The shard
contract checks exact-once coverage, balanced weights and a
75% work budget against the existing 12-minute/two-worker step limit (1,080
seconds). This leaves room for setup, serial tails and runner variation; increasing
the suite requires reviewing that headroom rather than merely keeping equal sums.
The browser image, isolation, assertions, retry policy and timeouts stay unchanged.

The Node/WebSocket executor-retirement fixture runs once in the web-tests job,
after restoring and verifying the same-commit Core/Node builds. It needs no
Chromium. This removes unrelated work from browser shard 1 without omitting it
from the final required verification. The workflow guard rejects skipped,
duplicated or source-only retirement placement.

Validate `ci-performance.test.mjs` and the workflow guard, list all four selections
to confirm exact-once test coverage, and run the affected real browser journeys.
After pushing, confirm every hosted shard's final result and elapsed time before
calling the repair complete. Keep this budget guidance in the local checklist.

Run `45041549860` completed Verify in 16m27s; its slowest browser job took
10m52s including setup. Developer Desktop Release `45041549856` took 17m17s,
with Intel packaging the longest native lane. These gates are close: shortening
only one does not remove the other from the all-green critical path. Rebalancing
is expected to trim browser tails, not halve the workflow. Evidence and timing
inputs are in ignored `artifacts/ci-critical-path-20261122/`.

The first revised hosted run (`45045691893`) passed all 396 browser cases,
but Verify took 16m51s, 24 seconds longer than the previous sample. The slowest
browser job remained 10m52s; other files slowed while recordings got faster.
The elapsed time to all-green was 16m51s instead of 17m17s because native desktop
packaging finished sooner. This does not establish a causal browser speedup.
Keep the slower per-file observations in the weights rather than selecting only
favorable timings. The managed integration lane was also near ten minutes after
compilation, limiting the possible benefit from adding more browser jobs alone.

## Intel macOS runner experiment

The normal release matrix still builds Intel on `macos-15-intel` and Apple Silicon
on `macos-15`. Developer Desktop Release has an explicit manual
`benchmark_macos_intel=true` option on `develop`; that mode skips release/Pages
publication and calls the read-only `desktop-macos-benchmark.yml` workflow.
Its default is false, so push and ordinary manual releases keep their behavior.

The experiment builds the same `x86_64-apple-darwin` source and verified exact-Build
frontend on both hosts. Both use Rust 1.100.0 and the normal signing, notarization,
architecture, executor and pnpm checks. The Apple Silicon host must already be
able to execute Intel binaries through Rosetta; no automatic license installation
or fallback is permitted. Its signed candidate is also transferred as a tar
archive, preserving executable modes, and checked on a native Intel runner.
No artifact is published as a release, and no GCP qualification or rollout runs.

Initial dependency-cache availability differs across hosts. Both perform a full
warm-up build, then clean only the app's release artifacts and bundle directory
before the measured complete rebuild. Dependency caches survive that cleanup;
benchmark jobs do not save Rust caches and use a separate temporary pkg cache,
so an experiment cannot populate a normal release cache with the other target's
base binaries. Compare measured rebuild, signing,
notarization and native-verification time separately from warm-up/setup/cache
transfer time. A warm rebuild result is not a cold-build result. Compare the
recorded Xcode/SDK versions before interpreting timings; mismatched toolchains
need a matched repeat, not a speed claim.

Use job/step durations and include the extra native verification, transfer and
runner-queue costs when estimating release benefit. One run is a feasibility
measurement, not grounds to switch regular hosts. Retain current release runners
until repeated representative runs demonstrate a useful all-green reduction
with every native/signing check passing. Local workflow and browser validation
cannot establish a macOS speedup on the Windows development machine.

After publishing the reviewed workflow changes, run the existing manual entry:

```sh
gh workflow run developer-windows-release.yml --ref develop -f benchmark_macos_intel=true
```

The entry already exists on the default branch. Select the reviewed `develop`
ref; the experiment's exact-source Build must have succeeded before signing.
Do not merge main or run the ordinary publication mode just to start an experiment.

For the original 38-spec repair, local verification passed all 17 CI-performance
tests, workflow/style/import and documentation checks, and its unchanged
362-case inventory across all four selections. The two targeted headless groups
passed 115 and 108 cases in 4.9 and
4.2 minutes respectively against a fresh web build. This includes the heaviest
recordings group and the previously interrupted viewport cases; it does not
predict hosted-runner timing or replace the next complete CI results.

## Supervisor fixture port allocation

The [Linux housekeeping check](https://github.com/valerypopoff/rivet2.0/actions/runs/43429991232/job/131903541698)
failed before starting its restore-consumer scenario: independently selected
ephemeral ports collided, and the production supervisor correctly rejected them.
Opening and closing each port in sequence does not guarantee distinct values;
the kernel can reuse a just-released port within the same fixture.

Supervisor fixtures now use the [shared port allocator](../../deploy/studio-server/images/api/fixtures/loopback-ports.mjs) to bind every
member of a port group concurrently before releasing the group for child startup.
Housekeeping fixtures group API, executor, health and housekeeping ports together;
two-owner fixtures also select both owners' ports together. Backend tests use the
same allocator instead of retrying duplicate selections. Allocation failure
closes earlier listeners before propagating its original error.

The regression observes real listeners during selection, so it fails
deterministically if an earlier reservation is released too soon. A separate
case injects a later bind failure and verifies cleanup. Run
`node deploy/studio-server/scripts/verify-housekeeping-linux.mjs` and the adjacent
`backend-supervisor.test.mjs` tests on Linux. Keep the production distinct-port
validation, original process assertions and normal test concurrency unchanged.

## Comparison fixture compilation repair: November 12, 2026

[Build 43291039140](https://github.com/valerypopoff/rivet2.0/actions/runs/43291039140/job/131439269832)
failed in desktop compilation on three branded-graph-ID errors in comparison
test fixtures. All App test shards passed: `tsx` executes those fixtures without
type-checking them, while the App's normal `tsc` project includes all `src` tests.
A scoped hosted-frontend type check also omits fixtures it does not import.

Construct recovery graphs with typed `GraphId` metadata and index comparison
maps with branded graph keys; do not bypass the errors with whole-object
`unknown` casts or exclude tests from the build. Validate changed App fixtures
through its actual TypeScript project and the normal desktop frontend/CLI build.
The developer desktop release correctly refused to reuse the failed Build;
that downstream failure needs no retry or release-gate change.

## Recordings browser scheduling repair: November 12, 2026

[Verify Studio Server 43104429099, editor shard 1](https://github.com/valerypopoff/rivet2.0/actions/runs/43104429099/job/130806358601)
hit the 12-minute test-step limit after 153 passing cases. It had no assertion
failure. The recordings file started about four minutes into the step, then
executed 84 of its 88 cases serially before cancellation. The other worker
finished its queue about six minutes before cancellation and stayed idle.
Balanced sums of file weights did not prevent this long indivisible tail.

The recordings suite now opts into parallel cases using the existing two CI
workers. Every case constructs its own Playwright page/context, mock routes,
fixture data and browser storage; it has no shared setup, mutable suite fixture
or external provider dependency. Other suites retain their existing serial
scenarios. Work weights use total case time rather than the shorter wall time
of parallel execution. They remain scheduling hints, not wall-clock acceptance
thresholds.

Keep every case, assertion and the existing 12-minute step limit. Validate the
complete affected shard with `RIVET_EDITOR_TEST_SHARD=1/4 yarn studio-server:ui:ci`
and confirm the recordings results use both workers with overlapping intervals.
Use the JSON reporter for worker/start/duration evidence when checking locally.
Do not infer a hosted runtime guarantee from a faster local browser.

The targeted production-build check passed all 88 recordings cases in 2m42s
without retries or skips. Its JSON report assigned 45 and 43 cases to the two
workers and confirmed overlapping execution. A complete local shard attempt
stopped at Chromium's Windows `ERR_NO_BUFFER_SPACE` during another fixture's
application bootstrap. The hosted Linux result below supplies the full-shard
validation.

[The complete hosted follow-up](https://github.com/valerypopoff/rivet2.0/actions/runs/43109601411)
passed all three browser shards. The repaired shard finished 145 cases in 9m25s,
but shard 2 took 11m44s, only 16 seconds below the unchanged limit. Its debugger
suite had grown to approximately 260 seconds of work while retaining a
56-second estimate. The complete recordings suite measured approximately
638 seconds of work. Refresh those two weights to 260 and 640 seconds so the
existing balancer accounts for that work across all three shards. Do not accept
equal estimated totals as proof of useful timeout headroom.

## Image-test browser setup repair: November 11, 2026

[Build Images 43053444658](https://github.com/valerypopoff/rivet2.0/actions/runs/43053444658)
built and scanned the runtime images, but the candidate-image rehearsal and full
HA upgrade jobs failed before browser acceptance. Both still ran
`playwright install --with-deps chromium` on the host. Their Ubuntu 26.04 runners
could not resolve the Azure, archive or security Ubuntu mirrors; dependency
installation spent about ten minutes retrying before exiting with code 100.
The HA summary failure was downstream of the unrun upgrade proof, and image
promotion correctly remained blocked. Build and Verify Studio Server on the
corresponding `develop` revision had passed.

These two jobs now use the same digest-pinned Playwright browser server as the
editor shards. Prepare and verify it before candidate smoke work or Kind cluster
creation, with a four-minute setup limit. Node, Docker, Helm and fixture servers
stay on the runner; only Chromium runs in the browser container. Matching
package/image versions, the read-only checkout, exact loopback control port,
loopback-only fixture forwarding and ownership-checked cleanup remain required.
Each job records its container ID before start and cleans only that exact owned
container even after a test/setup failure. The non-browser HA scenarios do not
start a browser container.

The observer launcher skips local browser installation when a remote browser is
configured, in both test and debug modes. A normal local observer retains its
existing installation behavior. The direct HA browser probe connects to the
prepared server as well; a failed remote connection must fail the proof rather
than falling back to an unrelated host executable. Browser assertions, test
retries, HA scenarios, image scans and promotion conditions are unchanged.

The workflow guard covers all three prepared-browser jobs, including matching
pins, setup ordering, no host package/browser installs, and cleanup. CLI
regressions cover remote/local observer modes; HA probe regressions cover the
remote connection, bounded loopback exposure, failure and local executable path.
Validate the real connection and host-loopback fixtures in the exact pinned image
before pushing a change to this setup. A registry failure can still stop image
preparation; this removes the demonstrated Ubuntu package-mirror dependency.

Local verification passed: the full root style and rollout-source gates, CI
formatting, workflow contracts and compiled workspace-export checks; five
focused browser regressions on native Linux; and four headless observer tests
connected to the pinned browser. A direct HA-browser connection also verified
host HTTP/API requests, WebSockets, streamed attachment downloads and video
delivery. The restricted Windows source run could not confirm an unchanged
backup fixture's child shutdown; the complete run with normal process permissions
and the three corresponding native Linux shutdown cases passed. No shutdown or
browser acceptance assertion was relaxed. Hosted image qualification still runs
through the normal main-branch workflow after merging the repair.

## Develop CI repair: November 11, 2026

Build passed for `54c429551`, but deployment contracts in
[Verify Studio Server 42924459264](https://github.com/valerypopoff/rivet2.0/actions/runs/42924459264)
exposed two independent failures. Node 24 on Linux reports `MainThread` in the
process-name column, so legacy launcher discovery must also inspect the Node
executable in argv. BusyBox can prefix that argv with `{comm}`; normalize the
display prefix before checking it. The real child-process test covers discovery,
and Windows retains its existing process inventory and ownership safeguards.

The temporary-cloud HTTP fixture gave every request only 100 ms. Under CI load,
an inventory read could time out before the intended uncertain create, leaving
zero writes for an assertion that correctly requires one. The fixture now allows
five seconds and deliberately delays its first inventory read by 150 ms in the
hanging-write scenario. It must still reach exactly one create, time out, avoid
write retries and resolve cleanup through observation. Production request
deadlines and rollout qualification criteria are unchanged.

Reproduce these cases locally before another push. Run the launcher ownership
suite on Windows through `yarn node --test` and exercise the real process case
on Linux with Node 24. Run the temporary-staging timeout scenario against its
owned loopback server. These checks need no cloud activation or application
image rebuild.

Later [verification 42934371949](https://github.com/valerypopoff/rivet2.0/actions/runs/42934371949)
exposed two browser-lane issues. Bundle-merge inset checks read the modal and its
children in separate browser calls while the centered dialog was moving. Measure
all rectangles synchronously in one DOM snapshot; retain the existing two-pixel
corner tolerance and content-alignment assertions rather than loosening them or
adding a fixed sleep.

The real cost-statistics fixture also encountered a Docker Hub HTTP502 downloading
PostgreSQL inside `docker run`. Prepare missing fixture images first, using the
existing read-only download policy (at most three attempts, with five- and
15-second delays), then create each container once with `--pull=never`. Cached
images do not require a registry request. The shared download policy recognizes
the observed `502 Bad Gateway` alongside its existing transport errors; access,
manifest, integrity, disk and unknown failures still stop immediately. Never
retry container creation or deployment commands under this policy. Reproduce the
download error with the subprocess regression and run the real PostgreSQL/MinIO
cost-statistics browser journey before pushing.

That run also exposed a torn simulated-clock read in the schema-maintenance
recovery fixture. The CLI rewrote `clock-offset.json` while a management child
was importing its preload, briefly exposing an empty file. Write the next clock
snapshot to a sibling file and rename it atomically. The regression observes
the clock exactly between truncation and writing: readers must retain the prior
complete value until replacement. This changes only the test clock, preserving
the production ownership, recovery and no-Helm-replay assertions. Run the focused
`lostFinalApply` command test as well as the deterministic clock regression.
Declare the regression's generated clock reads with `test-style: fixture-read`;
they do not inspect authored source. Run the root `yarn test:style` lane as well
as `studio-server:verify:test-style`, which is a separate deployment-test check.

## Develop CI repair: November 9, 2026

The first `8165d45f4` push failed before compilation on four independent gates:
the schema publication fixture, Editor lint, import-boundary review and a new
RustSec SQLite finding. Developer Desktop Release then correctly refused to
reuse a frontend from the failed exact-commit Build. It needs no fallback or
independent frontend rebuild.

The publication regression derives its predecessor/successor versions from the
candidate instead of combining the old 17-to-18 receipt with schema 19. It still
rejects missing rolling evidence and unreviewed jumps. Full Editor lint includes
existing consumers of changed hooks: history callbacks now use `wrapAsync` to
retain a void event-handler contract and report rejected navigation consistently
for toolbar buttons and keyboard shortcuts.

The five reviewed reference-index imports have exact entries in
`scripts/checks/import-boundary-debt.json`: browser-safe coverage presentation
and its type, the API's shared workflow response type, and its existing HTTP
error utility. They introduce no server state or Node runtime into the editor.
The three-level boundary rule and rejection of new or stale entries remain.

The desktop now bundles patched SQLite through `rusqlite 0.41.1` and
`libsqlite3-sys 0.39.1`; its declared minimum Rust version is 1.89. The native
evaluation-store tests enforce the SQLite 3.54.0 security floor alongside atomic
batch/import behavior. The fresh unfiltered audit must pass the existing exact
exception policy; this repair adds no security exception.

Before another push, run the complete rollout source gate, the Editor/tooling
lint lane, `yarn test:style`, native evaluation-store tests and a fresh Rust audit.
In one local checkout, finish `test:style` before full lint/typechecking: its
asset checks rebuild Core exports, which must not disappear under a live linter.
Run the focused cross-project history browser journey after changing its hook.
These local checks prepare CI; they are not a staging test or production rollout.

## Release iteration improvements: November 3, 2026

The shared `studio-server-source-contracts.yml` workflow runs
`yarn node scripts/ci/verify-rollout-source.mjs` before application compilation,
image builds and actor publication. General Build covers main/develop PRs;
Studio verification and direct actor publication also call the same gate.
It uses Node 24.22.1, the tracked offline cache and an immutable `skip-build` install,
without compiled workspace outputs, Docker or GCP. Its partial checkout excludes
the five unused desktop executables, preserving authored source and dependencies.
The source job has an eight-minute limit and a five-minute cold-checkout limit.
The former two-minute checkout limit failed before tests on PR #239, while a
successful sibling checkout took about 2m39s. Git's 30-second low-speed cutoff
still stops stalled transfers; the larger total budget does not retry them. Failure,
skip or cancellation blocks expensive dependents; required aggregate checks still
fail. Full repository verification remains parallel with image work.

The provider's journal-persistence/observer contract is a separate source-only
suite (`provider-rollout-observation.test.mjs`) and runs in this gate as well as
the full Kubernetes contract suite. It checks persistence before observation and
both failure paths, while treating the timing file as diagnostic output rather
than a journal observation. The source command also checks hosted setup access,
coordinator/worker settlement and real TLS/WebSocket transports. Helm-dependent
overlap feature tests stay in their existing lane.

The same early job now downloads checksum-verified kubectl 1.36.6 and Helm 3.22.1
and runs the packaged provider's preparation/cleanup against loopback fixtures,
plus the existing staging and readiness regressions. Tool installation and the
native test step each have a two-minute deadline; failure blocks compilation and
image publication through the existing job dependency. This adds no cluster,
cloud authentication or Docker requirement to hosted CI. These upstream CLI
versions match the actor's upstream sources; the actor additionally rebuilds
them with its patched Go/dependency graph and retains its final-image tool check.
Local proof used the actual patched Linux tools with Docker networking disabled.

The native Helm-status case belongs to `provider-tool-contracts.test.mjs` in
this pinned native step. Keeping it in the general source suite instead used
the runner's unreviewed Helm 4 and exposed the native process to the whole source
suite's startup load. A local full-suite run reproduced its 10-second timeout
before any loopback request even with pinned Helm; both versions passed in
isolation. Moving this integration case preserves the assertion and deadline
without serializing the source suite or changing production timeouts. Its Helm
storage/plugin settings are fixture-owned, failures include the request trace,
and the workflow explicitly exports the pinned Helm path before native tests.
The new native cases took about eight seconds together. This is measured local
test time, not a promise about hosted checkout, downloads or total workflow time.
See [the preparation contract audit](automated-runtime-qualification.md#local-provider-preparation-contracts).

The Kind matrix now requires successful runtime scans. The independent managed
Kubernetes check runs in the shorter `lostAcknowledgement` lane, using that
lane's explicit disposable context. All three HA scenarios, scheduling/browser
checks, evidence assembly and cleanup remain required. No drain or 300-second
protection duration was shortened. Balancing these existing lanes removes
163–183 seconds from the longest lane before accounting for the new prerequisites.

Qualification actor/janitor builds use the existing exact-source context with a
`docker-container` buildx builder and `--load`, preserving classic-store
configuration IDs, archive checks and fresh scans. GHA v2 caches have separate
actor/janitor/amd64 scopes and export intermediate layers (`mode=max`) so stable
Helm/kubectl/esbuild compilation can be reused. Imports/exports have 60-second
timeout settings; export failures do not invalidate an otherwise verified image. A missing
cache builds normally. Set repository variable `RIVET_QUALIFICATION_CACHE=off`
for a deliberately cold publication if the cache service fails; this does not
authorize an automatic workflow/test retry. The local runtime action exports
runner cache credentials through `GITHUB_ENV` after registering the token with
the runner's secret masker, never through build command arguments,
image layers or logs. Cached output is not qualification evidence.

The first hosted cache population took 172 seconds to export despite that
60-second setting, and the tooling job took 14m13s. Treat the configured timeout
as unverified for total transfer duration. Warm-build savings remain unmeasured;
do not add a separate build merely to benchmark them.

Per-owner routing, active-work drain, replacement readiness, templates, proxy
handoffs and settlement now use the existing HA timing reporter. Provider progress
uses source-owned public descriptions; Pod details stay in private timing files.
First failure visibility is separate from managed-command shutdown, actual cleanup
and lock closure. No progress record can claim that a writer has stopped.

Local evidence and the measured/proposed distinction are recorded in the
[release performance plan](release-workflow-performance-plan.md). A network-disabled
clean Node 24 fixture passed the early gate without application outputs; a fresh
local builder reused an external cache while preserving the archive/configuration
ID and invalidating changed input. Hosted GHA cache hits and end-to-end workflow
timings still require the next authorized CI run. The improvement to failed
iterations is larger than the projected successful-build saving; do not advertise
these changes as a demonstrated 10-minute full image release.

A desktop job cancelled with an empty runner name/ID, no executed steps and no
available job log is not evidence of a compiler or signing failure. Inspect those
facts before changing packaging code. A failed-job-only workflow retry preserves
successful platform artifacts and can recover runner allocation; do not change
architecture labels, bypass notarization or publish missing-platform downloads
to mask a runner-start failure. Confirm the retried job actually starts and
finishes before reporting recovery as successful.

On November 9, 2026, [Developer Desktop Release 42642896276](https://github.com/valerypopoff/rivet2.0/actions/runs/42642896276)
at `a5dc939cb` hit this case: the Apple Silicon job waited 15m01s, had runner ID
zero and no steps, and GitHub annotated it with hosted-runner acquisition failure
and macOS arm64 capacity notices. Build, Studio Server verification, Windows and
Intel macOS all succeeded. GitHub's overall operational status did not establish
available ARM capacity. Read the job's check annotations before choosing recovery;
a missing log alone cannot distinguish cancellation from a failed build.

Recover the unstarted job once at the same commit and preserve successful
artifacts. Read the job's `check_run_url` annotations when logs are unavailable;
the workflow's overall failure label alone does not identify a code defect.
Finish publication before advancing that release's branch: `publish-pages`
checks the live branch head before publishing assets and Pages (`develop` for
Developer Desktop Release, `main` for Stable Desktop Release). An allocation failure
does not justify changing platform labels, bypassing signing or replaying completed
builds. A second allocation failure remains a provider-capacity blocker.

The later user-authorized recovery (attempt 5) completed at 18:25:49 UTC on
November 9 in 11m52s, at the same `a5dc939cb` source. Apple Silicon compilation,
signing/notarization, desktop download publication and Pages deployment passed
once GitHub assigned the runner. No packaging-code change was needed for this
recovery.

The following code push, `7dc43e2d1`, encountered the same provider issue in
[Developer Desktop Release 42680470866](https://github.com/valerypopoff/rivet2.0/actions/runs/42680470866).
Its Apple Silicon job `129380106284` waited from 19:20:26 to 19:35:27 UTC without
an assigned runner or any executed steps. The check explicitly reported failure
to acquire a hosted runner and macOS arm64 capacity constraints. Build
`42680471172`, Studio Server verification `42680470834`, Windows packaging and
Intel macOS packaging all passed. This is another runner-allocation failure,
not evidence of a regression in the graph deletion, bundle diagnostics or cost
accounting changes. Recover only the unstarted job once; record the outcome
before advancing the branch. An unrelated source change or another full build
cannot repair unavailable hosted capacity.

The single targeted recovery (attempt 2) completed successfully at 20:00:55 UTC
on November 9, at the same `7dc43e2d1` source. Apple Silicon packaging, signing,
notarization and executor checks passed. Publication also passed after the
existing bounded Pages retry recovered a deployment timeout. This recovery
required no application or packaging-code change.

The repository-contract lane uses a filtered, shallow checkout that excludes only
five exact native desktop pnpm executable paths under `packages/app/sidecars/pnpm/`.
No wildcard excludes future source or metadata with a similar name.
All source, tests, sidecar provenance and the complete offline Yarn cache remain
available, and `git ls-files` retains the full tracked inventory for structural
and migration checks. This lane does not package a desktop application; native
packaging jobs keep full checkouts. A five-minute cold-checkout budget fits inside
the unchanged 15-minute job limit. The measured current snapshot was about
706 MiB before filtering, including 265 MiB of unused executables; shallow history
alone did not remove them. Low-speed HTTP guards are supplemental, not an
explanation for every checkout timeout. See [Build and CI](../BUILD-AND-CI.md)
for the regression and verification contract.

## Keep release fixtures aligned without weakening checks

Same-image overlap adoption tests run three sequential CLI invocations:
preflight, an application with a lost acknowledgement, and exact-token recovery.
Each child keeps its 300-second deadline and physical process cleanup. The
complete journey has a 930-second budget (three child budgets plus 30 seconds
for fixture work); a single 330-second outer budget could cancel the combined
journey under hosted-runner contention. Concurrency, production timeouts and
all recovery/no-replay assertions remain unchanged. A cancelled test still
fails the release gate; retain its log and require the fresh candidate's complete
image workflow to pass before provider activation.

The current schema version (20) differs from its rollback floor (17). Helm defaults
and migration commands must use the current version. Forward rollback uses the
previous image's own schema version as its lower reader bound, not that image's
rollback floor; only the upper bound expands to the already-migrated successor.
The successor's rollback floor determines whether that predecessor is permitted.
Historical upgrade fixtures still begin
at their original schema and assert all pending migrations rather than assuming
that the repair under test is forever the last migration. Keep the chart, compiled
PostgreSQL gate and release-manifest tests together when changing this contract.
The existing managed lane now exercises the real 18 → 20 rolling-policy
expansion, including bounded trigger-install contention, rollback and reader
availability. It also runs the local recording-durability crash fixture.
Schema-changing HA image
qualification runs both image-owned recording and revision repositories and binds their
receipts into the certificate; an old-image startup verifier alone is insufficient.
Unchanged-schema candidates avoid those extra image workers. See the
[rolling DB contract](deployment-operations.md#rolling-database-compatibility-contract)
for budgets, local image/source checks and evidence limits.

Fast incoming-reference unit tests are registered in the deterministic API test
manifest. The existing managed deployment-contract lane also runs
`test:references-managed` immediately after schema verification, before longer
integration checks. This uses its own disposable local PostgreSQL container to
cover lookup, backfill fencing, concurrent repairs and latency; it creates no
new CI job or GCP resources. Direct `test:files` runs alone do not prove that a
new unit test is registered: retain the API manifest/sharding check too.

Node-settings tests assert the full editor group order, including the collapsed
**Token pricing** section. Generated AI Graph Builder help must be refreshed after
node-reference documentation changes with `yarn check:graph-builder-node-specs --write`
and then verified without `--write`. Do not skip these checks to publish installers.

The test-style guard's `fixture-read` annotation is for test-owned artifacts, not
production source. The HA assembly CLI regression reads only the evidence JSON it
created in its temporary directory; it does not need a source-reading allowlist
entry. It still executes the CLI and checks exact run identity and rejected attempts.

## Hosted baseline: October 5, 2026

| Run                                                                                                  | Measured bottleneck                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Studio verification 37338900939](https://github.com/valerypopoff/rivet2.0/actions/runs/37338900939) | 23m40s total; API shard 2/4 spends 18m17s running tests, while the others take 1–3 minutes                               |
| [Build 37338901177](https://github.com/valerypopoff/rivet2.0/actions/runs/37338901177)               | 10m28s total; Core test step takes 6m14s                                                                                 |
| [Desktop release 37338901290](https://github.com/valerypopoff/rivet2.0/actions/runs/37338901290)     | 20m40s total; Intel native job takes 18m33s, including repeated frontend preparation and bundling                        |
| [Staging images 37309266681](https://github.com/valerypopoff/rivet2.0/actions/runs/37309266681)      | 27m59s total; classification checkout takes 5m28s; one API test step takes 18m25s; image builds take roughly 5–7 minutes |

The develop baseline runs succeeded. The staging baseline failed its image
rehearsal; timings do not certify promotion. Compare existing `job-timing.mjs`
summaries with the next hosted runs after landing changes. Local timings cannot
certify hosted speed, queue delays or Apple notarization latency.

## Execution boundaries

Container images have a separate mandatory [vulnerability gate](./container-security.md).
It scans the exact candidate digests and all published architectures alongside
functional qualification; High/Critical findings or incomplete scans block
promotion. It does not replace Yarn/Cargo audits or introduce a cloud rehearsal.

- Classification uses shallow sparse checkout of its standalone helper and
  fetches only missing full-SHA event endpoints, with source blobs filtered out.
  It still compares complete commit trees over the whole push/PR range,
  including deleted and renamed files, not just checked-out files. Existence
  probes disable Git's lazy fetching so they cannot download history before
  the explicit depth-one fetch. Forced verification needs no historical fetch.
  Fetch errors fail classification, never skip checks. The migration ledger job
  retains full history because its provenance checks need historical commits.
  Migration-history preparation fetches only when inspection cannot read required
  objects. Already-present evidence with mismatched immutable identities fails
  immediately, preserving the integrity error without a redundant transfer. Its
  shallow-checkout regression fences that negative case against another fetch.
- Final Build/Studio status jobs sparsely check out only the standalone timing
  helper. Their previous full checkouts cost 22–26 seconds after all checks had
  finished. The required result aggregation and workflow timing remain intact.
- Local-upgrade runtime scenarios are split across the existing four API runners,
  with two concurrent scenarios per runner. Other files are assigned exactly once.
  Full local runs still run all scenarios four at a time. Each owns all source and
  control roots, child environments and ephemeral HTTP ports. Restart, rollback,
  copy-fault and crash phases stay sequential within a scenario, in fresh
  processes. Other API files retain `--test-concurrency=1`; global-environment
  fixtures must not be parallelized.
  CI uses the verified API tsc output for rehearsal children and supervised API
  restart/provisioning, rather than repeatedly transforming the same sources.
  `RIVET_API_TEST_RUNTIME=prebuilt` requires those compiled entries; it never
  silently falls back to source. Omit it for ordinary source-based local tests.
- Build dependency compilation no longer includes the desktop bundle. A separate
  mandatory frontend/CLI job preserves all root build coverage in parallel with
  tests. The six long Core/App lanes have their own six-job matrix; the four short
  suites have a separate two-job matrix, avoiding matrix-slot head-of-line delays.
- Production Docker builds install from pinned dependency inputs before copying
  source directories. All workspace manifests are required by a guard. Changing
  sources does not invalidate installation or recopy the Yarn cache into a second
  layer. API/executor final stages copy only compiled runtime workspace exports
  and bootstrap modules, excluding desktop/docs/source/test trees. Dynamic
  third-party runtime dependencies remain intact, including non-hoisted
  workspace-local modules and relative links; the root node_modules alone is insufficient.
  Existing package licenses/readmes are retained as well.
  The only third-party fixture exclusion is the reviewed, unexported
  `zod-to-json-schema` dist-test-v3/v4 dependency installations; see
  [container security](container-security.md) for runtime/compiler pins and tests.
  Image smoke and migration release gates
  remain mandatory; cache reuse is an optimization, not their replacement.
- Pure/isolated Core tests use narrow implementation imports where safe and load
  the complete registry only when constructing a processor. Registry/public API
  integration tests still exercise the public export surface. Do not bypass a
  deliberate registration/import-order requirement to win a startup benchmark.
- Core uses two native Node file partitions, each with four workers. Both remain
  required by the Build aggregator. Set `RIVET_CORE_TEST_SHARD=1/2` or `2/2`, then
  run `yarn workspace @valerypopoff/rivet2-core run test:shard` to reproduce one.
  Local `yarn test:core` still runs the full suite.
- Browser CI uses four required matrix shards, each with two browser workers.
  `scripts/ci/editor-test-shards.mjs` assigns all 40
  selected specs exactly once using measured file weights (plus explicit estimates
  for new specs). The cost-statistics specs are included explicitly: the fast modal
  contract and the real mixed-model bundle/HTTP/WebSocket/cancellation fixture.
  The complete Run recordings modal suite is also registered, including immediate
  opening, independent catalog/results, retained sessions, deletion and replay.
  Bundle comparison, the expanded export suite, Bus ordering and Passthrough
  port labels are included explicitly.
  Refresh materially stale work estimates from complete hosted timings, retaining
  slower observations rather than replacing them with a single faster run. Adding a selected spec
  also updates the inventory count and membership assertions in
  `ci-performance.test.mjs`; run its `balanced editor shards` and `editor shard work`
  cases before pushing.
  Their inclusion is asserted by the shard regression. These weights balance work,
  not predict hosted wall time. Independently isolated recordings cases can use
  both workers; other files preserve serial scenarios. Test-owned contexts,
  mocks, temporary paths, assertions and retry policy are unchanged. Each shard
  has separate reports and failure artifacts. Executor-retirement verification
  runs exactly once, on shard 1.
  Set `RIVET_EDITOR_TEST_SHARD=1/4`, `2/4`, `3/4` or `4/4` before
  `yarn studio-server:ui:ci` to reproduce a lane. Omit it to run the complete
  selection; unknown shard values fail instead of silently dropping coverage.
  Locally, finish build-mutating checks (including `yarn test:style`) before
  starting browser lanes: their real-API fixtures consume Core's compiled exports.
  Parallel shards need distinct `PLAYWRIGHT_CI_PORT` values. Hosted matrix jobs
  have independent checkouts and verified artifacts rather than shared outputs.
  The shared isolated-editor bootstrap mocks optional provider-environment
  lookups as unset; it must not contact an ambient API or read local credentials.
  Individual provider tests can override that route with their own fixture.
- Deployment contracts have four required, isolated matrix lanes: managed
  storage/schema, VM migration/restore, deployment/Helm contracts, and gateway/proxy
  behavior. The full VM migration suite runs independently of other PostgreSQL
  checks. All four consume verified same-commit compiled artifacts. Proxy templates still run
  serially through real DNS expiry, address replacement and unhealthy/healthy
  transitions; no TTL or outage assertion is shortened to improve timings.
  Fixture phases within each lane remain ordered. Only the deployment lane
  installs Helm/Kubernetes tools; lanes do not share containers or source roots.
- Node tests validate the same-commit artifact with
  `RIVET_NODE_TEST_DEPENDENCIES=prebuilt`, avoiding a redundant Core/Node build.
  Local tests still build both ESM and CJS prerequisites.
- Build's Node 22 frontend job is the single desktop compiler across Build and
  Desktop Release. The latter retrieves the exact Build run's artifact by ID
  using read-only Actions access, verifies its SHA/length/hash inventory and
  re-exports it for native consumers; it does not compile another copy. No PR,
  fork, stale SHA or unqualified fallback is allowed. Windows and both native macOS
  consumers restore the source-SHA artifact and verify its complete length/hash
  inventory before Tauri prepares platform sidecars. Rust builds, architecture
  checks, signing, notarization, packaged executor/pnpm smoke and publication
  gates stay native and mandatory. Local Tauri keeps its ordinary build hook.
- Desktop Vite omits compression-size reporting unless bundle analysis is
  requested. Only diagnostic work changes, not generated assets/minification.
- Developer public-docs-only pushes can publish documentation without native
  packaging, but only when both the push range and the last published desktop
  commit differ exclusively under `packages/docs/`. This prevents a later docs
  push from canceling an unpublished app change and reusing stale installers.
  Missing metadata/history or any non-docs difference retains the full native
  build. Manual and official releases always build native installers. Docs-only
  preparation preserves both channels' existing metadata and installer links;
  it neither publishes assets nor labels old installers with the new docs SHA.
  The primary metadata commit is rechecked immediately before preparation.
  See [Build and CI](../BUILD-AND-CI.md#desktop-release-and-pages-workflows).

## Browser environment reliability: October 26, 2026

[Main image run 40341552808](https://github.com/valerypopoff/rivet2.0/actions/runs/40341552808)
did not expose a slow-test regression: shard 2 spent about 16 minutes installing
browser dependencies, including an Ubuntu mirror download of 15.9 MB taking
15m24s. Its tests then hit the overall 20-minute job deadline before completion.
The same 59 tests passed on develop in 4.7 minutes; main shards 1 and 3 completed
their tests in 6.3 and 5.1 minutes. A cancelled shard is not a successful release,
and image promotion correctly remained blocked.

The editor shards connect to Chromium in the official Playwright
1.62.1 Noble image, pinned by OCI digest in `studio-server-verify.yml`. It supplies
browsers and Linux libraries without `apt` or browser downloads in each job.
Node tests still run on the GitHub host: the hosted-Subgraph regressions start
real Docker PostgreSQL/MinIO fixtures and must retain host loopback access.
Moving the entire job into a browser container would break that contract.
This is a disposable CI environment, not a production image. `setup-yarn` still
selects Node 24. Verified exact-commit compiled artifacts, executor-retirement coverage, the
shard selection, two workers, assertions and retry policy are unchanged.
The browser-only container uses `--init --ipc=host`, a read-only checkout mount
and `playwright run-server`, with its port published only on host `127.0.0.1:3100`.
The test runner uses the matching `PW_TEST_CONNECT_WS_ENDPOINT` and exposes only
`<loopback>` through `PW_TEST_CONNECT_EXPOSE_NETWORK`, so its ephemeral API
fixture addresses remain reachable by Chromium too (including on Windows).
Do not expose `*` or publish the control port on all host interfaces.
The container has no Docker socket or production credentials. Its exact created
ID is recorded before start, and cleanup checks the run/attempt/shard ownership
label before removing that ID;
there is no name scan or blanket Docker cleanup. See the
[official container guidance](https://playwright.dev/docs/docker).

`verify-browser-environment.mjs` rejects a mismatch between the installed
Playwright package and the expected image version before connecting to the
exact loopback browser endpoint. It renders a static page in a real offline
Chromium context and closes the connection on success or failure.
There is no fallback download, host executable override or test retry. Update
the image tag/digest and `RIVET_CI_PLAYWRIGHT_VERSION` together when the resolved
Playwright lockfile version changes; run the smoke and browser suite in that
exact image before publishing. The workflow guard enforces the pin and bounds.

[Verify Studio Server 44411054034](https://github.com/valerypopoff/rivet2.0/actions/runs/44411054034)
lost the connection to the Playwright registry during a layer download, before the
editor tests started. All prepared browser jobs now use the same bounded
image-download retry as the candidate fixtures. It retries recognised registry
transport errors at most twice, using the original digest and a 5-second then
15-second delay. Authentication, missing images, integrity and other failures
still fail setup. Once the pull succeeds, `docker create --pull=never` uses the
local image. Browser startup, smoke checks and editor tests have their own
failure paths.

Dependency installation has its own 3-minute limit, browser pull/start/smoke 4 minutes,
and actual browser tests 12 minutes; the existing 20-minute whole-job ceiling
remains. Setup gets an explicit timing summary before tests, the Playwright
report records actual test time, and the final job summary retains total elapsed
time. Image pull/runner initialization remain visible in GitHub's job timing,
not hidden as test work. Browser reports are retained on successful and failed
jobs unless the job is cancelled, when cleanup/artifact steps may not run.
No increase in worker count or reduction in coverage compensates for a slow
package mirror. Registry or image-pull failures remain real infrastructure
failures; a prepared image reduces dependency churn, not all network risk.

Local evidence must be distinguished from the next hosted run: an offline
Chromium smoke or locally passing suite does not establish GitHub queue/pull
time or release promotion. Do not treat a rerun as proof that setup was fixed.

Local verification passed all 181 existing browser regressions through the
browser-only container (11.3 minutes unsharded, two workers), including both real
Docker-backed hosted-Subgraph scenarios, bundle download/upload, recording
playback and remote debugging. All 11 focused CI regressions passed, including
version/endpoint rejection, smoke cleanup and unchanged exact-once shard
coverage. The earlier whole-job-container check passed 179 tests but could not
run the two Docker-backed scenarios; that topology was rejected, not adopted
with skipped tests. The exact workflow prepare/smoke/ownership-checked cleanup
shell blocks also passed locally, and their new containers were removed.
Hosted per-shard timings still require the next CI run.

## October 24 follow-up and evidence limits

The browser step then took 15.9 minutes for 165 tests; adding more workers inside
one runner would compete for its CPU. The initial three-shard split targeted
that critical path while preserving the entire selected suite; the current
four-shard budget is described above.
The managed lane also combined independent DB/restore and deployment-command
work; these now run separately. Hosted improvements must be measured on the
next complete runs, including queue and checkout overhead. More runners can
reduce elapsed time while increasing total runner-minutes.

### Completed follow-up: narrower cross-workflow handoff

Existing workflow graphs/triggers and required aggregate job IDs are retained.
Desktop Release now consumes Build's exact-SHA frontend, then requires the
matching Build run/attempt to succeed before any publication. Native packaging
can overlap other checks. Asset freshness is checked after the Build wait, so a
manual release that becomes stale while waiting skips publication. An ordering
guard protects this boundary. Pages retries likewise recheck the branch after
the failed attempt and retry delay rather than trusting earlier freshness.
Docs-only publication also requires a successful Build
for its current SHA. Failed/canceled runs, stale ownership, expired artifacts,
changed attempts and uncertain responses fail closed. Read-only polling is
bounded; unlike a single-DAG rewrite, the handoff has some polling/transfer
overhead that must be included in hosted measurements. It avoids rewriting the
signing/release graph or introducing a privileged `workflow_run` trigger.

Six short lint jobs are grouped into two lanes and four supporting-test jobs into
two, preserving every original command exactly once. The six long Core/App lanes
remain parallel and fail-fast remains disabled. Native installers still publish
automatically for relevant code pushes and remain manually available. Node 24
Studio verification, security audits, migration/restore checks and provider/image
release gates are unchanged. This pass does not claim that fewer jobs alone
guarantees lower wall time or that packaging cannot start before Build finishes.

Local follow-up verification passed all 165 browser tests across the three
shards (69/53/43), with exact test-identity union checked against the unsharded
selection. The observe-runner smoke, Studio build, style/structure/workflow guards
and real Git/HTTP publication regressions also passed. Initial live-API fixture
startup failures came from running a Core-rebuilding style check concurrently;
the affected partitions passed after that check settled, with no retry-policy or
assertion changes. The optional Postman simulation exercised actual Pages
preparation and changed-baseline rejection using synthetic local assets only.
None of these local results certify hosted timings, signing or publication.

The completed handoff also passed real local HTTP evidence tests (including
failed/canceled Builds, identity changes, reruns, expired/foreign artifacts and
bounded timeouts), the actual CLI against a synthetic GitHub simulation, and
the desktop/CLI build plus sealed-inventory verification. All four regrouped
supporting suites passed (578 tests), all six lint commands passed, and the
real-process executor retirement regression passed both scenarios. Lint exposed an existing floating
`node:test` registration promise in executor retirement coverage; marking that
registration `void` preserves its assertions without disabling the lint rule.
Cross-workflow artifact transport and hosted speed still need the next push run.

The HTTP evidence regressions assert each rejection's specific cause, rather
than accepting arbitrary network errors. Positive requests have ordinary local
startup headroom; only timeout scenarios use short deadlines, keeping the suite
fast without conflating identity validation with timing failures.
Preserved same-site downloads also validate their declared byte count, rejecting
shortened HTTP 200 bodies before writing assets/metadata. The actual Pages CLI
regression uses synthetic HTTP responses, not a stubbed fetch.

## Parallel HA image qualification

The image workflow's HA critical path is three independent, required scenarios:
`upgrade`, `lostAcknowledgement`, and `leaseLoss`. The matrix has at most three
concurrent jobs and disables fail-fast. Each owns a separate four-node Kind
cluster, PostgreSQL/MinIO, private kubeconfig, namespace and scenario artifacts.
The managed Kubernetes and hard-spread scheduling gates run once in the upgrade
lane. Only that lane installs a browser; its existing headless retained/oldest
browser checks are unchanged. Both recovery lanes still complete the **entire**
rollout after injection. No routing, heartbeat, graceful-shutdown, sample or
workload assertion is shortened to improve wall time.

Recovery setup explicitly installs the candidate with the same HA topology and
persists the ordinary workflow/web-app fixtures. It rejects an unfinished
release journal before injecting a fault. This replaces the implicit dependency
on the normal upgrade's already-updated namespace: recovery is candidate-to-
candidate, as before, while the upgrade lane alone proves the predecessor-to-
candidate transition. Schema-incompatible predecessors produce bootstrap, not
mixed-version, evidence and still require a maintenance cutover in production.
If a fresh fixture has no release journal, the real rollout command first
completes a no-change operation. It must leave all ordinary pod UIDs unchanged;
an attempted retirement fails the baseline. Fault injection then starts a new
operation from that acknowledged completed journal, retaining the original
real-API journal-reuse coverage without a second replacement rollout. No
completed record is fabricated or inserted by fixture SQL.

`kubernetes-ha-release-gate.mjs scenario <name>` uses the existing rollout,
fault transport, probes and production safety checks. New version-1 internal
scenario reports bind the full candidate manifest digest, SHA, images, chart,
predecessor and browser baseline to the repository/run/attempt. They also retain
the exact cluster (`kube-system` namespace UID) and test namespace identities.
Reports are checked after observation for fixture replacement. Each recovery
report includes the protected original UID, exact-once accepted begin, unchanged
recovery token, completed journal, all five before/after ordinary owner identities
and the accepted lease-loss editor receipt. The acknowledged baseline journal
and resumed operation have separate exported tokens; a baseline token in runner
options alone is not evidence. Each lane must independently retain
at least 100 successful traffic samples with no failed requests. Observation
windows are never summed or merged to satisfy that requirement.

The read-only `managed-kubernetes-ha-evidence` job downloads exactly the three
named current-run/current-attempt artifacts. It verifies their individual
observations and calls the existing certificate creator; missing, duplicate,
foreign, mismatched, oversized or unknown-format reports fail closed. Separate
clusters and namespaces are required. The public v3 certificate remains
unchanged because its behavioral guarantees are retained. Image promotion
requires both the full matrix and this assembly job to succeed.
The assembler retains the original `managed-kubernetes-release-gate` check name
so an existing required status does not disappear when matrix jobs gain suffixes.
Rerunning only part of a failed attempt cannot mix earlier evidence into a new certificate;
rerun the complete qualification attempt instead. Assembly does not access
Kubernetes or cloud credentials; the workflow reads only the immutable predecessor
manifest from GHCR in addition to its Actions artifacts.

`ha-kind-cluster.mjs` refuses pre-existing clusters and kubeconfig files. It
records exact immutable Docker container IDs only after acknowledged creation,
then checks the owner run/attempt/scenario and current Kind labels before
removing those IDs and their anonymous volumes. Unknown partial creation or a
changed inventory is held for inspection, not deleted by prefix. Cleanup uses a
dedicated kubeconfig, never the user's active context. Do not upload that private
kubeconfig. Cleanup runs with `always()`, followed by diagnostics upload; job
success includes cleanup success. A hard runner cancellation can still prevent
these steps, so GitHub's disposable-runner teardown remains the final containment
boundary. There are no GCP resources in this gate.

`ha-timing.json` records bounded monotonic setup, workload, rollout/recovery and
acceptance phases. Logs show the current retirement phase/owner every 30 seconds,
without bodies, credentials or error stacks. Timing artifact failures never
replace the behavioral result; timing does not extend deadlines or retry writes.
GitHub still reports setup, cleanup and total job time separately.

For a controlled **local** serial comparison, `certify` invokes those same three
scenario implementations sequentially, creating and ownership-cleaning a fresh
cluster for each rather than retaining another certification implementation.
Supply the exact candidate/predecessor manifests, digest-pinned image settings,
and their explicit `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`
binding. The tracked checkout must match the candidate. Kind 0.27, Docker,
Helm/Kubectl, registry read access and the matching Playwright browser are required.
The wrapper refuses an existing cluster with a reserved proof name. Private
kubeconfigs stay under ignored `artifacts/ha-private/`; reports stay under the
chosen HA artifacts directory. This is disposable local evidence, not GKE
qualification or authorization to deploy.
Use a fresh artifacts directory for a new comparison; creation receipts and
previous certificates are never overwritten to disguise a new attempt.

Verification commands include the complete `yarn studio-server:build`,
`yarn node --test deploy/studio-server/scripts/ha-proof-scenarios.test.mjs`,
the existing HA evidence/gate suites, workflow/style/structure/doc-link checks,
and real local scenario execution. The assembly CLI regression uses an isolated
Git repository and actual certificate files; it does not mock certificate
creation. Compare serial/parallel behavior on identical candidate inputs and
measure hosted wall time, queue time and total runner-minutes separately.
Parallelism may consume more runner-minutes. No fixed duration or hosted speedup
is promised before measurement.

Local verification scope (October 27): the complete Studio Server build,
Kubernetes contract/render suite (including real Linux ownership and executable
deployment-recovery tests), 58 focused HA/evidence/assembly CLI regressions, CI
policy/classification, documentation and style checks passed. Earlier Kind
attempts were interrupted during image loading. The operator subsequently
reported possible manual container interruptions; the original observations
do not establish a Docker Desktop defect.

Subsequent uninterrupted diagnostic attempts were not successful qualification:

- A preloaded cluster lost Kubernetes controller/scheduler leases and never
  created its database Pods before the existing readiness deadline expired.
- Fresh normal-image-pull fixtures reached Rivet installation and saved-fixture
  acceptance. The lease-loss case completed its no-change journal baseline
  without replacing an ordinary owner, then failed on an actual
  `etcdserver: request timed out` journal update and a traffic timeout.
- The upgrade's real headless browser retained its page and unsaved edit,
  reconnected its session, resumed the accepted run and displayed the expected
  output. The local forwarded HTTP connection subsequently stopped accepting
  requests (`ECONNREFUSED`); the recording response was not observed and the
  browser acceptance failed. The cause of that transport loss is not established.
  Completed output is not a substitute for recording/whole-upgrade acceptance.

These diagnostic runs reused existing digest-pinned images from source
`9fae0a32c21e677ac9db4182efef9d95be14e19d` (image build run `40415803069`),
not a new release of the uncommitted tooling. Their reports remain under ignored
`artifacts/ha-local-verification/`; every recorded test node was removed with
its anonymous volumes, without restarting Docker or touching regular local
Rivet, GCP or production. Shared image caches and private diagnostics are retained.
No failed observation was retried into success or used to issue a v3 certificate.
The complete three-scenario real-container proof, headless acceptance and
same-input timing comparison remain release-validation work in an uninterrupted
healthy local cluster or the isolated GitHub jobs. Do not make the mandatory
matrix optional to work around these local validation failures, and do not
claim a hosted speedup before measuring it.

## Verification

The first optimization was measured on successful develop runs: Studio
verification [37355329746](https://github.com/valerypopoff/rivet2.0/actions/runs/37355329746)
took 13m34s (previously 23m40s), desktop release
[37355330453](https://github.com/valerypopoff/rivet2.0/actions/runs/37355330453)
13m18s (previously 20m40s), and Build
[37355329795](https://github.com/valerypopoff/rivet2.0/actions/runs/37355329795)
10m06s. The next changes target the remaining 9m48s API test lane, 80-second
desktop prerequisite and source-invalidated Docker installation/cache exports.
Their hosted benefit must be measured after landing, not inferred from local runs.

`yarn test:style` includes regressions for shallow fetches, damaged/stale desktop
artifacts, exact-once native shard selection, prebuilt modes and macOS retry
arguments. The workflow guard checks producer/consumer dependencies and all
existing release gates. Run the complete local-upgrade runtime suite, both Core
partitions, Node tests in prebuilt mode and `yarn studio-server:ui:ci` when
changing these boundaries.

After pushing, compare the three critical paths against this baseline. Expected
benefits come from reducing sequential work and repeated frontend builds, not
from deleting checks. Remaining costs include cold SDK imports, Rust/container
builds, DNS/image rehearsals and third-party signing services. Do not promise a
fixed duration before the new hosted runs have completed.

Do not blindly increase job/file concurrency. Each runner has a finite CPU and
memory budget, and concurrent branch workflows share the account's job limits.
Keep the bounded worker counts until hosted timings and resource use justify a
change. Full-history migration provenance, live dependency failures, signing
and image promotion are deliberate remaining costs, not redundant work.

Local verification of the first optimization passed both Core partitions (1,803 tests),
Node's prebuilt lane (307 tests), all 25 runtime migration scenarios and all 48
browser CI regressions, plus API typechecking, the desktop frontend build,
artifact sealing/verification and both test-style guards. The Windows browser
runner needed its owned preview processes stopped after the assertions finished;
that cleanup issue is not evidence of a hosted Linux test failure. Native
packaging/signing and final hosted timings still require the next GitHub run.

The actual Windows Tauri CLI was also exercised with the prebuilt configuration:
it selected the new hook and rejected missing source-SHA evidence before sidecar
preparation or native compilation. This verifies hook/path wiring, not a signed
native release. Sparse/partial-clone regressions prove that unmaterialized files
remain in the diff while missing source blobs and parent history stay unfetched.

The follow-up optimization was verified separately: all 25 migration scenarios
passed using the four compiled-runtime partitions, and a source-mode browser
backup scenario passed. Both Core partitions, Node's prebuilt suite, API
typechecking, desktop/CLI builds and both test-style guards passed. The API, executor and web images
built locally, with the dependency installation reused across source changes.
The standalone Node 20 executor loaded its runtime workspace exports. The
headless production-image upgrade rehearsal passed all 14 evidence phases,
including online/offline recovery, coordinated restart and live SQLite serving.
These disposable local checks establish correctness, not GitHub runner speed.

Runtime staging also has a behavioral dependency-resolution regression, run on
Windows and Linux: a workspace-local version must win over the hoisted version,
relative links must remain usable, and dependency-owned assets must survive API
test pruning. The real API image confirms both dependency versions coexist
(root minimatch 10 and API-local minimatch 9); image trimming must not change the
API's selected major version.

## Desktop ZIP audit scope: November 17, 2026

A fresh pre-push audit found two additional findings with an unchanged lockfile:
[RUSTSEC-2026-0545](https://github.com/RustSec/advisory-db/blob/main/crates/zip/RUSTSEC-2026-0545.md)
concerns unauthenticated AES entry reads, and
[RUSTSEC-2026-0548](https://github.com/RustSec/advisory-db/blob/main/crates/zip/RUSTSEC-2026-0548.md)
concerns checking central-directory names but extracting local-header names with
a streaming reader. A policy-only expiry check cannot discover new findings;
CI also checks the unfiltered current audit report.

The reviewed `zip 0.6.6` has only `tauri 1.8.3` as a consumer. Both crate archives
were checked against their Cargo.lock SHA-256 values. Windows-target Cargo
metadata resolves no ZIP features: Tauri disables default features and does not
enable AES. Its updater verifies the signed archive before extraction, then uses
`ZipArchive::by_index` and the same entry's central-directory `name_raw` in its own
copy loop. It never switches to a streaming reader. No Rivet native ZIP extraction
command was found. The affected paths therefore are not used by this build.

The two documented exceptions keep the existing November 30 expiry and exact
version/checksum/sole-consumer guard. They do not patch the dependency or excuse
a new ZIP consumer, encryption feature or extraction path. The patched ZIP major
is incompatible with Tauri 1's dependency constraint; replacing the legacy updater
remains separate work. No dependency, application behavior or signing rule changed.
