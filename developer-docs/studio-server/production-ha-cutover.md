# First production HA adoption: operator runbook contract

This is a maintenance conversion, not a zero-downtime rolling upgrade. Subsequent
HA releases use the existing rolling owner and exact-token recovery. Planning,
read-only inspection and dry runs do not authorize any production write.

## Approval and ownership gates

Before execution, record explicit approval of the selected immutable release and
its qualification limitations, additional ongoing HA capacity/cost, backup scope
and cost, maintenance start/window, and the exact Rivet-only changes. Never reuse
a staging spending allowance as production-capacity or backup authorization.
Existing accepted work must finish; cancellation of paused/long-running work is a
separate choice, not implied by a maintenance window.

Maintain one operator and an exact resource inventory. Pin project number, cluster
ID, namespace UID, release/manifest digest, route and policy UIDs, storage ownership
and secret references. Stop on drift or an unfinished operation. No shared-node
drain, shared SQL instance rollback, default-context change, IAM replacement,
credential rotation, DNS/TLS change or unrelated application change is included.

## A consistent baseline precedes the first migration

The release CLI's `--maintenance-cutover` moves directly from stopping old pods
to installing/validating the candidate. It has **no backup-only checkpoint**.
Do not interrupt a live command at an assumed phase or invent a prepare-only flag.

For a legacy singleton, a separately approved offline backup phase must first
close Rivet admission, settle all accepted work, stop all installation writers
and prevent external controllers from recreating them. A UI login screen, empty
Run Activity view, disabled metric, database snapshot alone or live bucket listing
does not establish that state. Unknown consumers or unaccounted work are no-go.

A narrowly scoped legacy-only stop may use exact named workload UIDs plus current
replica/resource-version preconditions, **before** a release runner owns the
operation. It must never scale an HA owner or override an active cutover/HA journal.
The normal supported release command owns every subsequent upgrade transition.
Do not delete a journal, force-delete a pod or use an unguarded label-wide scale.

Keep external admission closed across intermediate releases: the CLI resumes each
candidate after validation. Paused human callers alone do not stop public or
in-cluster clients. An environment-owned maintenance gate must be separately
approved, identity-guarded and verified through the real edge. A route detach is
permitted only when the exact attached-route inventory proves no other route can
serve the Rivet hostname; preserve and restore the original parent references.
It is not a DNS/TLS change or permission to alter another application's route.
Internal callers and pre-existing sockets need separate quiescence. Never claim
the external gate freezes database/background writers.

While all writers are stopped, capture the complete dedicated Rivet database,
database-referenced object generations and required installation-owned retained
assets, plus separately protected encryption keys. Preserve stored bytes and
encoding metadata: compressed recordings must not become expanded JSON in the
backup. Include runtime-library releases, not just the workflow prefix. Record
source/schema/manifest identity, checksums, generation mapping, key IDs, freeze
interval and verification outcome. All stores must remain stable until capture
finishes. An export/copy/checksum/reference mismatch blocks the first migration.

Backups must use a separate private destination; never overwrite or synchronize
deletions into the live bucket. Offloaded provider exports and backup retention
are billable and need their own approval. An export of a named database is not a
snapshot of, or permission to restore, the shared Cloud SQL instance. A local
isolated database restore can inspect dump integrity and referenced-key coverage
without creating a paid GCP rehearsal; label untested provider recovery honestly.

## Apply and recover

Validate every promoted manifest against its exact clean source checkout and
archived chart. Stage manifests/operator values inside that checkout, as the CLI
rejects outside paths. Use explicit `--manifest` pins for a multi-hop adoption,
not a mutable production pointer. Preserve all existing installation-owned
configuration. Run each dry run before the maintenance window.

Apply one approved hop at a time with `--maintenance-cutover`, its exact context,
namespace, release, values, manifest and a new diagnostics directory. Verify
source/digests, readiness, normal authorization, recordings, storage integrity and
an approved side-effect-free workflow before advancing. Keep schedules and public
callers paused and the external maintenance gate closed until final acceptance.

All hops of this initial conversion, **including the hop that first enables HA**,
use cutover recovery: stop/settle the original runner, inspect the actual journal
and any lost acknowledgement, then use the same immutable inputs with
`--resume-cutover <original-token>` after ownership permits it. `--resume-ha` is
for an already-installed HA rolling operation, not recovery of this conversion.
Never infer a new operation from a timeout, replay uncertain executions or use
generic `helm rollback`. HA reverse-image replacement is explicitly refused by
the launcher; do not promise it as a recovery option.

Prefer repair-forward. Restoring data is a separate destructive decision with
writers stopped and exact Rivet database/object ownership verified. A shared
instance PITR restore, broad prefix deletion or automatic restore-on-timeout is
not an acceptable rollback. Stop rather than widening these boundaries.

At the end, verify actual HA placement and required surge capacity, restore only
the exact approved maintenance-gate fields, confirm public health/auth/recording
playback and safe workflow results, then restore only the schedules/callers paused
for this operation. Keep recovery artifacts through their approved retention.

See [release and migration commands](kubernetes.md#incompatible-reader-maintenance-cutover),
[provider backup contracts](kubernetes.md#cross-store-backup-and-restore-drill) and
[the qualification limits](ha-rolling-upgrades.md). Environment-specific packets
belong in protected operator storage, not Git; store only secret references and
non-secret approval/evidence receipts in the general runbook.
