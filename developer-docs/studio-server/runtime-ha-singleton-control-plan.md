# Plan: HA runtime consolidation and drain-aware autoscaling

Status: **10-pod bridge functionally verified locally; compact six-application-pod profile and independent autoscaler implemented with local regression coverage; seven-pod autoscaling baseline still awaiting exact-image/provider qualification; not deployed**.
No GCP changes, paid rehearsal, image publication or production rollout are
authorized by this document. Existing HA and local development behavior remain
the defaults; this profile requires explicit selection and qualification.

The [qualification publication sequence](runtime-ha-qualification.md) keeps
post-build provider evidence bound to the original candidate without rebuilding
its images. An installed unqualified manifest cannot be enriched in place:
produce a new compatible candidate naming it as predecessor, qualify that pair,
then install the qualified bridge before transferring ownership.

## 1. Goal and exact availability contract

Additional accepted scope: [automatic runtime scale-up and safe scale-down](runtime-autoscaling.md).
Its opt-in controller implementation and local protocol tests are separate from
the earlier compact profile. It adds one independent controller pod (seven total
at compact baseline), keeps developer tiers fixed, and requires its own exact
image/chart/policy provider qualification before production enablement.

Reduce the installation's normal footprint from 13 pods to 10 by making developer
tools single-instance and embedding rare maintenance work in that backend. Keep
published production execution independent of developer availability.

The approved final target additionally reduces proxies from six to two: two proxy,
one web, one editor/maintenance and two execution pods, six total. This is the
explicit `availability.gkeGatewayProfile: compact` policy in
`gke-compact-edge.yaml`, layered after the two existing GKE overlays. It accepts
less infrastructure-failure redundancy: two distinct proxy nodes across at least
two zones, not two proxies in every one of three zones. Existing regional defaults
and the historical ten-pod receipts below are unchanged; they do not qualify
compact operation. Planned zero-downtime upgrades remain a verification requirement,
not a guarantee inferred from two Ready pods or idle load.

Keep edge capacity reduction separate from maintenance ownership transfer:
qualify/install the bridge, transfer 13 -> 10 with all six proxies, then use the
qualified ordinary HA rollout to change the edge to two proxies (10 -> 6).
Reverse by restoring six proxies before a regional 10 -> 13 ownership transfer.
The controller refuses changing proxy capacity inside the ownership operation.
An isolated compact fixture can separately exercise 9 -> 6 -> 9, but is not proof
of the cross-profile reduction. No new cluster or paid rehearsal is authorized.

Compact publication requires exact `evidence.runtimeControl.edgeProfiles` coverage
and the additional `compact-proxy-rolling-upgrade`, `compact-proxy-eviction` and
`edge-profile-transition` checks. A missing field means regional-only evidence;
list both profiles for the staged forward/reverse route. Backend/execution counts,
fenced retirement, positive NEG health, hard separation, `maxUnavailable: 0`, one
surge proxy and the established drain/min-ready windows are not relaxed. Remaining
work includes exact-image compact/provider qualification, representative capacity
measurements and the edge-profile transition under continuous traffic.
The compact availability proof requires exactly two settled proxies, not surplus
replicas that can mask endpoint-loss risk. Release admission checks compact source
installations as well as compact destinations, including same-image recovery or
restoring six proxies; regional-only evidence cannot qualify the smaller source.
Adjacent capacity checks now reject invalid frontend HPA ranges and require two
execution owners in both replicated and singleton control modes, not only the new
profile. Explicit maintenance validation may still temporarily stop public tiers.
The frontend proof's final sample-collection phase has a bounded deadline; slow
successful traffic is not permission to wait past that phase's configured timeout
or claim qualification without its required observations.

The holistic rollout audit also covers failures after preflight: each new
replicated-tier withdrawal requires two other Ready, serving peers with stable
observed UIDs. A missing, retiring or replaced peer blocks retirement; exact-token
resume succeeds after recovery without replaying commands. The check is scoped
to the target tier (never counts developer pods as production capacity), and
singleton developer/maintenance owners keep their deliberate serial interruption.
Ordinary-roll pod reads now require the recorded controlling StatefulSet UID,
matching the ownership-transfer safety boundary. The core rollout validates the
two-execution floor even when invoked without Helm. Local regression coverage
does not replace the compact six-pod provider qualification still pending above.

| Role                                | Audited baseline | Intermediate steady state | Target responsibility                                                                   |
| ----------------------------------- | ---------------: | ------------------------: | --------------------------------------------------------------------------------------- |
| Proxy                               |                6 |                         6 | Existing three-zone production edge policy, two per zone                                |
| Web                                 |                2 |                         1 | Developer dashboard/editor assets                                                       |
| Editor/control API + local executor |                2 |                         1 | Authoring, latest-draft runs, debugger, development management and embedded maintenance |
| Published execution                 |                2 |                         2 | Published workflows, public web apps/assets/OAuth/actions and published scheduling      |
| Dedicated maintenance               |                1 |                         0 | Responsibilities move to the singleton control backend, not removed                     |
| Total                               |               13 |                        10 | Temporary rollout/migration capacity is allowed and counted separately                  |

Required guarantee:

- Planned upgrades and the 13-to-10 transition keep production request admission
  and execution available. Accepted work finishes on its original owner; uncertain
  execution is never automatically replayed to another owner.
- Losing/restarting/scaling the developer backend or web UI to zero in an isolated
  test does not break published HTTP routes, public web-app loads/assets/sign-in,
  actions, scheduled published work, recordings or production readiness.
- Two ordinary published execution owners remain healthy during controlled
  replacement; temporarily add a third owner before retiring an existing one.
- Developer UI/API/latest-draft operations may be briefly unavailable when their
  single owner is replaced or fails. Preserve saved data, unsaved browser workspace
  recovery and honest reconnect/error behavior; do not promise crash-proof live
  developer runs or silently resubmit writes.
- Maintenance exports/imports/cleanup retain their existing integrity, cancellation,
  recovery, authorization and storage-ownership guarantees.

Exceptions and limits:

- A destructive legacy restore deliberately fences shared Rivet storage and may
  interrupt production. Keep that explicit confirmation/maintenance-window
  contract; embedding its owner does not make restore zero-downtime.
- This is not a guarantee against shared PostgreSQL/GCS/provider outages, all
  execution nodes failing together, or arbitrary termination of an in-memory run.
- Independence covers platform-owned published-runtime paths. At a later approved
  preflight, identify production workflows/integrations that explicitly call
  developer-only `/api/*` or latest-draft HTTP routes; do not silently rewrite
  their semantics or claim they survive removal of their chosen dependency.
- Six (compact) or ten (regional) is a steady-state count, not a ceiling during upgrades, migration
  Jobs or future approved scale-out. No new always-on helper replaces the removed
  maintenance pod.

## 2. What is already known versus unfinished

- [x] Read-only production inventory saved in the ignored local operation folder
      `artifacts/rivet-resource-audit-20261020/`: 6 proxy, 2 web, 2 control, 2 execution,
      1 maintenance; all ready; no installed HPAs.
- [x] Existing fenced retirement, pinned manifests, mixed-version/schema checks,
      DNS recovery, bundle archive publication and browser-version continuity provide
      reusable mechanisms. Their historical receipts do not qualify this new profile.
- [x] Live GCP edge health check was verified to use proxy `/readyz`; the proxy
      currently forwards that path to the control API.
- [x] Source inspection identified another cold-start dependency:
      `RIVET_PROXY_SETTINGS_URL` currently points to the control-only proxy-config
      endpoint. Changing the probe alone is insufficient.
- [x] Source inspection identified control-owned scheduling, maintenance-only
      restore startup, RWO claim ownership and release-controller assumptions of
      two ordinary backends plus a separate maintenance owner.
- [x] Typed `ha.controlPlane.mode`, guarded 10-pod overlay, execution-owned settings
      projection/readiness selection, published scheduler scope/admission, embedded
      maintenance responsibility and singleton debugger readiness implemented locally.
- [x] Serial developer replacement, same-image journaled forward/reverse transfer,
      PVC/PV/owner UID checks and volume-detachment gate implemented. Normal version
      upgrades refuse a topology switch; transfer explicitly disables migrations.
- [x] Real PostgreSQL scope/claim integration passed; focused API/chart/retirement
      regressions passed. Full local mixed-image/provider qualification is separate.
- [x] Complete API regression run: 1,655 passed, six skipped, zero failures;
      API typecheck, Kubernetes contract/render suite and headless browser
      OAuth/assets/action checks passed locally.
- [x] Separate local component window passed cold runtime independence,
      distinct-image 10-to-10 upgrade, serial RWO developer replacement and reverse
      ownership transfer, with 1,169 workflow and 397 web-app requests and no failures.
      The earlier primary window remains failed (a test-harness terminating-proxy
      assertion); its 1,720 workflow/601 web requests had no failures. These windows
      are not combined into one uninterrupted qualification certificate.
- [x] Corrected complete local window passed old 13 -> bridge 13 -> 10 -> newer
      10 -> serial replacement -> reverse 13, including cold proxy and execution
      processes without developers, browser OAuth/assets/action, exactly one saved
      published schedule occurrence, embedded archive hash and preserved volume bytes.
      It recorded 3,022 workflow and 1,024 web-app requests, zero failures, and a
      minimum of two actually ready execution pods throughout. The earlier failed
      windows remain separate; none contributed samples to this passing receipt.
- [x] Final GET-only developer-route acceptance passed through all six proxies.
      Recovery waits on reads before new maintenance writes; an allowed developer
      Service propagation pause never authorizes replaying a failed POST.
- [x] Disposable local cluster/registry cleanup verified: eight containers, eight
      volumes and the private network are absent. Existing local Rivet containers
      remained healthy and the pre-existing `rivet-ha-proof` cluster was preserved.
      Diagnostic receipts and ordinary local image build caches were retained.
- [ ] Representative maintenance peak measurements and exact published-candidate
      provider qualification remain required; do not claim those from small fixtures.
- [x] Production boundary respected: no GCP modification, paid rehearsal,
      publication or production rollout performed.
- [x] Follow-up failure-path audit reproduced and corrected late detection of
      denied VolumeAttachment reads and acceptance of same-name developer pods with
      a foreign StatefulSet owner. Permission/source-owner checks now run before
      edge changes; retirement revalidates the recorded owner UID. Focused regressions
      cover both faults without changing serving behavior or retrying writes.
- [x] Adjacent recovery audit reproduced reverse-transfer failures after lost
      template/verification acknowledgements and acceptance of a recreated backend
      controller during recovery. Verification now accepts the expected final edge
      policy while retaining the owner-phase execution-health gate and original
      backend controller UID. Forward/reverse lost-ack regressions assert that Helm,
      scaling and retirement are not replayed.

Local receipts are retained under the ignored
`artifacts/runtime-ha10-local-20261020/`, with the complete window in
`proof-complete/runtime-control-local-report.json` and the final route acceptance
in `proof-complete/developer-route-acceptance.json`. The API builds differ; the
web image is the same build, so this does not re-qualify browser-version
continuity. Seven local Docker nodes simulate three zones, not independent GKE
nodes or a regional Gateway. Shortened local lifecycle timings and a tiny export
are not production drain-time or maintenance-sizing evidence. Default/full-HA
Kubernetes contracts, the full API suite and focused lost-acknowledgement,
lease-conflict, UID/storage-drift and capacity-boundary regressions passed.

### Implemented operator contract (not deployment approval)

Merge `gke-ha.yaml`, then `gke-runtime-ha.yaml`, then reviewed installation values.
`ha.enabled` remains true; replicated is still the default. The singleton profile
rejects backend/web counts other than one, execution below two, disabled public
admission, an admission budget below two, and web autoscaling. The six-proxy GKE
policy is unchanged. `/api/deployment-status` exposes the control availability
policy separately from runtime-library synchronization and actual pod health.

New full-HA images form the bridge: they support execution-owned proxy settings,
but replicated-mode proxies deliberately retain their control-owned settings and
health target during the first mixed-image upgrade. Otherwise a new proxy could
wait for an endpoint absent from old execution images before the runner reaches
execution replacement. The separate topology transfer switches both targets only
after verifying every bridge owner's authenticated runtime contract.

Once the same qualified bridge manifest is installed, the supported release
command accepts `--ha-control-plane-transition`. This is a distinct same-image
operation, never an automatic side effect of changing a replica count. It uses
the existing release CAS journal, fences/drains developer owners, observes their
exit and disk detachment, retains the exact claim, and starts the new placement.
Before withdrawing any developer owner, it UID/RV-patches only the recorded
proxy Deployment to the execution-owned template, waits for all six replacements
and their minimum-ready availability, and checks each proxy's real `/readyz`
reports execution health. GKE NEG gates, when present, must have a positive
`LoadBalancerNegReady` observation, not the no-health-check shortcut. The patch
intent is journaled before sending it; recovery observes an unknown result and
never blindly repeats it. This prevents a health-check outage that ordinary
TCP-ready local proxy tests would miss. Reverse transfer keeps execution-owned
edge health until replicated control is restored.
`--resume-ha <token>` recovers that exact operation/configuration. Unknown Helm
outcomes are inspected, not replayed. A reverse transition uses the same protocol
and replicated bridge values, never generic Helm rollback. Production execution
workloads are neither scaled nor deleted by this transfer.
Choose the operator timeout from the qualified GKE timings before starting:
six proxies with the production minimum-ready and withdrawal windows can exceed
the CLI's 15-minute default. The local fixture's shortened timing is not that
qualification or permission to extend an approved production window. A timeout
while preparing the edge leaves developer owners intact and requires exact-token
observation/resume; never force readiness or replay the patch to meet a deadline.

The deployment command rejects singleton installs/updates and either transfer
direction unless the promoted manifest contains separate exact-source/image/chart
`evidence.runtimeControl`. The older full-HA certificate is insufficient.
Promotion accepts `--runtime-control-evidence <repository-relative-receipt.json>`;
this validates evidence identity, not permission to fabricate passing checks.
Local development receipts from a dirty tree cannot authorize production.
After any later singleton version upgrade, reverse ownership using the current
installed manifest and that version's qualified replicated-control values. The
older bridge is a recovery reference, not permission to downgrade images inside
a topology transfer; any image rollback is a separate compatible operation.
Its separate evidence also requires embedded-maintenance capacity measurements;
small export success and idle pod counts cannot qualify a merged memory budget.
The PostgreSQL capacity guard includes the scheduler's separate two-connection
pool on eligible control/execution owners and one eligible HA surge. It must not
count those pools as part of the shared workflow/settings query pool or omit them
when removing the dedicated maintenance owner. With two execution replicas and
default 30-reserved/10-query-pool/restore settings, the declared ceilings are
133 connections for full HA and 101 for singleton control; these are not usage
measurements and do not authorize changing a shared database's capacity.
Provider frontend observations accept one web only under the explicit singleton
policy, while retaining all six proxy health/zone/hostname requirements. The
default replicated-control observation still requires two web replicas.

Published scheduling now has execution-owned recurrence materialization and
claims; latest stays in control and dedicated maintenance starts no scheduler.
The store partitions before claim under its existing transaction/advisory lock.
Running leases are never replayed after loss. At most the existing configured
scheduler concurrency runs installation-wide per scope. In enforced public
admission, a schedule reserves an ordinary execution permit before claiming and
retains it through recording/outcome persistence, leaving one per-pod slot for
HTTP traffic. Saturation leaves it queued, not failed/retried. Local/non-HA
all-in-control behavior and explicit disabled/observe admission remain readable.

Embedded maintenance does not enable the API-only maintenance flag: the backend
still runs its editor executor. Its API process alone owns restore recovery and
bundle scratch on the existing restore claim. Destructive restore still fences
all shared Rivet writers and requires its separate maintenance confirmation.

## 3. Design decisions: one explicit profile, no new platform

Add one validated opt-in control-plane mode, provisionally
`ha.controlPlane.mode: replicated | singleton` (final naming must follow existing
configuration conventions). Keep `ha.enabled: true` in both modes.

- Replicated/default: preserve the existing 13-pod production profile and its
  dedicated maintenance owner, probes, release behavior and predecessors.
- Singleton: require exactly one control backend, exactly one web pod and embedded
  maintenance ownership. Require at least two published execution owners and the
  existing six-proxy/three-zone edge policy.
- Derive maintenance placement from that mode. Do not add independent flags that
  allow zero maintenance owners, two active owners, or embedded ownership on every
  backend. Do not set the old maintenance-only flag on a normal editor backend:
  it also changes executor, peer and Evaluation behavior.
- Keep stable existing Services/workload names where possible. Consolidation adds
  no database, bucket, domain, broker or permanent scheduler pod. The subsequently
  approved autoscaling extension adds one independent controller Deployment, not
  another application API/executor or maintenance owner.
- Keep general Docker/local/singleton and existing full-HA installs unchanged.
  Add a separate installation overlay, not a rewrite of generic defaults.

At the audited per-pod requests, removing the three redundant pods nominally
removes 1.5 vCPU and 2.5 GiB of reservations. The merged backend's maintenance peak
must be measured; that arithmetic is not a promised saving or a safe sizing result.
Do not weaken proxy anti-affinity or lower GKE requests below its current minimum
as part of this change. Frontend placement optimization is a separate project.

## 4. Milestone A — dependency contract and health/config isolation

### Route and responsibility matrix

| Surface                                                                 | Owner after change            | Developer backend unavailable                                   |
| ----------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Published workflow HTTP and trusted internal published execution        | Execution                     | Continue                                                        |
| Published web-app HTML, immutable JS/CSS, uploads and action WebSockets | Execution                     | Continue                                                        |
| Published web-app OAuth callback/logout/session/access-policy checks    | Execution/shared storage      | Continue without UI-auth fallback                               |
| Edge production health and proxy cold-start routing settings            | Execution/proxy               | Continue                                                        |
| Published schedules and their recordings                                | Execution with durable claims | Continue                                                        |
| Dashboard, editor assets, `/api/*`, UI key/OAuth login                  | Web/control                   | May be unavailable                                              |
| Latest-draft workflows/apps, editor executor, bundle debugger           | Control                       | May be unavailable; recover honestly                            |
| Bundle conversion/duplicate/upload/export and legacy restore management | Embedded control owner        | Wait/fail visibly while owner unavailable; recover durable work |

Implementation:

1. Trace and test _all_ calls from public paths and execution startup, not only
   nginx routes: auth/session storage, cross-project/bundle loads, datasets,
   publication/access-policy invalidation, runtime libraries/plugins, settings,
   recording/outbox persistence, worker startup and readiness. Any necessary
   runtime consumer must operate in the execution tier against existing shared
   storage; a control REST callback must not be silently retained.
2. Give the production edge a readiness path backed by execution readiness, not
   control or web readiness. Use a distinct documented path if needed to preserve
   old `/healthz` semantics. Return no secrets and consume no workflow admission
   slot. A local nginx TCP success alone is not sufficient: public execution must
   actually be ready. Keep control health observable through its own Service.
3. Expose the existing revisioned, read-only proxy settings snapshot on execution
   as well as control, reusing `createProxySettingsSnapshot` and the same initialized
   shared settings repositories. Point the new profile's proxies at execution.
   Preserve internal authentication and the public `/internal/*` deny rule; do
   not expose administration routes on execution or add a second settings store.
4. Cold proxies must initialize successfully with control/web absent. Startup must
   fail closed if no valid execution-owned settings snapshot is available, not
   guess default route prefixes or disable auth. Running proxies retain the last
   validated configuration on transient refresh failure; updates remain atomic.
5. Preserve custom route prefixes, timeouts, request-size limits, forwarded-header
   trust, WebSockets, OAuth, immutable assets and DNS outage behavior. No automatic
   replay of public POSTs or uncertain graph actions.
6. Prove execution readiness has no circular dependency on control or proxy
   readiness. Missing control must not remove healthy execution Service endpoints.

Owners: proxy templates/entrypoint/settings scripts, `app.ts`,
`proxy-settings-snapshot.ts`, API profile exposure tests, proxy and OAuth fixtures.

Exit: a local production-like stack can start cold and serve real published
workflows and a public web app with both developer Services having zero endpoints.

## 5. Milestone B — scheduling and background execution ownership

The current `server.ts` starts schedules in control, and the scheduled runner
executes graphs locally. Keeping it unchanged would leave production schedules
dependent on the singleton developer pod.

1. Keep schedule administration in control. Make both runtime owners eligible to
   claim **published** occurrences through the existing PostgreSQL store/leases.
   Keep Saved latest occurrences in control. Preserve existing snapshot/version,
   timezone, missed-occurrence, cancellation and recording semantics.
2. Partition claiming at the durable store boundary, not after a job has already
   been claimed. Audit recurrence materialization and lease renewal too; do not
   leave a control-only producer required to create future published occurrences.
3. Reuse existing lease/occurrence identities and recovery rules. No new cron
   service, broker or blanket exactly-once claim about external side effects.
   During mixed-version handoff, old control and new execution workers must not
   execute an occurrence twice or reclaim uncertain still-running work.
4. Account for scheduled executions in runtime admission/concurrency and retirement
   barriers. Avoid either starvation of public HTTP traffic or an unbounded
   scheduler bypass of the four-runs-per-pod budget. Make the chosen bounded
   allocation explicit and retain observable overload/defer behavior.
5. Inventory other background consumers needed for production durability. Move
   only necessary shared/runtime work; administration, package builds and optional
   Evaluations remain developer responsibilities. Already-published runtime-library
   artifacts must remain usable and cold-loadable without the build worker.

Exit: published occurrences continue and record once with developer pods absent,
including a runtime rolling upgrade and a lease-conflict/lost-acknowledgement case.

## 6. Milestone C — embed maintenance without losing ownership or data

Choose embedded ownership, not scale-to-zero activation: rare operations run in
the existing control backend. This is simpler than adding an activation controller.

1. Separate the role of developer API/executor from the responsibility of owning
   maintenance. Make exactly one process in the singleton control pod initialize
   restore recovery, accept maintenance jobs and recover bundle/upload journals.
   Do not instantiate two owners in its API and executor child processes.
2. Reuse current durable journals, installation/workspace epochs, shared compressed
   archive manifests, multipart reconciliation and request-work barriers. A
   disconnect is not job completion; uncertain writes/exports are not retried.
3. Direct singleton-mode management requests to that local owner, avoiding a
   self-proxy loop. Preserve legacy dedicated-owner routing for full HA and the
   bridge release. Keep completed archives available through the existing guarded
   download path and retain expiration/cleanup behavior.
4. Move the **existing** restore RWO claim to the singleton backend; do not create
   a fresh empty claim or copy/delete its data. Guarantee old ownership is drained
   and detached before new ownership mounts it. Never permit a surge backend to
   share the RWO claim. Retain the claim during forward and reverse transitions.
5. Keep restore's explicit destructive confirmation, Rivet-only shared-database
   boundary, global serving fence, preserved settings/keys, recovery state and
   consumer warmup. Never turn restore into an ordinary non-disruptive API call.
6. Keep bundle/import work bounded in CPU/memory/disk and queue concurrency.
   Preserve streaming/progress/cancel behavior. Test large archives and restart
   recovery before deciding whether the merged pod can retain its current request.
7. Planned control replacement drains saves/uploads/exports, editor runs, streams,
   schedules and other accepted jobs. An active restore or unresolved archive
   publication blocks replacement; a timeout reports a blocker, not permission
   to kill the process. Abrupt singleton failure uses durable recovery, without
   promising that non-durable editor executions survive.

Exit: download/upload/duplicate/convert, cancellation, interrupted preparation,
cleanup and local backup/restore recovery work with no dedicated maintenance pod.

## 7. Milestone D — chart, runtime and release-controller support

### Chart/runtime contracts

- Update `validate-values.yaml`, backend/maintenance workloads, Services, storage
  mounts and typed environment ownership. Full HA must still reject its old
  invalid layouts. Singleton mode must reject backend >1, no embedded owner,
  public execution <2, invalid edge counts and ambiguous restore claim owners.
- Make backend readiness and debugger peer discovery support a single ordinary
  control owner. Do not require a permanently absent second peer. Keep bundle
  debugger grouping, project identity, reconnects and bounded replay unchanged.
- Update deployment-status, monitoring and expected replica counts to distinguish
  a deliberately unavailable developer tier from unavailable production execution.
  Do not suppress actual runtime failures to make the new profile look healthy.
- Preserve the default six-proxy placement/health/drain policy; the explicit
  compact extension keeps the same lifecycle protections with two-zone separation.
  Permit one web pod only
  in the new explicit profile. The full-HA two-web constraint remains intact.
- Adjust developer PDBs to the documented best-effort singleton policy rather
  than leaving `minAvailable=2` on one pod. Do not permanently block all voluntary
  developer-node maintenance. Keep runtime PDB/retirement protections intact;
  a PDB alone does not drain an accepted graph execution.
- All three removed steady-state pods must truly be absent. No hidden sidecar
  adds a second full always-on API process to replace the maintenance pod.

### Release controller

- `assertHaRolloutPlan`, Kubernetes workload discovery and release probes currently
  assume >=2 ordinary backends and a dedicated maintenance workload. Replace
  global assumptions with validated profile-specific invariants; do not weaken
  the existing mode or switch `ha.enabled` off to evade validation.
- Public execution: retain immutable image/chart/schema identity checks, two
  ready ordinary owners, a ready surge, observed routing withdrawal, incarnation-
  bound retirement, recording flush and exact-UID removal. No automatic graph
  replay, forced deletion or unsafe HPA scale-down.
- Singleton control: **serial** replacement, with no RWO-sharing surge. Fence new
  developer mutations/jobs, drain accepted work, confirm old process completion
  and volume release, then replace and recover the owner. Developer-only downtime
  is acceptable; public execution observers must remain green throughout.
- Web: use the existing zero-unavailable/one-surge Deployment strategy where
  feasible. One steady-state replica is not a requirement to delete the old web
  pod before its replacement. Preserve version-pinned browser assets/recovery.
- Treat the embedded developer owner as one retirement participant with all its
  job barriers, not separate competing backend/maintenance deletion phases.
- Include profile, worker responsibility, PVC handoff and desired counts in the
  manifest/capability checks, configuration digest and operation journal. Recover
  unknown outcomes by observation under the same token. Do not reinterpret an
  unfinished older journal as a new topology operation.
- Keep grow/shrink and cost optimization out of this milestone. Steady-state
  runtime remains two; existing HPA settings remain explicit. Any future automatic
  shrink still needs drain-aware owner retirement.

Exit: new-to-new singleton-control upgrades pass locally, and existing full-HA
and non-HA launch/upgrade regressions still pass.

## 8. Milestone E — one-time 13-to-10 transition and reverse path

Do not attempt this as an unguarded `helm upgrade` or three `kubectl scale` calls.
The first transition must not fall into the old all-writer maintenance cutover.

1. Produce a bridge release supporting both layouts. First upgrade the old
   13-pod layout through its supported protocol, installing public health/config
   independence and compatible worker/ownership logic while retaining all old
   owners and Services. Only switch proxies to execution-owned endpoints after
   compatible execution owners are ready. Missing capabilities fail preflight.
2. Prove independence before consolidation: published traffic, web apps/OAuth,
   active actions, recording persistence, configuration refresh/cold starts and
   published scheduling must not depend on the developer endpoints.
3. Begin a distinct, journaled topology transition. Validate project/cluster/
   namespace/workload/PVC identities, source/image/chart pins, backup evidence,
   storage ownership, quota/surge headroom and no unfinished operation. Fence
   only new developer-side maintenance/authoring work; no global production fence.
   Preserve non-Rivet data in the shared `rivet-support-db` database. Record
   neighboring workload health and account for shared Autopilot scheduling; do
   not drain/delete nodes or alter other apps to make this transition fit.
4. Before draining developers, switch the exact proxy Deployment to execution
   health/config while all source owners still serve. Wait for every proxy's
   replacement, stable availability, actual execution `/readyz` and positive GKE
   health observation where applicable. Then drain the second ordinary control
   backend and remove it through the existing
   retirement handshake. Keep its saved data and browser workspace records.
5. Finish and stop admission to old maintenance work; an active restore or
   uncertain job blocks progress. Record journal/claim identities. Drain the
   dedicated maintenance owner, scale it to zero and verify process/volume
   withdrawal. Never force-detach a disk or assume a timeout proves absence.
6. Serially replace the remaining ordinary control pod with the embedded-owner
   template using that same PVC. The singleton template must not be applied to
   a multi-replica creator that could mount it twice. Recover durable jobs and
   prove there is exactly one maintenance owner before reopening developer writes.
7. Set web steady state to one through the qualified frontend update path. Keep
   all six proxies and both ordinary execution owners. Remove the obsolete
   maintenance workload/service only after confirmed ownership handoff; preserve
   the PVC, stored jobs, manifests and archives.
8. Verify the exact 10-pod inventory, public acceptance, developer reconnects,
   maintenance operations and unrelated-resource identity preservation. Record
   terminal evidence; do not infer completion solely from Helm success.

Rollback/recovery:

- Keep a qualified 13-pod bridge configuration as the rollback anchor. A bridge
  is necessary because original images do not understand the new ownership model.
- Before handoff, resume/abort the exact transition safely; do not replay an
  uncertain retirement command. After handoff, reverse it under a new recorded
  ownership transfer: drain embedded jobs, withdraw its PVC ownership, restore
  the dedicated owner on the same claim, then restore replicated control/web.
- Never reactivate the old maintenance pod while embedded ownership is active.
  Do not use generic Helm rollback, restore production data, rewrite whole IAM
  policies, drop shared database tables or delete retained claims/backups.
- If new schemas prove necessary, specify additive mixed-version compatibility
  and a tested rollback reader window before publication. Do not bump schema
  merely because pod roles changed, or assume schema16 automatically suffices.

## 9. Verification matrix and acceptance evidence

All destructive/failure scenarios below run **locally in disposable fixtures**
until separately authorized otherwise. They must never target a production context.

| Proof                                                   | Required result                                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Render both profiles + dev/default overlays             | Exact owner counts/mounts/Services/probes; old profiles unchanged; invalid combinations rejected                              |
| Public route/auth profile tests                         | Published routes/assets/OAuth on execution; admin/internal trust boundaries unchanged                                         |
| Control + web absent before cold start                  | Proxies and execution start, read non-default settings and serve published journeys                                           |
| Developer disappearance during live production requests | Zero lost acknowledged requests or duplicate executions; healthy public edge remains ready                                    |
| Developer absent while one execution owner rolls        | Remaining and surge owners sustain the published route; no cold-start callback to control                                     |
| Public browser journey                                  | Load uncached assets, sign in against a local OAuth fixture, stream action, reconnect and complete with control/web down      |
| Published bundle A -> B -> C                            | Correct frozen snapshots, same-bundle access, datasets/libraries, nested recordings and original outcomes                     |
| Proxy config and DNS faults                             | Atomic refresh, retained valid settings, custom paths/limits, no auth bypass, no replayed POSTs                               |
| Scheduled published and latest work                     | Correct claim partition; published continues without control; no duplicate occurrence/attempt or silent semantics change      |
| Published recording/background consumers                | Outcomes/recordings persist while control is absent and during a mixed-version roll; no hidden outbox dependency              |
| Maintenance functional journeys                         | Convert/duplicate/download/upload, streaming and progress, cancellation, archive identity/cleanup and local restore           |
| Crash during upload/export/cleanup                      | Durable recovery or explicit repair-needed state; no silent restart/retry of uncertain effects                                |
| RWO handoff                                             | One mount/owner only; delays block safely; existing claim and stored bytes survive forward/reverse transition                 |
| Embedded-owner upgrade with accepted work               | Waits for saves/jobs/runs; active restore blocks; developer-only outage does not break public traffic                         |
| Operation lost acknowledgement/lease conflict           | Same-token observation/resume, no duplicate begin/delete/handoff; no fake completion                                          |
| Existing full HA                                        | Old >=2 backend/dedicated-maintenance behavior, debugger mesh and probe receipts remain valid for that profile                |
| Local development and desktop                           | Existing commands, direct/tunnel executor routing, bundle editing/debugging and storage behavior unchanged                    |
| Real mixed images                                       | Old -> bridge at 13, bridge 13 -> candidate 10, candidate 10 -> later candidate 10, plus qualified reverse ownership transfer |

Traffic proofs use one uninterrupted observation window per experiment, preserve
separate primary/recovery outcomes, match exact fixture/correlation recordings
and do not hide failures with retries or merge windows. Use long/paused runs
exceeding ordinary shutdown deadlines and verify original owners/UIDs actually
retire. Browser reconnect must not initiate a second action. New code must not
claim old image receipts as its own qualification.

Use existing focused API/retirement tests, chart contracts, proxy/DNS Docker
fixtures, the local Kind HA runner and headless `yarn studio-server:ui:observe`.
Add fixtures and assertions in the existing owners rather than another generic
rehearsal framework. Update hard-coded two-backend/maintenance assertions in
`ha-release-probes.mjs` deliberately; keep equivalent full-HA assertions.

## 10. Delivery sequence, stop conditions and approvals

Implementation order:

1. Add typed profile/dependency tests and the regression fixtures (A's contract).
2. Implement public health/config/cold-start independence and published workers (A/B).
3. Implement embedded maintenance and data/volume fencing (C).
4. Implement opt-in chart/runtime/release-controller and reverse handoff (D/E).
5. Run focused and full local mixed-version/failure/browser proofs; fix reproduced
   blockers, not speculative unrelated refactors. Measure maintenance peaks.
6. Update owning developer/user/operator docs, review the complete diff and exact
   tested source, then request any needed publication/provider/deployment approvals.

Stop rather than proceed when public paths still depend on developer services,
RWO ownership is uncertain, a job/restore cannot drain, the public observer fails,
required compatibility is unproven or the proposed merged memory budget is unsafe.
Do not cancel accepted production runs merely to finish the transition.

Documentation owners: `access-and-routing.md`, `ha-rolling-upgrades.md`,
`kubernetes.md`, `development.md`, `production-ha-cutover.md`, `resource-sizing.md`,
the relevant user bundle/restore instructions and this checklist. Clearly
separate implemented, locally verified, provider-qualified and deployed states.

Approvals not granted by the current planning request:

- Implementation and committing the complete reviewed local diff to `develop`
  were subsequently authorized. Push/main publication and image publication
  remain separately controlled; a local commit or image build is not publication.
- Any GCP modification or new paid provider rehearsal. Local evidence cannot
  certify GKE load-balancer/Autopilot behavior. Agree a bounded provider-specific
  qualification path and cost envelope separately before claiming that guarantee.
- Production transition, temporary developer-only downtime, backup storage/data
  handling, or permission to interrupt/cancel any lingering work.
- Destructive restore or rollback of customer data, unrelated app changes,
  credential rotation, IAM expansion or deletion of old storage.

No GCP resources need to change to complete this plan or begin a subsequently
approved local implementation. Re-read the live configuration only at a later
authorized preflight; the inventory cited here is a historical baseline, not a
permanent deployment identity.

## Source anchors

- [Current HA protocol and ownership](ha-rolling-upgrades.md)
- [Public/developer routing and trust boundaries](access-and-routing.md)
- [Sizing evidence requirements](resource-sizing.md)
- `deploy/studio-server/images/proxy/default.conf.template`
- `deploy/studio-server/images/proxy/normalize-workflow-paths.sh`
- `deploy/studio-server/helm/templates/{validate-values.yaml,_backend-workload.tpl,backend-statefulset.yaml,ha-disruption.yaml,_containers-proxy.tpl}`
- `deploy/studio-server/scripts/lib/{ha-rolling-upgrade,ha-kubernetes-rollout,ha-release-probes}.mjs`
- `packages/studio-server-api/src/{app.ts,server.ts,proxy-settings-snapshot.ts,ha-maintenance-routing.ts}`
- `packages/studio-server-api/src/{legacy-restore,scheduled-runs}/`
