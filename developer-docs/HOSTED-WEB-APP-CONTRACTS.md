# Hosted And Web App Contracts

Canonical guide for embedding Rivet and serving declarative Rivet web apps.

## Hosted Editor

`RivetAppHost` installs the same app providers used by desktop and exposes wrapper
policy through `ui`, executor configuration, and `RivetWorkspaceHost`. Wrappers own
their shell, authentication, persistence, publication, and route mapping. They do
not import app-internal atoms.

## Declarative Web Apps

`Project.uiGraphs` stores declarative UI resources. UI graphs are not executable
workflow graphs and cannot be a Main Graph. Actions target ordinary graphs in the
same project.

Shared component and interaction semantics live in core's UI-graph runtime model.
React desktop preview and the generated Node client both use
`createUiGraphInteractionController(...)` for UI state, per-button running/errors,
abort propagation, and stale-patch protection. Clipboard fallback and JSON downloads
also use core's browser-runtime helpers; only React-versus-direct-DOM rendering and
Markdown integration remain host adapters. A cross-host JSDOM parity test executes
the same UI graph through both adapters. The generated client is a checked artifact;
`packages/node/scripts/build-web-app-client.cjs --check` must fail when its source
changes without regeneration. Its build script fixes esbuild's working directory to
the Node package, so generating from the repository root or through a workspace
command produces the same artifact.

Core's `normalizeUiGraph(...)` / `normalizeProjectUiGraphs(...)` functions are the
shared structural boundary for wrapper-provided snapshots. They validate every
component and `runGraph` action discriminator and required field, and report
`UiGraphNormalizationError.issues` with UI graph IDs, component indexes, nested
binding indexes, and field names. The only automatic migration repairs missing,
blank, or duplicate legacy component IDs. A wrong-type ID, unknown component,
missing action/state key, or invalid enum is rejected rather than reaching a
renderer. Hosted editor project snapshots are normalized before app state is
updated, and the Node serving APIs normalize direct inputs before rendering or
dispatch.

## Node Serving API

- `renderRivetWebAppHtml(...)` renders the document/runtime payload.
- `runRivetWebAppAction(...)` validates mappings and runs the target graph.
- `createRivetWebAppHandler(...)` provides the Fetch-style reference host.
- `getRivetWebAppAssetManifest()` exposes the immutable browser assets for
  lower-level or CDN-backed hosts.

`createRivetWebAppHandler(...)` validates and applies legacy ID repair to the
project's complete `uiGraphs` collection when the handler is created. Lower-level
`renderRivetWebAppHtml(...)` and `runRivetWebAppAction(...)` validate the selected
UI graph directly. Wrappers should surface `UiGraphNormalizationError.message` (or
its structured `issues`) as a project/publication configuration error; it is not an
action request error and should not be retried.

`validateProjectUiGraphButtonBindings(...)` is the publication/load preflight for
hosts that want to inspect every web-app button without mutating an immutable
revision. Hosted action execution runs the same component-level preflight and
rejects stale or ambiguous mappings as `400` with code
`invalid_button_bindings`. Omitted inputs and outputs remain valid because graph
defaults and intentionally ignored outputs are part of the action contract.

### Asset And CSP Modes

`inline` is the default asset mode and keeps each HTML response self-contained.
`external` mode removes inline style and executable script content from the page.
The reference handler serves its content-addressed CSS and JavaScript below
`<basePath>/_rivet/assets`; that path is reserved while external mode is active.
The asset route supports `GET` and `HEAD`; neither successful nor missing `HEAD`
responses include a body. Asset responses use one-year immutable caching, strong
ETags, explicit MIME types, and `X-Content-Type-Options: nosniff`. HTML tags also
carry SHA-256 Subresource Integrity metadata.

Wrappers that call `renderRivetWebAppHtml(...)` directly should serve the entries
from `getRivetWebAppAssetManifest()` and pass their route or absolute CDN URL as
`assetBasePath`. Use each entry's `content`, `contentType`, `etag`, and `fileName`
without rewriting the content or filename. A cross-origin asset host must permit
anonymous CORS because the generated tags combine SRI with
`crossorigin="anonymous"`.

The serialized UI graph and initial state live in a non-executable data attribute,
not an inline bootstrap script. External same-origin mode therefore supports a
strict `script-src 'self'; style-src 'self'` policy. For self-contained pages,
`renderRivetWebAppHtml(...)` accepts `cspNonce`; the reference handler's
`resolveCspNonce(request)` resolves one per HTML response. Rivet applies that value
to every inline style/script tag (and external scripts for `strict-dynamic`
policies), but the host owns nonce generation and the matching
`Content-Security-Policy` response header. Never reuse a nonce between responses.
The shared clipboard fallback uses a renderer CSS class rather than assigning DOM
inline styles, so copying output does not weaken that policy after first paint.
The packaged Markdown stylesheet uses a data-URL mask, so a complete host policy
also needs `img-src data:`; allowlist any remote Markdown image origins separately.
Handler tests boot the external page and reject browser assets that introduce
`eval(...)` or the `Function(...)` constructor, preserving operation without
`'unsafe-eval'` as dependencies change.

Processor options are action/request scoped. Wrappers retain Express/Fastify route,
auth, revision, storage, recordings, headers, and error-envelope ownership.
`revisionKey` is an opaque consistency token, not authentication; stale actions
return the machine-readable `revision_mismatch` conflict used by the shared reload
modal.

The generated browser client reads every action response body as text once before
attempting to parse the JSON action protocol. JSON errors continue to use their
`error` and `code` fields, including the `revision_mismatch` reload flow. A failed
empty, HTML, or other non-JSON response is rendered only as its HTTP status message
(for example, `413 Request Entity Too Large`), never as proxy content or a JSON
parser error. A successful non-JSON response is treated as an invalid action
response.

Each button action has a narrow state boundary. The React preview and generated
browser client project UI state to only the data keys named by that button's graph
input bindings before crossing an action boundary. `runRivetWebAppAction(...)`
repeats the projection for direct host calls, so lifecycle hooks and
`createProcessorOptions` receive only those action-relevant keys. Unrelated form
values and prior output state remain local to the web app.

Button execution is request-scoped rather than represented by one global pending
button. Different buttons can remain active independently, while a second click on
the same pending button is ignored. If concurrent actions write the same UI data
key, the latest-started action owns that key; disjoint state patches still apply,
and a newer direct form edit prevents an older action from overwriting it.

The generated client aborts active fetches when the page unloads and aborts sibling
requests after a revision mismatch. `runRivetWebAppAction(...)` prefers an explicit
`createProcessorOptions.abortSignal`, then falls back to the supplied Fetch
`Request.signal`. It forwards that source through an action-scoped signal and removes
the forwarding listener as soon as processor execution settles, so a wrapper may
safely reuse a longer-lived cancellation signal without retaining completed processors.
Wrappers that adapt Express requests should bridge their
disconnect/close event into that Fetch signal (or return an explicit signal) when
they want abandoned browser actions to stop the underlying graph run.

## Security

Web apps are declarative: no project JavaScript or arbitrary HTML execution.
Markdown and rich content use the shared sanitization policy. Action routes should
be same-origin and wrapper-authenticated. Do not put credentials, request headers,
or secrets in UI-graph state, HTML payloads, cache keys, or lifecycle hooks.

## Parity Tests

Core runtime-model tests define component/action semantics. Node client tests execute
the generated runtime in JSDOM. React tests cover app-specific editing/preview
behavior. Do not maintain two hand-written component interpreters or test parity by
matching similar source strings.
