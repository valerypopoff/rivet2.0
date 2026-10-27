# GitHub Actions performance

Optimize measured critical paths without dropping coverage, weakening release
gates or reusing an unverified build from another commit. Standard GitHub-hosted
runners for public repositories are free; these changes need no paid runner.
Branch targeting, signing and protected deployment safeguards remain unchanged.

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
- Browser CI uses three required matrix shards, each running two independent
  spec files at once. `scripts/ci/editor-test-shards.mjs` assigns all 29
  selected specs exactly once using measured file weights (plus explicit estimates
  for new specs). These weights balance work, not predict hosted wall time. Serial tests
  within each file, test-owned contexts/mocks/temporary paths, assertions and
  retry policy are unchanged. Each shard has separate reports and failure
  artifacts. Executor-retirement verification runs exactly once, on shard 1.
  Set `RIVET_EDITOR_TEST_SHARD=1/3`, `2/3` or `3/3` before
  `yarn studio-server:ui:ci` to reproduce a lane. Omit it to run the complete
  selection; unknown shard values fail instead of silently dropping coverage.
  Locally, finish build-mutating checks (including `yarn test:style`) before
  starting browser lanes: their real-API fixtures consume Core's compiled exports.
  Parallel shards need distinct `PLAYWRIGHT_CI_PORT` values. Hosted matrix jobs
  have independent checkouts and verified artifacts rather than shared outputs.
  The shared isolated-editor bootstrap mocks optional provider-environment
  lookups as unset; it must not contact an ambient API or read local credentials.
  Individual provider tests can override that route with their own fixture.
- Deployment contracts have three required, isolated matrix lanes: managed
  storage/schema/restore, deployment-command/Helm contracts, and gateway/proxy
  behavior. Deployment checks no longer wait behind PostgreSQL/restore fixtures.
  All three consume verified same-commit compiled artifacts. Proxy templates still run
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

The three editor shards now connect to Chromium in the official Playwright
1.62.1 Noble image, pinned by OCI digest in `studio-server-verify.yml`. It supplies
browsers and Linux libraries without `apt` or browser downloads in each job.
Node tests still run on the GitHub host: the hosted-Subgraph regressions start
real Docker PostgreSQL/MinIO fixtures and must retain host loopback access.
Moving the entire job into a browser container would break that contract.
This is a disposable CI environment, not a production image. `setup-yarn` still
selects Node 24. Verified exact-commit compiled artifacts, executor-retirement coverage, the
three-shard selection, two workers, assertions and retry policy are unchanged.
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

The recent browser step alone took 15.9 minutes for 165 tests; adding more
workers inside one runner would compete for its CPU. The bounded three-shard
split targets that critical path while preserving the entire selected suite.
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
