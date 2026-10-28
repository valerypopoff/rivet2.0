# Local Kubernetes HTTP error simulation — 2026-10-28

## Purpose

Repository-owned transport-contract stand-in (`default.js`), reused without cloud
credentials, external mock discovery, workspace changes or publication. Stateful
Kubernetes and WebSocket interleavings live in the adjacent Node regression suites.

## Execution

Start `postman simulation run deploy/studio-server/scripts/fixtures/autoscaler-kube/simulation.sim.yaml --port auto --no-history --output ndjson`.
Use the actual listening port with host `127.0.0.1`, not the advertised `localhost`.
Set `RIVET_AUTOSCALER_SIMULATION` to that loopback origin and run
`execution-autoscaler-kubernetes.test.mjs`. Stop the exact simulation process after
requests settle; do not use wildcard process termination.

## Assumptions

- This tests HTTP parsing, bounded errors and timeouts, not scheduling, GCP or
  controller ownership. No mutating API routes are modeled. (observed 2026-10-28)

## Observations

<!-- begin:observations -->

2026-10-28 schema-adjacent review: kube served OK, NotFound, JSON503 and
HTML502; the client bounded the hang, with no silent members. Two broad local
runs passed after replacing the shutdown test's wall-clock assumption with
confirmed-exit/recovery checks. Separate real PostgreSQL/source-overlay workers
and strict Pod/code/receipt regressions passed; this is not GKE qualification.

2026-10-28 schema-compatibility review: kube served OK, NotFound, JSON503 and
HTML502; the client bounded the hang, with no silent members. Separate CLI
stand-ins checked actual Pod images, replaced Jobs and worker settlement; real
PostgreSQL/source-overlay workers passed. None of this is GKE qualification.

2026-10-28 preparation-adjacent review: kube served OK, NotFound, JSON503 and
HTML502; the client bounded the hang. No member was silent. Separate stateful
HTTP regressions verified surviving-Job rejection, node loss during cleanup and
deadline fencing, including expiry between a recorded intent and its request.

2026-10-28 rollout-preparation hardening: kube served OK, NotFound, JSON503 and
HTML502; the actual client bounded the hang. No member was silent. Stateful
HTTP tests separately reproduced lost-CREATE orphan cleanup, stopped admissions,
namespace replacement and source-controller identity failures before their fixes.

2026-10-28 rollout-preparation implementation: kube served OK, NotFound, JSON503
and HTML502; the real client bounded the hang. No member was silent. Separate
stateful HTTP and actual CLI stand-ins covered parallel preparation, response
loss and exact cleanup; cached-container checks are not native scheduling proof.

<!-- end:observations -->
