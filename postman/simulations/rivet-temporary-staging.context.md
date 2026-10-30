# Rivet temporary staging simulation

Created 2026-10-29. The local mock models the official Google REST contracts;
no owner-published mock was available. Nothing is uploaded to Postman or GCP.

## Purpose

Run the real infrastructure client and lifecycle against local HTTP. See
`postman/mocks/temporary-gcp/contract.cjs` for modeled requests and failure controls.

## Execution

Start `postman simulation run postman/simulations/rivet-temporary-staging.sim.yaml --no-history --output ndjson`.
Use the `listening` event's bound URL, then set `RIVET_TEMPORARY_SIMULATION_URL`
to its `/gcp/` member and run
`yarn node --test deploy/studio-server/scripts/temporary-staging.test.mjs`.
Keep logs private. Stop only that exact simulation process.

## Assumptions

- Local HTTP proves client/journal behavior, not IAM permissions, Autopilot
  admission, scheduling, billing, controller reconciliation or provider qualification.
  (reasoned 2026-10-29, mock contract)
- Unsupported paths answer 501; modeled absent resources answer 404.
  (reasoned 2026-10-29, mock contract)
- Postman supplies `req.body`, not Node's asynchronous stream. Its response
  shim cannot destroy a socket, so lost responses use HTTP 500 after the fake
  write; the direct HTTP fixture separately tests actual socket loss.
  (observed 2026-10-29)

## Observations

<!-- begin:observations -->

- Supported, 2026-10-30: the real infrastructure client rejects missing project
  create/cleanup permissions before any infrastructure write. All 48 staging
  tests passed through Postman CLI 1.75.0 using the existing local path-routed
  simulation with history disabled. Its log contains 2,006 `gcp` and nine
  `registry` requests, including 19 read-only Resource Manager
  `testIamPermissions` calls. The four firewall/certificate permission omissions
  each left an empty resource journal and no billable intent. Twelve focused
  direct-HTTP tests additionally passed, preserving the actual socket-loss and
  timeout checks that the Postman response shim cannot reproduce. The exact
  simulation server/workers stopped and its local port was released. Evidence:
  `artifacts/continuity-release-20261030/project-permission-postman-proof.json`,
  the adjacent private request/test logs, and `temporary-staging.test.mjs`.
  This supports caller behavior under these scenarios, not GKE qualification.

- Supported, 2026-10-30: Network Admin alone does not cover the maintained
  firewall and SSL-certificate cleanup paths. A real pre-billing staging attempt
  received an explicit `compute.firewalls.create` denial; its exact network and
  subnets were subsequently removed with verified cleanup. The approved
  operator's actual project `testIamPermissions` response omitted firewall
  create/delete and regional/global SSL-certificate delete from the 24 checked
  lifecycle permissions. Google documents these exclusions and the read-only
  inspection endpoint. Sources: [Compute roles](https://docs.cloud.google.com/iam/docs/roles-permissions/compute),
  [Resource Manager API](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/testIamPermissions),
  and the private continuity operation packet. No role name, passing simulation
  or successful quota check establishes effective cloud privileges; check the
  actual principal before creating resources.

- Source-admission reassessment, 2026-10-30: the existing real-Git source fixture
  reproduced acceptance of an untracked source file hidden by a status-display
  preference. The fix rejects it before cloning and during actor verification,
  and a working filesystem-monitor fixture proves that verification no longer
  invokes the configured hook. Both source/installer tests passed on Windows
  and Linux (Linux used three reviewed read-only source/test overlays).
  The adjacent actor/provider/dependency suite passed 66 tests on Windows;
  its one Linux-only process case separately passed on Linux. The unchanged
  real CLI trusted-TLS/HTTP2/no-replay probe and seven security-policy regressions
  passed. The headless built-frontend save/Evaluations journey passed again.
  No new Postman server, cloud request or image qualification is implied.

- Final security acceptance, 2026-10-30: exact Linux-amd64 image
  `sha256:9dedcb136e4dd71cda5a519162a563474008c59cac331f6f50441c1895783b25`
  passed the unchanged full-image gate with zero High/Critical findings;
  56 Medium, 11 Low and 10 Unknown findings remain visible. It also passed
  offline browser/video admission, 78 Linux transport/chart, two source/installer
  and 27 kernel-lock/process tests with no skips and no host source overlay.
  The required headless runner passed a save/editing/Evaluations journey against
  its actual built frontend with controlled API responses. These are local
  fixtures, not live GCP, a new Postman run or provider qualification. Evidence:
  `artifacts/staging-security-20261030/acceptance/`. This supersedes the earlier
  failing actor scan below without changing its retained report or scan policy.

- Security follow-up, 2026-10-30: the byte-exact source projection passed actual
  offline browser/video admission, 78 Linux transport/chart checks, two
  source/installer checks and 27 kernel-lock/process checks, without skips.
  These used the maintained direct HTTPS/WebSocket fixtures and local mock
  handler, not live GCP or a new Postman server run. The separate patched
  toolchain target passed actual kubectl TLS/HTTP2, file-backed mutation,
  lost-acknowledgement/no-resend and stale-identity checks. Intermediate images
  are not a passing final-image scan or provider qualification. The original
  247-finding report below remains historical evidence, not suppressed output.

- Additional 2026-10-30 full-actor security scan failed with 247 High/Critical
  findings across Helm, kubectl, esbuild binaries, npm's bundled dependencies
  and desktop Cargo metadata. Foreign-platform copies repeat some findings.
  The passing functional simulation/browser checks do not override this gate;
  that earlier actor was not ready for publication or provider qualification. No scanner
  policy or source-integrity check was relaxed.

- Final 2026-10-30 local verification: all 41 staging client tests passed with
  direct HTTP stand-ins, followed by 20 Linux actor/bootstrap tests against
  authenticated HTTPS/WebSockets. The Linux bootstrap mounted only the reviewed
  current tooling files read-only; this is not an immutable-provider report.
  Separately, the clean actor snapshot passed its actual network-disabled
  browser preflight with a nonempty video. The full-image gate caught a missing
  FFmpeg dependency that the host-only browser check could not expose. Docker
  runtime checks that timed out during concurrent image building passed unchanged
  after building finished. No timeout or assertion was relaxed. No real CA order,
  cloud activation, production operation or history upload occurred.

- Observed 2026-10-30 deployment-tool repair: the complete staging client suite
  passed 34 tests with no failures/skips against Postman CLI 1.75.0 on an
  automatically allocated localhost port. Both `gcp` and `registry` route keys
  served real requests; the exact simulation process was stopped afterward.
  Local certificate-worker uncertainty tests used disposable files and a Docker
  command stand-in, never a real ACME order. The separate authenticated
  HTTPS/WebSocket bootstrap exercised IP-hostname setup, exact JSON-patch guards
  and lost HTTPS acknowledgements through teardown. These results establish
  local client behavior, not DNS/CA availability, GKE timing or qualification.

- 2026-10-29 full-plan audit: both `gcp` and `registry` served the lifecycle
  suite successfully. The separate concrete HTTPS/WebSocket fixture proved
  lost/corrupt terminal exports fail qualification without blocking safely
  verified cleanup, and late test admission preserves cleanup time. The exact
  simulation server was stopped; no cloud activation or history upload.

- Observed 2026-10-29 cleanup-receipt reassessment: the focused lifecycle,
  actor, bootstrap and adjacent qualification suite passed all 64 tests against
  the local simulation and isolated process fixtures. Both `gcp` and `registry`
  route keys served traffic; the exact simulation server was stopped afterward.
  Completed cleanup returns its original bound receipt without new provider
  calls, journal revisions or verification timestamps, including never-activated
  operations. Later operation resources remain untouched. This is not GKE
  qualification; no cloud requests or history uploads occurred.

- 2026-10-29 reassessment: both `gcp` and `registry` members served the real
  client recovery suite successfully. The exact simulation server was stopped
  afterward. Gateway-retry ordering and terminal export were additionally
  exercised through the separate concrete HTTPS/WebSocket bootstrap fixture;
  this simulation does not model GKE controller timing.

- Observed 2026-10-29: Postman CLI 1.75.0 served both local members on port 3000. The real `temporary-staging.test.mjs` client suite passed all 18 tests,
  with no failures or skips, using `RIVET_TEMPORARY_SIMULATION_URL` for the GCP
  and anonymous-registry members. The simulation log contained request events
  for both route keys. The exact server was stopped afterward; no history,
  mock upload or cloud environment was created.
- Observed 2026-10-29: the matrix exercised operation completion, exact identity
checks, original deadlines, lost create/delete acknowledgements, HTML errors,
timeouts, replacement resources, busy settlement, residual inventory, network
rule ownership, private-registry admission and hash-chained journal failures.
These are local behavioral results, not provider qualification.
<!-- end:observations -->
