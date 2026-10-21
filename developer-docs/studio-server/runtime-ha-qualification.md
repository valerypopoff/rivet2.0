# Runtime HA qualification publication

The compact singleton layout and drain-aware autoscaler need separate exact-image
provider evidence in addition to ordinary replicated-HA qualification. Local
functional tests are not a GKE certificate.

## Release order

1. Freeze a reviewed main candidate and let its normal **Build Images** run finish
   successfully. Retain its candidate/promoted manifests, exact predecessor and
   image digests. Do not install this unqualified candidate in production yet.
2. Complete local and separately approved isolated GKE verification against those
   exact images/chart/policy: regional/compact transfer and reversal, mixed-image
   compact upgrade, cold runtime independence, browser OAuth/actions, maintenance
   peaks/recovery, real metrics/RBAC, accepted-work drain, restart and node headroom.
3. Settle every observer/worker, retain truthful terminal diagnostics and clean
   up the exact recorded test resources. Do not combine failed/partial windows
   into a passing certificate or derive maintenance sizing from tiny exports.
4. Run **Publish qualified runtime HA** on that same main source, supplying the
   successful Build Images run ID and the two sanitized provider declarations.
   It downloads the original candidate and ordinary-HA promotion; it never
   rebuilds images, runs a GCP experiment or deploys workloads.
5. The resulting immutable manifest retains the source/images/chart/schema and
   predecessor, adds the exact runtime evidence, and records this publication's
   actual workflow run as promotion provenance. It advances the artifact pointer
   only while main and the original ordinary-HA production pointer still match.
6. Pin that qualified manifest. Install it at the existing replicated layout
   through normal HA first. Then perform regional13->10 ownership transfer,
   compact10->6 rollout, and separate autoscaler6->7 enablement, accepting each.

Evidence changes the manifest digest. Never edit an installed manifest in place
or bypass predecessor validation to bolt on a certificate. If the unqualified
manifest was already installed, create a new compatible candidate with that exact
installed manifest as predecessor. Same images do not authorize a sibling rollout.

## Dispatch declaration contract

Each JSON input is at most 16,384 characters with exactly these fields:

- `protocol`:1, `provider`:"gke", `scope`:"isolated-provider", `outcome`:"passed",
  `cleanupVerified`:true.
- `operationId`, `projectId`, `projectNumber`: the same approved isolated operation
  in both declarations. Never use production resources as the test target.
- `startedAt`, `finishedAt`: the actual completed ISO observation window.
- `reportSha256`: SHA-256 of the retained sanitized terminal provider report.
- `evidence`: the exact runtimeControl/runtimeAutoscaling shape in
  `lib/ha-release-evidence.mjs`, constructed only after every required check passes.
- Autoscaling additionally needs `policy`: all normalized `autoscalerPolicy`
  fields. Its canonical digest must match the evidence.

Control must cover both regional and compact profiles. Failed, local, incomplete,
uncleaned, mismatched source/images/chart/policy or different-operation inputs
are rejected. No copied unit-test checklist can establish provider qualification.

These are trusted-operator attestations backed by reviewed retained reports.
The workflow checks release/policy binding, structure, main build provenance and
publication lineage; a report hash is provenance, not remote cryptographic proof
that GKE performed a test. The job itself never runs or inspects the paid experiment.

Do not include credentials, project contents, prompts, outputs or raw logs.
Unknown declaration fields are rejected, and malformed values are not echoed in
validation errors. Only normalized declarations/evidence and the promoted manifest
are retained for 90 days. The content-addressed GHCR artifact is the durable record.

## Recovery and boundaries

The workflow is manual/main-only, uses the protected staging environment and shares
the normal main image-promotion concurrency group. A newer main push may cancel it.
Changed pointers are inspected, never overwritten. Publication changes artifacts
only: production backup, identities, shared-database budget, capacity, approval and
guarded deployment checks remain mandatory.

If acknowledgement/upload fails, inspect the immutable artifact and pointer before
retrying publication. The registry write may already have succeeded. Do not start
another paid rehearsal or replace already-qualified evidence to repair an artifact
upload. Source/image/chart/policy changes require a new reviewed candidate.

`runtime-qualification-publication.test.mjs` covers source/build provenance,
declaration rejection, release/policy binding, pointer identity and CLI input-log
redaction. The existing CI workflow-policy checker owns the YAML/permissions,
manual/main-only and publication-order checks. These are not a provider certificate.
