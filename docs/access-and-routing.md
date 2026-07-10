# Access And Routing

This document describes the current external route families, the nginx gate, and the trust boundary between `proxy`, the control-plane API, the execution-plane API, and `executor`.

The current runtime split keeps:

- `control plane`
  - `/api/*`
  - `/ui-auth`
  - latest workflow execution
  - latest Rivet web apps
  - latest debugger websocket
  - runtime-library and plugin admin flows
- `execution plane`
  - published workflow execution
  - published Rivet web apps
  - internal published-only execution for trusted in-cluster callers

Those labels describe logical ownership. In `RIVET_API_PROFILE=combined`, the same API process serves both surfaces. In split deployments, `RIVET_API_PROFILE=control` and `RIVET_API_PROFILE=execution` separate them.

## Proxy-exposed routes

The Docker dev and production stacks expose these route families through nginx:

| Path | Backing service | Purpose |
|---|---|---|
| `/` | `web` | Wrapper dashboard shell |
| `/?editor` | `web` | Hosted Rivet editor iframe |
| `POST /__rivet_auth` and `/__rivet_auth/oauth/*` | control-plane `api` (`/ui-auth`) | Server UI key/OAuth exchange |
| `/api/*` | control-plane `api` | Wrapper API surface |
| `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName` | execution-plane `api` | Execute frozen published workflow snapshot |
| `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug` | execution-plane `api` | Serve one published declarative Rivet web app from its frozen project snapshot |
| `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName` | control-plane `api` | Execute the latest live draft for a still-published workflow, keyed by the current draft endpoint |
| `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug` | control-plane `api` | Serve one published declarative Rivet web app from the latest saved draft/current server-side project |
| `/ws/latest-debugger` | control-plane `api` | Latest workflow and latest web-app action remote debugger websocket |
| `/ws/executor/internal` | `executor` | Hosted editor execution websocket |
| `/ws/executor` | `executor` | Upstream-compatible executor websocket path |

The nginx configs keep a `100 MiB` server-wide body limit for API/editor payloads. App Settings -> `Web apps` can independently change the maximum JSON data a web-app button action may send (default `100 MiB`); nginx hot-reloads that value as a location-specific `client_max_body_size` for the published and latest web-app route families, and the API enforces the same limit when it receives an action directly. If an external ingress or host reverse proxy sits in front of Rivet, it must independently allow at least the same body size; the wrapper cannot reconfigure infrastructure outside its own proxy container.

Current proxy timeout behavior:

- `/api/*`, `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_APPS_BASE_PATH}` use the App Settings -> `Workflow endpoints` HTTP timeout, saved in seconds under `settings/runtime-limits.json` and defaulting to `180`; the proxy watches that file and rewrites a generated timeout include before reloading nginx
- websocket routes stay long-lived at `86400s`; the workflow-endpoint timeout is only for the standard HTTP upstream routes
- this proxy timeout is separate from App Settings -> `General` shell command limits, which only apply to hosted shell execution under `/api/shell/exec`

Important local-Docker wiring note:

- the repo-local Docker stacks still run a single `api` container in `combined` mode
- nginx therefore proxies `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}`, `${RIVET_PUBLISHED_APPS_BASE_PATH}`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH}`, and `${RIVET_LATEST_APPS_BASE_PATH}` to that same container there
- the control-plane vs execution-plane labels in the table describe the intended split topology and the route ownership enforced by `RIVET_API_PROFILE`, not a guarantee that local Docker physically runs two API services
- the executor websocket upstream remains a separate internal service on port `21889`; it must not inherit the API `PORT` value from `.env`
- in Docker modes the executor process binds to `0.0.0.0` inside its container so nginx can reach the `executor:21889` service; external clients should still use the proxy routes, not the executor container directly

## Browser-side websocket ownership

The browser transport seams now match the backend route split more explicitly:

- `/?editor` prefers `/ws/executor/internal` for the hosted executor websocket and keeps `/ws/executor` only for upstream-compatible clients
- the editor loads `/api/config`, mounts through Rivet 2.0's `RivetAppHost`, and passes the runtime-configured executor websocket as `executor.internalExecutorUrl`
- upstream Rivet owns the executor session, upload, run, abort, pause/resume, internal-executor UI classification, and request-scoped websocket event handling; the wrapper only passes the configured executor websocket URL through `executor.internalExecutorUrl`
- wrapper code still owns dashboard/editor `window.postMessage` commands and hosted project IO

Those executor websocket responsibilities are separate from the dashboard/editor `window.postMessage` bridge. The bridge coordinates project-open/save/delete/path-move behavior between browsing contexts; the executor session talks to executor routes.

## `/api/*` route families

The wrapper API currently exposes these groups behind `/api`:

- `/api/workflows/*`
  - `GET /api/workflows/tree`
  - `GET /api/workflows/recordings` (compatibility alias for the workflow-list response)
  - `POST /api/workflows/move`
  - `POST|PATCH|DELETE /api/workflows/folders`
  - `POST|PATCH|DELETE /api/workflows/projects`
    - `DELETE /api/workflows/projects` returns `{ deleted: true, projectId }` so the hosted editor bridge can clear editor-owned state for that workflow id even when its tab is already closed.
  - `POST /api/workflows/projects/duplicate`
  - `POST /api/workflows/projects/upload`
  - `POST /api/workflows/projects/download`
  - `POST /api/workflows/projects/publish`
  - `POST /api/workflows/projects/unpublish`
  - `GET /api/workflows/projects/web-apps?relativePath=...`
    - returns current and still-published-missing web apps with per-row `Not published`, `Published`, or `Unpublished changes` status derived from the web app's own pinned `/apps` snapshot/revision versus the latest saved `/apps-latest` draft
  - `POST /api/workflows/projects/web-apps/publish`
  - `PATCH /api/workflows/projects/web-apps/access`
    - updates wrapper-owned allowed-email access lists for already-published web apps without republishing or changing the app's pinned snapshot/revision
  - `POST /api/workflows/projects/web-apps/unpublish`
  - `GET /api/workflows/recordings/workflows`
  - `GET /api/workflows/recordings/workflows/:workflowId/runs?page=1&pageSize=20&status=all|failed`
    - optional input filter query: `inputPath=$.foo&inputOperator=%3D%3D&inputValue=bar&inputCursor=0`
    - `$` is the captured graph input root from Rivet's `inputs.input.value`; recordings whose graph inputs do not include an `input` port fall back to an object of all captured graph input values keyed by port name
    - input-filtered responses scan newest-first and may return `totalRunsExact: false`, `hasMore: true`, and `nextInputCursor` so the dashboard can show recent matches quickly, request the next cursor automatically, and append later matches as they are found; a non-exhaustive cursor response may contain zero matches when the current scan window did not match
    - if the client aborts the request, the API stops the input-filter artifact scan after the current small read batch
  - `GET /api/workflows/recordings/:recordingId/recording`
  - `GET /api/workflows/recordings/:recordingId/replay-project`
  - `GET /api/workflows/recordings/:recordingId/replay-dataset`
  - `DELETE /api/workflows/recordings/:recordingId`
- `/api/runtime-libraries/*`
  - `GET /api/runtime-libraries/`
  - `POST /api/runtime-libraries/install`
  - `POST /api/runtime-libraries/remove`
  - `POST /api/runtime-libraries/replicas/cleanup`
  - `GET /api/runtime-libraries/jobs/:jobId`
  - `POST /api/runtime-libraries/jobs/:jobId/cancel`
  - `GET /api/runtime-libraries/jobs/:jobId/stream`
- `/api/native/*`
  - hosted filesystem read/write/list/remove helpers used by the editor
- `/api/projects/*`
  - `GET /api/projects/list`
  - `POST /api/projects/open-dialog`
  - `POST /api/projects/load`
  - `POST /api/projects/save` - validates the hosted project payload and normalizes the saved `.rivet-project` title to the current workflow tree/file name before persisting
  - `GET /api/projects/workspace-root`
- `/api/plugins/*`
  - `POST /api/plugins/install-package`
  - `POST /api/plugins/load-package-main`
- `/api/shell/exec`
  - allowlisted shell execution
- `/api/config`, `/api/path/app-local-data-dir`, `/api/path/app-log-dir`, `/api/config/env/:name`
  - hosted env/config helpers
- `/api/app-settings/node-executor-proxy`
  - guarded app-settings helper for persisted internal Node executor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` values
- `/api/app-settings/run-recordings`
  - guarded app-settings helper for recording queue depth, per-endpoint history length, and age-retention limits
- `/api/app-settings/deployment-storage`
  - guarded app-settings helper for workflow/runtime-library storage mode, filesystem artifact root, managed PostgreSQL settings, and managed object-storage settings; secret values are write-only from the browser
- `/api/app-settings/workflow-endpoint-auth`
  - guarded app-settings helper for the default-on workflow endpoint bearer-token requirement
- `/api/app-settings/web-app-auth`
  - guarded app-settings helper behind `Settings` -> `Web apps` auth mode, `Settings` -> `OAuth` provider/session settings, and `Settings` -> `Server UI access` admin settings

Current tree-response note:

- `GET /api/workflows/tree` is the dashboard's main workflow-library metadata source
- each `WorkflowProjectItem` in that response carries the API-derived publication status used by the sidebar and Project Settings flows
- that same project item also carries per-project `stats` (`graphCount`, `totalNodeCount`), which drive the active project summary shown in the dashboard
- stats are cached as wrapper-owned metadata (`*.wrapper-stats.json` in filesystem mode, revision columns in managed mode), but publication status stays API-derived from settings/hash/revision state so save refreshes still show the correct `Published` or `Unpublished changes` state

`GET /healthz` lives on the API service itself and is used by the Docker healthchecks. The API starts listening only after startup reconciliation and workflow storage initialization finish, so Docker Compose gives the API healthcheck a long startup grace period in both dev and production stacks.

Current move-route behavior:

- `POST /api/workflows/move` accepts `{ "itemType": "project" | "folder", "sourceRelativePath": string, "destinationFolderRelativePath"?: string }`
- omitting or emptying `destinationFolderRelativePath` moves the item back to the workflow root
- it returns the moved `project` or `folder` plus `movedProjectPaths` for any affected open project references
- moving a folder into itself or one of its descendants is rejected
- the dashboard uses this route for workflow-library drag/drop and then applies `movedProjectPaths` through the editor bridge retargeting flow

Current duplicate-route behavior:

- `POST /api/workflows/projects/duplicate` accepts `{ "relativePath": string, "version"?: "live" | "published" }`
- it returns `201 { "project": WorkflowProjectItem }`
- it creates a sibling `.rivet-project` using the same saved-version tag model as downloads, for example `Name [unpublished] Copy`, `Name [published] Copy`, or `Name [unpublished changes] Copy`
- repeated duplicates of the same duplicate stem are numbered as `... Copy 1`, `... Copy 2`, and so on
- duplicating an already duplicated project stays literal, so `Name [unpublished] Copy` becomes `Name [unpublished] Copy [unpublished] Copy` before numbered variants are needed
- `version: "live"` duplicates the saved live workflow file
- `version: "published"` resolves the published snapshot through the publication model and returns `409` if no published version is available
- it writes only the new project file; dataset sidecars, wrapper settings, published snapshots, and recordings are intentionally not copied
- the dashboard calls this route directly from the project-row context menu: `unpublished` duplicates `live`, `published` duplicates `published`, and `unpublished_changes` opens a chooser for the user to pick which saved version to duplicate

Current create-project route behavior:

- `POST /api/workflows/projects` accepts `{ "folderRelativePath"?: string, "name": string }`
- it returns `201 { "project": WorkflowProjectItem }`
- it creates a new blank `.rivet-project` file in the target folder and uses the provided name for both the filename base and initial project title
- the dashboard currently calls this route from the folder-row context menu's `Create project` action
- folder-level project creation currently exists only in that custom folder context menu, not in an inline row button
- if the target folder already contains that exact project name, the route returns `409`

Current rename-project route behavior:

- `PATCH /api/workflows/projects` accepts `{ "relativePath": string, "newName": string }`
- it returns `{ "project": WorkflowProjectItem, "movedProjectPaths": WorkflowProjectPathMove[] }`
- it also rewrites the saved project contents so `project.metadata.title` matches `newName`; managed storage does this by creating a new current draft revision while leaving published revisions/history unchanged
- the dashboard calls this route from the project-row context menu; Project Settings does not expose a second rename control
- the project-row context-menu flow and selected-row `F2` shortcut edit inline in the workflow library, hide the edit field immediately on `Enter`, show a row preloader while the route is pending, retarget selected/open project paths through `movedProjectPaths`, and ask the hosted editor to apply the externally persisted title/path through `RivetWorkspaceHost.updateProjectMetadata(...)` when the renamed project is already open
- if the target sibling project name already exists, the route returns `409` and the inline preloader clears without leaving the edit field open

Current upload-route behavior:

- `POST /api/workflows/projects/upload` accepts `{ "folderRelativePath"?: string, "fileName": string, "contents": string }`
- it returns `201 { "project": WorkflowProjectItem }`
- it parses the uploaded `.rivet-project`, assigns a fresh workflow metadata ID, updates the stored title to the final saved filename base, and writes only a new project file into the selected folder
- name collisions are resolved as `Name`, then `Name 1`, `Name 2`, and so on
- the dashboard calls this route directly from the folder-row context menu after reading the selected local file in the browser
- browser file-picking is still validated client-side and server-side; some browsers do not reliably pre-filter Rivet's custom `.rivet-project` extension in the native picker
- uploads intentionally ignore unsaved editor changes, do not use the editor bridge, and never create sidecars, published snapshots, or recordings automatically
- invalid project files or wrong extensions return `400`; a missing target folder returns `404`

Current download-route behavior:

- `POST /api/workflows/projects/download` accepts `{ "relativePath": string, "version": "live" | "published" }`
- it returns the raw `.rivet-project` file body, not JSON
- it currently serves `application/x-yaml; charset=utf-8` with `Content-Disposition: attachment`
- it sets attachment headers so the browser downloads the file with a status tag such as `Name [published].rivet-project`
- `version: "live"` reads the saved live workflow file from the workflow tree
- `version: "published"` resolves the published snapshot through the publication model and returns `409` if no published version is available
- the dashboard calls this route directly from the project-row context menu: `unpublished` downloads `live`, `published` downloads `published`, and `unpublished_changes` opens a chooser for the user to pick which saved version to download
- downloads intentionally ignore unsaved editor changes and never include sidecars or recordings

## Server UI auth

The browser/editor surface is protected by the proxy asking the API whether the current request is allowed. The bootstrap mode is intentionally deployment-owned and comes from `.env` or Kubernetes/Vault-provided env:

- `RIVET_SERVER_UI_AUTH_MODE=none` leaves the dashboard/editor ungated.
- `RIVET_SERVER_UI_AUTH_MODE=key` asks for `RIVET_KEY` in the browser and stores the signed `rivet_ui_token` cookie.
- `RIVET_SERVER_UI_AUTH_MODE=oauth` redirects users through the OAuth provider saved in `Settings` -> `OAuth` and allows only emails listed in `Settings` -> `Server UI access` -> `Server UI admin emails`.
- If `RIVET_SERVER_UI_AUTH_MODE` is unset, the legacy `RIVET_REQUIRE_UI_GATE_KEY=true` behaves like `key`; explicit `RIVET_SERVER_UI_AUTH_MODE` always wins.
- `Settings` -> `General` -> `Trusted hosts` lists exact hosts that bypass the server UI gate, web-app auth, and public workflow bearer checks.

When a request is not allowed, nginx uses `auth_request /__rivet_ui_auth_check` and then proxies to the API-rendered `/ui-auth/prompt` page. The prompt preserves the sanitized original local path in `return_to`, so successful key or OAuth sign-in returns to `/`, `/apps/my-tool/`, or whatever route the browser originally tried to open. Form or OAuth failures redirect back to the same local path with `auth_error` added so the prompt can explain the failure without losing the destination.

Server UI OAuth is a two-step bootstrap:

1. Start the server with `RIVET_SERVER_UI_AUTH_MODE=none` or `key`.
2. Open `Settings` -> `OAuth` and save the shared OAuth provider settings and session policy.
3. Open `Settings` -> `Server UI access` and save `Server UI admin emails`.
4. Register the server UI callback URL with the provider: `https://your-host/__rivet_auth/oauth/callback`.
5. Change `.env` / deployment env to `RIVET_SERVER_UI_AUTH_MODE=oauth` and recreate the API container or rollout the API pod so the mode env is re-read.

The saved web-app callback URL remains the visitor-web-app callback, usually `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/callback`. It is separate from the server UI callback above. Retired `RIVET_SERVER_UI_OAUTH_*` env values are ignored; the OAuth provider details and server UI admin allowlist live in `settings/web-app-auth.json` under `RIVET_APP_DATA_ROOT`, but the UI shows them in separate `OAuth` and `Server UI access` tabs.

Server UI OAuth sessions are fail-closed. Empty admin email lists deny all OAuth users. State cookies and session cookies are bound to the active saved OAuth settings version, so changing provider URL, client credentials, scopes, email claim, admin emails, or session policy invalidates stale sign-ins without needing to rotate `RIVET_KEY`.

`RIVET_KEY` is still required in proxy-fronted deployments even when `RIVET_SERVER_UI_AUTH_MODE=none` or `oauth`, because the proxy-to-API trust header is derived from that key.

## Web apps

Rivet web apps are browser surfaces with wrapper-owned route and auth policy. Web-app routes and auth live in `Settings` -> `Web apps`; workflow endpoint route families live in `Settings` -> `Workflow endpoints`.

The `Workflow endpoints` tab's `Routes` section controls the published/latest workflow endpoint URL slugs. The `Web apps` tab's `Routes` section controls the published/latest web-app URL slugs. Both sections write `settings/public-routes.json` under `RIVET_APP_DATA_ROOT`. The API reads that file dynamically, and the proxy watches it, regenerates the nginx public-route include, validates it with `nginx -t`, and reloads nginx. Changing these slugs from Settings therefore does not require recreating/restarting the stack. If the settings file is missing, the deployment env defaults are used as first-run/bootstrap values: `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, `RIVET_LATEST_WORKFLOWS_BASE_PATH`, `RIVET_PUBLISHED_APPS_BASE_PATH`, `RIVET_LATEST_APPS_BASE_PATH`, then the legacy web-app aliases, then `/workflows`, `/workflows-latest`, `/apps`, and `/apps-latest`. If the saved file exists but is malformed or invalid, route reads fail loudly rather than silently switching top-level route families. The saved slugs must be single top-level URL segments, unique across all four route families, and cannot use reserved top-level routes such as `api`, `ws`, `internal`, `ui-auth`, `assets`, `node_modules`, or `__rivet_auth`.

The `Auth` section controls the API-owned web-app auth mode, not `.env`:

- `Key` is the default. Visitors enter the Rivet key before opening web apps.
- `OAuth` lets the API show a hosted sign-in page for app visitors before they leave for the configured OAuth provider. The default callback path is `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/callback`, and logout is served from `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/logout`, so the app slug `auth` is reserved.
- `No gate` leaves web-app route auth open at the API layer and should only be used behind an external access-control layer.

The proxy no longer reads a web-app auth mode env var or serves the web-app key prompt itself. It forwards the web-app route families to the API with the same trusted proxy metadata used elsewhere. Legacy `RIVET_WEB_APPS_AUTH_MODE` and `OAUTH_*` env values are ignored; changing the web-app auth mode is done through the `Auth` section, and changing shared provider/session settings is done through `Settings` -> `OAuth`. Neither change requires recreating containers.

`Settings` -> `General` -> `Trusted hosts` bypasses web-app auth in all three modes because nginx forwards an internal trusted-host hint to the API. This is useful for internal health checks or trusted hostnames, but it is still a proxy-trust feature; direct access to the API container does not get that hint. The saved list lives in `settings/trusted-hosts.json`; the legacy `RIVET_UI_TOKEN_FREE_HOSTS` env var is ignored/rejected so `.env` cannot silently change this bypass policy.

OAuth mode is intentionally vendor-neutral. The `OAuth` tab stores the provider authorize, token, and profile URLs; client ID; write-only client secret; optional callback URL; scopes; email claim path such as `data.email`; session lifetime; token endpoint client-auth method; write-only session signing secret; provider choice; local dummy-login options; and temporary profile debug logging. The `Server UI access` tab stores the server UI admin emails because that allowlist belongs to the editor/dashboard gate, while the gate mode itself remains controlled by `RIVET_SERVER_UI_AUTH_MODE` in deployment env. The default token exchange sends `client_id` and `client_secret` in the form body; `HTTP Basic` sends them through the `Authorization` header instead. External OAuth provider URLs must use `https`; plain `http` is accepted only for localhost development endpoints. For local testing only, `Local dummy` replaces the external provider with a local page at `/apps/auth/dummy`; it lets the tester submit an email, then completes the normal callback/session-cookie flow. Dummy OAuth is accepted only for `localhost`, `127.0.0.1`, or `[::1]` requests unless the `OAuth` tab explicitly allows non-localhost dummy sign-in. Enable profile debug logging only temporarily while discovering the correct claim path, then turn it back off because the payload can contain user profile data. Unauthenticated HTML app requests render a `Sign in required` page; its `Sign in` button starts the OAuth redirect. Web-app HTML and OAuth redirect responses are sent with `Cache-Control: no-store` because they can carry auth prompts, sign-out links, revision keys, or short-lived state cookies. The temporary OAuth state cookie carries the sanitized original web-app path and the saved OAuth settings version, so provider-side errors that return without echoing the OAuth `state` parameter, token exchange failures, or missing-email profile responses can still redirect the browser back to the app with an `auth_error` query, but callbacks from an older OAuth policy cannot mint a session after settings change. If OAuth settings are cleared, disabled, rotated, or otherwise changed while an old provider callback is in flight, stale signed state is treated as an invalid sign-in state and does not mint a fresh OAuth session. Existing web-app OAuth session cookies are also bound to the saved OAuth auth settings version, so changing provider, mode, client credentials, scopes, email claim, admin emails, or session policy invalidates old app sessions even when the session signing secret itself did not change. HTML app requests that already have an OAuth `auth_error` render a sign-in failure page with a retry link instead of immediately starting another OAuth loop, even if a stale login trigger is also present. After callback, the API stores only a signed HTTP-only web-app session cookie and uses the email claim for per-web-app allowlists. Each OAuth-protected web app must explicitly list allowed emails; an empty allowlist denies all signed-in users. Non-empty allowlists are exact email matches, case-insensitive.

Because `ui-gate` and `oauth` modes use browser cookies, app JSON and action requests also enforce a same-origin browser request check before session lookup. This keeps the global API CORS policy from turning a user's web-app session into cross-site action credentials. HTML requests that fail this early origin check render a styled `Web app request blocked` page with `code: "origin_forbidden"` instead of raw browser boilerplate, which usually points to a proxy origin/host mismatch. By default, the Rivet proxy derives the browser-facing host from the request `Host` header, including its port, and passes that sanitized value to the API in `X-Forwarded-Host`; OAuth redirects, dummy-provider URLs, and `/api/config` browser URLs therefore stay on `localhost:8081` or whatever public host the user opened. The API only trusts `X-Forwarded-Host` and `X-Forwarded-Proto` from requests that carry the internal proxy-auth header, so directly exposed API ports cannot make spoofed forwarded headers look same-origin. Set `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true` only when a trusted ingress sits immediately in front of the Rivet proxy and strips/replaces client-supplied `X-Forwarded-Host` and `X-Forwarded-Proto`. Trusted-host matching strips the effective port before checking the saved exact-host list. Normal direct navigation to the app HTML still works, and hosts listed in Settings bypass web-app auth entirely as before.

OAuth app HTML pages include a small wrapper-owned floating `Sign out` link after the generated Rivet renderer scripts. The wrapper inserts it at the document's final closing body tag, not at matching text inside packaged browser scripts. It calls `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/auth/logout` and returns to the app path so users can switch accounts. That logout clears the Rivet web-app session cookie, not the upstream provider's own session. The returned app path carries an internal account-selection marker, and the next OAuth authorization request sends `prompt=select_account`; providers that support that standard prompt should show an account chooser instead of silently reusing the previous identity. If a signed-in user is not in a web app's allowed-email list, the HTML route returns a styled `Web app access denied` page with that same sign-out action; JSON and action routes continue to return `403` with `code: "oauth_forbidden"`.

## Trusted proxy boundary

The intended access path is:

```text
browser -> nginx -> control-plane api / execution-plane api / executor
```

The API independently enforces that boundary:

- `/api/*` requires the trusted proxy header
- `/ui-auth` requires the trusted proxy header
- `/ws/latest-debugger` requires the trusted proxy header during websocket upgrade

nginx injects `X-Rivet-Proxy-Auth`, derived from `RIVET_KEY`, for those requests.
Direct access to the API container for `/api/*`, `/ui-auth`, or `/ws/latest-debugger` bypasses that header and is rejected.
Keep any diagnostic API port, such as the Compose `http://localhost:3100` binding, private to the host or trusted operators. Public browser traffic should enter through the Rivet proxy so route auth, trusted-host hints, forwarded host/protocol normalization, UI cookies, and web-app OAuth behavior all share one boundary.
Docker dev and local-docker managed-service diagnostic ports bind to `127.0.0.1` by default through `RIVET_LOCAL_BIND_HOST`; set it to `0.0.0.0` only on a trusted/firewalled network.

Operationally, that means `RIVET_KEY` is still mandatory anywhere nginx fronts the API, even if server UI auth is disabled or `Settings` -> `Workflow endpoints` -> `Access control` disables bearer checks on public workflow routes. Those optional browser/public-workflow checks do not disable the proxy-to-API trust channel.

The public workflow execution routes are mounted outside `/api`, so they do not use the `requireAuth` middleware. They still rely on nginx to mediate access and, for trusted hosts, inject the internal trusted-host hint. Web-app routes are also mounted outside `/api`, but they are browser surfaces and use the persisted web-app auth setting rather than the workflow endpoint bearer-token setting.

Forwarded host/protocol headers are part of the same trust boundary. The proxy ignores incoming `X-Forwarded-Host` and `X-Forwarded-Proto` by default and derives its own effective values from the browser request. Only set `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true` when the proxy is behind a trusted load balancer or ingress that overwrites those headers. Do not enable it for a directly internet-facing proxy, because spoofed forwarded headers can affect OAuth callback construction, same-origin checks, cookie-security decisions, and trusted-host matching.

The API CORS policy is closed by default for cross-origin browser credentials. Same-origin browser requests are allowed automatically, and non-browser clients such as Postman or server-side callers do not need CORS. If an external browser application must call workflow or API routes directly, add only that exact origin to `RIVET_CORS_ALLOWED_ORIGINS`; do not use CORS as a substitute for bearer tokens, server UI auth, OAuth, or the proxy boundary.

## Published Rivet web app contract

Published Rivet web apps are published independently from workflow HTTP endpoints. A project can expose multiple web apps at the same time, each mapped to a distinct user-defined slug under `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}`. Each slug points at the frozen project snapshot/revision captured when that UI graph was published:

- `GET ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug`
  - renders the published UI graph attached to that slug as HTML
- `GET ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug/app.json`
  - returns the published UI graph JSON
- `POST ${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}/:slug/actions/run`
  - runs the button action's target graph in the same published project

Each published web-app slug also exposes a latest-saved-draft route under `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}`:

- `GET ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug`
  - renders the same UI graph from the current saved server-side project
- `GET ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug/app.json`
  - returns the current saved UI graph JSON
- `POST ${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug/actions/run`
  - runs the button action's target graph against the current saved server-side project

The route prefixes are owned by `Settings` -> `Workflow endpoints` -> `Routes` for workflow endpoints and `Settings` -> `Web apps` -> `Routes` for web apps after an operator saves them. The env names `RIVET_PUBLISHED_WORKFLOWS_BASE_PATH`, `RIVET_LATEST_WORKFLOWS_BASE_PATH`, `RIVET_PUBLISHED_APPS_BASE_PATH`, and `RIVET_LATEST_APPS_BASE_PATH` remain first-run/deployment defaults, and `RIVET_WEB_APPS_BASE_PATH` / `RIVET_LATEST_WEB_APPS_BASE_PATH` remain supported aliases for older deployments until `settings/public-routes.json` exists.

The wrapper intentionally uses the lower-level upstream web-app helpers instead of the single Fetch-style handler so route ownership, browser/session auth, timing headers, code-runner setup, dataset providers, project-reference loading, and response envelopes stay consistent with the existing endpoint execution stack.

Web-app action requests use the same `ManagedCodeRunner`, dataset provider, project path, project-reference loader, and browser request `context.headers` shape as published workflow execution, but the wrapper strips sensitive browser/session headers before graph execution. In particular, `cookie`, `authorization`, `proxy-authorization`, `x-forwarded-authorization`, `x-rivet-proxy-auth`, and `x-rivet-token-free-host` are not exposed to web-app action graphs or the Fetch-style action request. The wrapper does not pass `inputs` for web-app actions; Rivet maps the declarative UI state into graph inputs according to the clicked button's action definition.

The slug segment resolves through published web-app state, not workflow endpoint state, so a project does not need to be published as a workflow endpoint before its web apps can be published. Saved project edits affect `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}` immediately, but do not affect `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}` until that web-app slug is republished. Unsaved in-browser editor edits are not visible to either server route until the project is saved. If the draft project later deletes a published UI graph, the old slug still serves the pinned snapshot/revision until the user explicitly unpublishes that app from Project Settings.

The HTML embeds an opaque published `revisionKey`. Action requests include that key and are rejected with `409` plus `code: "revision_mismatch"` when that slug is republished between page load and button click. The embedded Rivet web-app client uses that coded response to show a blocking reload modal, so stale open pages recover without an automatic refresh or action rerun.

Auth follows the persisted `Settings` -> `Web apps` -> `Auth` mode:

- `ui-gate` is shown as `Key` in Settings and protects the HTML, `app.json`, and action routes with the same signed key cookie machinery as the server UI key gate.
- `oauth` redirects page requests to the configured provider, returns to the originally requested web-app URL after callback, and enforces each app's allowed-email list after the project is resolved.
- `none` leaves web-app route auth open at the API layer.
- hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass web-app auth for both web-app route families too
- workflow endpoint routes remain bearer/trusted-host routes and do not accept UI or OAuth web-app session cookies as a substitute for `Authorization`
- published web-app action routes do not attach the Remote Debugger; latest web-app action routes can attach it when latest debugging is enabled
- The proxy derives browser-facing host/protocol values itself unless `RIVET_TRUST_INCOMING_FORWARDED_HEADERS=true` is explicitly set for a trusted ingress that overwrites client-supplied forwarded headers. OAuth callback generation, web-app same-origin checks, trusted-host matching, UI-gate cookie security, and `/api/config` public URLs all use those effective browser-facing values.

## Workflow execution contract

All three workflow execution handlers are `POST`-only:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}/:endpointName`
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}/:endpointName`
- `/internal/workflows/:endpointName`

Public route exposure rules:

- `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` resolves only the actively published endpoint identity
- `${RIVET_PUBLISHED_APPS_BASE_PATH}` resolves only actively published web-app slugs and serves their pinned UI graph from the frozen project snapshot/revision
- `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` resolves the current draft endpoint identity only while the workflow still has active published lineage
- `${RIVET_LATEST_APPS_BASE_PATH}` resolves only actively published web-app slugs and serves the matching UI graph from the latest saved draft/current server-side project
- workflow unpublish closes only the workflow route families even though the saved draft `endpointName` remains in project settings for later republish convenience
- web-app route families stay open until each web-app publication is explicitly unpublished
- endpoint uniqueness follows those same active public identities; a fully unpublished saved draft endpoint does not block another workflow from publishing on that name

Current request/response behavior:

- the incoming JSON body becomes the workflow's `input` value
- an empty request body is treated as `{}`
- published, internal published, and latest execution routes inject the incoming request headers into `context.headers`
  - header names follow the normalized lowercase keys exposed by Node/Express
  - `context.headers` is always a plain JSON object with string values
  - duplicate or multi-value headers are joined with `, `
  - invalid header names, unsafe prototype keys, undefined values, and non-string internal values are omitted
- if the workflow's final `output` port is typed as `any`, the HTTP response body is that raw value
- otherwise the response body is the full outputs object
- every execution response sets `x-duration-ms`
- when `RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS=true`, execution responses also emit:
  - `x-workflow-resolve-ms`
    - in `filesystem` mode: endpoint-index freshness validation, possible lazy rebuild, and endpoint lookup
    - in `managed` mode: endpoint pointer resolution
  - `x-workflow-materialize-ms`
    - in `filesystem` mode: materialization-cache validation, possible project/dataset reload plus one-time reparsing, and per-request dataset-provider reconstruction
    - in `managed` mode: immutable revision materialization
  - `x-workflow-execute-ms`
  - `x-workflow-cache`
    - `hit`, `miss`, or degraded `bypass` in `filesystem` mode
    - `miss` or `hit` in `managed` mode
- if the success payload is an object and does not already include `durationMs`, the API injects `durationMs` into the JSON body
- failures return JSON shaped like `{ "error": { "name"?: string, "message": string }, "durationMs": number }`

## Filesystem execution hot path

When `Settings` -> `Storage` uses `Local folders`, the published/latest routes keep a local derived warm path on the API process:

- a startup-warmed endpoint index for published/latest endpoint pointers
- an authoritative uncached filesystem execution source behind that cache, so degraded requests can still resolve through the real publication rules
- a lazy materialization cache for raw project and dataset contents plus the parsed `Project` and attached data for the current file signature
- per-request reconstruction of `NodeDatasetProvider`, while warm hits reuse the cached parsed workflow instead of reparsing YAML every time

Those caches are accelerators only:

- the filesystem tree remains authoritative
- out-of-band edits are still honored without restart
- freshness comes from validation against the filesystem rather than from a watcher
- global validation covers workflow-tree directories and workflow settings sidecars
- selected published endpoint pointers also validate the live-backed inputs that can change published eligibility without a settings edit

Current filesystem debug-header semantics are:

- `x-workflow-cache=hit`
  - the warmed endpoint index was still fresh and served the endpoint pointer directly
- `x-workflow-cache=miss`
  - the index had to rebuild because startup warmup had not happened yet or tracked filesystem state changed
- `x-workflow-cache=bypass`
  - the cache intentionally fell back to uncached filesystem resolution/materialization because cached state was uncertain
  - correctness wins over latency in that degraded mode, so the request should stay correct even though it is colder and slower

Operationally:

- the API warms endpoint pointers at startup, so the first request after a clean API start should already avoid the full recursive workflow-tree scan
- after a project-affecting mutation or an out-of-band tree-shape change, the next request can be a single rebuild `miss`, and the following request should be warm again
- latest-route saves that only change live project contents refresh materialization without needing to dirty the endpoint index
- referenced-project loading for published references still uses the existing compatibility path; this filesystem cache pass only accelerates published/latest endpoint execution

In local Docker, those reads still happen against `/workflows`, which is normally a bind mount of the host workflows directory. On Windows/Docker Desktop, that bind-mounted filesystem path can still add noticeable fixed overhead, but the warmed endpoint/materialization path removes the old full-scan-plus-full-reload cost from steady-state trivial requests.

## Managed execution hot path

When `Settings` -> `Storage` uses `Object storage`, workflow execution stays authoritative through Postgres plus object storage, but each API replica keeps local derived execution caches for the warm path:

- endpoint-pointer cache entries map `runKind + endpointName` to workflow identity, relative path, and revision id
- revision-materialization cache entries store immutable raw project and dataset contents by revision id
- the first request after startup or after an invalidating mutation can still be a cold miss that reads Postgres/object storage
- repeated requests for the same unchanged workflow reuse the warm local cache path instead of repeating remote shared-state reads
- pointer-cache invalidation comes from same-process post-commit clearing plus Postgres `LISTEN/NOTIFY`
- if the invalidation listener is degraded, pointer caches are cleared and bypassed until listener health is restored

The refactor work kept that route and cache contract intact while making the ownership boundaries clearer: control-plane versus execution-plane routing still stays explicit at the API layer, and the hosted browser editor delegates executor session/run transport plus internal executor UI classification to upstream Rivet 2 hooks. Wrapper code passes the proxied internal executor URL into `RivetAppHost` and keeps dashboard/editor messages separate from websocket execution.

Managed runtime-library sync is part of that execution path too:

- `ManagedCodeRunner` calls `prepareRuntimeLibrariesForExecution()` lazily when Rivet enables `require(...)` for a code invocation
- plain JS Code/Expression invocations that do not receive `require(...)` skip runtime-library sync and use the compiled-function cache
- API replicas therefore reconcile the active managed runtime-library release through the same backend contract that the runtime-library admin surface exposes
- that keeps published/latest route behavior aligned with runtime-library activation without making endpoint execution depend on a shared mounted `node_modules` tree

## Workflow execution auth

Workflow execution auth is separate from server UI auth:

- `Settings` -> `Workflow endpoints` -> `Access control` enables or disables bearer-token checks on the public workflow routes; it is enabled by default
- `Authorization: Bearer <RIVET_KEY>` is required on `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}` and `${RIVET_LATEST_WORKFLOWS_BASE_PATH}` when enabled
- if bearer-token checks are enabled but `RIVET_KEY` is empty, public execution fails with `500`
- hosts listed in `Settings` -> `General` -> `Trusted hosts` bypass public workflow bearer auth because nginx forwards `X-Rivet-Token-Free-Host: 1`

The internal published-only route:

- `POST /internal/workflows/:endpointName`

is mounted on the execution-plane API service, is not exposed through nginx, and intentionally skips bearer auth for trusted intra-stack callers.

## Execution-plane storage note

The current runtime split does not make `RIVET_APP_DATA_ROOT` authoritative for workflow contents during published execution:

- workflow truth remains Postgres plus object storage
- `Code` node package resolution comes from the managed runtime-library cache under `RIVET_RUNTIME_LIBRARIES_ROOT`
- execution-plane `app-data` is required settings state in Kubernetes, not workflow blob storage; execution pods must mount the same app-data claim as the control plane so UI-managed storage, recording, workflow endpoint auth, web-app auth, runtime-limit, and outbound proxy settings are visible

Important limitation:

- API-hosted published/latest execution does not currently register package plugins from local app-data
- package-plugin install/load remains a control-plane and editor/executor concern
- the execution-plane `app-data` contract is therefore intentionally minimal today; plugin-backed published endpoint execution is not something the current split newly enables
- App Settings -> `Storage`, `Run recordings`, `Web apps`, `Workflow endpoints`, and `Node executor proxy` write settings files under shared app data; those values are not read from `.env`, Vault dotenv, or legacy deployment variables in split execution pods. Optional hosted executor/default-debugger websocket URL overrides also live under app data and are blank by default, which keeps the normal request-host-derived websocket URLs.

## Latest Debugger Model

Latest remote debugging is enabled by default and separate from the executor websocket:

- it is enabled unless `RIVET_ENABLE_LATEST_REMOTE_DEBUGGER` is explicitly set to `false`, `0`, `no`, or `off`
- it applies to latest workflow endpoint runs and latest web-app action runs under `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}/:slug/actions/run`
- published workflow endpoint runs and published web-app action runs never attach the remote debugger
- the browser-facing websocket path is `/ws/latest-debugger`
- when disabled, websocket upgrades on `/ws/latest-debugger` are rejected with `404`

Endpoint recording persistence is unaffected by debugger state. Latest workflow runs still persist normal recording history when recordings are enabled:

- in `filesystem` mode, as recording bundles under `RIVET_WORKFLOW_RECORDINGS_ROOT` plus SQLite index rows
- in `managed` mode, as Postgres metadata plus recording/replay blobs in object storage

Kubernetes support note:

- the supported Kubernetes topology keeps `/ws/latest-debugger`, `${RIVET_LATEST_WORKFLOWS_BASE_PATH:-/workflows-latest}`, and `${RIVET_LATEST_APPS_BASE_PATH:-/apps-latest}` on the singleton control-plane backend
- execution-plane API replicas may scale independently for `${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-/workflows}` and `${RIVET_PUBLISHED_APPS_BASE_PATH:-/apps}`
- latest workflow endpoint runs and latest web-app action runs remain debuggable in that topology because both the latest execution route family and `/ws/latest-debugger` stay on the same backend process boundary
- published workflow endpoint runs and published web-app action runs remain non-debuggable
- manually scaling the backend outside the chart guardrails is unsupported for latest debugging because the current debugger is still process-local, not a distributed cross-replica debugger

## Local dev note

`npm run dev` preserves the nginx routing and auth model described above.

`npm run dev:local` does not recreate that proxy boundary. It starts the services directly and serves the web app from Vite on `http://localhost:5174`.

Current Vite wiring in that mode:

- `/api/*` is proxied directly to `http://localhost:3100`
- `/ws/executor` and `/ws/executor/internal` are proxied directly to the local executor websocket service
- published/latest workflow endpoints, Rivet web app routes, `/ui-auth`, and `/ws/latest-debugger` are not recreated through a trusted proxy layer
- Vite does not inject nginx's trusted proxy headers when it proxies `/api/*`

That means browser-driven control-plane routes that depend on proxy trust, including `/api/*`, `/ui-auth`, and `/ws/latest-debugger`, are not representative in `dev:local` unless you add your own trusted proxy in front. Use Docker dev for full hosted-shell routing and auth validation.
