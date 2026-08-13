# Kubernetes

This repo supports one Kubernetes topology today:

- `proxy`: scalable
- `web`: fixed at `1` in the current endpoint-heavy recommended shape
- `backend`: singleton
- `execution`: scalable

That split is intentional. The singleton `backend` owns:

- `/api/*`
- `/ui-auth`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}`
- `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}`
- `/ws/latest-debugger`

The `execution` Deployment owns:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}`
- `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}`
- `/internal/workflows/:endpointName`

Do not scale `backend` horizontally in the current chart shape. Latest workflow execution, latest web-app action execution, and `/ws/latest-debugger` are still process-local control-plane features.

## Scaling model

Scaling in this chart is per Deployment or StatefulSet, not in fixed pod pairs.

- a new `execution` pod is only another execution-plane API pod
- a new `proxy` pod is only another nginx proxy pod
- a new `web` pod is only another dashboard shell pod
- the `backend` StatefulSet stays at one pod because the current control-plane and latest-debugger behavior is still process-local

That means rising endpoint demand should usually add `execution` pods first. `proxy` should stay redundant and may also scale, but it does not need to grow one-for-one with `execution`.

Recommended operator mental model:

- scale `execution` for workflow endpoint throughput
- keep `proxy` redundant so ingress and websocket termination do not become a single bottleneck
- keep `web=1` when the dashboard is only used by one operator and temporary UI hiccups are acceptable
- keep `backend=1` until the process-local control-plane constraints are removed architecturally

Typical endpoint-heavy production shape:

- `proxy`: `2` to `5`
- `execution`: `2` to `10`
- `web`: `1`
- `backend`: `1`

Do not treat that as a forced ratio. `execution=8` with `proxy=2` can be correct. The tiers scale independently.

## Autoscaling prerequisites

The current HPAs are CPU-based:

- `proxy` HPA targets the `proxy` Deployment
- `execution` HPA targets the `execution` Deployment

Before relying on those HPAs in production, set real CPU and memory requests in the chart values for at least:

- `resources.proxy`
- `resources.execution`

Without CPU requests, CPU-utilization HPA behavior is not trustworthy. The chart shape is ready for autoscaling, but operators should treat resource sizing as a required part of the production handoff.

## Local rehearsal

Use the local Kubernetes launcher when you want the closest practical browser-level rehearsal of the real chart:

```bash
npm run dev:kubernetes-test
```

If Helm is not already on PATH, install the pinned cached copy first:

```bash
npm run setup:k8s-tools
```

Current behavior:

- builds local `proxy`, `web`, `api`, and `executor` images
- deploys the real Helm chart into a dedicated namespace
- uses the explicit `RIVET_K8S_CONTEXT` when set
- otherwise uses the current `kubectl` context when one exists
- otherwise falls back to the `minikube` context automatically when the Minikube CLI is installed
- keeps `backend=1`
- keeps `web=1`
- scales `proxy` and `execution`
- port-forwards the proxy service for local browser access
- on Docker Desktop, imports freshly built images into the cluster node containers
- on Minikube, loads freshly built images with `minikube image load --daemon=true`
- on Minikube-backed `dev`, `up`, and `recreate`, starts the target Minikube profile automatically when needed

The launcher expects:

- external managed Postgres
- external S3 or S3-compatible storage
- local renderer inputs named `RIVET_K8S_DATABASE_*` and `RIVET_K8S_STORAGE_*`

For local rehearsal, the launcher also creates a namespace-scoped app-data PVC and wires the chart to it with `storage.appData.existingClaimName`. The defaults are `RIVET_K8S_APP_DATA_CLAIM_NAME=rivet-local-app-data` and `RIVET_K8S_APP_DATA_SIZE=10Gi`; override them only when you need a different local claim name or storage request.

The local overlay at [charts/overlays/local-kubernetes.yaml](../charts/overlays/local-kubernetes.yaml) is not a standalone values file. It is meant to be merged with the generated values file from `scripts/dev-kubernetes.mjs`.

Managed runtime-library startup now serializes its shared Postgres schema initialization behind a PostgreSQL advisory lock. That avoids first-boot deadlocks when the control-plane API and execution/editor processes start against the same managed database at the same time.

Useful commands:

- `npm run dev:kubernetes-test:config`
- `npm run dev:kubernetes-test:ps`
- `npm run dev:kubernetes-test:logs`
- `npm run dev:kubernetes-test:down`

Useful Minikube-specific overrides:

- `RIVET_K8S_CONTEXT=minikube`
- `RIVET_K8S_CLUSTER_PROVIDER=minikube`
- `RIVET_K8S_MINIKUBE_PROFILE=minikube`
- `RIVET_K8S_MINIKUBE_BIN=/path/to/minikube`

Helm resolution order for the local launcher and `npm run verify:kubernetes` is:

1. `RIVET_K8S_HELM_BIN`
2. system `helm`
3. cached Helm under `.data/tools/helm/`

If none of those exist, the launcher/verification flow fails with an explicit instruction to run `npm run setup:k8s-tools`.

## DevOps handoff map

This repo is already shaped like a Kubernetes application, but it is not the single-container sample chart shape. Treat it as a custom four-workload app:

| DevOps expectation | This repo |
|---|---|
| Root `image/` directory | Present. It contains four runtime images: `image/proxy/Dockerfile`, `image/web/Dockerfile`, `image/api/Dockerfile`, and `image/executor/Dockerfile`. |
| Application user `uid/gid=10001` | Present. Runtime images and chart security contexts run workloads as `10001:10001`. |
| Environment overlays | Present under [charts/overlays](../charts/overlays). If your GitLab template requires `deploy/overlays`, point that wrapper at these values or copy environment overrides from here; do not replace the custom chart with a generic single-service chart. |
| Helm chart | Present under [charts](../charts). It renders `proxy`, `web`, singleton `backend`, scalable `execution`, services, ingress, HPAs, Vault annotations, and validation guards. |
| CI image build | Current publishing is GitHub Actions at [.github/workflows/build-images.yml](../.github/workflows/build-images.yml). If deploying from GitLab CI, create equivalent jobs for all four Dockerfiles or reuse the published GHCR images. |
| Vault AppRole | The chart uses Vault Injector annotations through `vault.role`, `vault.authPath`, `vault.secretPath`, and `vault.dotenvTemplate`. The containers source `/vault/dotenv` during startup. |

Do not deploy this app with a generic one-Deployment chart unless that chart can faithfully express the four workload roles and their routing:

- public browser traffic enters `proxy`
- dashboard/editor assets come from `web`
- `/api/*`, latest workflow execution, and `/ws/latest-debugger` go to singleton `backend`
- published workflow endpoint traffic goes to scalable `execution`
- the internal editor Node executor websocket goes to the executor sidecar in the singleton `backend`

If company delivery requires a root `.gitlab-ci.yml`, treat the current GitHub workflow as the image-publish reference and the Helm values in this document as the deploy reference. The GitLab pipeline must either:

- reuse the published GHCR images and only run Helm deploy stages, or
- build and push four images, one per Dockerfile, then pass the resulting repositories and one shared tag through `images.*`

Environment-specific Vault AppRoles from CI should line up with the chart values:

- CI/deploy credentials belong in the GitLab pipeline template
- the pod runtime Vault role belongs in `vault.role`
- the Vault auth mount, when not default, belongs in `vault.authPath`
- the secret rendered into `/vault/dotenv` belongs in `vault.secretPath`

Do not use `vault.roleIdSecretName`; that value is retired and the chart rejects it during render.

## Cluster prerequisites

Have these ready before the first `helm upgrade --install`:

- a `linux/amd64` node pool, unless the API and executor images are rebuilt for another platform
- an ingress controller that supports websocket upgrades and long-lived websocket connections
- DNS for the public Rivet hostname and a TLS secret or certificate-manager integration
- a pre-created app-data PVC set as `storage.appData.existingClaimName`; use RWX-capable storage for multi-node or scaled proxy/execution deployments
- managed Postgres reachable from the cluster
- S3 or S3-compatible object storage reachable from the cluster
- Vault Injector installed when `vault.enabled=true`
- `metrics-server` or equivalent resource metrics if the CPU HPAs are enabled
- GHCR image-pull access, either anonymous for public images or `imagePullSecrets` for private packages

The pods need outbound network access to Postgres, object storage, Vault, and GHCR during image pulls. The proxy also needs in-cluster DNS resolution through `env.RIVET_PROXY_RESOLVER`; the default value is `kube-dns.kube-system.svc.cluster.local`.

## Production handoff

The production starting point is [charts/overlays/prod.yaml](../charts/overlays/prod.yaml).

Before DevOps installs it, they must replace or confirm:

- `images.*.repository` and `images.*.tag`
- `clusterDomain` if the cluster does not use `cluster.local`
- ingress hostnames and DNS annotations
- Vault role, secret path, and dotenv template if Vault is used
- managed Postgres secret wiring
- object-storage bucket, region, endpoint, and secret wiring
- `auth.keySecretName` or equivalent Vault-provided `RIVET_KEY`

The chart defaults deliberately use `example.invalid/...` image repositories and the templates fail validation until those placeholders are replaced. This keeps production installs from silently using stale or accidental images.

The Rivet 2 wrapper image pipeline publishes the default GitHub Container Registry repositories as:

```yaml
images:
  proxy:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/proxy
    tag: latest
  web:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/web
    tag: latest
  api:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/api
    tag: latest
  executor:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/executor
    tag: latest
```

The `latest` tag is produced from pushes to `main-rivet2`; commit SHA and tag-derived image tags are also produced by the same workflow. The image workflow resolves the configured upstream Rivet ref to an exact commit before the Rivet-consuming image builds and labels the resulting images with that Rivet source, ref, and revision. All four images first publish under a deterministic wrapper-commit plus Rivet-commit staging tag; public tags are promoted only after the complete image matrix succeeds. Runs for the same Git ref are serialized so overlapping pushes cannot race an older image set back onto `latest`.
For production, prefer pinning all four image tags to the same published commit SHA or release tag instead of leaving them on `latest`.
If the GHCR packages are private, configure `imagePullSecrets`; public packages should pull anonymously.

Current published image platforms:

- `proxy` and `web`: `linux/amd64` and `linux/arm64`
- `api` and `executor`: `linux/amd64`

Run the production chart on `linux/amd64` nodes unless the API and executor images are rebuilt for another platform.

### Environment values skeleton

Use this as the shape for an environment override file, whether your pipeline stores it as `charts/overlays/prod.yaml`, `charts/overlays/test.yaml`, or a company-standard `deploy/overlays/<env>.yaml` wrapper:

```yaml
fullnameOverride: rivet

imagePullSecrets:
  # Required only when the GHCR packages are private.
  # - name: ghcr-pull-secret

images:
  proxy:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/proxy
    tag: <published-tag>
  web:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/web
    tag: <published-tag>
  api:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/api
    tag: <published-tag>
  executor:
    repository: ghcr.io/valerypopoff/cloud-hosted-rivet2-wrapper/executor
    tag: <published-tag>

ingress:
  enabled: true
  className: <ingress-class>
  host: <rivet-hostname>
  externalDNSHostname: <rivet-hostname>
  tlsSecretName: <tls-secret-name>
  annotations:
    # Use the equivalent long-timeout/websocket annotations for the target ingress controller.
    nginx.ingress.kubernetes.io/proxy-body-size: 100m
    nginx.ingress.kubernetes.io/proxy-read-timeout: "86400"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "86400"

vault:
  enabled: true
  role: <vault-approle-name>
  authPath: <vault-auth-path>
  secretPath: <vault-secret-data-path>
  tlsSkipVerify: false
  caSecretName: <vault-ca-secret>
  caCertPath: /vault/tls/ca.crt
  dotenvFileName: dotenv
  dotenvTemplate: |
    {{- with secret "<vault-secret-data-path>" -}}
    {{- range $key, $value := .Data.data }}
    {{ $key }}={{ $value | toJSON }}
    {{- end }}
    {{- end }}

postgres:
  mode: managed
  host: <postgres-host>
  port: 5432
  database: <postgres-database>
  username: <postgres-username>
  sslMode: require
  # If Vault is disabled, also set passwordSecretName/passwordSecretKey

objectStorage:
  endpoint: <s3-or-compatible-endpoint>
  bucket: <bucket-name>
  region: <bucket-region>
  prefix: workflows/
  forcePathStyle: false
  # If Vault is disabled, also set accessKeySecretName and secretKeySecretName

auth:
  # If Vault is disabled, set keySecretName/keySecretKey.
  # If Vault is enabled, /vault/dotenv may provide RIVET_KEY instead.
  keySecretName: ""

storage:
  appData:
    enabled: true
    size: 20Gi
    storageClassName: <storage-class>

resources:
  proxy:
    requests:
      cpu: <value>
      memory: <value>
    limits:
      cpu: <value>
      memory: <value>
  execution:
    requests:
      cpu: <value>
      memory: <value>
    limits:
      cpu: <value>
      memory: <value>
```

The sample `service.type: NodePort` / single `service.targetPort` pattern from simple apps does not apply here. This chart creates component services internally, keeps them as `ClusterIP`, and routes ingress to the `proxy` service.

`nginx.ingress.kubernetes.io/proxy-body-size` is the ingress-side ceiling. If App Settings -> `Web apps` -> `Button data` is set above `100 MiB`, raise this annotation to the same or a larger value too; the running app can reload its own proxy configuration but cannot rewrite an ingress controller's annotations.

If you are adapting a standard single-app overlay, do not expect these sample keys to do anything until the chart explicitly supports them:

- `metrics`
- `writableDirs`
- `sidecar`
- `probes`
- `strategy`
- `topologySpreadConstraints`
- `pdb`
- single-service `hpa`

Use this chart's existing `autoscaling.proxy`, `autoscaling.execution`, `resources.*`, `ingress`, `vault`, and component `service.*` values instead. Add new chart support intentionally if the cluster standard requires one of the unsupported knobs.

### Persistence and storage

LLM Profile circuit-breaker health is part of managed operational state. Every backend and execution replica uses the shared `llm_profile_health` Postgres table; do not replace it with pod-local memory, a browser snapshot, or SQLite in a multi-replica cluster. The table stores the exact project id for efficient project-scoped listing and atomic reset, plus the serialized state used by row-locked begin/finish/renew transitions. Transitions and reset operations also share a project-scoped PostgreSQL advisory lock, which closes the new-row race between a project reset and a transition whose placeholder has not stored its project id yet.

The backend's hosted executor sidecar calls the loopback `/api/workflows/llm-profile-health` route and authenticates with the existing `RIVET_KEY`-derived proxy token. Published and latest endpoint runs plus HTTP/WebSocket web-app actions are injected directly with the managed store. No additional public Service or Ingress route is required for executor coordination.

Half-open ownership is a renewable lease. Postgres time is authoritative across replicas; renewals are monotonic, a successful probe invalidates permits from the pre-open health generation, and a stale finish after a project reset is a no-op. These guarantees depend on all replicas using the same Postgres database and applying the managed schema before serving traffic.

In Kubernetes, production should stay on managed storage:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- workflow metadata, publication state, recording metadata, resumable web-app action state, and runtime-library state live in managed Postgres
- workflow blobs, recording/replay blobs, and runtime-library artifacts live in object storage

The chart requires `storage.appData.existingClaimName`. This PVC is the shared app-settings volume for the backend, proxy, execution, and executor pods. Use RWX-capable storage for multi-node or scaled proxy/execution deployments; a generated backend-only StatefulSet claim is not enough because Deployments cannot mount that private claim.

The API and executor containers deliberately mount that same `app-data` volume at different paths: `/data/rivet-app` for the API and `/home/rivet/.local/share/com.valerypopoff.rivet2` for the executor. The proxy mounts the same claim read-only at `/data/rivet-app` so it can hot-reload public route, timeout, trusted-host, and web-app body-limit settings. App Settings -> `Storage` writes `settings/deployment-storage.json` from the API; App Settings -> `Run recordings` writes `settings/run-recordings.json` from the API; App Settings -> `General` -> `Trusted hosts` writes `settings/trusted-hosts.json` from the API; App Settings -> `Node executor proxy` writes `settings/node-executor-proxy.json` and `settings/executor-url-overrides.json` from the API; App Settings -> `Workflow endpoints` -> `Routes` and App Settings -> `Web apps` -> `Routes` both write `settings/public-routes.json` from the API; App Settings -> `Workflow endpoints` -> `Access control` writes `settings/workflow-endpoint-auth.json` from the API; App Settings -> `Web apps` -> `Auth`, App Settings -> `OAuth`, and App Settings -> `Server UI access` write `settings/web-app-auth.json` from the API; App Settings -> `Workflow endpoints` -> `HTTP request timeout` and App Settings -> `Web apps` -> `Button data` write `settings/runtime-limits.json`. API and executor startup read deployment storage settings from app data; runtime storage/database env values are ignored, and Kubernetes uses only the init container's `RIVET_DEPLOYMENT_*` bootstrap values when the settings file is absent. API bootstrap also clears process proxy env first and then reads the proxy settings file through `RIVET_APP_DATA_ROOT` for latest/headless execution paths that run in that process, while the editor executor bootstrap reads the same relative file from the desktop-style app-data mount. Hosted executor/default-debugger websocket URL overrides are read through `/api/config`; blank override settings keep the normal public-host-derived websocket URLs. Keep this claim persistent if operators use UI-managed storage, recording limits, public route slugs, trusted hosts, workflow endpoint auth, web-app auth, runtime limits, websocket overrides, or executor proxy settings.

Published workflow endpoints and published web apps in the split `execution` deployment also consume this settings volume for UI-managed storage credentials, recording limits, workflow endpoint auth, web-app auth, runtime limits, and proxy values. Storage/database settings are read from `settings/deployment-storage.json` at process startup, while recording queue/retention limits, workflow endpoint bearer-token auth, trusted host bypasses, web-app auth/OAuth settings, runtime endpoint proxy values, workflow HTTP timeout settings, and web-app button-data limits are not read from `.env`, Vault dotenv, or deployment `RIVET_RECORDINGS_MAX_*` / `RIVET_REQUIRE_WORKFLOW_KEY` / `RIVET_UI_TOKEN_FREE_HOSTS` / `RIVET_WEB_APPS_AUTH_MODE` / `OAUTH_*` / `RIVET_SERVER_UI_OAUTH_*` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / timeout variables. Server UI auth has one bootstrap env knob: `RIVET_SERVER_UI_AUTH_MODE` selects `none`, `key`, or `oauth`; OAuth provider settings and server UI admin emails still come from `settings/web-app-auth.json` on the shared app-data claim, but the UI shows provider/session controls in `Settings` -> `OAuth` and admin emails in `Settings` -> `Server UI access`. Bootstrap a fresh deployment with `none` or `key`, save the shared OAuth settings and admin allowlist from the UI, then switch `RIVET_SERVER_UI_AUTH_MODE=oauth` and roll out the API. Storage/database changes require pod restart or rollout so process singleton backends are rebuilt. Public route slugs are read by the API dynamically from `settings/public-routes.json`; the proxy hot-reloads its nginx public-route, trusted-host, timeout, and per-web-app-action body-limit config from the same app-data claim. The Docker startup wait timeout stored in the same runtime-limits settings file is intentionally ignored by Kubernetes; it only affects npm Docker launcher commands.

The managed schema also stores short-lived web-app action runs, sequenced replay/progress events, and cross-pod cancellation commands. Every API pod receives `RIVET_RUNNER_SLOT_ID` from its Kubernetes pod name. The gateway keeps the graph processor on that owning pod, renews its database lease while it is running, and uses Postgres notifications plus polling to deliver durable events/cancellation across pods. A browser reconnect can therefore land on another API pod and resume the same authorized action; a crashed or drained owner eventually emits an explicit interrupted terminal event. The database run ledger is intentionally short-lived (terminal rows are pruned after 24 hours) and separate from the long-term Run recordings artifacts. WebSocket action message limits are captured when the API process starts, so roll out API pods after raising or lowering `Settings` -> `Web apps` -> `Button data`.

Runtime-library local files are caches/workspaces, not the source of truth in managed mode. The default is `emptyDir` for execution replicas. Only set `runtimeLibraries.cache.existingClaimName` if the PVC can be mounted by every pod that needs it; with more than one `execution` replica, that usually means an RWX-capable volume. A single RWO claim reused by multiple execution pods can leave pods stuck waiting for volume attachment.

`tmpVolume` is an `emptyDir` mounted at `/var/tmp` with a default `2Gi` size limit. Increase `tmpVolume.sizeLimit` if workflows write larger temporary files; do not use the unsupported generic `writableDirs` overlay key.

### Ingress and public routes

Ingress should route all public traffic to the chart's `proxy` service. The proxy then routes internally:

| Public path | Internal target |
|---|---|
| `/` | `web` |
| `/api/*` and `/ui-auth` | singleton `backend` API |
| `/workflows/*` | scalable `execution` API |
| `/workflows-latest/*` | singleton `backend` API |
| `/apps/*` | scalable `execution` API |
| `/apps-latest/*` | singleton `backend` API |
| `/apps/*/actions/ws` | scalable `execution` API websocket |
| `/apps-latest/*/actions/ws` | singleton `backend` API websocket |
| `/ws/latest-debugger` | singleton `backend` API websocket |
| `/ws/executor/internal` and `/ws/executor` | executor container in the singleton `backend` StatefulSet |

Keep ingress body-size limits high enough for project import/export and keep websocket timeouts long. The tracked nginx overlay examples use `100m` body size and `86400` second read/send timeouts. For non-nginx ingress controllers, translate those annotations to the controller-specific equivalents.

Do not route `/workflows` directly to `execution` from the external ingress. External traffic should still enter through `proxy`, because the proxy injects the trusted `X-Rivet-Proxy-Auth` header and handles the optional UI/public workflow auth policies consistently.

### Health checks and probes

The chart already defines Kubernetes liveness and readiness probes. They are part of the chart templates today, not environment-overlay values.

| Workload | Container | Probe shape |
|---|---|---|
| `backend` StatefulSet | `api` | HTTP `GET /healthz` on the API port |
| `backend` StatefulSet | `executor` | TCP probe on executor port `21889` |
| `execution` Deployment | `api` | HTTP `GET /healthz` on the execution API port |
| `proxy` Deployment | `proxy` | TCP probe on proxy HTTP port |
| `web` Deployment | `web` | HTTP `GET /` on the static web server port |

The API server exposes `GET /healthz`. It starts listening only after startup reconciliation and workflow storage initialization finish, so the endpoint is a lightweight process-ready check rather than a deep Postgres/S3 transaction on every probe.

The app does not currently expose `/health`, `/readyz`, `/livez`, or `/up` aliases. If the target platform requires one of those conventional paths, add the aliases deliberately in the API/proxy/web runtimes and update the chart probes at the same time. Do not assume a generic overlay key named `probes` will change this chart; that key is not currently wired.

No `startupProbe` is currently defined. If cold production startup needs a longer grace period than the current liveness/readiness delays, add explicit chart support rather than relying on unsupported environment overlay fields.

### Vault dotenv contract

Runtime images source `/vault/dotenv` at startup and also accept the Vault Injector default fallback path `/vault/secrets/<dotenvFileName>`. API and executor workloads receive the configured full dotenv; the proxy's chart-owned template writes only `RIVET_KEY` to that path.

When Vault is enabled, the dotenv file should provide the sensitive values that should not live directly in Helm values:

```dotenv
RIVET_KEY=<shared-random-secret>
RIVET_DEPLOYMENT_DATABASE_PASSWORD=<postgres-password>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID=<object-storage-access-key-id>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY=<object-storage-secret-access-key>
# Arbitrary provider aliases used by LLM Chat/Profile are supported too:
BILLING_OPENAI_KEY=<provider-api-key>
```

You may provide `RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING` instead of `RIVET_DEPLOYMENT_DATABASE_PASSWORD`, but keep the non-secret `postgres.host`, `postgres.database`, and `postgres.username` values in the Helm values because chart validation uses them to catch incomplete managed-storage configuration. The chart bootstrap writes these values into `settings/deployment-storage.json` when that file is absent; API and executor runtime containers read the settings file rather than the dotenv variables.

Vault dotenv injection is the preferred place for production LLM/provider credentials. The full injected file is sourced only by backend API, execution API, and editor executor workloads, so custom credential names do not require a fixed chart template list. The proxy receives a generated one-variable dotenv containing only `RIVET_KEY`; it does not receive provider credentials. Non-secret development values may use `env`, which is likewise projected into execution workloads while the proxy receives only its route/resolver settings. Do not commit provider keys in Helm values. Browser access remains separately restricted by `RIVET_ENV_ALLOWLIST`; server-side availability never makes a secret browser-readable.

`RIVET_KEY` must be available to both the proxy and API workloads. It is used for trusted proxy-to-API identity and for optional public route/UI access checks.

If Vault is disabled, create Kubernetes secrets that match the chart values. For example:

```bash
kubectl -n your-namespace create secret generic rivet-shared-key \
  --from-literal=RIVET_KEY='<shared-random-secret>'

kubectl -n your-namespace create secret generic rivet-postgres \
  --from-literal=password='<postgres-password>'

kubectl -n your-namespace create secret generic rivet-object-storage \
  --from-literal=accessKeyId='<object-storage-access-key-id>' \
  --from-literal=secretAccessKey='<object-storage-secret-access-key>'
```

Then set:

```yaml
vault:
  enabled: false

auth:
  keySecretName: rivet-shared-key
  keySecretKey: RIVET_KEY

postgres:
  passwordSecretName: rivet-postgres
  passwordSecretKey: password

objectStorage:
  accessKeySecretName: rivet-object-storage
  accessKeySecretKey: accessKeyId
  secretKeySecretName: rivet-object-storage
  secretKeySecretKey: secretAccessKey
```

Use `postgres.connectionStringSecretName` instead of the host/database/username/password tuple only if your operations standard prefers a single connection-string secret.

Create or reference the shared app-data PVC before installing the chart. The claim name must match `storage.appData.existingClaimName` and must be mountable by backend, proxy, execution, and executor pods:

```bash
kubectl -n your-namespace apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: rivet-app-data
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 20Gi
  storageClassName: <rwx-storage-class>
EOF
```

Then set:

```yaml
storage:
  appData:
    existingClaimName: rivet-app-data
```

### Direct Helm commands

Use these commands as the raw Helm equivalent of a CI deploy step:

```bash
helm lint ./charts \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml

helm template rivet ./charts \
  --namespace your-namespace \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml

helm upgrade --install rivet ./charts \
  --namespace your-namespace \
  --create-namespace \
  -f charts/overlays/prod.yaml \
  -f path/to/environment-values.yaml
```

With release name `rivet`, the default Kubernetes object names are prefixed as `rivet-rivet-*` because the chart name is also `rivet`. Set `fullnameOverride: rivet` in the environment values if the desired object prefix is just `rivet-*`.

### First deploy checks

After install or upgrade, check the rollout from the cluster side before opening the browser:

```bash
kubectl -n your-namespace get pods,svc,ingress
kubectl -n your-namespace rollout status deployment/rivet-proxy
kubectl -n your-namespace rollout status deployment/rivet-web
kubectl -n your-namespace rollout status deployment/rivet-execution
kubectl -n your-namespace rollout status statefulset/rivet-backend
```

Then port-forward the proxy service and verify the proxy-facing routes:

```bash
kubectl -n your-namespace port-forward svc/rivet-proxy 8080:80
curl -i http://127.0.0.1:8080/
```

If server UI auth is disabled with `env.RIVET_SERVER_UI_AUTH_MODE: "none"` or the forwarded host is listed in `Settings` -> `General` -> `Trusted hosts`, `/api/config` should be reachable through the proxy directly:

```bash
curl -i http://127.0.0.1:8080/api/config
```

If server UI auth is in key mode for the forwarded host, authenticate first and reuse the cookie:

```bash
curl -i -c rivet-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"key":"<RIVET_KEY>"}' \
  http://127.0.0.1:8080/__rivet_auth

curl -i -b rivet-cookies.txt http://127.0.0.1:8080/api/config
```

If server UI auth should use OAuth, do not provide retired `RIVET_SERVER_UI_OAUTH_*` env values. Instead:

1. First deploy with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`.
2. Open `Settings` -> `OAuth` and save the shared OAuth provider settings and session policy.
3. Open `Settings` -> `Server UI access` and save `Server UI admin emails`.
4. Register `https://<public-host>/__rivet_auth/oauth/callback` with the provider for the server UI callback. If web-app OAuth is also enabled, register the app callback path configured in the same OAuth tab, usually `https://<public-host>/apps/auth/callback`.
5. Change deployment env to `RIVET_SERVER_UI_AUTH_MODE=oauth` and roll out the backend API so the mode env is re-read.

For GitOps-only installs, pre-seed `settings/web-app-auth.json` on the shared app-data claim before switching the mode to `oauth`; treat that file as secret-bearing app data because it can contain client and session secrets. Keep the server UI OAuth admin list separate from per-web-app allowed-email lists. The server UI list controls who can administer the Rivet editor/dashboard; web-app allowlists are saved per published web app in Project Settings.

Public workflow execution routes require `Authorization: Bearer <RIVET_KEY>` when `Settings` -> `Workflow endpoints` -> `Access control` is enabled. It is enabled by default and persisted in `settings/workflow-endpoint-auth.json` on the shared app-data claim.

Web-app routes under `/apps/*` and `/apps-latest/*` follow the persisted `Settings` -> `Web apps` -> `Auth` mode:

- `Key` is the default. Visitors enter the Rivet key before opening web apps.
- `OAuth` redirects web-app page visitors through the configured OAuth provider, returns them to the originally requested app URL after callback, and then checks the per-web-app allowed-email list stored in Project Settings. The allowlist is fail-closed: leave it empty only when nobody should be able to open that app yet.
- `No gate` leaves web-app routes open at the API layer and should only be used behind an external access-control layer.

Hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass web-app auth in every mode. In OAuth mode, configure the provider callback as `https://<public-host>/apps/auth/callback` unless `Settings` -> `Web apps` -> `Routes` changes the published app slug or the `OAuth` tab's callback URL intentionally changes it; the active published-app auth logout route, usually `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/logout`, is also reserved by the API for local sign-out. That logout clears only the Rivet web-app OAuth session, then asks the provider for `prompt=select_account` on the next sign-in so users can choose another account when the provider supports it; it does not terminate the provider's own browser session. OAuth provider settings are vendor-neutral and are stored through the `OAuth` tab, including provider URLs, client credentials, scopes, email claim path, session lifetime, client-auth method, and profile debug logging. Server UI admin emails are stored through the `Server UI access` tab because they apply to the editor/dashboard gate, not to individual web-app visitors. External OAuth provider URLs must use `https`; `http` is accepted only for localhost development endpoints. `Local dummy` is only for local testing and must not be used in Kubernetes or production; it lets a localhost tester type an email at the active published-app dummy route, usually `/apps/auth/dummy`. Profile debug logging can be used briefly during integration to log the raw provider profile JSON, but should stay off in normal production because it can expose user profile data in pod logs. `RIVET_CORS_ALLOWED_ORIGINS` should stay empty unless a known external browser origin must call API or workflow routes directly. In production, treat `settings/web-app-auth.json` as secret-bearing app data, `settings/trusted-hosts.json` as the explicit gate-bypass policy, and `settings/public-routes.json` as the proxy/API route contract: persist them, back them up according to the app-data policy, and restrict pod/volume access appropriately. The proxy no longer needs web-app auth mode or trusted-host env vars; it forwards app routes to the API and keeps `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=false` by default so browser-supplied forwarded headers cannot influence OAuth redirects or trusted-host matching.

If an ingress or gateway rewrites the upstream `Host` or terminates TLS before the Rivet proxy and the API must see the original public host/scheme, configure that ingress to strip any client-supplied `X-Forwarded-Host` / `X-Forwarded-Proto` headers and write its own trusted values, then set `env.RIVET_TRUST_INCOMING_FORWARDED_HEADERS: "true"`. Leave it false for directly internet-facing proxies or untrusted ingress chains. The effective host/proto feed OAuth callback construction, same-origin web-app action checks, trusted-host matching, server UI cookie security, and `/api/config` browser URLs.

If `fullnameOverride` is not set, replace `rivet-*` with the rendered object names from `kubectl get`.

Common first-deploy failure patterns:

- `ImagePullBackOff`: check GHCR visibility, tag names, and `imagePullSecrets`
- `Pending`: check that `storage.appData.existingClaimName` exists in the namespace, can be mounted by backend/proxy/execution/executor pods, and uses access modes/storage class compatible with the replica topology; also check any runtime-library cache PVC choices
- Vault injector never creates `/vault/dotenv`: check `vault.role`, `vault.authPath`, `vault.secretPath`, Vault auth policy, and Vault Injector installation
- API pods crash during startup: check Postgres connection values, object-storage credentials, and whether the secret keys match the names in `postgres.*`, `objectStorage.*`, or `/vault/dotenv`
- HPA shows missing metrics: install/fix `metrics-server` and set CPU requests for `resources.proxy` and `resources.execution`
- browser loads but websockets disconnect through ingress: check websocket upgrade support and long read/send timeout annotations on the ingress controller

The production contract today is:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- `replicaCount.proxy=2`
- `replicaCount.web=1`
- `replicaCount.backend=1`
- `replicaCount.execution=2`
- `autoscaling.proxy.enabled=true`
- `autoscaling.web.enabled=false`
- `autoscaling.backend.enabled=false`
- `autoscaling.execution.enabled=true`
- `env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH=/workflows`
- `env.RIVET_LATEST_WORKFLOWS_BASE_PATH=/workflows-latest`
- `env.RIVET_PUBLISHED_APPS_BASE_PATH=/apps`
- `env.RIVET_LATEST_APPS_BASE_PATH=/apps-latest`
- `/ws/latest-debugger` is enabled by default for latest workflow and latest web-app action debugging; set `env.RIVET_ENABLE_LATEST_REMOTE_DEBUGGER=false` only for deployments that intentionally forbid this hosted debugger websocket
- `storage.appData.existingClaimName=<shared-app-data-pvc>` is required; use an RWX-capable claim for multi-node or scaled proxy/execution deployments
- storage/database settings are configured after deploy in `Settings` -> `Storage`; public route slugs are configured in `Settings` -> `Workflow endpoints` and `Settings` -> `Web apps`; trusted hosts are configured in `Settings` -> `General`; web-app auth mode is configured in `Settings` -> `Web apps`; shared OAuth provider/session settings are configured in `Settings` -> `OAuth`; server UI admin emails are configured in `Settings` -> `Server UI access`; Kubernetes-relevant runtime limits are configured in `Settings` -> `General` and `Workflow endpoints`; the `Docker` settings tab is harmless but Docker-launcher-only. The resulting app-settings files must be on persistent/shared app data for any API pod that serves workflow or web-app routes, storage changes require pod restart/rollout, and dynamic route-family/timeout/trusted-host changes require the proxy to mount that same app-data claim so it can hot-reload nginx
- `clusterDomain=cluster.local` unless the cluster DNS suffix is different
- `env.RIVET_PROXY_RESOLVER` must be set for in-cluster nginx DNS resolution
- control-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=none` with the job worker enabled there
- execution-plane runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=endpoint` with `RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED=false`
- executor runtime-library reporting should stay at `RIVET_RUNTIME_LIBRARIES_REPLICA_TIER=editor`
- `proxy` and `execution` scale independently; they are not a tied pair
- production resource requests should be defined before relying on CPU-based HPA decisions

Chart-maintainer note:

- backend/execution chart reuse is intentionally shallow
- shared env and pod fragments live in `_env.tpl` and `_pod.tpl`
- API containers mount app-data at `/data/rivet-app`, while the executor keeps its app-data mount at `/home/rivet/.local/share/com.valerypopoff.rivet2` because it still expects the Rivet desktop storage layout
- `proxy` and `web` remain mostly explicit so rendered pod shape stays operator-readable

## Repo-local verification

Run this before handing the repo to DevOps:

```bash
npm run verify:kubernetes
```

That command proves:

- the local rehearsal values path still renders cleanly
- the static Kubernetes contract tests still pass
- the production overlay still lint-renders with concrete image repository overrides

For a live-cluster local check, also run:

```bash
npm run dev:kubernetes-test
```

Then validate:

- the proxy URL opens successfully
- `/api/config` returns the expected published/latest base paths
- published workflow runs succeed through the scaled `execution` Deployment
- latest workflow runs and latest web-app action runs still debug through the singleton `backend`

## Operator checklist

- scale `execution` for endpoint demand
- keep `proxy` redundant and autoscaled because all endpoint traffic still crosses it
- keep `web` fixed at `1` unless real dashboard traffic becomes significant
- keep the control plane conservative and do not scale `backend`
- do not couple `proxy` and `execution` replica counts mechanically; let each tier scale for its own pressure
- set concrete CPU and memory requests for `proxy` and `execution` before treating HPA as production-ready
- keep the same `RIVET_KEY` available to both `proxy` and the API workloads
- route `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, `${RIVET_LATEST_APPS_BASE_PATH}`, and `/ws/latest-debugger` to the singleton control plane
- route `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_PUBLISHED_APPS_BASE_PATH}` to the execution plane
- keep runtime-library job ownership on the singleton control plane and keep execution replicas in sync-only mode
- treat the local launcher as a rehearsal wrapper around the real chart, not a separate deployment contract
