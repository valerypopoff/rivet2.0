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

Shared component semantics live in core's UI-graph runtime model. React desktop
preview and the generated Node client consume that model. The generated client is a
checked artifact; `packages/node/scripts/build-web-app-client.mjs --check` must fail
when its source changes without regeneration.

## Node Serving API

- `renderRivetWebAppHtml(...)` renders the document/runtime payload.
- `runRivetWebAppAction(...)` validates mappings and runs the target graph.
- `createRivetWebAppHandler(...)` provides the Fetch-style reference host.

Processor options are action/request scoped. Wrappers retain Express/Fastify route,
auth, revision, storage, recordings, headers, and error-envelope ownership.
`revisionKey` is an opaque consistency token, not authentication; stale actions
return the machine-readable `revision_mismatch` conflict used by the shared reload
modal.

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
