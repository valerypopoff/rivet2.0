# Temporary provider qualification infrastructure

## Scope and activation

`scripts/temporary-staging.mjs` is the outer lifecycle for the maintained inner
fixture. `execute-runtime-qualification.mjs execute` selects it only when
`RIVET_QUALIFICATION_ENVIRONMENT_MODE=temporary`. Existing reusable-cluster
qualification remains supported, with its original inventory boundaries.

This is repository implementation, not GKE qualification or spending approval.
Do not activate from an uncommitted checkout. Publish the reviewed candidate,
pass ordinary CI, prepare the exact actor image and private configuration, then
obtain operation-specific activation approval. No production deployment is part
of qualification. The previous staging operations and their inventories are not
inputs to this route.

## Implementation completion and release gates

The lifecycle implementation is present in the repository. Completion of the
implementation and qualification of an exact release are separate gates. The
ten plan areas map to these owners and local checks:

| Plan area                                     | Implementation and local evidence                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Repeatable lifecycle                       | `temporary-staging.mjs` and lifecycle module; provision/qualify/cleanup recovery matrix                                                                                 |
| 2. Separate infrastructure and fixture owners | Runtime/inventory modules and existing inner janitor; namespace, exact-identity and unrelated-resource regressions                                                      |
| 3. External journal and exclusive writer      | Contract/store modules; immutable inputs, lost acknowledgements, torn journals and real Linux lock checks                                                               |
| 4. Whole-environment spending clock           | Original intent/deadline and parent binding; no-reset and late-test-admission regressions                                                                               |
| 5. External actor coordination and monitor    | CLI/watchdog and exact-Pod exec adapter; paused processes, interrupted marker release and authenticated transport checks                                                |
| 6. One maintained fixture                     | GCP/runtime modules, pinned actor Dockerfile and dependency installer; local HTTPS/WebSocket bootstrap, offline Docker transport, browser and PostgreSQL/MinIO fixtures |
| 7. Parent binding and terminal evidence       | Qualification operation and private export; matching release/deadline, corrupt/lost export and missing-evidence publication checks                                      |
| 8. Ordered teardown                           | Shared cleanup/network helpers; residual disks, Gateway-child waits, replacement identities and narrow IAM/DNS cleanup checks                                           |
| 9. CI and publication                         | `studio-server-qualify-release.yml` and protocol-2 declarations; publication requires verified outer cleanup, while readiness is a separate read-only observation       |
| 10. Verification and handoff                  | Commands below, simulation context and owning guides; full clean-candidate image build/scan and actual GKE results remain separate release gates                        |

This closes repository implementation, not release qualification. Separately:

- Review/commit/publish the clean candidate through normal CI when authorized.
- Build and scan its full actor image, pin its digest and configure the durable
  external control host, staging identities, certificate and reviewed estimate.
- Obtain activation approval and run the exact-image GKE qualification, including
  verified final cleanup. Only its accepted evidence can qualify a release.

No local passing result substitutes for these gates or authorizes production.

## Owners and sequence

1. Validate exact main build/artifacts and the freshly observed installed
   predecessor. Freeze the private template, code closure, image digests,
   certificate/key hashes, project ID/number and allowance in an operation plan.
2. Arm a detached watchdog on a **native, durable, self-hosted Linux control
   host outside GKE**. It has a separate process group and does not inherit
   Actions tracking/GitHub tokens or production credentials. Verify its actual
   PID, `/proc` start identity, command hash, nonce and fresh heartbeat before
   the first provider mutation. A disposable hosted runner or job container is
   not an acceptable watchdog host.
3. Before cloud writes, verify the complete release pair, local actor image,
   tools and headless browser fixture with Docker networking disabled. Check
   explicit staging identity, quotas, Kubernetes version, existing service
   accounts, DNS zone and the absence of all reserved names. Capture a complete
   baseline inventory. No quota or API-enablement request is automatic.
   Node, in-cluster reader and external operator accounts must be distinct;
   assigning the operator identity to a Pod or node is rejected before access.
4. Create one custom VPC, two disjoint subnets (nodes/secondary Pod and Service
   ranges; regional proxy-only range), narrow edge firewall, regional address
   and regional Autopilot cluster. Existing node/operator/reader Google service
   accounts are protected, not operation-owned. No Cloud SQL instance, bucket,
   manually configured peering, private-service reservation or new long-lived
   identity is created. GKE's own controller-created network dependencies are
   inventoried and must be removed normally; they are never forcibly detached.
5. Create fresh UID-bound control, actor and edge namespaces. Add only the two
   previously absent Workload Identity members on the existing reader account.
   Install the exact TLS Secret, staging A record and regional Gateway. Package
   the existing provider/janitor against the newly observed cluster/Gateway
   identities. Start the digest-pinned actor Pod with a staging-only Kubernetes
   service account; send the closed driver package over authenticated v5 exec
   stdin. Never send Actions control tokens, production or operator-cloud
   credentials into it. Optional reviewed pull-only registry credentials are
   separate Kubernetes Secrets, not actor environment variables.
   The actor and janitor use the UID-verified internal Kubernetes Service;
   management access remains on the separately restricted external endpoint.
   Observe the actor's exact node/VM and add only its verified egress IPv4 `/32`
   to the fixture's dummy-auth allowlist. This does not widen management access.
6. Wait for fresh janitor, Gateway/listener, trusted TLS, CSI and metrics
   evidence. Re-observe production **read-only**, reject installation changes
   and freeze the fresh observation. Run the existing seven provider phases
   through that exact actor UID. A missing exec acknowledgement cannot authorize
   another seed, upgrade, upload or execution request.
7. Let the inner fixture settle accepted work and verify namespace/CSI/NEG
   cleanup. Export its terminal registry and bounded private diagnostics before
   deleting the actor/edge. Large videos and trace archives have explicit
   omission metadata; they are neither cleanup authority nor required in-memory
   archives. Authoritative phase receipts remain in the external journal.
   An unconfirmed inner settlement cannot trigger a terminal actor export.
   Export files have unique names and a journal-pinned hash; a process exit
   between file creation and acknowledgement cannot block recovery on an old
   filename or overwrite earlier diagnostics. Validate exported file names,
   canonical encoding, exact content hashes and size/count limits. Deliberately
   omitted large traces remain labelled omissions, not silently truncated files.
   Once inner settlement is independently verified, failed diagnostic transfer
   or private export writes record an evidence failure and do not alone block
   teardown. They do block qualification, even if all test phases passed.
   If expiry already removed the actor, the verified terminal registry remains
   cleanup recovery evidence, not a replacement for lost qualification evidence.
   Failure to persist the ownership journal still blocks cleanup: that is an
   authority failure, not merely missing diagnostics.
8. Discover the complete bootstrap namespace inventory. Verify exact namespace
   UIDs, known objects and controller references; ambiguous Events/custom
   objects block cleanup. Pin Gateway children through the recorded Gateway UID,
   reserved address and exact provider relationships. Remove Gateway first and
   wait for those children, then remove bootstrap objects/namespaces, cluster,
   address, firewall, subnets and VPC. Remove only recorded new IAM members and
   the exact A record. Never force dependencies or replace unrelated policies.
   A completed GKE delete is not assumed to have finished VM/disk/group garbage
   collection: observe those children disappearing before parent removal.
   Remaining firewall/static-route cleanup requires a fresh immutable parent
   network check, post-baseline identity and exact network relationship. Rules
   on other networks and pre-existing identities are never deleted. Managed
   subnet/peering routes are held for controller cleanup or explicit review,
   never forcibly detached.
   Recovery repeats the recorded Gateway-child absence checks even when the
   Gateway DELETE was already acknowledged. It cannot advance to namespace or
   cluster deletion while any exact recorded edge child remains.
9. Re-inventory the provider. Any new residual identity blocks certification;
   discovery is not deletion authority. Only verified full cleanup releases the
   project admission marker and exposes qualification outputs for publication.

The inner janitor still cannot delete the cluster, Gateway or network. It owns
application settlement at expiry; the external watchdog owns foundation expiry.
Management tokens use IAM Credentials' returned expiry, a five-minute safety
margin and a maximum 50-minute single-flight cache for requested one-hour
impersonated credentials. A printed source token is never assumed newly minted.
Each management HTTP/exec handshake obtains a current
token; refreshing credentials never retries an application/provider write.
Provider stderr is retained privately, not confused with a failed command merely
because progress was logged. A successful WebSocket exit status, valid complete
JSON receipt and all existing acceptance checks remain mandatory. UTF-8 output
may cross frame boundaries without corrupting the receipt.

## Journal, clock and recovery

Private state lives outside the checkout and deletable cluster. Linux `flock`
serializes writers without TTL stealing. The lock inode is never replaced.
Fsynced snapshots are atomically published, append-only and hash-chained. Partial
or inconsistent final records block recovery. Snapshot history retains exact
IDs and original clock fields; readers never see half-written final records.
The original cloud baseline, account identities and pinned environment fields
cannot be rewritten by a later snapshot. Confirmed settlement and cleanup flags
cannot move backward; partial bootstrap may add identities but never replace one.
Terminal cleanup stores one receipt, atomically with completion, bound to the
exact operation/input, terminal inventory and original verification timestamp.
Journal reads and admission release validate that binding. Changing the receipt,
inventory or date after completion is rejected; completion flags without the
bound receipt require explicit inspection, never a fabricated acknowledgement.

Record an intent before every modifying call. Save the returned operation and
wait for actual completion, then pin immutable cloud IDs/Kubernetes UIDs. After
a lost response, inspect exact state and ownership; do not replay the write.
An absent object does not generally prove that an uncertain CREATE was rejected.
A DELETE intent plus independently verified exact absence is a cleanup
observation, not an invented successful acknowledgement.
Kubernetes removals use UID/resourceVersion preconditions. The modeled GCP
Compute/GKE delete APIs address a resource by name and do not provide that same
UID compare-and-delete guarantee. The manager rechecks the immutable ID directly
before dispatch and serializes its own writers; this cannot fence an unrelated
administrator replacing the resource between that check and the provider call.
Use an exclusively managed isolated project during the operation. Detected
replacement or unaccounted inventory blocks cleanup rather than authorizing a
name-based retry. Local tests do not establish provider-side atomic deletion.

The clock starts **conservatively at the first billable create intent**, before
the address request. Observed first activation is recorded separately. Test
startup inherits this original deadline and allowance; it never resets either.
Provisioning, tests and cleanup share the allowance. Reserve enough cleanup time
and a minimum test window; recheck both before each new test phase, not only
once before bootstrap. Slow preparation cannot consume the cleanup reserve and
then admit another protected window. Stop admission if insufficient time remains. USD 50
is an approved allowance, **not a hard billing cap**. Reviewed estimates and
quota headroom are necessary, not a guarantee of actual spend or provisioning
speed.
The template's project ID/number and allowance must also match the protected
Actions environment values. Free-network preparation interrupted before the
first billable intent expires at the original approval deadline, not never.

At expiry, the watchdog closes admission independently of the writer lock and
requests normal shutdown of only the exact recorded operator process. A live or
paused writer blocks takeover. The inner janitor similarly requires exact Pod
and original-node evidence before expiry takeover, then drains accepted work.
Unknown work/ownership blocks deletion; there is no forced abort shortcut.

The watchdog stays quiet while unchanged, retains changed blocked-cleanup alerts
with exact residual identities, and continues inspecting without replaying
writes. Its private `watchdog.log` and `watchdog-alert-*.json` files must be
collected by the control host's operational alerting. If the host powers off,
credentials expire, or the frozen checkout changes, cleanup can be blocked; no
local process is an independent cloud-enforced billing cap. Keep that host,
checkout and credentials available until verified cleanup.
CLI failures retain a bounded reason in private `terminal-error-*.json` files;
they do not print cloud responses, private settings or credentials to Actions.
Diagnostic export never changes cleanup authority or replaces the failed exit.
Unchanged blocked observations do not append duplicate journal snapshots or
repeat settlement already proven with admission closed. The watchdog backs off
while blocked; it never advances by redispatching an uncertain modifying call.
Admission-marker removal has one owner shared by the operator and watchdog,
under the operation's kernel lock. A completed-state watchdog finishes a marker
left behind by an interrupted operator exit; it waits quietly for a still-held
writer lock and never removes a newer operation's marker. Completion does not
permit reissuing provider writes.
The watchdog re-reads completion after obtaining the lock. A stale expiry
observation cannot restart cleanup of a completed operation or signal its
already-completed writer.

For the exact private operation directory:

```sh
yarn node deploy/studio-server/scripts/temporary-staging.mjs status /private/rivet/rivet-q-RUN-ATTEMPT
yarn node deploy/studio-server/scripts/temporary-staging.mjs inspect /private/rivet/rivet-q-RUN-ATTEMPT
yarn node deploy/studio-server/scripts/temporary-staging.mjs cleanup /private/rivet/rivet-q-RUN-ATTEMPT
```

`status` reads only private metadata. `inspect` may append newly verified
identities, never retry cloud writes. `cleanup` uses the same frozen helpers,
kernel lock and safety checks as the watchdog. It is not a resume-tests command.
Status reports test success, evidence export and cleanup verification separately;
`complete` means cleanup completed, not that a release qualified. A terminal
evidence failure remains visible even after all infrastructure is removed.
After verified completion, `cleanup` returns the exact historical receipt without
cloud calls, new inventory attribution, time changes or journal writes. It may
release only its own leftover admission marker; it does not reacquire admission
or touch a newer operation's marker. This applies equally to environments that
never activated. A historical receipt is not a fresh observation of the project.
Do not erase journals, delete admission markers, extend expiry, edit receipt
hashes or restore production to unblock a test. Restore the exact code and
credentials; inspect/report uncertain resources rather than force them.

## Control-host configuration

Configure the protected `rivet-managed-staging` environment and
`rivet-qualification-control` runner label. These are administrator file paths,
not workflow-dispatch command strings:

- `RIVET_TEMPORARY_STAGING_TEMPLATE`: reviewed JSON described below.
- `RIVET_TEMPORARY_STAGING_CERTIFICATE`, `RIVET_TEMPORARY_STAGING_KEY`: private
  operation-hostname certificate/chain and matching key, valid for the allowance.
  Obtain certificate/terms approval separately; this code does not issue one or
  use production certificates/DNS.
- `RIVET_TEMPORARY_STAGING_ESTIMATE`: reviewed itemized estimate file; its exact
  bytes must match the template's estimate digest before cloud access.
- Optional `RIVET_TEMPORARY_STAGING_REGISTRY`: explicitly approved, operation-
  scoped, pull-only Docker config. Pin its bytes with `registrySecretSha256` in
  the template. Only `auths` and explicit `auth` entries for required registries
  are accepted, never credential helpers or unrelated hosts. Review scope and
  lifetime with the issuer: base64 auth cannot prove a provider's permissions.
  The code rejects an Actions/control token copied from its environment.
- `RIVET_QUALIFICATION_PRIVATE_STORE`: persistent external private directory.
- Optional `RIVET_QUALIFICATION_OVERLAP_PROFILE`: reviewed exact profile JSON.
- Existing production-observation configuration: read-only kubeconfig/context,
  namespace UID, release and private values file. Never mount these into GKE.
- Staging-only gcloud impersonation credentials for the template's operator
  account. The operator needs reviewed Compute/GKE/DNS permissions plus
  get/set-IAM-policy on the exact reader account; the reader account needs only
  the existing Compute/project read permissions used by the inner janitor.
  Configure required APIs and service-account roles separately, never broaden
  permissions automatically to repair a failed test.
  Configure the control host's `CLOUDSDK_CONFIG` for a source principal allowed
  to mint the exact operator account's token. The minting hop explicitly clears
  implicit CLI impersonation, targets only that staging account through IAM
  Credentials and uses the staging project for quota. The short-lived operator
  token—not the source credential—is used for resource requests. Required APIs
  and token-creation permission must already exist; this code grants neither.

The template contains all fields accepted by `temporaryStagingPlan`, **except**
`protocol`, `operationId`, `sourceSha`, `candidateDigest`, `predecessorDigest` and
`codeHashes`: those are derived from the exact validated run, not dispatch input.
It includes project ID/number, region, explicit Kubernetes version, managed DNS
zone/domain, node/operator/reader account emails, four disjoint private IPv4
CIDRs, non-world-open trusted clients, three digest-pinned images, `/app` actor
source root, certificate/key SHA-256 values, reviewed itemized estimate digest
and CPU/SSD/USD requirements plus `externalAddresses` (peak node addresses and
the reserved edge address), and:

```json
{
  "maxUsd": 50,
  "maxSeconds": 86400,
  "cleanupReserveSeconds": 3600,
  "minimumTestSeconds": 3600,
  "approvalExpiresAt": "REPLACE_WITH_APPROVED_UTC_TIMESTAMP"
}
```

Those fields belong under `allowance`. The example is not current approval or
a usable configuration. The exact config must fit the candidate's tested peak
capacity, including infrastructure Pods, temporary developer backend and
autoscaling tests—not just the seven application Pods.

Build the maintained actor locally from an exact **clean published** candidate:

```sh
yarn node deploy/studio-server/scripts/build-temporary-staging-actor.mjs SOURCE_SHA registry.example/qualification:SOURCE_SHA
```

Verify and scan that exact local build before publishing it (use new private
output paths; stop on any failed command):

```sh
docker run --rm --pull=never --network=none --interactive --init --entrypoint timeout registry.example/qualification:SOURCE_SHA -s TERM -k 10 240 node /app/deploy/studio-server/scripts/qualification/temporary-actor.mjs preflight < /private/actor-preflight.json
docker image save --output /private/qualification-actor.tar registry.example/qualification:SOURCE_SHA
yarn node scripts/ci/scan-container-images.mjs --archive /private/qualification-actor.tar --platform linux/amd64 --output /private/qualification-actor-scan
```

The private stdin file contains only `sourceRoot: "/app"` and the exact
`sourceSha`. Require a zero exit and matching `offlineFixturePassed: true`
receipt, not merely a printed line. The production admission adapter performs
that check against the subsequently pinned immutable registry image as well.
The scanner is the existing [container-security gate](container-security.md),
not a new exception policy or permission to suppress actor findings.

The helper builds only; it does not push. The Dockerfile pins Node and tool
versions, installs Chromium and preserves the exact single-commit Git checkout for source
verification. Publish/scan that image through the reviewed delivery process and
put its immutable registry digest in the template. Pull it onto the control host
before dispatch: the admission check uses `--pull=never`. Local image creation
and passing mocks do not themselves qualify the provider.
Without a private pull config, preflight checks anonymous GHCR, Docker Hub and
Quay manifests. With an explicitly approved private config it validates the
exact manifests using that isolated Docker configuration, then creates separate
UID-bound pull Secrets for the actor and janitor; the existing inner fixture
copies only its approved pull Secret. The default Docker config is never used.
An unavailable image stops setup before GCP writes. The actor image contains
source: keep it private unless publication of that source is intentional. The
build context excludes local credentials, ignored files and historical commits.
Its isolated checkout disables Git's `autocrlf` conversion, so Windows control
hosts cannot alter the committed source bytes before Linux verification.
It also uses a fresh empty Git template and disables configured checkout hooks
for context preparation. Host template files, private hook configuration and
hook-generated files must not enter the image's otherwise-clean `.git` metadata.
The build Dockerfile is copied from that verified single-commit clone, not
re-read from the mutable developer checkout after cloning.
The image's dependency-install helper switches Yarn to `node-modules` while
retaining the exact committed `.pnp.cjs` and `.pnp.loader.mjs` bytes. Yarn removes
those tracked loaders when changing linkers; leaving them deleted would fail
the actor's own clean-source admission. This is not a dirty-source exception:
the helper rejects a dirty/wrong-SHA input, restores only missing captured
loaders with their original permission bits, refuses unexpected replacement
types/contents/permissions, and requires the entire
checkout to remain clean afterward. Authored source, lockfiles and unrelated
edits are never reset or ignored. Runtime commands still use `node-modules`.
Linux Git tracks the executable bit; byte-identical restoration with a fixed
`0644` mode is not necessarily source-identical. Restoration uses an exclusive
file handle and reapplies the captured mode independent of the current umask.
The real linker regression checks bytes, permissions and clean Git state after
both initial and repeated installs. Run it on Linux as well as Windows: Windows
Git normally does not detect executable-bit changes.
Offline admission invokes Docker with `--interactive` so its private JSON packet
actually reaches stdin. It accepts only a successful, physically closed process
with the exact source SHA and a passing fixture receipt. Input-pipe errors,
invalid/oversized output, failed exit and deadline expiry fail admission before
any provider write. The separate Docker transport regression mounts only a
synthetic input/receipt fixture; it does not claim to build or qualify the full
release actor. CI may pull its pinned public Node base, while local runs may
reuse the explicitly selected `RIVET_HOUSEKEEPING_TEST_IMAGE`.
Docker-client exit is not treated as proof of container exit. Offline preflight
also uses Docker's init/reaper and a container-side `timeout` command, with the
same rounded-up deadline and a ten-second termination grace. This independent
deadline survives abrupt client loss; `--rm` removes the stopped container.
The termination limit applies **only** to this network-disabled, credential-free
offline check. It never aborts accepted provider/workflow activity or changes
the in-cluster janitor's drain/ownership rules. A failed client still blocks all
provider admission, even while the isolated local container finishes expiry.

## Verification and publication

Protocol-2 provider declarations carry the matching outer cleanup receipt;
publication rejects missing, mismatched, early or unsuccessful cleanup. Legacy
reusable-cluster declarations retain protocol 1. No public project/bundle or
production Helm values change.

Run the lean local gates before any paid activation:

```sh
yarn node --test deploy/studio-server/scripts/temporary-staging.test.mjs deploy/studio-server/scripts/temporary-staging-actor.test.mjs deploy/studio-server/scripts/temporary-staging-bootstrap.test.mjs deploy/studio-server/scripts/runtime-qualification-execution.test.mjs deploy/studio-server/scripts/runtime-qualification-publication.test.mjs deploy/studio-server/scripts/reusable-staging-transport.test.mjs
yarn node deploy/studio-server/scripts/verify-housekeeping-linux.mjs
PLAYWRIGHT_HEADLESS=1 PLAYWRIGHT_SLOW_MO=0 yarn studio-server:ui:observe runtime-control-fixture-contract.spec.ts
```

The real HTTP matrix also runs through
`postman/simulations/rivet-temporary-staging.sim.yaml`; see its adjacent context
document. Linux locking/process tests are mandatory, not platform skips.
Bootstrap tests use actual local HTTPS/WebSocket clients and package the actual
driver, while replacing provider infrastructure and strict shared-TLS admission
with isolated stand-ins. Separate real-TLS and browser fixtures cover those
client boundaries. None proves GKE admission, IAM, billing, controller scheduling,
regional availability or production zero downtime. Those require the separately
approved exact-image provider qualification.

### Local implementation evidence — 2026-10-29

- Focused lifecycle/actor/bootstrap and adjacent qualification suite: 68 tests
  passed without skips. Both Postman members served traffic and the exact
  simulation server was stopped. The subsequent expanded bootstrap matrix
  passed all five scenarios, including late admission (six tests with its
  parent); this overlaps the focused suite, not an additional cumulative total.
- Maintained Linux gate: 25 tests passed without skips, including real kernel
  locks, paused/surviving processes, interrupted marker release and private CLI
  status/error diagnostics.
- Real PostgreSQL/MinIO provider fixture: guarded two-project bundle export,
  maintenance handover, saved catalog/ZIP bytes and accepted restore journal
  preservation passed using the cached API image and source-owned fixture.
  That is not a build of the full candidate qualification actor.
- Headless `runtime-control-fixture-contract.spec.ts`: passed.
- Full local `verify-kubernetes.mjs` deployment-regression and Helm-render gate:
  passed. Its existing opt-in integration skips are not provider evidence.
- Workflow policy, test-style, repository/import boundaries, documentation
  links, formatting and whitespace checks: passed.

The regressions include a disposable real Yarn linker switch retaining exact
tracked loaders, exclusion of host Git templates, independent offline-container
expiry after client loss, idempotent historical cleanup receipts, lost/corrupt
terminal evidence, late test admission and repeated Gateway-child waits. They
exercise the maintained paths without changing developer dependencies, replaying
uncertain writes or targeting existing development containers.
The linker regression always sets `CI=true` and enables immutable installs.
It first verifies Yarn rejects the absent fixture lockfile with `YN0028`, then
permits only its disposable seed install to create that lockfile before committing
the fixture. The actual actor installer and repeated CLI install remain immutable;
no production or repository install guard is disabled. Captured Yarn diagnostics
are text rather than opaque buffers so another fixture failure remains readable.

The full qualification actor Docker image was not built from this dirty
implementation checkout. Its clean-candidate build/scan and actual GKE
qualification remain activation gates, not implied by these local results.
No cloud resources, production changes, publication or paid test occurred.
