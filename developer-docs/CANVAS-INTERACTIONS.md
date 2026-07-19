# Canvas Interactions

Canonical ownership guide for graph canvas selection, ports, connections, and
resource canvases.

## Interaction Owners

- `NodeCanvasViewport` renders nodes and applies selected execution-page status.
- `WireLayer` renders connections and connection comparison/hover/bend state.
- `useNodeCanvasInteractions` owns pointer/keyboard canvas gestures.
- `domain/graphEditing` owns pure connection, port, and variadic-reorder mutations.
- `useEditNodeCommand` and related command hooks are the undoable mutation boundary.

Do not mutate graph arrays directly from node body controls. Canvas controls use the
same commands as settings editors so undo/redo, connection recovery, comparison, and
serialization remain aligned.

## Connection Mode

Connection mode survives canvas pan/zoom and keeps its pending wire attached to the
pointer. It exits on successful connection, right-click canvas, consumed Escape, or
click outside the canvas. Existing connections are removed only by the intended
left-click/reconnect path; right-click must not disconnect them.

Wire hit testing uses a wider invisible interaction path rather than expensive
geometry work in JavaScript. Bend points are graph connection metadata and older
Rivet versions ignore them while still rendering the underlying connection.

Before a wire is created or rewired, `useDraggingWire` validates the complete
proposed topology. It rejects any connection that would leave an enabled
**Start Async Branch** subtree invalid: a Graph Output in the subtree, a route
back into the trigger, or an input from outside the subtree. It shows the
matching runtime-style warning instead of saving the wire. The pure traversal
lives in `domain/graphEditing/connectionValidation.ts`. Disconnect the invalid
wire first when repairing a malformed graph. Runtime validation remains the
defense in depth for serialized graphs and non-editor callers.

## Tool Continuation Connections

[`toolContinuationWireState.ts`](../packages/app/src/components/nodeCanvas/toolContinuationWireState.ts)
uses core's graph-level `resolveToolContinuationConnections(...)` result to decorate the
ordinary persisted connection from LLM Chat `Tool Calls` (`function-calls`) to
Delegate Tool Call `Tool Call` (`function-call`). A valid continuation wire uses
two thin, parallel lanes to communicate the runtime request/response relationship:
the forward lane has an arrowhead at the Delegate end and the return lane has one
at the LLM end. It animates only while the selected Delegate process page is
running. Idle lanes and arrowheads retain the ordinary wire color; hover and
active execution apply the normal primary highlight to the lanes. Respect
`prefers-reduced-motion`, and for bent connections put markers only on the two
outer segment endpoints. Project Compare remains visible on valid continuation
wires: added, changed, and removed wire colors also color the matching arrowheads
while the two lanes remain thin. Ambiguous continuation styling has higher
priority and stays red and dashed in every comparison state.

Paired lanes are normal-offset from samples of the same wire geometry; do not
translate their endpoints. Endpoint translation makes the two Bézier curves
converge and diverge, while normal offsets keep their separation constant along
the rendered route. The first and last normals follow the wire's horizontal
port tangents exactly, so a steep or short route still begins and ends on its
own port.

Ambiguous eligible connections are red and dashed rather than silently choosing
a Delegate. The hover title explains that auto-continuation requires exactly one
connected Delegate. These visuals do not add a connection kind to project data:
turning off tool use or auto-continuation, disabling an endpoint, or changing the
connection makes the same stored wire ordinary again. Enabling **Run per item**
on LLM Chat also keeps the wire ordinary because split-run continuation is not
upgraded in this iteration.

The connected Delegate's persisted `assistant-message` output is presented as
`Message (fires before tool call invocation)` and requires no editor toggle.
The context-menu freeze policy uses the same continuation resolution and
disables freezing that Delegate, because frozen replay cannot participate in the
live request/response loop. Keep wire styling, freeze eligibility, and runtime
behavior derived from the shared resolver so they cannot disagree. Editor
callers must resolve linked Node library instances before this analysis,
matching graph preprocessing at runtime: `WireLayer` uses
`effectiveNodesByIdState`, while context-menu policy resolves the current
graph's prefab instances with the current project.

Persisted graphs can also contain stale connections whose input or output port
no longer exists. Core preprocessing removes those edges before choosing the
first effective input connection. The app's
`definitionValidConnectionsState` derives the same port-definition-valid view
for the wire, graph-aware node editors, and context-menu policy; do not resolve
continuation semantics against raw serialized connection order. The selector
caches input/output port-id sets once per endpoint node during each evaluation,
so validating many edges on one variadic node remains linear in the number of
ports and connections rather than repeatedly scanning the same definitions.
Canvas surfaces with connections disabled, such as Node library editing, keep
their own local connection list instead of combining decorative nodes with the
active graph's definition-valid connections.

## Selection And Navigation

Shift drag-selection accumulates groups while Shift remains held. Page Up, Page
Down, and Home navigate graph/resource history through the shared workspace target,
including Node library. Fit-to-content has a maximum zoom so one or two nodes do not
fill the viewport.

## Node Library Canvas

Node library reuses normal canvas behavior where meaningful: settings close on
canvas click, alignment tools, selection, Alt-drag duplication, port display, and
viewport restoration. Ports are decorative and cannot create connections. Copying
normal graph nodes into the library creates supported reusable library nodes;
copying linked instances back as sources is blocked.

## Tests

Use pure graph-editing tests for connection recovery, drag actions, variadic reorder,
and bend-point persistence. Use focused browser/visual tests only for hit targets,
pointer capture, portals, or layout that pure geometry cannot prove.
