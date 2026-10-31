# Production update continuity implementation plan

The standard delivery path is now the lighter
[Release Rivet workflow](automated-runtime-qualification.md): build once, reuse
isolated staging, select full/focused tests automatically, publish the exact
manifest and perform live checks/rolling update/acceptance in one production
action. Shared staging infrastructure and access are configured once under a
fresh recurring budget; temporary setup campaigns are exceptional. First adoption
still requires full regional qualification and its observed bridge transition.
Each first-transition handoff waits the protected request plus propagation
(360 seconds for the starting profile), with 360-second LB drain and
420/600-second proxy preStop/grace. The manufactured second release/campaign is
deferred. Historical milestones below do not grant new cloud activation authority.

Status: **Repository changes implemented; exact-image verification, provider
qualification and production activation remain open.** See the
[implemented contract and operator guide](production-update-continuity.md).

The third retained test passed frontend/authentication preparation, then exposed
an incompatible timing assumption: Autopilot reduced bridge grace from 900 to
600 seconds while retaining the 660-second preStop. The replacement settings
below fit that limit. Server-side dry-run admission now rejects such mutations
before any bridge resource or HPA freeze is created. Actual full qualification,
cleanup and the first observed production rollout remain open.

The implementation adds the opt-in Helm profile, journal-owned ingress bridge,
early HPA capacity floor and scale-down fence, live regional backend inspection, full-body/HTTP2/
late-action provider probes, exact-profile evidence and admission checks. The
local validation results are recorded in that guide and the implementation
handoff. Phases F–G still require their operation-specific approvals and actual
provider evidence; no production guarantee follows from repository tests alone.

The user narrowed the October 31 delivery to one successful regional GKE
qualification, the first protected production update with external observation,
the ordinary rolling-update runbook, and verified cleanup. The manufactured
second Node release, its separate GKE campaign and associated PR work are
deferred until a real subsequent release. Keep the 300-second checks, production
preflight and cleanup gates. The closed temporary campaign's last attempt failed in dependency preparation
before application deployment, so neither qualification nor activation is closed.
See the operator guide for the PostgreSQL mount and automatic NEG annotation
repairs. Rebuild/revalidate the changed source before another qualification.
The narrowed campaign is now closed: all three attempts failed, cleanup and
quota restoration were verified, and production serving configuration is
unchanged. Phases F–G remain open; local repairs and cleanup are not rollout
acceptance.

The first isolated Autopilot attempt in the October 31 campaign failed before
application qualification. Live observations exposed an ignored legacy node
service-account field, managed nodes absent from the customer Compute inventory,
and cleanup discovery that confused diagnostic Events and read-only metrics with
persisted owned objects. The repaired source uses the Autopilot node defaults,
checks the actual node account before bootstrap writes, validates managed Node
identity against the pinned cluster/network, and inventories only deletable
objects without treating Events as ownership authority. The failed attempt does
not qualify a release. Fresh exact-source image/actor checks, successful regional
qualification, its verified cleanup, and the first observed production update
remain required for essential delivery; production serving configuration is unchanged.

Release preparation began on 2026-10-30 after authorization to carry out the
remaining sequence. The candidate includes the continuity changes and their
existing temporary-staging/toolchain prerequisites. Fresh read-only inspection
confirmed production revision 60, the recorded predecessor manifest and schema
18, seven ready pods, and a 520-second running proxy timeout. These observations
are retained in the private `artifacts/continuity-release-20261030/` packet;
they do not constitute provider qualification or an activation receipt. No
self-hosted qualification runner or qualification variables were configured at
inspection, so the external Linux control host must be prepared for the new run.

The reviewed candidate is published in
[PR 204](https://github.com/valerypopoff/rivet2.0/pull/204). Its first CI run passed
compilation, lint, dependency audits and application/Core/Node tests, but rejected
stale generated model help. Both catalogs were regenerated. Release preparation
also advanced the actor's real kubectl to 1.36.6 for the observed GKE 1.36 control
plane, verified its compiled transport behavior, and added offline version-skew
admission. The follow-up headless model/fixture check passed all 23 cases.
Workflow limits now cover a reviewed four-hour qualification operation and the
20-minute continuity preflight plus setup; operation-specific allowance/expiry
still govern admission. A costed cloud/certificate activation request is retained
in the private packet with no affirmative consent assumed. Full final-image
scanning and regional qualification remain required before activation.

### Requirement reconciliation after implementation audit

The earlier completion label overstated phases A/E. Local source checks cannot
complete the clean-candidate, packaged-image or provider gates. The audit also
found and completed missing qualification coverage: native protected
proxy replacement timing, return handoff, the 60/180/295-second duration matrix and
requests actually admitted before HPA removal. Version 2 evidence requires their
facts and temporal overlap rather than successful scenario names.

| Phase | Current disposition                          | Implementation / remaining evidence                                                                                                                                                                          |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A     | Release gate open                            | Existing actor/toolchain work is preserved; clean reviewed source and exact actor build/scan remain required.                                                                                                |
| B     | Implemented, locally checked                 | `helm/overlays/gke-proxy-continuity.yaml`, lifecycle validation, `request-continuity.mjs` and profile/render tests.                                                                                          |
| C     | Implemented, locally checked                 | `proxy-continuity-transition.mjs`, Kubernetes/Compute adapter, exact-token recovery and per-resource lost-create/route/delete tests.                                                                         |
| D     | Implemented, locally checked                 | `provider-request-continuity.mjs`, HPA observer, admission markers, duration/native-roll/return probes, version-2 evidence validators and provider behavior tests. Actual provider observations remain in F. |
| E     | Local checks recorded; exact-image gate open | Kubernetes, browser, transport, qualification, cutover and documentation checks; the clean candidate's complete packaged actor/image verification remains required.                                          |
| F     | Attempted; no successful qualification       | Repair and revalidate the exact source after the failed Autopilot bootstrap; successful isolated regional qualification, retained observations and verified cleanup remain required.                         |
| G     | Not executed                                 | Publish the qualified immutable release, fresh production packet/preflight/backup, then the approved first transition and independent acceptance.                                                            |
| H     | Supported in code; live completion pending   | Already-protected admission omits bootstrap; a later actual mixed-image update must still prove this on GKE.                                                                                                 |

Optional developer-service continuity remains outside the mandatory scope. None
of the repository changes constitutes an uninterrupted-production acceptance.

Prepared 2026-10-30 from the read-only production inspection and the user's
300-second product-request requirement. This document authorizes no cloud
resources, publication, production changes or maintenance interruption.

## 1. Required result and boundaries

Implement compatible production updates that preserve:

- Published workflow endpoint requests from the product backend, including full
  response bodies, when the work completes within 300 seconds.
- Public web-app loading, assets, authentication and actions.
- Published schedule admission and accepted execution/recording durability.
- Continuous admission at a qualified load, with no deployment-induced HTTP
  failures, connection resets, duplicate invocations or lost results.

Requests exceeding 300 seconds may be interrupted during an update. This is
tolerance, not a requirement to add a global request timeout or force cancellation.
Do not turn it into a 300-second limit on scheduled/background jobs, paused editor
runs or every workflow execution. Existing accepted-work retirement guards remain.

Editor/control API, latest-draft execution, hosted Evaluations and debugger
continuity are a separate optional workstream in section 12. Published services
must not depend on that workstream. Incompatible schema/browser contracts and
destructive restore remain explicit maintenance operations; the rolling command
must reject them rather than silently relaxing this contract.

## 2. Starting evidence: refresh before execution

Inspection on 2026-10-30 at 11:05 UTC / 15:05 Asia/Tbilisi found:

| Property                                   | Observed value                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Cluster / region                           | `rivet-cluster` / `europe-central2`                                       |
| Project / namespace / release              | `wartime-storyteller` / `rivet` / `rivet`                                 |
| Helm revision / state                      | 60 / deployed                                                             |
| Source / schema                            | `af0a6651e586031c404c465c89fab4c9ccb0ea90` / 18                           |
| Manifest                                   | `sha256:d1969c1aad6289de5d943de960b255daf82177534e2a151eac2bbcdbf1ae1a4f` |
| Topology                                   | 2 proxy, 1 web, 1 singleton backend, 2 execution, 1 autoscaler            |
| Execution / proxy scaling bounds           | 2–7 / 2–4                                                                 |
| Gateway                                    | `gke-l7-regional-external-managed`                                        |
| Request timeout / LB drain                 | 3600s / 60s, verified against the actual Compute backend service          |
| preStop / application shutdown / pod grace | 120s / 120s / 270s                                                        |
| Rivet DB allowance / reserve / API pool    | 200 / 30 / 10                                                             |

The installed manifest has general HA evidence but lacks the runtime-control and
autoscaling evidence for this compact production layout. The offline admission
check rejected it with `Runtime HA evidence does not qualify the requested GKE
edge profile.` The October 30 operation used an explicit maintenance waiver.

Private observations are under `artifacts/deployment-analysis-20261030/` and the
completed operation record is under
`artifacts/production-upgrade-af0a6651e-20261030/`. These are timestamped evidence,
not reusable deployment approval or a permanent statement of live state.

Before implementation handoff and again before paid qualification/deployment,
refresh the installed manifest, images, chart, schema, namespace/cluster UIDs,
Gateway/route/policy identities, pod templates and policy digest. Stop if they
changed; derive a new exact predecessor and reviewed plan. Keep credentials and
raw Helm settings out of ordinary reports.

## 3. Delivery sequence

| Phase | Work                                                                    | Exit condition                                                            |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A     | Reconcile existing staging/tooling work and freeze requirements         | Clean reviewed source; no duplicated implementation or inherited approval |
| B     | Add the bounded request-continuity profile                              | Effective pod settings, LB policy and validation agree                    |
| C     | Implement a safe first transition from short-lived proxy pods           | Old proxies cannot be deleted while protected requests remain exposed     |
| D     | Extend provider probes, evidence and admission                          | A certificate proves the exact 300-second contract and transition         |
| E     | Complete local and packaged-image verification                          | All relevant failure/recovery checks pass                                 |
| F     | Build and qualify the exact candidate on isolated regional GKE          | Continuous observations, runtime/autoscaling evidence and cleanup pass    |
| G     | Publish, preflight and perform the approved first production transition | Qualified candidate installed without a published-service outage          |
| H     | Use the ordinary rolling path for subsequent compatible releases        | No bootstrap needed when the installed profile is already protected       |

Do not start F before A–E pass. Do not start G from a failed/waived qualification.
The optional developer-overlap phase follows the production-traffic work.

## 4. Phase A — finish existing prerequisites without duplicating them

The working tree already contains separate deployment/staging work. Review it
with its owner before building a candidate; preserve unrelated changes. Relevant
owners include:

- `deploy/studio-server/images/qualification/Dockerfile`,
  `install-dependencies.mjs`, `prepare-browser-tools.mjs`,
  `verify-source.mjs`, `verify-toolchain.mjs`, and the pinned tool build scripts.
- `deploy/studio-server/scripts/build-temporary-staging-actor.mjs`.
- `scripts/lib/temporary-staging-{actor,contract,runtime,network,certificate}.mjs`
  and `scripts/qualification/{temporary-actor,temporary-acme-server}.mjs`, relative
  to `deploy/studio-server/`.
- `scripts/qualification/provider-entry.mjs`, staging tests and the existing
  actor/source-packet dependency-closure checks.

The previous production operation recorded staging packaging and hostname
blockers. The current uncommitted work already addresses parts of these areas;
inspect and validate it before proposing another fix. Its existence does not mean
it is present in a clean main image or provider-qualified.

Pass the exact packaged actor's entrypoints, required module resolution,
certificate tooling, kubectl/Helm/browser availability and source-fingerprint
checks. Use the maintained trusted-hostname route, including reviewed ACME terms
if that mode is selected. No certificate bypass or ad hoc shared staging reuse.

Keep temporary staging controlled from the durable external Linux host with its
independent watchdog, exact inventory and existing expiry/cleanup protocol.
Prepare a new budget/deadline/resource approval before activation; previous
allowances and maintenance waivers are not inputs to this work.

## 5. Phase B — one explicit 300-second continuity profile

Use the following **proposed starting settings**, then qualify them on GKE:

| Setting                            |            Proposed target | Purpose                                                 |
| ---------------------------------- | -------------------------: | ------------------------------------------------------- |
| Protected product request duration |                       300s | User's required request envelope                        |
| Proxy backend-service drain        |                       360s | Request duration plus propagation allowance             |
| Proxy preStop                      |                       420s | Drain window plus initial 60s NEG propagation allowance |
| Proxy termination grace            |                       600s | Fits observed Autopilot admission; covers 565s minimum  |
| Proxy/web minReadySeconds          |      Retain 120s initially | Independent readiness stabilization                     |
| Ordinary request timeout           |    Preserve existing 3600s | No new blanket 300s timeout                             |
| Non-proxy lifecycle settings       | Preserve existing settings | Accepted-work drain still precedes owner deletion       |

These are engineering starting values, not measured bounds. Increase the
propagation allowance if provider observations require it; a failed trial does
not pass by excluding its failures. Keep a documented relationship between the
protected duration, LB drain, observed propagation and pod lifetime.

The earlier 2x drain proposal could not fit Autopilot's observed 600-second
grace limit with the existing shutdown budget. The replacement uses the explicit
300-second envelope plus propagation, then preserves the relationships between
drain, preStop and shutdown. These values require real provider qualification;
server admission alone is insufficient. See [GKE draining guidance](https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing)
and [Gateway policy configuration](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/configure-gateway-resources).

### Helm and installation configuration

1. Add optional proxy-specific lifecycle overrides, proposed as
   `lifecycle.proxy.preStopDelaySeconds` and
   `lifecycle.proxy.terminationGracePeriodSeconds`.
   An absent field inherits the existing global value. Explicit zero must remain
   distinguishable from absence for local fixtures; do not use a truthiness
   fallback. Do not change every serving tier's preStop to eleven minutes.
2. Update `helm/values.yaml`, `helm/templates/_pod.tpl`,
   `helm/templates/_containers-proxy.tpl`, `helm/templates/proxy-deployment.yaml`
   and `helm/templates/validate-values.yaml`. Resolve effective values once using
   a small shared helper if needed. Preserve the validation-owner no-preStop
   behavior and existing local/Docker/non-HA behavior.
3. Add `helm/overlays/gke-proxy-continuity.yaml` for the selected proxy lifecycle
   profile. Validate the effective proxy grace against effective preStop plus
   shutdown/finalization allowance. Test missing, zero, negative, fractional and
   contradictory values.
4. The live `GCPBackendPolicy` is installation-owned, outside the chart. Preserve
   that ownership. Add a reviewed example under
   `deploy/studio-server/examples/gke-proxy-continuity.policy.example.yaml`, with
   target placeholders and no production identities or credentials. Its existing
   request timeout, health check and target must be preserved when drain changes.
5. Extend the installation preflight/acceptance adapter to inspect the exact
   policy UID/resourceVersion, Service, Gateway/HTTPRoute and actual regional
   Compute backend service. A Kubernetes desired value alone is insufficient.
6. Freeze a normalized continuity profile in the private operation and resulting
   certificate. Include effective proxy lifecycle values and LB timing. Keep live
   UIDs in the operation binding, not in a reusable cross-environment profile hash.
   After an owned policy/route change, compare against that phase's recorded
   expected state. Do not mistake an acknowledged operation-owned change for
   foreign drift, or disable drift checks for unrelated fields.

Do not shorten application shutdown to fit existing 270-second pods. Keep nginx's
graceful stop behavior; verify the actual image signal/process chain. Deployment
timeouts and staging expiry must allow longer graceful termination and cleanup.

## 6. Phase C — safely bootstrap the existing proxy pods

**Required first-transition work.** Updating the template does not change the
existing pods' short lifecycle. A native rollout could delete one with a protected
request still active. Raising the LB drain alone does not extend that pod's life.

Implemented mechanism: a temporary, separately labelled four-proxy bridge at the
approved proxy HPA ceiling, using the
installed proxy image and the new lifecycle profile. It forwards to the existing
Rivet Services. After the transition it is removed; routine updates retain the
normal seven-pod baseline.

Implement this as a bounded stage of the existing release operation, not a new
permanent controller or independent concurrent cloud writer. Proposed new owner:
`deploy/studio-server/scripts/lib/proxy-continuity-transition.mjs` and its focused
tests. Integrate with `deploy-kubernetes-release.mjs`,
`lib/deployment-operation.mjs`, `lib/release-operation-journal.mjs`, readiness,
capacity preparation and exact-token recovery.

Sequence to implement and qualify:

1. Capture and bind the existing route/policy/Service/controller UIDs, versions,
   selectors, filters, images and Secret references. Inventory every ingress to
   the proxy; identify direct consumers that bypass the public route.
2. Journal and apply a temporary normal HPA minimum at its approved ceiling
   (four), with scale-down paused. Wait for that capacity before creating four
   bridge proxies, their distinct Service and
   their own health/drain policy. Derive their templates from the exact installed
   proxy template with only the reviewed lifecycle, labels and resource changes.
   Use installed immutable images and references to existing configuration; do
   not copy plaintext credentials or let the normal HPA/Deployment select them.
   Review affinity/topology selectors for the bridge's own peers as well as the
   normal proxies; retain unrelated placement constraints and require distribution
   across at least two nodes/zones.
3. Verify bridge readiness through the real regional Gateway using a narrow
   operation-owned probe rule, preserving hostname, TLS and authentication.
   Retain the existing route and backend reference throughout. Budget all normal
   pods, bridge pods, preparation Jobs, autoscaling and terminating pods.
4. Raise the existing proxy policy to the reviewed drain interval using UID and
   resourceVersion guards, then verify actual Compute settings and health. No old
   proxy is deleted at this point.
5. Shift new traffic to the bridge using the existing HTTPRoute, with both old
   and bridge references retained and the old weight set to zero. Preserve all
   other matches/filters/parents. Verify controller acceptance, actual provider
   routing, authenticated probes and an uninterrupted external observer.
6. Keep old proxies alive until routing withdrawal is established and the full
   protected-request window plus propagation margin has elapsed. Use the
   conservative 600-second quiet/drain window initially. A route/endpoint return
   or uncertain observation invalidates the window and retains the old owners.
7. Run the candidate rollout while the bridge carries public ingress. The normal
   proxy Deployment now installs protected pods without exposing accepted public
   requests on the short-lived predecessors. Execution retirement still uses the
   existing replacement-capacity and accepted-work protocol.
8. After candidate proxy/Service/LB readiness and application acceptance, shift
   new traffic back to the normal protected proxy Service. Keep the bridge and
   its backend reference and the normal HPA floor/pause alive for its own full
   drain window. Restore the original HPA policy only after normal traffic has
   returned, then remove only
   the journal-owned objects. Restore the intended route shape and verify it.
9. Mark completion only after route/policy settlement, bridge cleanup, normal
   workload/autoscaler settlement and application acceptance.

Weighted routing is supported by [GKE Gateway traffic management](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/traffic-management).
Whether a zero-weight backend preserves the necessary existing connections and
provider objects on this exact regional Gateway is a **qualification question**.
Prove it with live 300-second requests before accepting this mechanism. If it
does not, stop and revise the ingress handoff; do not treat weight zero or a
Ready pod as proof of continuity.

Recovery must inspect every uncertain write. It must not recreate an acknowledged
bridge, adopt a foreign object, replay a route patch, restore stale filters over
another operator's change, or delete an uncertain serving target. After process
loss, re-establish routing facts and restart the protective waiting window rather
than trusting elapsed wall time from a stale receipt. Failure retains verified
serving capacity; the command reports the exact resume token and pending state.

Future ordinary rollouts skip this stage only when live pod templates/pods,
policy and required certificate already satisfy the protected profile. This
decision must be verified, not inferred from an image tag or Helm values alone.

## 7. Phase D — prove the contract and bind its evidence

### Fix the staging/public-policy parity gap

The maintained `qualification/provider-gate.mjs:createPublicRoute()` now creates
a fixture-owned GCPBackendPolicy alongside the Service, HTTPRoute and
HealthCheckPolicy, before proxy admission.
Qualify the observed predecessor policy and proposed candidate policy, including
the first-transition change. Verify actual Compute settings. Register new
resources in existing intent/UID/inventory/cleanup mechanisms.

### Extend the existing provider probes

Owners to extend, relative to `deploy/studio-server/scripts/`:

- `lib/ha-workflow-traffic.mjs`, `lib/ha-release-probes.mjs`,
  `lib/runtime-upgrade-qualification.mjs` and
  `qualification/{provider-entry,provider-gate,provider-proxy-hpa,provider-faults}.mjs`.
- `lib/runtime-qualification-{installation,execution,publication,driver}.mjs`.
- `lib/ha-release-evidence.mjs`, `execute-runtime-qualification.mjs` and the
  existing qualification/publication workflows.

Required cases:

| Scenario                                                                | Required observation                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Continuous short authenticated requests                                 | Zero failures across the complete operation at declared non-overload load                                  |
| 60s, 180s, near-300s and nominal-300s synchronous runs                  | Complete correct bodies; no reset, truncation, retry or duplicate invocation                               |
| Request admitted immediately before old-proxy withdrawal                | Same completion guarantee, with acceptance/route timestamps                                                |
| HTTP keep-alive reuse and HTTP/2 streams, where supported by the caller | Requests admitted near withdrawal complete; no assumption that a new request requires a new TCP connection |
| First bridge handoff in both directions                                 | Protected requests survive each route/policy change and bridge cleanup                                     |
| Ordinary proxy rollout after adoption                                   | Protected requests survive real Pod/NEG replacement                                                        |
| Proxy HPA removal at the target profile                                 | Accepted requests survive scale-down; current production HPA can remove proxies independently of releases  |
| Execution owner retirement, returning demand and controller restart     | Two-ready floor, fresh headroom, accepted-work/recording drain, no competing replica writers               |
| Public web-app load/auth/assets/actions                                 | Functional journeys and accepted actions across replacement                                                |
| Late action on an established web-app WebSocket                         | Reconnect/resume preserves accepted results without duplicate action invocation                            |
| Published schedules                                                     | Expected occurrence IDs admitted without missed or duplicate accepted invocations in the tested window     |
| Developer backend/web replaced or absent                                | Published readiness and public journeys remain independent                                                 |
| Observer, lease or acknowledgement loss                                 | Explicit failure/recovery; no hidden retry or missing observation interval counted as a pass               |

Use isolated synthetic workflows with deterministic outputs and correlation IDs;
include an idempotency-sensitive test counter to detect duplicate invocations.
Read full response bodies and verify terminal recordings. A 200 header followed
by background work or a truncated stream is insufficient evidence. Avoid paid
model/provider calls. Client deadlines must exceed the fixture duration plus
observation margin so the test client does not create its own cancellation.
Keep the existing short-traffic observer's timeout and failure sensitivity;
implement long-request cohorts separately instead of making every health/traffic
probe wait ten minutes. Match the product caller's protocol and connection-pool
behavior. Review `packages/studio-server-api/src/web-app-action-websocket.ts` and
its durable run-store/client resume path if the established-socket case fails;
longer LB settings alone do not prove safe WebSocket action handoff.

Classify any intentionally longer-than-300-second request before the scenario
starts. Such requests may fail without violating that narrow allowance; never
relabel a failed protected request as long after the fact. Do not infer generic
exactly-once side effects from a bounded duplicate-invocation fixture.

### Evidence/admission changes

1. Add a versioned `requestContinuity` section to the runtime qualification facts,
   carrying the 300-second scope, normalized timing profiles, full-body/recording
   results and first-transition result where applicable.
2. Bind it to exact predecessor/candidate image digests, sources, both chart digests, regional
   edge profile and autoscaler policy, with hashes of retained provider reports.
3. Extend `qualificationSizing()`'s allowlist to include effective proxy-specific
   lifecycle fields and safe external policy facts. Never export raw Helm values,
   environment variables, kubeconfig or secret data.
4. Require the new proof for an installation requesting this continuity profile.
   Old certificates remain readable for their original scope but cannot claim
   300-second protection. Do not modify an already installed manifest in place.
5. Express the first transition as an exact qualified source-profile to
   target-profile change. Do not waive all installed-settings comparisons merely
   because the target profile differs. Unrelated topology, pool or policy changes
   remain rejected.
6. Keep `runtimeControl` and `runtimeAutoscaling` requirements. Passing a new long
   request probe cannot substitute for the existing runtime/controller suites.
7. Keep uninterrupted observation windows and verified cleanup mandatory for
   publication. A failed window followed by a passing window is a new result,
   not one concatenated zero-failure certificate.

## 8. Phase E — local and packaged-image verification

Add focused behavioral/failure tests for new effective lifecycle resolution,
policy inspection, bridge state/recovery, evidence/profile binding and admission.
Extend existing tests rather than creating a parallel deployer test framework:

- `ha-gke-availability.test.mjs`, relevant Helm/API contract tests.
- `ha-release-evidence.test.mjs`, `ha-rolling-upgrade.test.mjs`,
  `ha-rollout-preparation.test.mjs`, `ha-rollout-headroom.test.mjs`.
- `deployment-command.test.mjs`, `deployment-operation.test.mjs`.
- `runtime-upgrade-qualification.test.mjs`,
  `runtime-qualification-execution.test.mjs`,
  `runtime-qualification-publication.test.mjs`.
- `temporary-staging*.test.mjs`, actor/source-packet and certificate tests for
  any changes adopted from the pending staging work.

Exercise failure before/after every bridge CREATE, policy/route patch,
acknowledgement, withdrawal observation and cleanup. Check foreign/replaced UIDs,
resourceVersion conflicts, returned routes, lost leases and insufficient capacity.
Test that an already protected installation follows the ordinary path without
creating bridge resources.

Representative existing commands from the repository root (run affected subsets
first, then the applicable required lanes):

```powershell
node .yarn/releases/yarn-4.17.1.cjs exec node --test deploy/studio-server/scripts/ha-release-evidence.test.mjs deploy/studio-server/scripts/ha-rolling-upgrade.test.mjs deploy/studio-server/scripts/ha-gke-availability.test.mjs deploy/studio-server/scripts/runtime-upgrade-qualification.test.mjs deploy/studio-server/scripts/runtime-qualification-execution.test.mjs deploy/studio-server/scripts/runtime-qualification-publication.test.mjs
node .yarn/releases/yarn-4.17.1.cjs studio-server:verify:kubernetes
node .yarn/releases/yarn-4.17.1.cjs studio-server:verify:production-cutover
node scripts/checks/check-doc-links.mjs
git diff --check
```

Run the real packaged actor/container with its pinned tools, not only source
imports. Inspect its graceful nginx process/signal behavior and cleanup on Linux.
Use local HTTP/TLS/exec-WebSocket fixtures for contract failures; these are not
provider evidence.

For browser-visible routing/session effects, build the current hosted frontend
and run the repo Playwright runner with `PLAYWRIGHT_HEADLESS=1`,
`PLAYWRIGHT_SLOW_MO=0` and the correct `PLAYWRIGHT_BASE_URL`. Include public web-app
journeys plus retained browser/debugger coverage, using the existing
`ha-latest-replay.spec.ts`, `remote-bundle-observation.spec.ts` and
`streaming-boundary-wires.spec.ts` where applicable. Inspect failures under
`artifacts/playwright/`; do not weaken assertions to pass this work.

## 9. Phase F — exact-candidate isolated GKE qualification

1. Review and publish a clean candidate through normal main CI. Preserve unrelated
   work and stage only the reviewed coherent change set. Use the freshly observed
   `installed_predecessor_digest` workflow input if publication has advanced past
   production. Do not rewrite lineage or build from a dirty operator checkout.
2. Retain the successful Build Images run, exact chart/source and all immutable
   image digests. Build/scan and pin the matching qualification actor. Package
   private settings through `package-reusable-staging.mjs` and the maintained
   driver dependency closure.
3. Before activation, obtain a new operation-specific staging budget, lifetime,
   trusted-hostname/certificate inputs and independent cleanup authority. Estimate
   the full run, not just idle baseline pods. Longer proxy lifetimes increase
   transient resource duration; terminating pods may consume resources beyond
   the nominal Deployment surge count.
4. Use dedicated isolated regional GKE with the same Gateway class, compact
   policy, predecessor image/profile, scaling limits and managed storage
   semantics. Never point disruption, migration, restore or load fixtures at
   production or its shared data prefixes/credentials.
5. Run the maintained ordinary seven-pod singleton suite, the new first-transition
   and 300-second cases, ordinary post-adoption rolling cases and the full
   drain-aware autoscaling suite. Keep the external observer alive throughout.
   Include provider node/NEG movement and the DNS recovery case required by the
   existing regional gap; local DNS tests do not close that qualification.
6. Make the test deadline and expiry reserve account for both bridge drain
   windows, proxy preStop/termination, execution retirement, startup, observation,
   recovery and final cleanup. Preserve the rule that a timeout does not replay
   an uncertain cloud writer or authorize abandoning accepted work.
7. Verify isolated saved-data/recording preservation, final seven-pod baseline,
   actual policy values, no competing autoscaler and all exact owned-resource
   cleanup. Independent cleanup verification must pass before publication.
8. Publish the resulting runtime-control, autoscaling and request-continuity
   evidence onto the original tested candidate through
   `.github/workflows/studio-server-qualify-release.yml` and the maintained runtime
   publication flow. Do not rebuild images after the provider test.

Exit: the real ordinary-admission validator accepts the exact installed-to-target
pair for the selected installation profile. If production changed meanwhile,
replan/requalify the actual pair rather than deploying the stale one.

## 10. Phase G — first production activation

Produce one operator packet before requesting production approval. It contains
the refreshed installed snapshot, qualified immutable target, exact private
values, network-policy/route patches, temporary bridge inventory, resource/DB
budget, recovery checkpoint procedure, application acceptance and resume steps.
This phase permits the declared developer-service pause but no published-service
maintenance outage. Obtain any separate approval needed for that developer pause.

Use `studio-server:kubernetes:release` as the single production entrypoint. Add
the bootstrap stage to its workflow; do not supply a second raw Helm/cloud script
as a shortcut. The normal command remains:

```text
yarn studio-server:kubernetes:release -- --context <exact-context> --namespace rivet --release rivet --manifest <qualified-target-manifest> --values <reviewed-private-values> --timeout 20m --preflight-only
```

The explicit manifest pins this reviewed first transition. Automatic selection of
the promoted production manifest remains supported for routine releases, subject
to the same exact-pair/profile checks; operators need no new manual-manifest
requirement merely because this profile is enabled.

Inspect the fresh result, then the approved deployment uses the same inputs with
`--confirm rivet` and without `--preflight-only`. Any new bootstrap approval input
must be implemented, documented and bound to this operation before this step;
this plan does not invent an already supported CLI flag.

Operational order:

1. Start protected external observations and capture a fresh online recovery
   checkpoint. Verify the exact operation ownership and two-ready execution and
   proxy floors before changing public routing.
2. Execute the qualified bridge/policy handoff from section 6. Retain serving
   capacity on any uncertainty. No global scale-to-zero, maintenance waiver or
   force deletion is permitted in this operation.
3. Execute the normal compatible candidate rollout while retaining the temporary
   proxy HPA floor and scale-down pause.
   Initially keep schema 18 unchanged to isolate this work from a new migration.
   Existing accepted non-HTTP work may delay retirement; keep the explicit
   blocked/resume behavior rather than inventing a cancellation policy.
4. Return public routing to protected normal proxies, wait the full quiet window,
   restore the original HPA policy through Helm, and drain/remove the bridge,
   then perform application acceptance and stable-settlement verification.
5. Verify the exact target images, source, schema, proxy lifecycle and actual LB
   policy; unchanged data/PVC/credential references; expected autoscaler policy;
   no bridge residue; and the complete observation/recording window.
6. Record the result and operator resume information. On failure inspect actual
   journal/Helm/schema/provider state and use the exact original resume token.
   Use supported forward recovery/rollback when its compatibility checks permit;
   never assume a route or schema write failed merely because its acknowledgement
   was lost.

## 11. Phase H — routine compatible releases and completion criteria

For subsequent releases, preserve the protected profile and exact predecessor
qualification. The first-transition bridge is omitted only after live inspection
proves all serving proxy pods have the protected lifecycle and the actual LB
policy is correct. Continue ordinary image warming, capacity checks, online
checkpoint, routing propagation, accepted-work drain and application acceptance.

The required work is complete only when all of the following are true:

- The existing short-lifecycle production installation has been safely converted
  using the exact provider-qualified transition.
- The ordinary update path is documented. A later real mixed-image update must
  pass the same protected contract without a bootstrap bridge before phase H's
  live acceptance can be claimed; that subsequent release is deferred from the
  essential first rollout.
- Nominal-300-second accepted requests finish with complete correct bodies during
  real proxy/NEG replacement and HPA removal; short traffic has zero failures.
- Public web-app journeys, schedule occurrence claims and recording preservation
  pass through backend/web replacement and controller restart.
- The qualified load retains execution/proxy floors and measured headroom;
  scaling and termination never exceed reviewed quota or DB budgets.
- No failed observation interval, lost acknowledgement, cleanup exception or
  maintenance waiver is represented as a successful continuity certificate.
- The main rollout remains resumable and safe after process loss; actual target
  profile/route/workloads are settled and no temporary resources remain.
- Owning docs explain the 300-second scope, longer-request tolerance, ordinary
  versus first activation, explicit maintenance exceptions and recovery.

Update `deployment-operations.md`, `ha-rolling-upgrades.md`,
`automated-runtime-qualification.md`, `runtime-ha-qualification.md`,
`runtime-autoscaling.md`, `gcp-ha-staging.md` and `temporary-staging.md` as their
implemented behavior changes. Preserve historical failed/waived results.

## 12. Optional: developer-service continuity

Do not make this a dependency of the mandatory published-service work. If later
required, use the already implemented `compact-seven-overlap-v1` suite and
`singleton-overlap` protocol, rather than raising backend replicas manually.

- Revalidate the full database budget. At the observed seven-execution-owner
  ceiling, allowance 200, reserve 30 and pool 10, the documented overlap budget
  is 201. The proposed pool-nine profile preserves the ceiling/allowance but still
  requires actual DB throughput and same-node resource qualification.
- Qualify the same-image sizing and ownership bridge, RWO co-location, exclusive
  housekeeping handover, accepted/paused editor work and authenticated developer
  requests. Initial adoption can interrupt developer activity.
- Follow the existing separately journaled `sizing`, `ownership` and ordinary
  candidate steps from [automated qualification](automated-runtime-qualification.md#first-activation-and-installed-lineage).
- Test retained dashboard/iframe editing, saving, debugger replay and browser
  assets across both backend and web replacement. The existing housekeeping
  handover 503 remains a separate maintenance-operation boundary unless its
  contract is explicitly extended.

This supports planned developer-backend replacement; it does not by itself
provide same-node failure redundancy or turn destructive restore into an online
operation.

## 13. Handoff and stop conditions

Handoff must distinguish: code implemented, local checks passed, exact images
built, provider qualification passed, evidence published, production preflight
passed, production deployed, and independent acceptance completed. Each has its
own evidence; none implies the next.

Stop for a changed installation/predecessor, unknown route/policy owner, missing
certificate, incompatible schema/browser contract, stale metrics, failed/unknown
provider write, broken protected request, insufficient headroom, unhealthy
survivors, expiry, or unverified cleanup. Keep the verified serving target and
report the owning operation/next observation. Do not compensate with hidden
retries, relaxed TLS, force deletion, a global outage, or forged qualification.
