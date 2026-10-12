# Supported Server Stack

Rivet Server requires PostgreSQL and S3-compatible storage, not Kubernetes.
Docker Compose and Kubernetes run the same images and managed API roles.
Desktop, Node and CLI graph execution are unchanged. File/SQLite implementations
remain migration/compatibility internals; existing data is never adopted automatically.

## Six single-machine commands

```bash
yarn studio-server:dev:local-storage
yarn studio-server:dev:external-storage
yarn studio-server:staging:local-storage -- --manifest <candidate-or-promoted.json> --confirm rivet-staging-local
yarn studio-server:staging:external-storage -- --manifest <candidate-or-promoted.json> --confirm rivet-staging-external
yarn studio-server:prod:local-storage -- --manifest <promoted.json> --confirm rivet-prod-local
yarn studio-server:prod:external-storage -- --manifest <promoted.json> --confirm rivet-prod-external
```

These are deployment selections, not different application runtimes. All read the
same private `.env`, selected optionally by `RIVET_ENV_FILE`. Docker with Compose
and the repository Node/Yarn installation are sufficient; Minikube, kubectl and
Helm are not required. No command installs or starts Kubernetes.

Local storage automatically starts private PostgreSQL/MinIO containers and
persistent project-scoped volumes. External storage provisions neither: the
operator supplies a dedicated PostgreSQL database and S3 bucket/prefix.
Only the proxy is published, on loopback by default. Ports default to dev 8080,
staging 8082, production 8083. Configure an authenticated TLS gateway before
public exposure. PostgreSQL, MinIO/console and internal API/executor ports are
not published. Host volumes require disk monitoring/capacity planning; Compose
does not provide Kubernetes PVC/ephemeral-storage quota enforcement or HA.

Development builds the checkout's API, web and proxy images with unique source
tags. It serves built assets, not the historical Vite/tunnel hot-reload stack.
Staging requires immutable candidate/promoted image evidence and a matching
clean checkout. Both production storage choices require a promoted immutable
manifest, matching clean source/chart/schema policy, installation confirmation
and exact predecessor lineage. Local storage is not an exemption from release
safety. The API image already contains the editor executor; its separate
manifest component is retained as release evidence, not another local runner.

`studio-server:dev` and `studio-server:vm` alias dev/local storage.
`studio-server:dev:recreate` rebuilds the same managed Docker installation;
it does not switch to Kubernetes.
`studio-server:prod` aliases prod/external storage.
Retired `prod:prebuilt`/custom commands do not redirect to another deployment
target; use the six concrete commands or the explicit Kubernetes release command.
The old Docker cleanup command remains for existing installations:
`studio-server:dev:docker:down`. It does not migrate their data.
Explicit Kubernetes rehearsal/release commands remain supported.

## Shared dotenv settings

Use `deploy/studio-server/.env.example` as the canonical template. Common
`RIVET_KEY` is the fallback authentication/encryption key (at least 32 characters).
Tier-specific settings use `RIVET_DEV_`, `RIVET_STAGING_` or `RIVET_PROD_`:

- `KEY`: optional key override; `PORT`: loopback browser port.
- `APP_SETTINGS_ENCRYPTION_KEY`: optional dedicated encryption key; falls back
  to shared `RIVET_APP_SETTINGS_ENCRYPTION_KEY`, then the authentication key.
  `APP_SETTINGS_ENCRYPTION_KEY_PREVIOUS` has the equivalent tier/shared lookup
  for decrypting older secrets. Keep the source key when restoring encrypted
  settings; the backup deliberately does not contain it.
- `COMPOSE_PROJECT`: stable lowercase installation name; defaults are
  `rivet-<tier>-local` or `rivet-<tier>-external`.
  Configured tiers must not share a Compose project. Resources carry their
  deployment stage; an immutable installation cannot be adopted by dev/source
  startup, even if its credentials happen to match.
- Local: `LOCAL_POSTGRES_PASSWORD`, `LOCAL_S3_ACCESS_KEY_ID`,
  `LOCAL_S3_SECRET_ACCESS_KEY`. Missing local credentials and a missing common
  key are generated/appended once. Keep them with the retained volumes.
- External: `DATABASE_CONNECTION_STRING`, `DATABASE_SSL_MODE`,
  `STORAGE_ENDPOINT` (optional for AWS), `STORAGE_BUCKET`, `STORAGE_REGION`,
  `STORAGE_PREFIX`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_ACCESS_KEY_ID`,
  `STORAGE_ACCESS_KEY`.

For example `RIVET_STAGING_DATABASE_CONNECTION_STRING` is never inferred from
production. Production retains compatibility fallback to its previously configured
`RIVET_K8S_*` external connection variables; dev/staging do not. Local storage
ignores every external connection and derives private container endpoints.
Configured stages cannot share the same declared PostgreSQL database. Hostname
aliases cannot establish physical isolation, so the database installation binding
is also checked before DDL. Each independent installation needs its own catalog.
Runtime-library archives retain their existing protected, bucket-global semantics.

The shared file is never a blanket container `env_file`. Only normalized runtime
configuration reaches services; unrelated host values and PnP preloads do not.
Ambient `COMPOSE_*` controls are removed from launcher subprocesses, so another
project's profiles, dotenv selection or orphan-removal policy cannot leak in.
Explicit Docker engine/context environment settings remain supported.
Generated Compose configuration contains credentials and remains private under
`.data/container-server/<project>/compose.private.json`, never diagnostic artifacts
or argv. POSIX files/directories are owner-only; check Windows ACLs separately.
Initialization uses an exclusive `.rivet-init.lock` and appends missing values,
preserving existing text. It atomically publishes the whole resulting dotenv and
syncs it before any Docker startup; credentials cannot be truncated by an
interrupted in-place append. The parser uses the last definition of a key.

Earlier `RIVET_VM_K8S_*` settings belong only to the explicit Kubernetes launcher;
the Docker aliases create a distinct installation. Neither silently imports its
PVCs, old Compose volumes or file/SQLite data. Keep prior credentials and data
until a verified backup/transfer restores the destination.

## Ownership, startup and recovery

`container-server-config.mjs` owns normalization and the managed Compose model.
`container-server-lifecycle.mjs` owns resource checks and startup ordering.
`container-server.mjs` owns admission, image policy, private configuration,
the exclusive per-installation launcher lock and pending/release records.
`container-server-files.mjs` owns private atomic file publication and the bounded
subprocess environment projection. State directories/files must be ordinary
entries, not symlinks/junctions into another installation. Replacements use a
private sibling file, sync it and rename it; POSIX also syncs the containing
directory. Windows keeps atomic replacement but does not sync directory handles.
Receipt/configuration reads also reject linked or non-file entries; only ENOENT
means absent state. On POSIX, newly created state directories sync their parent
before work can begin, not just their subsequently written files.

The backend supervisor still owns control API and editor executor processes.
Execution and Evaluation containers use the same API image with explicit roles.
PostgreSQL owns settings, metadata, leases and durable coordination; S3 owns
artifacts. Replicas do not enumerate each other in normal serving. No serving
container mounts the Docker socket, receives Kubernetes API credentials, or writes
schema migrations. The serving contract remains managed, coordinated, verify-only.

Startup verifies every selected container, named volume and network before
mutation. Foreign resources and changed storage/credential fingerprints fail
closed; unexpected service names also fail before shutdown or DDL, rather than
leaving an old reader outside the drain inventory. Deployment-stage labels
prevent cross-tier adoption; earlier unlabelled dev fixtures remain compatible.
A still-running migration/volume-preparation container also blocks launch/stop.
After launcher interruption, stop or await that owned task and establish its
outcome before removing the stale launcher lock; killing the CLI alone does not
prove a Docker one-shot task has stopped.
It drains application services and verifies the host browser port is free
before DDL; local dependency containers
remain independent. A root one-shot task initializes only the owned restore/export
volume roots. The migration task uses the existing schema/settings tools, binds
restore ownership, seeds absent settings and verifies them before application
startup. Local MinIO bucket creation is limited to the new owned local endpoint;
external buckets must already exist.
The ownership/release inventory is checked both before build/pull and immediately
afterward, before writing the pending receipt or draining services. A foreign
resource or leftover one-shot task appearing during a long image build must not
be authorized by the earlier snapshot. The port probe uses the published
`127.0.0.1` address and identifies the selected tier's `RIVET_<TIER>_PORT` setting.

The fingerprint includes the primary settings key; adding a previous decryption
key does not change it. Changing primary keys or connection credentials requires
explicit installation reconciliation, not a reset or silent adoption.

Local installs use offline migration only after owned application containers have
stopped; their database is private to this installation. External incompatible
migrations retain the SQL guard and require `--offline --confirm <project>` only
after the operator has stopped **all** consumers of that database, including
other hosts/orchestrators. Stopping this Compose project cannot prove that.
Kubernetes migrations retain their existing reader inventory guard.

Before DDL, the restore control's read-only ownership gate rejects foreign or
incomplete installation bindings. SQL advisory locks, schema verification and
restore writer leases remain unchanged. This prevents a wrong destination from
being altered before a later ownership check rejects it.
The migration task now holds the existing restore-coordinator advisory lock from
that read-only check through DDL and durable installation binding. Concurrent
first installs cannot both pass an empty-owner check. Any unfinished restore
must complete or be cancelled through its normal UI before upgrading; migration
does not recover, cancel or overwrite its journal. Serving verification stays
read-only and does not acquire that coordinator lock.
The deployment coordinator requires two connections: one holds the owner lease
while the other checks/binds state. Single-connection serving coordinators reject
this operation immediately instead of deadlocking their pool.

A write-ahead pending record survives uncertain migration/start acknowledgements.
Failures never automatically resume old images or roll back a possibly advanced
schema. If application startup/readiness fails, the launcher drains any partially
started new producers and keeps persistence running. The pending receipt remains;
no migration is replayed by this cleanup. Failed cleanup reports both the original
startup error and drain failure; it cannot claim admission was closed.
Repair forward with the same project, storage identity and immutable
manifest. Preserve private configuration and release evidence. A crashed launcher
that failed during its first startup can also recover with that matching pending
receipt; no successful release record is required until it becomes healthy.
Remove a crashed launcher's lock manually only after the old process is stopped.
Successful releases record their exact manifest; missing/contradictory evidence
blocks unidentified adoption. Do not use ad-hoc Docker/Helm rollback to bypass
these gates.

To stop an installation while preserving containers/volumes:

```bash
yarn studio-server:dev:local-storage -- --stop
yarn studio-server:prod:external-storage -- --stop --confirm rivet-prod-external
```

There is no data reset, volume delete, Docker prune, namespace delete or automatic
rollback in this launcher. Back up matching PostgreSQL, S3 contents and encryption
keys off-machine. Local MinIO/PostgreSQL is not managed cloud durability.
Shutdown drains application services before stopping local PostgreSQL/MinIO;
if the application stop fails, persistence is left running.

## Legacy backup restoration

Open Settings → Storage → Restore legacy backup. Docker and Kubernetes use the
same importer, table/object ownership checks, durable journal, database writer
fencing, consumer warmup and authenticated backend-supervisor restart.
The dedicated restore named volume survives container replacement. Serving
workers remain verify-only and do not need migration permissions.
This operation replaces only registered application data; it is not an automatic
migration from the old launcher. Original v1 legacy backups are supported, not
arbitrary SQLite/volume snapshots.

## Kubernetes remains optional

`studio-server:dev:kubernetes-test` provides the explicit local rehearsal.
`studio-server:kubernetes:release` retains the promoted-manifest Helm release
engine, chart profiles, reader guards, maintenance cutover and forward recovery.
It requires explicit context and does not change the current kubeconfig context.
The chart's single-machine profile can co-locate role containers in one application
pod; Docker has no pods. The external cluster may scale execution separately.
See [Kubernetes](./kubernetes.md) for placement, gateway, capacity and qualification.

## Verification

`container-server.test.mjs` covers all six configurations, private endpoints,
role parity, rejected stage sharing/foreign resources, fingerprint changes,
stop-before-migrate ordering and no automatic replay/resume on failure.
Managed serving-contract tests admit the same roles with/without Kubernetes while
rejecting filesystem/SQLite or serving migrations.
The repository-structure verifier guards the shipping managed entry point;
the legacy fixture transformer has an exact-output behavioral test. Launcher
tests read only their temporary dotenv/receipt artifacts, not implementation text.
Restore-control tests cover read-only ownership preflight.
Run focused API/schema/restore tests, Docker image builds and a real isolated
Docker UI restore/endpoint execution; retain Kubernetes contract/render verification.
External cloud provider qualification is separate from local PostgreSQL/MinIO.
Build shared Core/Node dependencies before the API suite, and do not rebuild or
clear their output directories concurrently with tests that import those outputs.
On Windows, process-tree cancellation checks need permission to terminate only
their own test descendants; sandbox denial is not equivalent to a passing check.

The destructive Docker check is explicitly opt-in and restricted to the disposable
`rivet-container-test` project with ownership/fingerprint checks. Start it using
`RIVET_ENV_FILE` pointing to a private fixture dotenv with `RIVET_DEV_COMPOSE_PROJECT=rivet-container-test`
and an unused `RIVET_DEV_PORT`, then run the normal headless UI runner with
`PLAYWRIGHT_LOCAL_DOCKER_RESTORE=1` and `local-docker-restore.spec.ts`.
It generates a real v1 archive inside Linux, restores through the UI, checks the
restored settings/project and invokes the published internal endpoint once after
read-only readiness probes. Never point this test at valuable data.

Regression coverage also includes ambient Compose isolation, atomic receipt-write
failure, linked-directory rejection, unexpected services, cross-stage/dev adoption,
and migration/restore coordination. The managed PostgreSQL fixture races two
first-install owners and verifies both foreign-owner and unfinished-restore
rejection before the migration callback runs.
Migration command generation is an explicit ordered list (local readiness/bucket
initialization, schema, settings import, settings verification), not a string
replacement that can silently omit a step when a script path changes.
Local PostgreSQL/MinIO and Docker results are compatibility evidence, not external
cloud-provider or promoted production rollout qualification. Those require
immutable release evidence and dedicated external connections.

Adjacent-failure tests inject partial readiness failure and cleanup failure,
interrupt dotenv publication, reject linked state reads, and exercise a real
loopback port collision. `RIVET_CONTAINER_LIFECYCLE_CHECK=1` opts into the isolated
`rivet-container-test` Docker lifecycle test: it starts real services, injects a
lost readiness acknowledgement, proves producers stop while stores remain alive,
then explicitly recovers forward. It is skipped in ordinary unit lanes and must
never target valuable data; use the same private fixture `RIVET_ENV_FILE` as the
UI restore check. This test leaves that disposable installation running for the
subsequent headless restore check; stop it afterward with the normal launcher.

Mocked restore-panel browser scenarios use the same access-key sign-in helper
as live checks, so they work behind the managed proxy gate as well as a static
test server. Image-contract checks cover the managed `serve` entry point, all
six launch commands and explicit rejection of retired production aliases.

With that explicit opt-in and private dotenv selected, run the lifecycle fixture
using `yarn node --test --test-name-pattern="real Docker partial startup" deploy/studio-server/scripts/container-server.test.mjs`.
