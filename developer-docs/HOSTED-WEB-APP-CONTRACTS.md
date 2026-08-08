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
- `prepareRivetWebAppAction(...)` exposes the validated processor before its
  one-shot `run()` for transports that attach progress listeners or recorders.
  A host that abandons a prepared action must call its idempotent `dispose()`.
- `createRivetWebAppHandler(...)` provides the Fetch-style reference host.
- `createRivetWebAppWebSocketGateway(...)` provides the resumable long-running
  action protocol for an authenticated `ws` connection.
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

Knowledge Source nodes use the same host seam across HTTP and WebSocket actions. A
static handler/session can provide `knowledgeStores`; request-scoped
`createProcessorOptions(context)` takes precedence. The registry contains live store
callbacks and is not browser state. Authenticated and multi-tenant hosts should build
it after resolving the request identity. See
[Provider-neutral Knowledge Source API](./KNOWLEDGE-SOURCE-API.md).

The generated browser client reads every action response body as text once before
attempting to parse the JSON action protocol. JSON errors continue to use their
`error` and `code` fields, including the `revision_mismatch` reload flow. A failed
empty, HTML, or other non-JSON response is rendered only as its HTTP status message
(for example, `413 Request Entity Too Large`), never as proxy content or a JSON
parser error. A successful non-JSON response is treated as an invalid action
response.

Each workflow-bound component has a narrow state boundary. The React preview and
generated browser client project UI state for a Button to only the data keys named
by that button's graph input bindings. Chat projects its own validated user/assistant
conversation and any data keys named by its additional input mappings, excluding its
draft and every unrelated app key. Action input resolution then sends the latest user
turn separately and converts only earlier turns into the native history Data Value.
Chat messages may additionally contain an optional browser-owned UTC ISO timestamp.
The browser stamps a user turn when it is submitted and stamps an assistant turn when
the completed action result arrives, so hosted HTTP and WebSocket responses use the
actual browser receipt time rather than a server clock. Timestamp metadata persists
with browser chat history and is formatted in the browser's locale and timezone, but
is stripped when Rivet converts conversation history to graph `chat-message[]` input.
Custom browser renderers can use `getUiGraphChatMessagePresentations(messages)` from
`@valerypopoff/rivet2-core/web-app-runtime` to render the local times and the
transition-only date separators without modifying Chat state. The timestamp
presentation for an assistant turn additionally exposes a browser-observed
`elapsedSincePreviousUserMessage` string when the closest preceding user turn has
a valid earlier timestamp. The React and hosted renderers append that string as a
second line in the message-time tooltip; it measures end-to-end browser time, not
only model inference time.
`runRivetWebAppAction(...)` repeats the projection for direct host calls, so
lifecycle hooks and `createProcessorOptions` receive only action-relevant state.
Unrelated form values and prior output state remain local to the web app.

Action execution is request-scoped rather than represented by one global pending
control. Different Button and Chat components can remain active independently,
while a second submission to the same pending component is ignored. If concurrent
Button actions write the same UI data key, the latest-started action owns that key;
disjoint state patches still apply, and a newer direct form edit prevents an older
action from overwriting it. Chat message keys are component-specific.

Web-app actions use the processor's early-output mode. If normal foreground
scheduling has completed and only managed Start Async Branch work remains,
`graphOutputsReady` releases the mapped Button/Chat result while the processor
continues Running. The terminal `graphFinish`/`done` events, resource cleanup, and
late async failures remain tied to `waitForRunCompletion()`. HTTP returns the JSON
action response at the early boundary. WebSocket publishes `action.completed` at
that boundary but retains the processor in its local active-run capacity until it
fully settles. The durable row is already terminal, so it is removed from lease
renewal at publication instead of being misclassified as a lost running lease.
It also defers `onRunFinished` until then, so a recorder attached through
`onProcessorPrepared` includes the async tail when the host persists it.
Request- or session-scoped abort forwarding also remains attached through that
full lifecycle, so returning the foreground result does not make the async tail
uncancellable.

Core graph processors provide the External Call function `setWebAppStatus`,
including desktop Node processors and nested graphs. The function receives the first
External Call argument, converts strings directly and other values to JSON/string
text, then reports it through normal `GraphProgress`; the shared normalizer caps the
visible message before transport. Web-app action processors reserve the name after
host options are applied, so the web-app behavior cannot be replaced accidentally.
Desktop preview receives the message through its local progress callback; hosted
WebSocket pages receive it as an `action.progress` event. HTTP actions retain the
same function for consistency, but cannot display intermediate status before the
response completes. Status is component-scoped, renders beneath its Button controls,
and is cleared by the shared interaction controller when the action finishes, fails,
is cancelled, or is interrupted. Ordinary graph runs may emit the same progress
event, but only a host with a web-app progress surface displays it. Other
host-supplied external functions are preserved, and no web-app-specific executor
marker is needed.

Persistent workflow state uses the built-in `Set Stored Value` and `Get Stored
Value` nodes. One controller belongs to the root graph run and is shared with
subgraphs and delegated tool graphs. It is read-through/write-through, loads a key
at most once per run, serializes same-key operations, and updates its synchronous
cache only after a successful backing-store write. The portable value contract is
strict JSON: `null`, booleans, finite numbers, strings, arrays, and plain objects.
Undefined values, functions, cycles, binary/media values, and malformed callback
results fail the node. Missing values remain distinct from stored `null` through
the Get node's `Found` output.

Web-app persistence defaults to the browser. The server never reads browser
`localStorage` directly. Each HTTP or WebSocket action carries a JSON-object
snapshot scoped by origin, normalized app pathname, and UI graph ID. The action
uses that snapshot as its controller's backing store and returns successful
changed-key writes in `storagePatch`; the browser merges the patch into the latest
app record without replacing disjoint keys. Per-key action ordering advances only
after that merge is persisted, so a failed newer write cannot suppress an older
successful action that completes later. Storage never enters component UI
state, graph input mapping, or lifecycle-hook state projection.
The patch is response-bound: writes performed only after an early web-app result
cannot be delivered in that HTTP/WebSocket completion payload. Put browser-backed
Set Stored Value nodes on the foreground path. A host callback-backed store writes
through directly and is the supported persistence mechanism for async branches.

Hosts can provide `storedValueStore` to `runGraph(...)`, `createProcessor(...)`,
`runRivetWebAppAction(...)`, a web-app handler, or a WebSocket session. A
request-scoped store returned by `createProcessorOptions(context)` overrides a
static web-app store. Either host store overrides the browser snapshot. In
callback-backed mode Rivet sends no writes back to browser storage; switching modes
does not migrate or erase either store. Callback errors fail the action without a
fallback. Hosts own tenancy, authentication, namespacing, authorization, and
cross-request concurrency.

The editor's Browser executor supplies a snapshot-backed store directly. Its
internal Node executor sends the same snapshot over the request-scoped debugger
protocol, creates the store in the sidecar, and returns the changed-key patch before
the successful terminal result. External Remote Debugger sessions do not permit
editor-originated web-app actions, so they never receive a browser-storage bridge.

The desktop **Run detached** preview keeps the durable app-local record in the
parent Rivet window rather than relying on its Tauri child webview's browser
storage. The parent sends that record when the preview starts (or requests its
payload), supplies the latest record to every action, and persists each successful
patch before replying. The detached renderer keeps the same record in memory between
actions, which makes storage work even when Tauri isolates `localStorage` per
webview. Its temporary bootstrap payload is best-effort browser storage only: if
either webview cannot access it, the child requests the same payload from the parent
over its token-scoped `BroadcastChannel`.

Ordinary Browser, Node, core, and headless runs create a fresh memory controller for
every top-level run. Reusing a processor therefore does not retain values by itself;
only a browser or host store persists across runs. Frozen Set Stored Value replay
seeds the run cache for downstream nodes without repeating the durable write.

`getWebAppStorage` and `setWebAppStorage` are no longer built-in External Calls.
This is an intentional breaking change; existing workflows must use the dedicated
nodes.

### Long-running WebSocket actions

HTTP actions remain the compatibility/default path. A host opts a rendered page
into resumable actions with:

```typescript
renderRivetWebAppHtml(uiGraph, {
  actionTransport: {
    type: 'websocket',
    socketPath: `/apps/${slug}/actions/ws`,
  },
  revisionKey,
});
```

The browser creates one socket per page, sends a random action `requestId`, and
receives a server-assigned `runId` plus monotonic event `sequence`. A reconnecting
page resumes with `{ runId, lastSequence }`; the gateway replays newer retained
events. Run attachment replays the first snapshot, subscribes, and then performs a
catch-up read so a completion cannot disappear in the read/subscribe gap. Repeating
the same request ID and component within the same owner scope reattaches to the
original run instead of starting the graph twice; reusing it for another component
is rejected as `request_id_conflict`. There is deliberately no silent
fallback from WebSocket to POST, because replaying a request through another
transport could duplicate side effects.

Each socket must first send `client.hello` with the exported protocol version. The
gateway closes missing or unsupported handshakes with WebSocket protocol error
code `1002`; idle clients that never finish the handshake are closed after the
configurable timeout. Only a valid hello receives `server.ready`; the generated
client waits for that acknowledgement before sending starts or resumes. Temporary
network/abnormal closes reconnect, while protocol, unsupported-data,
invalid-payload, policy, and oversized-message closes (`1002`, `1003`, `1007`,
`1008`, `1009`) are surfaced immediately because retrying the same rejected
connection cannot recover. Reconnect backoff resets only after a valid
`server.ready` message, not merely after the TCP/WebSocket connection opens, so a
proxy that repeatedly accepts and drops an unusable socket cannot create a tight
retry loop. Relative HTTP paths are upgraded to `ws`/`wss`; explicit `ws://` and
`wss://` endpoints retain their configured scheme.

The host must authenticate the upgrade and resolve the permitted immutable project
revision/UI graph before calling `gateway.handleConnection(socket, session)`.
`session.ownerScope` is the authorization boundary for start, resume, and cancel;
use a stable composite such as tenant, principal, app endpoint, and revision. It is
not an authentication token. Session processor options, context, datasets, project
references, telemetry, and lifecycle hooks remain request/connection scoped and use
the same `prepareRivetWebAppAction(...)` validation and mapping as HTTP actions.
The optional session `onProcessorPrepared(...)` hook is awaited after the actual
`GraphProcessor` is created and before `run()` or `onActionStart`. It receives the
processor, action context, client request ID, and server run ID so wrappers can
attach `ExecutionRecorder`, timing listeners, and other processor observers without
reimplementing the socket protocol. Hook failures prevent execution, report the
original exception through gateway `onError`, and expose only `action_unavailable`
to the browser. The gateway disposes the prepared action in this path, which
releases pre-run Remote Debugger attachments and other processor-owned transport
resources. Cancellation while the hook is pending follows the same cleanup path.

`onRunFinished(...)` and `onRunFailed(...)` are session-only terminal hooks for
recording/telemetry ownership. They preserve the exact action context, client request
ID, and server run ID received during `onProcessorPrepared(...)`, so hosts must key
recorders by `runId`, never by a component ID or mutable UI state. The successful hook
also receives the action result. The failed hook receives a terminal outcome of
`failed`, `cancelled`, or `interrupted`, plus the original error when available;
lease-recovery interruptions fall back to their persisted interruption message.
Rivet invokes at most one terminal hook only after the corresponding terminal event
is durably stored. Hook exceptions are reported through gateway `onError` and must not
change protocol state, graph execution, or the persisted terminal event.
If cancellation arrives while `onProcessorPrepared(...)` is still attaching a recorder,
the browser receives its persisted cancellation immediately while Rivet waits to invoke
the terminal hook until that attachment settles.

`createInMemoryRivetWebAppRunStore(...)` and
`createInMemoryRivetWebAppRunCoordinator(...)` are reference/local defaults. The
store survives socket and proxy disconnects, retains the accepted event plus bounded
recent event history, and prunes old completed runs. The coordinator lets several
gateways in one Node process forward events and cancellation. Neither survives a
process restart or coordinates separate replicas.

Production multi-instance hosts should implement `RivetWebAppRunStore` in their
database and `RivetWebAppRunCoordinator` over their internal message bus. The
coordinator routes cancellation to the `hostId` that owns the live processor and
publishes persisted events to reconnecting gateways. A reconnect may therefore land
on any replica: it replays durable events, subscribes to the owner, then performs a
second durable read to close the read/subscribe race. Event delivery may be
duplicated or reordered: the gateway de-duplicates by durable sequence and fills
sequence gaps from the run store before forwarding later events. Coordinator
subscriptions must be active before `subscribe(...)` resolves. A missing live owner
is not by itself a definitive coordinator failure because lease recovery may still
publish the terminal interruption.

The durable store is the authority for idempotency, event ordering, and ownership
leases. `createRun(...)` atomically reserves `(ownerScope, requestId)` and derives
`leaseExpiresAt` from `leaseDurationMs` using the store/database clock.
`appendEvent(...)` atomically verifies the unexpired `leaseId`, assigns the next
sequence, verifies the event's run/request identity, and appends the event. Run IDs
must also be globally unique independently of the `(ownerScope, requestId)`
idempotency key. Store reads must return detached snapshots so a caller cannot mutate
durable replay state. `renewRunLeases(...)` renews only the explicitly
listed active run IDs still owned by that lease and returns the IDs it renewed.
`interruptExpiredRuns(...)` atomically adds one `action.interrupted` terminal to
expired running rows; concurrent recovery workers must not both recover the same
row. `interruptRunsByLease(...)` is the graceful-shutdown equivalent for one process
incarnation. The gateway serializes its own event appends per run, so slower progress
persistence cannot overtake a later terminal event.
The in-memory store's `maxStoredRuns` is a hard process-wide bound. It prunes old
terminal runs first and rejects a new run when every retained slot is still active;
production wrappers should combine durable retention with wrapper-owned global and
per-principal quotas.
`hostId` is a unique routing identity for the current gateway process, while the
gateway-generated `leaseId` identifies that exact process incarnation. Neither must
survive a Deployment pod replacement. Active gateways renew only runs still present
in their processor map. All gateways periodically recover expired rows, and
`recoverInterruptedRuns()` is available for an explicit startup/operations sweep.
This turns a dead pod's rows into durable `action.interrupted` terminals without
knowing the old pod name. The recovering worker publishes that terminal under the
original run identity so an already reconnected browser settles. Rivet never moves or
pretends to resume the dead process's in-memory `GraphProcessor`.

Without a coordinator, cross-process live resume/cancel still fails explicitly as
`run_unavailable`; a durable store alone cannot reach a live processor. With both
adapters, sticky client-IP or WebSocket routing is unnecessary. The wrapper remains
responsible for implementing and operating the database and message-bus adapters.

The gateway validates resource-limit options at construction, limits message size
and active runs per owner scope, validates every protocol message, checks ownership
on resume/cancel, and shares the debugger's ping/pong heartbeat utility. Missing,
pruned, unauthorized, or process-orphaned run
handles receive the same `run_unavailable` rejection so the client settles instead
of waiting forever without disclosing whether another owner has that run ID. A cancel
that races with a stored terminal event replays the terminal result. `drain()` rejects
genuinely new starts while allowing existing runs to finish and idempotent request IDs
to reattach. A start whose durable run reservation races with draining is finalized
as interrupted and never reaches processor creation. The reservation retains its owner
scope until settlement, so that interruption is also published to clients already
reattached through another gateway. `dispose({ interrupt: true })`
marks unfinished stored runs owned by that gateway host as interrupted, broadcasts
that terminal state, requests processor abort without waiting for a slow node to
become cooperative, and closes every gateway-owned socket with service-restart code
`1012`. The interruption is fenced by this gateway's `leaseId`, so one draining
replica cannot terminate a sibling's runs. Plain `dispose()` also closes idle sockets
and releases their heartbeat timers while leaving already-started processors to their host's shutdown policy;
later connections are rejected with `1012`. The
optional `onError` callback is the observability sink for asynchronous store/replay/
terminal-persistence failures, and callback failures are isolated from transport
cleanup; resume or cancel lookup failures also close the affected socket with code
`1011`. Pre-accept infrastructure errors are exposed to the page only as
`action_unavailable`, while the original error goes to `onError`. If terminal
persistence fails after a run was accepted, attached clients receive `run_unavailable`
instead of remaining in a permanent running state. Hosts still own websocket origin
policy, authentication, global rate limits, deployment draining order, and any
durable-store retention policy.

Disposal is a lifecycle barrier for gateway-owned setup work. Once disposal begins,
queued start messages are rejected and `dispose(...)` waits for any durable run
reservation already crossing `createRun(...)` before interrupting its lease and
unregistering the coordinator. It also awaits an already-running lease-maintenance
pass; that pass stops after its current store call and cannot recover runs or invoke
lease-loss callbacks after disposal has begun. This ordering prevents a late durable
row or maintenance callback from escaping graceful shutdown.

The hosted renderer rebuilds its direct DOM presentation when action status or
progress changes. It captures and restores the focused text control, selection, and
internal scroll position across that render so progress reports do not interrupt a
user typing in another component.

Every renderer includes the shared `Reset app` control in the upper-left toolbar.
Reset is session-only: it aborts active actions, clears action errors/progress, and
restores the UI graph's initial state without changing the project or YAML. The
desktop editor preview keeps its interaction controller in an in-memory registry
keyed by open project and UI graph, so switching to another graph or UI graph does
not lose entered fields, outputs, chat messages, or an in-flight action. An action
started in that embedded preview keeps running while its renderer is temporarily
unmounted by workspace navigation; reopening the preview reattaches the same
controller and shows its progress or completed result. Explicit Abort, Reset,
page unload, deleting that UI graph, and closing the project still abort its action.
Detached previews and hosted pages own their own controller and therefore start a
fresh session when they are opened or reloaded.

The Chat header uses the shared icon-only styling for its overflow, pins, and
search controls. Their hover and focus states change the icon color without
adding a button-shaped background, while all three controls keep larger hit
areas for reliable pointer and keyboard use. React preview and hosted DOM
rendering both consume this CSS from `UiGraphRendererStyles.ts`.

Chat bubbles keep Markdown blockquote text and its rule in the bubble foreground
color. Their sender-facing bottom corner is deliberately square: right for user
messages and left for assistant messages.

Text Input, Textarea, Chat composer, and Chat search controls also share an
explicit renderer-owned interaction style: hover uses the control hover
background, and focus uses a subtle foreground-mixed border with no outline or
box shadow. This prevents browser or host form-control focus styles from
creating different colors or weights across preview and hosted pages.

Output components use the shared renderer styles and have a responsive maximum
height with internal vertical scrolling, so large output values do not expand the
entire web-app page. The browser-runtime resize observer enables the native vertical
handle only when an expanded value exceeds that responsive cap, then bounds it from
one rendered content line through the value's natural rendered height. Both the
React preview and generated hosted client install the same observer; do not add
host-specific resize calculations.

`renderRivetWebAppHtml(...)` validates transport configuration at runtime as well as
through TypeScript: HTTP `actionPath` and WebSocket `socketPath` values must be
non-empty. This keeps JavaScript wrappers from publishing a page whose action runner
cannot connect.

Graph-authored status uses the built-in **Report Progress** passthrough node. It
emits a normalized optional message and/or percentage through GraphProcessor,
subgraphs, recordings, Browser execution, Node execution, Remote Debugger, desktop
preview, and the hosted socket. Progress is presentation-only and is never a graph
output. The shared interaction controller rejects progress from stale/cancelled
executions and keeps Button/Chat progress independent.

The generated client aborts active HTTP fetches when the page unloads. WebSocket
actions instead detach on unload so the server run can continue. Automatic replay
covers temporary socket loss while the same page is alive; a full reload does not
currently restore the browser-side run handle unless the host adds its own run
discovery/session restoration. Detach releases browser-side promises and listeners
without sending cancellation. Explicit **Abort** sends
`action.cancel`, immediately records/broadcasts `action.cancelled`, and requests
processor abort. Button actions keep their authored label and configured green
color while running, with reduced opacity, and show the shared circular running
indicator to its right. Revision mismatch remains a
terminal error and uses the existing
blocking reload modal. `runRivetWebAppAction(...)` prefers an explicit
`createProcessorOptions.abortSignal`, then falls back to the supplied Fetch
`Request.signal`. It forwards that source through an action-scoped signal and removes
the forwarding listener as soon as processor execution settles, so a wrapper may
safely reuse a longer-lived cancellation signal without retaining completed processors.
Wrappers that adapt Express requests should bridge their
disconnect/close event into that Fetch signal (or return an explicit signal) when
they want abandoned browser actions to stop the underlying graph run.
When browser navigation places a hosted page into the back/forward cache, `pagehide`
still detaches active actions and closes the page's socket. A persisted `pageshow`
creates a fresh transport while retaining the restored interaction state, so buttons
remain usable after browser back/forward restoration instead of targeting a disposed
WebSocket runner.

## Security

### Optional Chat response inspection

Chat response inspection is opt-in per component through
`allowResponseInspection`; the default is `false`. When disabled, the action
runner must not collect, transport, persist, or expose an `AgentResponseTrace`.
When enabled, HTTP results and protocol-v1 `action.completed` messages may add an
optional `responseTrace`. This is an additive v1 field: older clients ignore it,
and newer clients show **Trace unavailable** if an older host omits it. Clients
also ignore an invalid or future-version optional trace without discarding the
otherwise valid `action.completed` state patch.

Assistant messages store only an optional `responseTraceId`. Conversation
history conversion ignores that field, so trace metadata never enters later LLM
context. Validated traces are stored separately from messages, scoped by app
path, UI graph, and Chat component; the browser keeps the newest 100 and prunes
orphans after history changes. Unavailable browser storage falls back to
in-memory storage for the page session. If a browser-storage write fails, that
in-memory copy remains authoritative until a later write succeeds, so an older
persisted record cannot hide a response trace that the current page just
produced. Disabling response inspection strips earlier trace IDs from persisted
messages and deletes that Chat component's separately stored trace data; later
trace-save attempts are ignored while inspection remains disabled.

The assistant-message menu order is **Open in reading view**, **Inspect
response**, **Remove message**. The shared accessible inspector groups metadata
into **Execution**, **Recovery behavior**, **Usage and cost**, and **Timing**,
then lists physical model and tool calls. **Provider request retries** means a
failed request was repeated; **LLM profile fallbacks** means execution moved to
the next configured profile. Correlation identities remain in the portable
trace for runtime isolation, recordings, and retention, but the normal inspector
does not render opaque trace, graph, node, or process IDs. Both React and
generated hosted renderers must validate the portable trace before rendering it.

The trace duration ends when graph outputs are ready. If managed async branches
remain active, the trace reports that fact without delaying the foreground
response. The trace contract forbids prompts, messages, generated text,
reasoning, tool arguments/results, retrieved content, raw provider bodies,
headers, credentials, and raw errors.

Web apps are declarative: no project JavaScript or arbitrary HTML execution.
Markdown and rich content use the shared sanitization policy. Action routes should
be same-origin and wrapper-authenticated. Do not put credentials, request headers,
or secrets in UI-graph state, HTML payloads, cache keys, or lifecycle hooks.

After sanitized Chat Markdown is inserted, both renderer adapters call
`enhanceUiGraphChatJsonCodeBlocks(...)` from the narrow core web-app-runtime
export. It decorates only `pre > code.language-json` blocks with Rivet-created
Copy JSON and Download JSON buttons. Button markup can never come from authored
Markdown. Each action closes over that code element's decoded `textContent`, so
prose, fences, neighboring blocks, and later DOM controls are excluded without
parsing or reformatting JSON. The helper applies to ordinary user and assistant
messages; compact pinned previews retain their usual Markdown-text rendering.
Non-JSON fences and inline code are untouched. Downloads reuse
the Output component's application/json filename utility. The original Markdown
source remains the browser-persisted Chat message and is sent unchanged through
later history inputs.

Chat JSON cards preserve their full-width code area and their top-right controls.
The shared post-render helper measures each code panel after it is inserted and
adds a scrollbar class only when it overflows vertically. That class applies the
same 1em safe inset used by the regular Output component; short JSON cards keep
their original control position.

## Parity Tests

Core runtime-model tests define component/action semantics. Node client tests execute
the generated runtime in JSDOM. React tests cover app-specific editing/preview
behavior. Do not maintain two hand-written component interpreters or test parity by
matching similar source strings.
