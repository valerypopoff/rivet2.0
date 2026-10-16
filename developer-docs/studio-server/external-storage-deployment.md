# External PostgreSQL/S3 deployment handoff

Use the [commented values example](../../deploy/studio-server/examples/external-storage.values.example.yaml)
with `yarn studio-server:kubernetes:release --values`. It is a complete environment
overlay, not a replacement for chart defaults or the production overlay. The helper
applies those defaults first and promoted manifest values last. Namespace-local
Kubernetes Secrets hold credentials; Vault is explicitly disabled. No cloud database,
bucket, public gateway or TLS certificate is provisioned.

Shared chart/production/test policy contains no installation endpoints, buckets,
database identities or Secret names. Vault is opt-in, not implicitly enabled by
production. The example intentionally leaves bucket and region empty so copying
it without filling them in fails preflight. An empty endpoint selects AWS regional
discovery only with an explicit region; GCS and other compatible providers set
their own HTTPS endpoint. Secret names in the example are suggestions, not chart
defaults. On upgrade retain the existing installation's names and keys rather
than creating the suggested new ones. See [configuration ownership](./kubernetes.md#configuration-ownership).

## Prerequisites

- Node/Yarn, kubectl access to the selected context, and Helm (or
  `yarn studio-server:setup:k8s-tools` for the pinned tool bootstrap).
- Docker and registry access to the production manifest promoted by Build Images
  CI, and a clean tracked checkout at its exact `source.sha`. The default command
  retrieves it automatically and reports the required commit when different.
  An explicit `--manifest` pin bypasses retrieval. Do not invent manifests
  or image tags. Manifest and values paths must be inside that checkout; ignored
  `artifacts/deployment/` is suitable.
- An existing installation-owned PostgreSQL database with migration/runtime
  privileges, provider TLS, and cluster network access. URL-encode reserved
  characters in username/password components.
  The migration account also needs `CREATE` on that database: legacy restore
  initializes the separate `rivet_restore_control` schema during the migration
  hook. Existing permissions on `public` tables alone are insufficient. Before
  a maintenance cutover, check
  `SELECT has_database_privilege(current_user, current_database(), 'CREATE');`
  through the intended database connection. If it is false, the database owner
  must grant that privilege only on the installation-owned database. Do not make
  the serving account an instance administrator or reset shared credentials.
- An existing private bucket, actual region/endpoint, and scoped object
  read/write/list/delete credentials. Prefer a dedicated bucket: workflow and
  fixed `runtime-libraries/` roots must not be shared across installations.
- Dynamic PVC provisioning for restore scratch; set `legacyRestore.storageClassName`
  if there is no default class. Size for upload, extraction and import scratch.
  Check the selected class's disk type and provider quota before taking serving
  workloads offline. On GKE, a `pd-balanced` class can consume the regional SSD
  quota even when its name contains `standard`. An existing `pd-standard` class
  is an alternative for restore scratch when that separate quota has capacity,
  with slower upload/extraction I/O; workflow and settings storage remain remote.
  Never delete unrelated disks to make room. Changing an immutable class on a
  newly created claim requires a guarded retry; replace only a verified unbound,
  empty installation-owned claim after the previous runner has stopped, using
  resource identity/version preconditions. Preserve bound claims and cutover
  recovery evidence.
- Metrics-server if execution autoscaling remains enabled. Set database capacity
  to actual provider limits and tune pools/replica bounds together.
- The [external gateway contract](./kubernetes.md#external-gateway-contract), TLS,
  UI session gate and service-isolating NetworkPolicies. Ordinary Ingress path
  routing alone is insufficient; verify the contract before public exposure.

## First deployment commands (Bash, Linux/macOS)

Run from the repository root. This is for a **new installation**. `kubectl create`
deliberately fails instead of overwriting existing Secrets. For upgrades reuse
the namespace, Secret names and original keys; do not rerun key generation.

Copy/edit the example without changing tracked source files. The initial dry-run
retrieves the promoted production manifest; if it reports a different source
commit, check out that commit and repeat before creating any Secrets:

```bash
set -euo pipefail
CONTEXT='REPLACE_WITH_KUBECONFIG_CONTEXT'
NAMESPACE='rivet'
RELEASE='rivet'
VALUES='artifacts/deployment/environment-values.yaml'

mkdir -p artifacts/deployment
cp deploy/studio-server/examples/external-storage.values.example.yaml "$VALUES"
# Edit "$VALUES": bucket, region, endpoint/path style, StorageClass, DB capacity.
kubectl --context "$CONTEXT" cluster-info

# Render/validation only: no cluster writes or provider connectivity test.
yarn studio-server:kubernetes:release -- \
  --context "$CONTEXT" --namespace "$NAMESPACE" --release "$RELEASE" \
  --values "$VALUES" --dry-run
```

The dry-run retains the validated manifest and immutable artifact identity under
`artifacts/kubernetes-production-release/$RELEASE/`. Pin that saved manifest in
the actual deployment below so a promotion between preflight and install cannot
select a different release. This pin avoids another registry request. If the
production pointer does not exist yet, CI must promote a release first; the
launcher never invents or falls back to an unverified release.

Create credentials without putting them in shell history, command arguments or
values. Files are private and have no trailing newline. Save both generated Rivet
keys in your secret manager **before** closing this shell. Protect Kubernetes
Secrets with RBAC/encryption at rest; base64 is not encryption. Do not use `set -x`.

```bash
umask 077
SECRET_DIR="$(mktemp -d)"
trap 'rm -f "$SECRET_DIR/RIVET_KEY" "$SECRET_DIR/encryptionKey" "$SECRET_DIR/connectionString" "$SECRET_DIR/accessKeyId" "$SECRET_DIR/secretAccessKey"; rmdir "$SECRET_DIR"' EXIT

# FIRST INSTALL ONLY. Securely back up these keys before closing the shell.
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIR/RIVET_KEY"
openssl rand -hex 32 | tr -d '\n' > "$SECRET_DIR/encryptionKey"

read -r -s -p 'PostgreSQL URL (password URL-encoded): ' INPUT; printf '\n'
printf '%s' "$INPUT" > "$SECRET_DIR/connectionString"; unset INPUT
read -r -s -p 'S3 access key ID: ' INPUT; printf '\n'
printf '%s' "$INPUT" > "$SECRET_DIR/accessKeyId"; unset INPUT
read -r -s -p 'S3 secret access key: ' INPUT; printf '\n'
printf '%s' "$INPUT" > "$SECRET_DIR/secretAccessKey"; unset INPUT

# Before continuing, securely save both generated keys in your secret manager.
# Do not wait until after deployment: a failed command can close this shell.
kubectl --context "$CONTEXT" create namespace "$NAMESPACE"
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic rivet-auth \
  --from-file=RIVET_KEY="$SECRET_DIR/RIVET_KEY"
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic rivet-postgres-connection \
  --from-file=connectionString="$SECRET_DIR/connectionString"
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic rivet-object-storage \
  --from-file=accessKeyId="$SECRET_DIR/accessKeyId" \
  --from-file=secretAccessKey="$SECRET_DIR/secretAccessKey"
kubectl --context "$CONTEXT" --namespace "$NAMESPACE" create secret generic rivet-settings-encryption \
  --from-file=encryptionKey="$SECRET_DIR/encryptionKey"

# The external gateway also needs RIVET_KEY for its trusted authentication gate.
# Never expose it or its derived proxy-auth credential to browsers.
```

If namespace creation reports an existing namespace, verify ownership, then omit
only that creation command. If a Secret exists, stop and recover original key
material; do not delete/overwrite it. Partial setup is not a reason to regenerate
keys already accepted by Kubernetes.

Deploy, then inspect release-scoped workloads and restore PVC:

```bash
yarn studio-server:kubernetes:release -- \
  --context "$CONTEXT" --namespace "$NAMESPACE" --release "$RELEASE" \
  --manifest "artifacts/kubernetes-production-release/$RELEASE/release-manifest.json" \
  --values "$VALUES" --confirm "$RELEASE"

kubectl --context "$CONTEXT" --namespace "$NAMESPACE" get pods,services,jobs,pvc \
  -l "app.kubernetes.io/instance=$RELEASE"
```

The helper migrates the schema and waits for workloads (default timeout: 15 minutes).
Repair migration failures forward, not with blind `helm rollback`. Incompatible-reader
upgrades may need the documented maintenance cutover instead of this first-install
command. Preserve failure artifacts under `artifacts/kubernetes-production-release/<release>/`.

After gateway/readiness verification, sign in with retained `RIVET_KEY` and use
**Settings -> Storage -> Restore legacy backup**. An encrypted backup without
its key requires the **source** key during restore; a new destination key cannot
decrypt old credentials by itself. The dedicated settings key is optional in the
application, but this example explicitly references it, so its Secret is required.

## Verification scope

The example is outside `helm/`, so adding it does not change the chart content
digest. Validate the merged example with Helm lint/template and production release
values. Rendering proves chart compatibility, not provider permissions, actual
cluster/gateway readiness or successful backup restore; those need live checks.
