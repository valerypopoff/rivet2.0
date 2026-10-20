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

For legacy installations with metrics disabled, do not infer zero in-memory work
from readiness, quiet traffic or idle SQL sessions. Shutdown is not a diagnostic:
its grace deadline can abort remaining executions. Establish trustworthy work
accounting before stopping writers; do not enable invasive runtime debugging as
an implicit part of a read-only check.

The release CLI's `--dry-run` exits before installed-release inspection. Run it
from every exact clean source revision and retain the corrected installation
values, but describe the result as offline command validation, not proof of live
lineage or available capacity. Actual execution must recheck those prerequisites
at each hop. Repositories with committed PnP loaders/caches can use those pinned
dependencies directly; regenerating tracked dependency state can invalidate the
clean-source guard.

The optional [ten-pod runtime-HA profile](runtime-ha-singleton-control-plan.md)
is a subsequent, same-image ownership transfer after a compatible 13-pod bridge,
not this first-adoption maintenance conversion. It needs its own qualified
runtime/control and embedded-maintenance capacity evidence and explicit rollout
approval. Do not substitute a raw Helm scale, generic rollback, or the older
full-HA receipt for that transfer.

Maintain one operator and an exact resource inventory. Pin project number, cluster
ID, namespace UID, release/manifest digest, route and policy UIDs, storage ownership
and secret references. Stop on drift or an unfinished operation. No shared-node
drain, shared SQL instance rollback, default-context change, IAM replacement,
credential rotation, DNS/TLS change or unrelated application change is included.
On a shared Autopilot cluster, namespace-scoped changes alone do not guarantee
that neighbouring Pod identities stay fixed: reducing Rivet temporarily can
trigger GKE's own node consolidation and reschedule other tenants. Check those
applications' controller availability and replacement readiness independently,
retain autoscaler events, and distinguish automatic rescheduling from operator
mutation. Do not claim uninterrupted service from a final Ready snapshot alone.
If that risk is unacceptable, arrange an approved isolation/consolidation policy
before maintenance; do not silently patch neighbouring workloads, node pools or
their disruption budgets during a Rivet upgrade.

## A consistent baseline precedes the first migration

The release CLI's `--maintenance-cutover` moves directly from stopping old pods
to installing/validating the candidate. It has **no backup-only checkpoint**.
Do not interrupt a live command at an assumed phase or invent a prepare-only flag.

HA adoption's temporary maintenance-validation overlay deliberately uses a
singleton and zero proxy/web replicas. It must set `availability.gkeGateway=false`
in that overlay: the GKE guard requires HA and cannot describe a fenced singleton.
This is not an installation-profile change. Full-target lint/render and the resumed
deployment must retain `availability.gkeGateway=true`, hard placement, replica
floors and the original installation values. Qualify the merged temporary overlay
too; a successful full-target dry-run alone does not exercise this cutover phase.

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

While all Rivet writers are stopped, capture the complete verified Rivet database
scope, database-referenced object generations and required installation-owned retained
assets, plus separately protected encryption keys. Preserve stored bytes and
encoding metadata: compressed recordings must not become expanded JSON in the
backup. Include runtime-library releases, not just the workflow prefix. Record
source/schema/manifest identity, checksums, generation mapping, key IDs, freeze
interval and verification outcome. All stores must remain stable until capture
finishes. An export/copy/checksum/reference mismatch blocks the first migration.

Key escrow must verify the required key ID and a persisted recovery round-trip
without printing plaintext. Keep it outside ordinary diagnostics and object
backups. Windows CurrentUser DPAPI is machine/profile-bound, not portable recovery;
document that limitation and preserve an independently approved recovery copy.
A newly created private backup destination and successful key escrow are only
preparation, never evidence that the cross-store baseline has been captured.

### When another application shares the database

A separate Cloud SQL instance is not required, and sharing a database does not
automatically require moving Rivet before an upgrade. However, a database name,
schema name or common SQL role is **not** an ownership boundary. Confirm the
installed source's exact table owners and compare them with the live catalog.
Do not dump/restore all of `public`, stop another application's clients, terminate
shared-user sessions or use whole-database recovery as a Rivet-only rollback.

For a shared database, prepare an explicit, schema-qualified Rivet allowlist from
the exact installed SQL owners. Include migration history, restore-control state,
the VM migration gate if present, owned sequence definitions/values and required
stored functions. The legacy-import replacement list alone is insufficient: it
deliberately omits control state and migration history. Do not select objects by
prefix, discover ownership from row counts, or infer it from the SQL owner role.

Check the catalog in both directions for cross-boundary foreign keys and sequence
use, custom triggers/rules, inherited/partitioned tables, RLS, dependent views,
custom types/default functions and enabled event triggers. An unexpected dependency
blocks the scoped procedure until reviewed; never expand the allowlist or add
`CASCADE` to make a restore succeed. Match required function bodies and security
attributes to the installed source. Preserve the observed object identities and
repeat the check immediately before capture; an earlier result is not a lock.

Use a supported PostgreSQL client with an exact `pg_dump --table` allowlist,
`--strict-names`, bounded lock waits and a custom-format archive. Include the exact
owned sequences explicitly, suppress unrelated global/ACL/publication objects and
large objects unless their ownership is separately proven. PostgreSQL table
selection does not automatically include every dependency, including stored
functions and required schemas; preserve and review those separately. See the
[PostgreSQL table-selection contract](https://www.postgresql.org/docs/18/app-pgdump.html).
One snapshot can capture Rivet's selected relations while unrelated application
traffic continues, but Rivet's writers must still be frozen for a consistent
database/object-storage recovery point. A live SQL snapshot alone is insufficient.

Inspect the archive's object inventory and restore it into a new isolated local
database with errors treated as failures, no ownership/ACL replay, and a single
transaction where supported. Verify required functions, row/key coverage,
sequence values and exact-source migration/verification behavior. Include
unrelated-app sentinels in the local source and target: they must be absent from
the archive and unchanged by restore/migration. Do not validate by restoring into
the live shared database or by disabling foreign keys/triggers.

A production data recovery remains a separate explicit decision. Prefer a new
Rivet-only destination and approved Rivet connection cutover, not `--clean`,
database replacement, `DROP SCHEMA public`, shared-instance PITR or automatically
overwriting shared tables. Do not change either application's credentials as a
side effect of preparing a backup. Operators must arrange a supported, approved
client connection before freezing writers; don't install a client into a serving
pod or assume a diagnostic pod connection survives stopping that pod.

Backups must use a separate private destination; never overwrite or synchronize
deletions into the live bucket. Offloaded provider exports and backup retention
are billable and need their own approval. An export of a named database is not a
snapshot of, or permission to restore, the shared Cloud SQL instance. A local
isolated database restore can inspect dump integrity and referenced-key coverage
without creating a paid GCP rehearsal; label untested provider recovery honestly.

## Apply and recover

On GKE Autopilot, required Pod anti-affinity has higher resource minimums than
ordinary small frontend Pods. Explicit installation values must request at least
`500m` CPU and `512Mi` memory for each proxy/web Pod using that policy; the small
generic defaults are not a valid availability profile by themselves. Verify the
rendered Pod specimens with non-persisting server-side admission dry runs before
the maintenance window. Keep the hard placement policy, correct resource requests
and recompute the cost envelope rather than disabling anti-affinity to make a
rollout fit. Apply the override to every HA-enabled adoption hop, not just the
last release. See [GKE's anti-affinity resource requirements](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests#workload-separation).
Admission success does not prove schedulable node or surge capacity: check regional
SSD boot-disk, CPU, instance/IP quotas **and project-wide `CPUS_ALL_REGIONS`**
independently. Regional CPU headroom does not override the global CPU ceiling.
Allow for the minimum physical nodes required by hard anti-affinity, rolling
surge and concurrent node-provisioning reservations, not just the sum of Pod CPU
requests or current quota usage. Autopilot can briefly reserve addresses for
multiple provisioning attempts even when steady-state usage is lower. Inspect
the exact Compute audit error/quota metric when autoscaling reports a generic
quota failure; it may not be the quota previously increased. Obtain approval
before requesting additional limits. Never free shared quota by deleting
existing disks, PVCs or nodes, or weaken placement to bypass a capacity failure.

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
Each successful hop completes and releases its own journal ownership; the next
ordinary pinned hop obtains a new operation. An exact-token resume applies only
to the unfinished hop and its immutable manifest, not to the entire hop chain.
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
An executor smoke must consume the authenticated `/api/config` response and use
its signed owner path plus the `rivet-session-v1` WebSocket protocol, as the hosted
browser does. A legacy hard-coded `/ws/executor/internal` smoke does not verify HA
owner routing. Keep signed capabilities out of diagnostic logs and do not weaken
authentication or session requirements to make a test client connect.
Use an isolated, non-secret `RIVET_ENV_FILE` for production Playwright checks;
the repository observer normally loads local-development dotenv values, which can
override a production credential passed in the process environment. Fetch the
approved key only into the test process and disable credential-bearing traces.
After first-adoption route detachment, existing Pods may retain a historical
`LoadBalancerNegWithoutHealthCheck` reason. Never rewrite that condition or call
it positive health evidence. Match all current proxy IPs/ports, node identities
and Service NEG groups to fresh `Compute get-health` results, and preserve the
original Pod reasons separately. This acceptance snapshot is not a replacement
for an unperformed regional eviction/recovery qualification.

See [release and migration commands](kubernetes.md#incompatible-reader-maintenance-cutover),
[provider backup contracts](kubernetes.md#cross-store-backup-and-restore-drill) and
[the qualification limits](ha-rolling-upgrades.md). Environment-specific packets
belong in protected operator storage, not Git; store only secret references and
non-secret approval/evidence receipts in the general runbook.
