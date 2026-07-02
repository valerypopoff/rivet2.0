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

The `latest` tag is produced from pushes to `main-rivet2`; commit SHA and tag-derived image tags are also produced by the same workflow. The image workflow resolves the configured upstream Rivet ref to an exact commit before the Rivet-consuming image builds and labels the resulting images with that Rivet source, ref, and revision.
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

In Kubernetes, production should stay on managed storage:

- `workflowStorage.backend=managed`
- `runtimeLibraries.backend=managed`
- workflow metadata, publication state, recording metadata, and runtime-library state live in managed Postgres
- workflow blobs, recording/replay blobs, and runtime-library artifacts live in object storage

The chart requires `storage.appData.existingClaimName`. This PVC is the shared app-settings volume for the backend, proxy, execution, and executor pods. Use RWX-capable storage for multi-node or scaled proxy/execution deployments; a generated backend-only StatefulSet claim is not enough because Deployments cannot mount that private claim.

The API and executor containers deliberately mount that same `app-data` volume at different paths: `/data/rivet-app` for the API and `/home/rivet/.local/share/com.valerypopoff.rivet2` for the executor. The proxy mounts the same claim read-only at `/data/rivet-app` so it can hot-reload public route, timeout, and trusted-host settings. App Settings -> `Storage` writes `settings/deployment-storage.json` from the API; App Settings -> `Run recordings` writes `settings/run-recordings.json` from the API; App Settings -> `General` -> `Trusted hosts` writes `settings/trusted-hosts.json` from the API; App Settings -> `Node executor proxy` writes `settings/node-executor-proxy.json` and `settings/executor-url-overrides.json` from the API; App Settings -> `Workflow endpoints` -> `Routes` and App Settings -> `Web apps` -> `Routes` both write `settings/public-routes.json` from the API; App Settings -> `Workflow endpoints` -> `Access control` writes `settings/workflow-endpoint-auth.json` from the API; App Settings -> `Web apps` -> `Auth` writes `settings/web-app-auth.json` from the API; App Settings -> `Workflow endpoints` writes `settings/runtime-limits.json`. API and executor startup read deployment storage settings from app data; runtime storage/database env values are ignored, and Kubernetes uses only the init container's `RIVET_DEPLOYMENT_*` bootstrap values when the settings file is absent. API bootstrap also clears process proxy env first and then reads the proxy settings file through `RIVET_APP_DATA_ROOT` for latest/headless execution paths that run in that process, while the editor executor bootstrap reads the same relative file from the desktop-style app-data mount. Hosted executor/default-debugger websocket URL overrides are read through `/api/config`; blank override settings keep the normal public-host-derived websocket URLs. Keep this claim persistent if operators use UI-managed storage, recording limits, public route slugs, trusted hosts, workflow endpoint auth, web-app auth, runtime limits, websocket overrides, or executor proxy settings.

Published workflow endpoints and published web apps in the split `execution` deployment also consume this settings volume for UI-managed storage credentials, recording limits, workflow endpoint auth, web-app auth, runtime limits, and proxy values. Storage/database settings are read from `settings/deployment-storage.json` at process startup, while recording queue/retention limits, workflow endpoint bearer-token auth, trusted host bypasses, web-app auth/OAuth settings, runtime endpoint proxy values, and workflow HTTP timeout settings are not read from `.env`, Vault dotenv, or deployment `RIVET_RECORDINGS_MAX_*` / `RIVET_REQUIRE_WORKFLOW_KEY` / `RIVET_UI_TOKEN_FREE_HOSTS` / `RIVET_WEB_APPS_AUTH_MODE` / `OAUTH_*` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / timeout variables. Storage/database changes require pod restart or rollout so process singleton backends are rebuilt. Public route slugs are read by the API dynamically from `settings/public-routes.json`; the proxy hot-reloads its nginx public-route and trusted-host includes from the same app-data claim. The Docker startup wait timeout stored in the same runtime-limits settings file is intentionally ignored by Kubernetes; it only affects npm Docker launcher commands.

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

All runtime images source `/vault/dotenv` at startup. They also accept the Vault Injector default fallback path `/vault/secrets/<dotenvFileName>`.

When Vault is enabled, the dotenv file should provide the sensitive values that should not live directly in Helm values:

```dotenv
RIVET_KEY=<shared-random-secret>
RIVET_DEPLOYMENT_DATABASE_PASSWORD=<postgres-password>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID=<object-storage-access-key-id>
RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY=<object-storage-secret-access-key>
```

You may provide `RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING` instead of `RIVET_DEPLOYMENT_DATABASE_PASSWORD`, but keep the non-secret `postgres.host`, `postgres.database`, and `postgres.username` values in the Helm values because chart validation uses them to catch incomplete managed-storage configuration. The chart bootstrap writes these values into `settings/deployment-storage.json` when that file is absent; API and executor runtime containers read the settings file rather than the dotenv variables.

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

If the UI gate is disabled or the forwarded host is listed in `Settings` -> `General` -> `Trusted hosts`, `/api/config` should be reachable through the proxy directly:

```bash
curl -i http://127.0.0.1:8080/api/config
```

If the UI gate is enabled for the forwarded host, authenticate first and reuse the cookie:

```bash
curl -i -c rivet-cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"key":"<RIVET_KEY>"}' \
  http://127.0.0.1:8080/__rivet_auth

curl -i -b rivet-cookies.txt http://127.0.0.1:8080/api/config
```

Public workflow execution routes require `Authorization: Bearer <RIVET_KEY>` when `Settings` -> `Workflow endpoints` -> `Access control` is enabled. It is enabled by default and persisted in `settings/workflow-endpoint-auth.json` on the shared app-data claim.

Web-app routes under `/apps/*` and `/apps-latest/*` follow the persisted `Settings` -> `Web apps` -> `Auth` mode:

- `Rivet key` is the default and reuses the main Rivet server key prompt when `RIVET_REQUIRE_UI_GATE_KEY=true`.
- `OAuth` redirects web-app page visitors through the configured OAuth provider, returns them to the originally requested app URL after callback, and then checks the per-web-app allowed-email list stored in Project Settings. The allowlist is fail-closed: leave it empty only when nobody should be able to open that app yet.
- `No app gate` leaves web-app routes open at the API layer and should only be used behind an external access-control layer.

Hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass web-app auth in every mode. In OAuth mode, configure the provider callback as `https://<public-host>/apps/auth/callback` unless `Settings` -> `Web apps` -> `Routes` changes the published app slug or the Auth tab's callback URL intentionally changes it; the active published-app auth logout route, usually `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/logout`, is also reserved by the API for local sign-out. OAuth provider settings are vendor-neutral and are stored through the Settings tab, including provider URLs, client credentials, scopes, email claim path, session lifetime, client-auth method, and profile debug logging. External OAuth provider URLs must use `https`; `http` is accepted only for localhost development endpoints. `Local dummy` is only for local testing and must not be used in Kubernetes or production; it lets a localhost tester type an email at the active published-app dummy route, usually `/apps/auth/dummy`. Profile debug logging can be used briefly during integration to log the raw provider profile JSON, but should stay off in normal production because it can expose user profile data in pod logs. `RIVET_CORS_ALLOWED_ORIGINS` should stay empty unless a known external browser origin must call API or workflow routes directly. In production, treat `settings/web-app-auth.json` as secret-bearing app data, `settings/trusted-hosts.json` as the explicit gate-bypass policy, and `settings/public-routes.json` as the proxy/API route contract: persist them, back them up according to the app-data policy, and restrict pod/volume access appropriately. The proxy no longer needs web-app auth mode or trusted-host env vars; it forwards app routes to the API and keeps `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=false` by default so browser-supplied forwarded headers cannot influence OAuth redirects or trusted-host matching.

If an ingress or gateway rewrites the upstream `Host` or terminates TLS before the Rivet proxy and the API must see the original public host/scheme, configure that ingress to strip any client-supplied `X-Forwarded-Host` / `X-Forwarded-Proto` headers and write its own trusted values, then set `env.RIVET_TRUST_INCOMING_FORWARDED_HEADERS: "true"`. Leave it false for directly internet-facing proxies or untrusted ingress chains. The effective host/proto feed OAuth callback construction, same-origin web-app action checks, trusted-host matching, UI-gate cookie security, and `/api/config` browser URLs.

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
- storage/database settings are configured after deploy in `Settings` -> `Storage`; public route slugs are configured in `Settings` -> `Workflow endpoints` and `Settings` -> `Web apps`; trusted hosts are configured in `Settings` -> `General`; web-app auth is configured in `Settings` -> `Web apps`; Kubernetes-relevant runtime limits are configured in `Settings` -> `General` and `Workflow endpoints`; the `Docker` settings tab is harmless but Docker-launcher-only. The resulting app-settings files must be on persistent/shared app data for any API pod that serves workflow or web-app routes, storage changes require pod restart/rollout, and dynamic route-family/timeout/trusted-host changes require the proxy to mount that same app-data claim so it can hot-reload nginx
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
