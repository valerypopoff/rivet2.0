# Focused connection-reset diagnostic

This is an investigation of the incomplete response seen on November 7, not a
release gate or a production update. It does not access the retained Rivet
installation, reset its baseline, remove its quarantine, or reuse its lock.
It uses a new disposable namespace and the pinned Node 24.22.1 and Nginx 1.30.6
runtime images. No application image build, database, external load balancer,
certificate issuance, persistent disk, or new cluster is needed.

The diagnostic proxy now explicitly matches the generated public workflow
route's upstream `Connection: close` and response buffering policy. Earlier
diagnostics cleared that header and disabled buffering, so they did not exercise
the same response delivery settings. Backend receipts record this one
non-sensitive header; the observer rejects a mismatch before changing the
Service and still settles all accepted requests. No workflow POST is retried.
The explicit header does not shorten an active response: it asks the upstream
to close after delivering it. Regenerate older frozen diagnostic bundles.

## What it tests

1. Keep two small HTTP backends, A and B, alive throughout the test. Route an
   internal Nginx proxy through one ClusterIP Service initially selecting A.
2. Complete one control request over each of fresh HTTP/1, pooled HTTP/1 and
   negotiated HTTP/2. Each uses a 16-KiB input and a 16,568-byte JSON response.
3. Start three more requests over the same transport variants, plus one HTTP/1
   control through an unchanged Service and the same proxy. A sends no
   headers or body until release, matching a synchronous graph execution.
   Record acceptance, owner UID,
   process incarnation, node, socket and transport before changing routing.
   Acceptance and first-failure events are emitted immediately to private
   container logs. Nginx log lines include the same request IDs.
4. Change only the disposable execution Service selector from A to B, using
   UID/resourceVersion/selector preconditions. Issue the PATCH once. If its
   acknowledgement is lost, read back its state without repeating it. The whole
   Service spec must match the original plus that selector change; a concurrent
   affinity or traffic-policy change makes the observation inconclusive.
5. Observe a fresh read reach B, keep the accepted requests silent for 300 seconds,
   verify both original owners remain alive,
   release A's four pending responses, and require all their bytes to arrive.
6. Save the result and private proxy logs, then delete only the diagnostic
   namespace. There are exactly seven workflow POSTs, with no retries. A failure
   closes new work and lets accepted requests settle.

The provider hold is deliberately five minutes: the previous sub-second,
partially streamed response did not test the idle connection that failed.
The backend and proxy Pods must occupy three different nodes, enforced by
required Pod anti-affinity. Each of these three Pods requests 500m CPU / 512Mi
memory with a 512Mi memory limit to meet Autopilot's anti-affinity minimums.
The unaffinitized client retains its 50m / 128Mi requests and 128Mi memory limit.
Holds auto-release after 330 seconds; an expiry or
a failed setup/observation is inconclusive. Requests have a 345-second deadline.
The Job has a seven-minute deadline and `backoffLimit: 0`.
All fixture Pods have a fifteen-minute lifetime limit as a fallback; explicit
namespace cleanup is still required.
The observer measures the silent interval with its own monotonic clock after
all four requests are confirmed admitted. Backend timestamps are evidence only;
clock skew cannot shorten or extend the hold. Confirmed routing to B is recorded
before that wait, so a later response failure retains the routing evidence.
Request durations and observation deadlines also use that monotonic clock;
wall-clock timestamps are correlation metadata. The observer rechecks the silent
deadline after timer wake-ups and records `observedSilentHoldMs` before release.
An aborted hold still fails and settles accepted responses without claiming the
required silent interval was observed.

The local runner substitutes a TCP connection router for the ClusterIP. It
preserves established connections while changing the destination for new ones;
it does **not** reproduce GKE/Cilium connection tracking. A local pass validates
the diagnostic, using a 100ms hold to keep local iteration short. A provider pass
only rules out this isolated five-minute endpoint-switch case under the observed
placement. Neither qualifies a release nor tests full Rivet behavior, retirement
or the external load balancer. Record node placement; a same-node run does not
satisfy the revised scenario.

## Local validation and offline preparation

The tools image must already exist locally and provide Node 24.22.1 and OpenSSL.
The runner checks both executables before creating the output directory, so a
wrong or incomplete tools image fails before any preparation files are written.
The command refuses to pull images or overwrite a previous output directory.
All local networking is confined to one internal Docker network; cleanup checks
ownership before removing its exact containers/network. The self-signed test
key is disposable and is deleted after local execution. Prepared bundles contain
that test key and must stay under the ignored `artifacts/` directory.
Node processes are launched through projected symlink paths locally as well as
in Kubernetes. Entry-point detection canonicalizes both paths, while importing
the fixture as a module remains inert. The regression covers normal Node
resolution and `--preserve-symlinks-main`.

```sh
node .yarn/releases/yarn-4.17.1.cjs exec node --test deploy/studio-server/scripts/connection-reset-diagnostic.test.mjs

node deploy/studio-server/scripts/connection-reset-diagnostic.mjs local --tools-image EXISTING_TOOLS_IMAGE
node deploy/studio-server/scripts/connection-reset-diagnostic.mjs local --tools-image EXISTING_TOOLS_IMAGE --truncate-response
node deploy/studio-server/scripts/connection-reset-diagnostic.mjs prepare --tools-image EXISTING_TOOLS_IMAGE
```

The negative control deliberately resets one held response after the selector
change. Exit status 1 and one incomplete response are expected; the other six
responses must complete, accepted work must settle, and cleanup must succeed.
The unchanged-route control is excluded from deliberate truncation even if it
arrives first. The affected handoff transport depends on arrival order and must
be read from evidence.

Local cleanup removes the verified container/network IDs, not names that could
be reused between inspection and deletion. Log-reading or log-writing failures
do not skip those removals. Such errors still fail the command; the separately
reported `cleanupVerified` describes resource/TLS cleanup, not log completeness.
Removal failures and TLS cleanup failures remain unconfirmed cleanup. All started
TLS removals are joined, and a result-write error cannot replace the original
diagnostic failure.

`prepare` generates three JSON files and `identity.private.json` with their SHA-256
fingerprints; it never calls
kubectl or a cloud API. Infrastructure, proxy and client are separate to ensure
Services/backends exist before Nginx resolves its upstream and to ensure no
synthetic work starts before readiness. The diagnostic account can only get and
patch the named `execution` Service in its own new namespace. Backend/proxy Pods
have no service-account token. No existing account or IAM policy is edited.

## Later staging execution

**Not authorized by local preparation.** Obtain the operation-specific staging
allowance and approval for the disposable namespace and its exact local Role/
RoleBinding first. Verify the current staging cluster UID and Kubernetes access
using the established operator path. Check the certificate still has enough
lifetime for the whole operation, image access, available capacity and a bounded
cleanup path before creating anything. Do not apply these files to production.

After those checks, on the approved staging context:

1. Create `infrastructure.private.json` once. Record the new namespace UID.
   Wait for Pods A and B to become Ready within the approved setup deadline.
   Use `diagnosticPodReady` from `lib/connection-reset-diagnostic.mjs`: a
   terminal Pod, exited diagnostic container or deletion is an immediate setup
   failure, even if a stale Ready condition remains. Do not wait out the deadline.
2. Create `proxy.private.json` once and wait for its Pod to become Ready.
3. Create `client.private.json` once. Save its Job status and logs privately.
   Do not retry a failed Job or replay a partially acknowledged create.
4. Capture the proxy log and Pod/node inventory before cleanup. Read the JSON
   result: `passed`, `failed` (a response failed), or `inconclusive` (setup,
   mutation or observation could not establish the scenario). In particular,
   status 200 without a complete body is a failure.
5. Recheck the exact namespace UID/ownership, delete that namespace normally,
   and verify absence. Preserve the first failure if collection or cleanup also
   fails. No forced deletion, prefix-based cleanup, or retained-app changes.

An unexpected state stops further mutations. Preserve the evidence and resolve
that state before proposing another attempt. Do not turn a diagnostic result
into a production deployment or a full qualification automatically.

## Local result on November 8

The positive Docker control completed all six responses and one selector
change. The negative control identified one truncated 11,959-byte response;
the other five responses completed. Both settled accepted work and removed
their local resources. The probe portion took under one second in each case;
container setup/cleanup is additional. These are local observations only.

## November 8 staging attempt: inconclusive before traffic

The first staging setup passed API access, manifest validation and server-side
Pod admission. Both backend Pods then exited with code 0 without starting their
HTTP servers. The client Job was never created, so no protected requests or
Service-selector change were exercised. This does not establish a Rivet
rollout or network failure.

The cause was reproduced locally with Linux/Node 24.22.1: ConfigMap projection
uses symlinks, while the fixture entry-point guard compares
`fileURLToPath(import.meta.url)` directly with `process.argv[1]`. Those paths
differ for a projected file, so the CLI body is skipped. The regular-file Docker
mount used in the original local controls did not exercise this condition.
Before a new attempt, make entry-point detection projection-safe and add a
regression using Kubernetes-style symlinked paths. Also treat a backend Pod
that exits before readiness as an immediate setup failure rather than waiting
out the readiness deadline. Do not patch/restart this failed setup as a retry.

A separate local credential-adapter assumption about an embedded CA was fixed
before any resource creation; the existing staging endpoint uses public CA
trust. Strict TLS and the verified staging cluster identity were retained.
No application image build, retained-application change, qualification
publication or production deployment was performed.

Cleanup was independently verified: the entire disposable namespace was absent,
and all eight retained staging Pods were Ready. No automatic retry or production
deployment occurred.

The follow-up repair canonicalizes the entry-point paths and adds the projected
path/import regression. The local Docker runner now uses that same symlink
layout for its actual backend, router and client processes. The shared Pod
readiness predicate rejects both terminal Pod phases and exited containers
immediately. These changes affect tooling only; application images are reused.

## Repaired staging diagnostic on November 8

After the projected-path and terminal-Pod fixes passed on Windows and Linux,
one fresh staging diagnostic passed. All six HTTP/1 fresh, HTTP/1 pooled and
HTTP/2 responses were complete (16,568 bytes each), including the three held
across one confirmed Service selector change. The probe took 760ms, the client
Job took six seconds, and setup/evidence collection/cleanup took 89 seconds in
total. The namespace was independently verified absent afterward, and all
eight retained staging Pods were Ready. There was no application image rebuild,
automatic test retry, qualification publication or production deployment.

Both backend owners were on the same node. This is a successful isolated
endpoint-switch diagnostic under that placement; it does not establish the
cause of the earlier reset or qualify the full rolling-update process.

## Subsequent rollout failure: investigate before another attempt

The next timed rollout again lost two complete-response checks. Its proxy log
reported an upstream TCP reset after 11,959 of 16,568 bytes; both affected
requests belonged to the same old worker. A candidate-worker request completed.
The old workers had not yet received retirement commands: the rollout was still
waiting for its legacy Service handoff. The earlier idle-connection retirement
fix therefore does not, by itself, explain this failure.

CI recorded the first failure promptly and stopped admitting synthetic work.
It then completed accepted-work settlement and cleanup. Do not confuse that
settlement time with failure-detection latency. The operator's private summary
must include `failureDetectedAt`, even while the worker remains running.

The revised diagnostic removes the streamed prefix and exercises a full silent
interval on distinct nodes. An unchanged-route request runs alongside the three
handoff requests, so a general idle-connection failure can be distinguished from
failure limited to the Service change without another five-minute batch.
Its local positive and negative controls validate the mechanism, not the GKE
dataplane. This diagnostic is optional: the next acceptance step is the focused
rollout with 295 seconds of work inside a 300-second total request deadline.
Use the diagnostic if that correctly scoped test still fails. Production still
requires successful qualification; a short control does not qualify a rollout.

Local investigation also ran three real five-minute workflow requests against
the old deployed API image, then three through local Nginx. All returned complete
bodies. This does not reproduce GKE Service routing and does not identify the
reset's origin. The revised diagnostic passed 13 focused tests on Windows and
Linux; its local positive control completed seven responses, and its injected
failure detected one truncated response while the other six completed. Both
local controls settled accepted work and verified cleanup. No provider repair
or new qualification is claimed by these results.

The follow-up local review fixed the clock dependency, kept deliberate failure
away from the unchanged-route control, preserved routing confirmation on early
failure, and made log-collection errors independent of owned-resource cleanup.
Previously frozen diagnostic bundles do not contain these repairs; regenerate
and review them before any later activation.
Review validation passed 24 diagnostic/transport regressions on Windows and
Linux, plus local TLS relay cases for backend clocks one hour ahead/behind and
a reset during the silent hold. The Docker success control completed seven
responses. Its deliberate-failure control completed six, detected the intended
truncation, and preserved the unchanged-route control. Both verified cleanup.
The additional routing-drift regressions reject changes to session affinity and
internal traffic policy without replaying the selector write. A local missing-
OpenSSL check confirms failure before output-directory creation.

## Investigation limits after the within-budget reset

The subsequent 295-second rollout request still lost its body before the
300-second client deadline. The old worker had not been instructed to withdraw;
the proxy reported an upstream reset while the legacy Service handoff was
pending. This cannot be explained away as an overlong fixture or attributed to
the earlier idle-connection retirement bug without further evidence.

The local investigation used the affected API image's real body parser and
serving response hooks with Linux/Node 24.22.1, Nginx 1.30.6, the recorded body
size and a configured 295-second silent interval. It did not reproduce the reset.
This fixture does not execute the complete managed graph/recording path or
emulate GKE's dataplane. Earlier full-workflow local controls also passed; neither
result establishes that the provider-specific handoff is safe.

Those controls exposed a second diagnostic gap: elapsed request times were
computed from wall-clock timestamps, which shifted during the Docker runs.
They cannot retrospectively prove the measured silent duration. The repair
uses monotonic elapsed times and explicitly records the completed silent hold;
short local controls and deterministic early-wakeup/clock-jump regressions
validate that repair without another five-minute batch.
The rollout's captured incomplete-body result remains a failure.
The final 27 diagnostic/transport checks passed on Windows and Linux/Node 24.
A Docker control stepped the client's wall clock forward one hour while all
seven responses completed and monotonic request/hold durations stayed correct.
The deliberate truncation control still rejected one response while the other
six completed. Each local run verified settlement and owned-resource cleanup.

The confirmed diagnostic repair is the upstream policy alignment above. Its
positive control must deliver all seven responses; its deliberate truncation
control must still fail while the other responses settle. A wrong-header
control must stop before changing routing and safely release its held requests.
These checks validate the diagnostic, not a fix for the captured reset.

If the reset remains unreproduced locally, retain the existing qualification
failure and prepare the isolated, three-node, five-minute diagnostic described
above. Activation requires its own approval. Do not substitute another full
rollout, relax complete-body checks, add POST retries, or change Service/network
configuration based only on the endpoint-change hypothesis.

## Cross-node setup rejection on November 8

The first activation of the revised cross-node diagnostic stopped at the first
Pod's server-side dry run. GKE's audit record confirmed that required Pod
anti-affinity raises the default-platform Autopilot minimum to 500m CPU and
512Mi memory. The fixture still requested 50m / 128Mi, so admission rejected it.
See [Autopilot workload-separation resource requirements](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests#resource-requests-for-workload-separation-and-extended-duration).

No diagnostic Pods or client Job were created; the five-minute scenario never
ran. The operator stopped, deleted the exact owned namespace, verified its
absence, and did not retry or deploy production. This is a fixture preparation
failure and supplies no evidence about the original reset.

The repair now sets the three anti-affinity wire Pods to 500m CPU / 512Mi memory
with matching 512Mi memory limits. The cross-node requirement is retained and
the unaffinitized client keeps its smaller reservations. A regression checks
the generated Pod and Job specifications; it rejects the previous undersized
bundle. Regenerate frozen bundles before separately authorizing any later
activation. This repair is local tooling work, not GKE admission or rollout
qualification.
The regression rejected the previous resource values, and all 28 focused
diagnostic/transport checks passed on Windows and Linux/Node 24. Regenerated
offline manifests were checked for all three wire Pods, the smaller client,
required cross-node placement and unchanged no-retry settings. No cloud test or
production deployment was started for this repair.

## Repaired cross-node staging result on November 8

One subsequently approved isolated diagnostic passed on the retained GKE
cluster. The repaired 500m / 512Mi wire Pods passed admission and occupied three
different nodes. All seven 16,568-byte responses completed, including fresh
HTTP/1, pooled HTTP/1 and HTTP/2 requests held across one confirmed Service
selector change and the unchanged-route control. Fresh read-only connections
reached B while the accepted requests stayed on A. The measured monotonic
silent interval was 300,000.18ms; accepted fixture work settled, with unchanged
wire Pod UIDs and zero restarts.

The probe took about five minutes, the client Job took 304 seconds, and operator
execution including evidence collection and normal cleanup took 6m35s. The Job
includes the probe. Cleanup independently verified the exact diagnostic
namespace absent and all eight retained staging Pods Ready. The original
application quarantine remained unchanged. No retry, application rebuild,
qualification publication or production deployment occurred.

The original rollout reset was not reproduced. This fixture uses standalone
HTTP handlers and retains the per-backend A/B Services; its backend-reference
lifecycle can differ from the original handoff. Its pass covers this isolated
cross-node Service-switch case, not the real old API/recording path, retirement,
external load balancer, or every Cilium backend-removal scenario. Keep the failed
rollout qualification and require demonstrated evidence before selecting a
cause-specific repair or starting another rollout.

## Real API response-path audit

Do not treat every incomplete response as the same failure. The earlier buffered
HTML retirement defect, the subsequent approximately 16-KiB synchronous JSON
reset, and ordinary server shutdown have different triggering conditions.

The November 8 source audit traced the published route through body admission,
`ExecutionSession`, processor disposal, recording persistence, managed project
materialization and the supervisor. Request-body deadlines end after receipt;
they are not execution deadlines. Processor cleanup has no HTTP socket, and
queued recording writes run separately from response delivery. Managed execution
materializes independent project state for each request. The affected API image
and candidate have the same workflow execution/body/recording implementation;
their relevant serving change is the retirement connection guard. These facts
narrow the investigation but do not prove that every application fault is absent.

A steady-state control using the affected API image completed four concurrent
295-second Code-node/delay/output runs, two returning 16,568 bytes and two
returning 262,328 bytes, with intact Content-Length and output hashes. One reader
paused for 500ms. Alongside them, 250 normal requests completed, 25 malformed
bodies returned their expected 400, and 25 intentionally disconnected clients
did not damage the long responses. Recordings were enabled and active execution
count returned to zero; no idle-close call occurred. The control used direct
HTTP/1 and filesystem persistence. It did not reproduce the managed PostgreSQL/
object-store or GKE network paths. The related local suites passed 120 tests,
with one platform-conditioned Windows skip and no failures.

A separate genuine shutdown gap was reproduced with the affected Linux/Node
24.22.1 API image and a real Code-node workflow response. `server.ts` calls
`server.close()` before accepted HTTP response buffers have necessarily flushed.
Node's close operation invokes its idle closer internally, so removing only the
following explicit `closeIdleConnections()` call would not fix it. A paused
reader received HTTP 200 but only 2,588,341 of 16,777,391 bytes. Waiting for the
existing accepted-request barrier before closing delivered all 16,777,391 bytes
in the paired local control. The repair is now implemented locally in
`closeHttpServerBeforeDeadline`: shutdown fences request admission immediately,
then waits for the existing accepted-request barrier within the original grace
period before calling Node's close. The listener still closes when grace
expires, and the caller retains forced socket closure. The Linux regression
failed with ECONNRESET before the fix and passes afterward; the actual changed
helper also delivered the complete real-API response. No image was rebuilt or
deployed by this local validation.

That shutdown gap does not establish the cause of the captured JSON reset:
the rollout's last owner checks required a serving owner with no retirement
operation, and its journal had not issued withdrawal or drain for the affected
worker. The failure occurred after Service routing changed. No packet capture
identifies which endpoint generated its reset. Keep both ordinary application
failure and routing/connection-tracking failure open until discriminating
evidence exists; a passing standalone handler cannot decide between them.

The next isolated experiment is prepared in
[Real Rivet response-reset diagnostic](./rivet-response-reset.md). It uses the
real API/Code/delay/recording path and compares a changed Service route with an
unchanged direct-Pod route concurrently. Local positive and injected-reset
controls validate it; no new cloud run or release qualification is implied.
