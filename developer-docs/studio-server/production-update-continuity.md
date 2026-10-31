# Bounded production request continuity

Status: implemented as an **opt-in repository contract**. Local tests and renders
do not qualify a GKE release. No new provider certificate has been produced and
production has not been changed by this implementation. The
[delivery plan](production-update-continuity-plan.md) retains the exact-image
qualification, publication and production activation gates.

The October 31 essential rollout scope is one successful regional qualification,
the first observed protected production update, the documented ordinary update
path, and verified cleanup. A manufactured second source release and second
cloud campaign are deferred until a real subsequent release. This changes the
delivery scope, not the 300-second qualification or production preflight gates.

An earlier temporary staging attempt failed before application deployment: PostgreSQL
initialized at the CSI mount root and rejected its `lost+found` directory.
The fixture now sets `PGDATA` to a child directory. Cleanup also distinguishes
GKE's automatic `ingress:true` annotation on a ClusterIP dependency Service
from an explicit pending NEG: it permits the status-less automatic annotation
only when a fresh namespace Ingress list is empty. Explicit ports, existing NEG
status, unknown intent, failed reads and any Ingress still require the complete
NEG inventory. Actor and janitor roles include read-only Ingress discovery.
These repairs do not qualify the failed images or authorize a production update.
Private terminal diagnostics retain up to four error causes (names/messages
only), so qualification wrappers preserve the underlying transport failure.
Command-output/environment fields and other error properties are not serialized.

The narrowed campaign closed after three failed staging attempts, with zero
successful qualifications and zero production serving updates. Child and parent
resource cleanup, temporary access removal, evidence transfer and restoration of
the original quota were verified. The repaired source still needs review/CI,
exact-image qualification and the first observed production transition.

The first retained-cluster test then failed during frontend preparation, before
upgrade/autoscaling or production deployment. Regional Compute reported healthy
proxy endpoints while the Gateway's standalone NEG Pod gates remained
`True/LoadBalancerNegWithoutHealthCheck`. Requiring the different
`LoadBalancerNegReady` reason rejected that valid regional attachment. The
repair below requires actual endpoint health instead. The actor was subsequently
evicted during scale-down; normal fixture deletion had completed, and independent
resource/writer absence plus the retained janitor verified cleanup before the
failed workflow and its exact lock were closed. This attempt produced no
qualification certificate. Admissions remain disabled until a new approved test.

The second retained test verified regional frontend health and seeded its
synthetic project, then failed the staging dummy-OAuth login with HTTP403. The
provider omitted its deployment-owned forwarding peers, so the load balancer's
address was not resolved to the allowed public test client. This is repaired by
explicit proxy-subnet/frontend trust, without broadening the client allowlist.
Its50 tracked resources were verified absent; an idle actor was closed after
diagnostics preservation because the old exec client waited beyond process exit.
The exec status channel now terminates that wait. This failed test produced no
qualification certificate or production update. A new paid operation needs its
own allowance after the repaired source/image gates.

The third retained test passed preparation, including real regional health,
client provenance and dummy OAuth. Upgrade then stopped before public handoff:
Autopilot admitted the requested 900-second bridge termination grace as 600
seconds while preserving its 660-second preStop. The strict specification check
correctly rejected that unsafe combination. The replacement profile below fits
600 seconds, and bridge creation now performs server-side dry-run admission
before freezing HPA or creating any bridge resources. This check needs the
deployer's existing namespace create permission; read-only inspection does not
invoke it. A dry run is admission evidence, not request-continuity qualification.
New exact-image GKE qualification remains required; production was not updated.

## Normal release process

Use **Release Rivet** with an existing successful main Build Images run. CI
qualifies those immutable images in a reusable isolated staging cluster, publishes
the exact certificate and invokes the normal production command once through
the protected production environment. That command owns fresh live checks, the
online recovery checkpoint, rollout, short application acceptance and journaled
recovery. There is no separate production-readiness job or repeated cloud setup.
See [automated qualification](automated-runtime-qualification.md) for runner
configuration and automatically selected full/focused test depth. A recurring
staging budget and one-time installation are still needed; the closed temporary
campaign grants no new cloud authority.

First activation still requires a successful full GKE qualification and the
observed temporary proxy bridge below. After that, ordinary updates omit the
bridge. No manufactured second release or second campaign is required to finish
the first rollout. Requests beyond 300 seconds may be interrupted as agreed.

## Contract and configuration

The protected envelope is a published product request completing within 300
seconds, including its complete response body. Published web apps, accepted
actions, schedules and recordings retain their existing runtime ownership and
drain contracts. This does not introduce a blanket workflow/job cancellation
limit. Requests exceeding 300 seconds may be interrupted by an update.

The optional `helm/overlays/gke-proxy-continuity.yaml` selects:

| Setting                       |       Value |
| ----------------------------- | ----------: |
| Protected request             | 300 seconds |
| Actual regional backend drain | 360 seconds |
| Initial propagation allowance |  60 seconds |
| Proxy preStop                 | 420 seconds |
| Proxy pod termination grace   | 600 seconds |

The LB drain must cover the 300-second request plus the propagation allowance;
preStop covers drain plus propagation. Grace also covers the existing
120-second proxy shutdown budget and 25-second finalization margin (565 seconds
minimum for this profile). The 600-second setting leaves additional headroom
and fits the observed Autopilot admission limit. Google's [Autopilot upgrade
documentation](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cluster-upgrades-autopilot)
also describes a 600-second termination limit during node draining. Increasing
propagation requires rechecking every timing inequality and actual admission;
do not accept a provider-shortened lifetime or omit failed probe results.

`lifecycle.proxy.preStopDelaySeconds` and
`lifecycle.proxy.terminationGracePeriodSeconds` inherit their global fields only
when absent. Explicit invalid/null/zero overrides cannot silently inherit a
longer value. Other serving tiers keep their existing lifecycle. Normal proxy/web
readiness stabilization remains independent of drain time.

Use the existing compact regional GKE runtime/autoscaling overlays first, then
the continuity overlay, then installation values. The installation must explicitly
set all five fields under `requestContinuity`: `routeName`, `backendPolicyName`,
`gatewayName`, `gcpProject`, and `gcpRegion`. They identify existing installation
resources; the chart does not take ownership of them. A rendered ConfigMap carries
the normalized timing profile and these identities into the rollout coordinator.

The reviewed policy example is
`deploy/studio-server/examples/gke-proxy-continuity.policy.example.yaml`.
Preserve the installation's timeout, health, target and other policy settings.
The coordinator changes only the drain field on its captured policy and restores
its own metadata after transition. It preserves the request timeout (normally
3600 seconds). See Google's
[draining guidance](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing)
and [Gateway policy reference](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-gateway-resources).

The initial implementation supports the qualified **single-container proxy**,
an unchanged proxy HPA policy, one explicit HTTPS hostname, one Gateway parent,
and route rules that each target the normal proxy Service. Proxy exporters,
multi-backend/shared or mirrored route rules, unknown Service ports and existing response-header modifiers fail
before mutation. They need their own reviewed transition and qualification.

## Read-only preflight

The ordinary deployment command and `--preflight-only` inspect the actual
namespace, route, policy, Gateway, Service, proxy Deployment, HPA, running pods,
NEG health, and regional Compute backend. They check each running proxy's
generated Nginx timeout include. `proxyReadTimeoutSeconds` must already be at
least **360** seconds; the default 180-second idle timeout cannot qualify a
five-minute response. This setting remains installation-owned and is not silently
rewritten in production. The isolated fixture sets it to 3600 using its own
revision-aware settings API and waits for all original proxies to reload it.

Compute observations require read access to regional backend services and their
health. Every current proxy must match a unique healthy endpoint IP/target-port
in its exact Service NEG, with a fresh observation, backend identity and zonal
redundancy. Healthy old/surplus endpoints cannot cover an unhealthy replacement.
`LoadBalancerNegWithoutHealthCheck` is accepted only with this independent
Compute proof; Pod readiness alone and `LoadBalancerNegTimeout` never suffice.
Frontend preparation, proxy HPA, bridge handoff and optional control-topology
transfer share this check. Readiness polls wait for a complete endpoint set;
ambiguous backend discovery and denied Compute reads fail before handoff.
See [standalone NEG readiness](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/standalone-neg).
Provider-gate construction requires the staging project's region even for a
local render-only fixture, so tests must supply that installation identity too.
The provider's HPA frontend snapshot uses the same regional wait/check as initial
admission, including standalone NEG conditions and exact current endpoints.
GCP observations are authenticated separately from Kubernetes. Local
operators use `gcloud auth print-access-token` (optionally a reviewed
`RIVET_GCLOUD_BIN` launcher); in-cluster staging uses its existing metadata
identity. Credentials and raw templates are not included in preflight reports.
`request-continuity-preflight.json` records only the normalized profile, UIDs and
observed backend drain. Acceptance and non-replaying verification repeat the live
checks, require protected normal pods plus matching desired/actual drain, and save
`request-continuity-acceptance.json`. An adopted installation's drift is rejected
at preflight rather than treated as an uncertified first transition. All routes
to the public proxy Service must be covered by the single-route handoff; adopted
network identities cannot silently change. Recovery uses the existing exact `--resume-ha` journal
instead of treating its own temporary route as a new installation baseline.

## First transition and recovery

Changing a Deployment does not extend the lifetime of old pods. The existing
deployment journal therefore owns a temporary ingress handoff before Helm can
change templates:

1. Capture the predecessor's exact immutable proxy template and network UIDs.
   Refuse plaintext proxy credentials in journaled templates. Pause the existing
   proxy HPA's scale-down policy using UID/resourceVersion tests and temporarily
   raise its minimum to the approved maximum (four). Wait for that normal capacity.
2. Create a distinct four-proxy bridge at the same approved HPA ceiling, Service, backend policy, health policy,
   narrow probe route and PDB. Rebind peer placement selectors to bridge labels.
   Wait for the bridge Service's regional NEGs **before creating its pods**, then
   require all four proxies ready, positive NEG health, at least two nodes/zones
   and the protected lifecycle. Preserve unrelated placement selector constraints.
3. Extend the normal backend's drain, observe actual Compute state, and require a
   continuous propagation window through the bridge probe route.
4. Change route weights while retaining both backend references and the old
   normal pods. Confirm public routing and provider drain continuously for a
   full protected-request-plus-propagation quiet window (300 + 60 = 360 seconds
   for the starting profile). Lost routing or drain confirmation resets that
   window. Only then prepare/apply candidate templates and
   execute the existing accepted-work retirement protocol.
5. After normal candidate settlement, confirm four healthy protected normal
   proxies. Keep the temporary HPA floor and scale-down pause through Helm's
   template update. Return route weights to normal and observe
   another full 360-second quiet window. Restore the original route specification,
   retain the longer backend drain, then let Helm restore the original HPA policy
   before removing only exact owned bridge UIDs. This prevents idle normal-pool
   metrics from shrinking capacity just before traffic returns.
6. Recheck ordinary settlement before completing the release journal. Subsequent
   updates inspect an already protected installation and omit the bridge.

The 600-second backend drain remains a configured upper bound; it is not an
additional mandatory handoff sleep. Proxy preStop/grace remain 420/600 seconds.
The shorter handoff is a repository change requiring the first full regional
qualification, not a measured routing guarantee from the failed campaign.

The bridge adds four temporary proxies; raising the normal pool's minimum can add
two more, in addition to native rollout surges and execution autoscaling. Size
the reviewed staging/production capacity allowance for that overlap. A scheduling
or readiness timeout retains serving owners rather than deleting capacity to
make space. Per-stage deployment deadlines and the external staging expiry must
cover the two drain windows, image preparation, 600-second pod termination,
accepted work, qualification requests and cleanup.
Use **`--timeout 20m` or longer** for this profile. The legacy 15-minute default
equals the protected pod grace and is rejected before ingress writes; each stage
deadline must exceed drain, propagation and pod termination grace.

The journal records creation, route/policy/HPA writes and deletion intents before
dispatch. It verifies namespace and owner lifetimes, latest owned network state,
bridge specs and public health while progressing. A lost acknowledged write is
resolved by reading its exact result. An unapplied/foreign/unknown write is not
replayed. An interrupted deletion is observed; a same-name replacement is never
deleted. An unfinished bridge prevents automatic preflight abandonment.
Lost return-route acknowledgements recover from the latest recorded write intent
even if the phase checkpoint was not saved. If Helm stores the temporary
four-proxy minimum, ordinary-layout admission normalizes a copy only for an
unfinished operation with the exact journal token, release, configuration and
profile. Raw installed values and live HPA identity/specification checks remain
unchanged. Already-protected updates validate the same baseline contract under
the owned lease even though they create no bridge.

If a release stops, retain its journal and serving pools, inspect its recorded
token/state and use the existing exact recovery route. Do not delete the bridge,
restore an old route, unpause HPA or retry an execution POST by hand merely to
clear a timeout. Zero-weight backend references follow
[Gateway traffic-splitting semantics](https://gateway-api.sigs.k8s.io/guides/user-guides/traffic-splitting/);
the exact regional provider behavior must still pass qualification.

## Provider qualification and evidence

Put `requestContinuityProfile` in the private settings supplied to
`package-reusable-staging.mjs`, together with the explicit staging `region`:

```json
{
  "protocol": 1,
  "maxProtectedRequestSeconds": 300,
  "backendServiceDrainSeconds": 360,
  "propagationSeconds": 60,
  "proxyPreStopDelaySeconds": 420,
  "proxyTerminationGracePeriodSeconds": 600
}
```

For temporary staging, `RIVET_QUALIFICATION_CONTINUITY_PROFILE` names the reviewed
JSON file. The frozen outer inputs, packaged settings and inner operation must
agree. An adopted installation requires the same target profile on every exact
successor qualification; it cannot fall back to the old short-request suite.
The approved window must be at least two hours and must actually cover the run
and settlement. No previous budget or expiry is inherited.

For a campaign with several qualifications and production windows, reserve the
whole remaining sequence before starting its next paid step. Recheck against
the original approval deadline after any wait for clarification; a later custody
approval does not restart that clock. Show the next stage's latest permitted
start in approval questions whenever it falls before the overall expiry.
If the remaining sequence no longer fits,
close admission, preserve and verify the actual evidence, then clean up the
temporary campaign. Successful builds or local checks do not justify shortening
the approved qualification or cleanup reserves.

The activation request must identify the trusted control host, credential and
Helm-value payloads, setup/cleanup ledger transfers, permitted readers and local
operator sudo access. Keep these files out of actor containers and public
artifacts. Resolve custody questions before starting the bounded cloud window
where possible; retain the actual reply time and immutable payload hashes.

`ProviderRequestContinuity` publishes a dedicated synthetic duration-controlled fixture.
It consumes and validates every body byte and correlates each request with one
successful recording. There are fresh HTTP/1, already pooled HTTP/1 and actually
negotiated HTTP/2 requests before the first backend-policy edit and routing
handoff in both directions, plus late admission, protected
proxy replacement, execution-owner retirement, and observed HPA removal. The
existing cold-proxy scenario runs while developer services are absent. Its
candidate native RollingUpdate is triggered by one UID/resourceVersion-guarded
template annotation patch; no proxy is manually deleted. Its before/after Pod
UIDs and observed termination time are required evidence. Proxy-only acceptance
reuses the live Kubernetes/Compute inspector and does not require absent developer
services to be healthy. The same fixture also
executes 60-, 180- and 295-second requests on all three transports sequentially
before admitting the nominal-300-second cohort across native replacement. Cohorts
settle before the next starts, capping long HTTP fixture demand at three requests
in addition to existing accepted-work and continuous short-traffic probes.
An exclusive, nonce-scoped marker written by each running workflow proves actual
admission on an execution owner before disruption. The observer supports the
combined `backend` container and legacy API/executor containers. Shared mounts
count once; markers on two distinct owners fail duplicate-admission checks.
Admission and disruption boundary times use the observer's clock, so execution
node clock skew cannot reverse their order. Both original execution owners
also receive pinned accepted 315-second background
work; their successful recordings must exist before owner removal. The HPA cohort
is admitted 240 seconds into its real 300-second stabilization window, while all
proxies still serve. Evidence must show every protected request accepted before
and completed after an observed deletion timestamp. Missing that overlap fails
qualification. A fresh Pod snapshot after all admissions must still show every
original proxy present without a deletion timestamp; racing withdrawal fails
instead of certifying requests that reached survivors. The test does not manually
shrink the Deployment or start a replacement cohort on survivors and call it a
drain test. Its deadline covers stabilization in addition to the protected
termination grace and cleanup headroom.
An idle pre-transition WebSocket starts a late action, then resumes the accepted
run through a new connection. Persisted acceptance/completion events must show
one run, one start and one completion. Existing published browser/OAuth, schedule,
accepted-work and continuous short-request probes remain mandatory.
HTTP/2 probes use an absolute deadline across headers and the full response body;
trickled bytes cannot extend it. Resets before headers and truncated bodies fail
settlement, and synchronous transport failures cannot orphan earlier requests.
The provider fixture uses the same HPA pause and temporary floor guards as the
production coordinator.
The provider browser check also exercises the actual served client: after
acceptance its connection closes, the client must automatically send one resume,
receive one completion, and never send another action start. A headless local
generated-client test independently checks the same behavior with a routed
WebSocket fixture. The provider-only case is deliberately skipped outside its
owned regional environment and cannot establish GKE evidence locally.

The temporary bridge and its provider children enter the existing durable staging
inventory before withdrawal. Their exact NEG identities become retiring before
deletion; they remain in cleanup verification after disappearing from live lists.
The independent expiry/settlement path still owns failed or expired runs.

Certificates compile from these validated observations **after both provider
phases and verified cleanup**, not from a supplied list of successful check names.
Version 2 of `runtimeControl.requestContinuity` binds the source, image set, chart digest,
predecessor manifest, normalized profile/hash and complete report hash. First
adoption records `bootstrap: passed`; a previously adopted installation records
`already-protected`. Exact-candidate recovery can use the first-adoption proof
after Helm has already installed its target values. Neither case authorizes a
different predecessor, silently disabling protection, or retuning its timing.
Explicit maintenance for incompatible schemas retains the adopted timing
configuration through its existing reviewed waiver/backup/cutover route. It does
not claim ordinary-update continuity or require an impossible backward-compatible
upgrade certificate. Maintenance cannot silently disable/retune this profile or
perform its first adoption. An uncertain Helm/schema acknowledgement still
retains the bridge for the existing inspected recovery path; network-write
reconciliation does not authorize replaying migrations.
Version 1 continuity observations cannot qualify this expanded suite. First
adoption requires 30 completed requests; an adopted predecessor requires 21.
The installed predecessor manifest digest binds its complete source, chart and
images, while the outer runtime certificate also binds the autoscaler policy.
The qualification command derives its read-only production preflight timeout
from the qualified profile (at least 20 minutes), including termination headroom.

## Verification and activation gates

Image-CI retirement probes use a separate synthetic latest workflow with an
explicit file admission/release barrier. A 300 ms workflow can complete before
its pause reaches the owner, so elapsed delay alone cannot prove live controls.
The probe observes the admitted file, sends one scoped pause/resume to the owner,
verifies peer events, then releases that exact nonce. The same barrier is used
inside the optional bundle child; ordinary requests pass through immediately.
It has a bounded deadline and cannot retry controls, reuse an old marker or
change production debugger authorization. Recovery probes prepare the fixture
once per probe instance; failed/uncertain publication is never replayed.

Focused tests are enrolled in `verify-kubernetes.mjs`:

```powershell
node .yarn/releases/yarn-4.17.1.cjs exec node --test deploy/studio-server/scripts/request-continuity.test.mjs deploy/studio-server/scripts/proxy-continuity-transition.test.mjs deploy/studio-server/scripts/request-continuity-evidence.test.mjs deploy/studio-server/scripts/request-continuity-transport.test.mjs deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs
```

They exercise rendering, inheritance/rejection, drain timing, first handoff,
HPA capacity fencing and restoration order, exact-token admission, lost acknowledgements,
UID replacement, cleanup, real HTTP/2 deadlines/resets/truncated bodies,
and certificate refusal for missing/short/duplicate/mismatched observations.
Run the complete Kubernetes verification command and the repository headless
Playwright runner before handoff. Docker/Linux checks establish process ownership
and packaged tooling behavior; they do not establish regional GKE continuity.
The Kubernetes runner bounds file concurrency to four, in addition to the CLI
journey suite's own bound, so local process contention cannot starve simulated
API requests past the existing lease/metrics freshness limits. The actor browser
registry check runs with workspace dependencies; the Linux kernel ownership
container remains dependency-free. The published web-app Playwright assertions
use the current Decision AI labels.

Plan-audit verification on 2026-10-30 passed:

- Full Kubernetes command: main suite 840 passed, three expected skips; initial
  contract lane, Linux ownership checks and all local/prod Helm renders passed.
- Final continuity, independence, admission, evidence and publication regression
  run: 104 passed, one platform-specific skip.
- Production-cutover lane: 242 passed, seven expected skips; executor-source
  checks passed three tests.
- Headless web-app checks: eight passed; the live provider browser case was
  skipped locally. Documentation links, CI policy and test-style checks passed.

Private logs are under `artifacts/continuity-implementation/`. These counts
overlap and must not be added together or represented as provider qualification.
The first broad audit run had one maintenance recovery CLI failure (838 passed,
one failed, three skipped). The exact case passed in isolation, and the full
rerun passed. The initial failure log is retained; its cause was not reproduced
and is not represented as a successful run.

Remaining essential acceptance work includes one successful isolated regional GKE
qualification, provider cleanup, qualified-manifest publication, fresh production
preflight and backup, and the first observed production transition.
Revalidate the exact source, installed predecessor, artifacts and scan freshness
before reusing an existing build or actor publication. The genuine later source
change requires its own build and qualification. Any provider failure remains a
failure and may require implementation changes before another reviewed run.
These repository changes do not automatically start a rollout or publication.

Operational preparation on 2026-10-31 completed candidate builds, scanned actor
publication and a local headless production-version continuity check. Its cloud
window closed with zero regional GKE qualifications and zero production serving
updates because the full remaining sequence no longer fit the fixed deadline.
Native preparation evidence was exported and independently verified before
temporary infrastructure/access cleanup and quota restoration. That was a closed
earlier window; its receipts do not settle the latest failed staging attempt.
