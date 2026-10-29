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
