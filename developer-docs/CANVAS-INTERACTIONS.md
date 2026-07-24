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
at the LLM end. It animates while any Delegate process in the selected graph run
is running; the selected process page still owns the displayed inputs, outputs,
and success/error styling. This aggregate running rule also drives node-header
running chrome, so a faster last-started parallel call cannot make the Delegate
look idle while an earlier sibling is still active. Idle lanes and arrowheads
retain the ordinary wire color; hover and active execution apply the normal
primary highlight to the lanes. Respect
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

## Passthrough Data Buses

`PassthroughNodeData.renderAsDataBus` is canvas-only presentation metadata. A
renderable bus must be an ordinary Passthrough with Conditional and split-run
execution disabled. `canRenderPassthroughAsDataBus(...)` is the shared guard:
the node editor uses it to disable incompatible controls, the viewport uses it
to hide the rectangular card, and wire/antenna classification uses it to avoid
presenting malformed hand-edited graphs as valid buses. An incompatible node
falls back to its normal visible card so the user can see and repair its actual
execution semantics.

Project data does not gain a connection type. A bus remains a normal
`passthrough` node with paired `inputN` / `outputN` ports and ordinary
`NodeConnection` records:

```yaml
'[bus]:passthrough "Shared values"':
  data:
    renderAsDataBus: true
  outgoingConnections:
    - output1->"Receiver" input
```

The provider is another ordinary connection into `input1`. Core derives the
highest Passthrough channel from connections on both the input and output sides.
Core also owns the maximum accepted Passthrough port index; editor-side bus
classification uses that same bound so malformed imported ports cannot be
presented as channels the runtime will never expose.
That preserves an output-only channel after its provider is disconnected, so
the rail can show **Missing provider** and keep downstream connections
repairable. Passthrough execution maps each present `inputN` directly to the
same `outputN`; it does not assume sparse inputs are contiguous.
Port suffixes are accepted only within the bounded Passthrough range, so
malformed imported connections cannot force the editor to allocate an
unbounded number of synthetic port definitions.
The editor normally enforces one provider per input. If imported or hand-edited
project data contains several providers for one bus channel, the rail labels
the conflict instead of silently presenting the first provider as authoritative;
the connected input can be disconnected repeatedly until one provider remains.

`DataBusRail` renders one sticky top-of-canvas bus shelf per eligible
Passthrough. A shelf is deliberately a compact, single-line canvas control
rather than a clipped or immovable node card: the node name, settings action,
and horizontally arranged channels share one shallow strip below the desktop
navigation bar. When the combined intrinsic content of the visible shelves
exceeds the compact `min(70vw, 760px * UI scale)` cap, all visible buses promote
into dedicated full-width rows immediately below the project tabs. Each bus
retains its own panel row; rows stack vertically in graph order rather than
flattening several buses into one strip. Every row begins at the live right
edge of an open left sidebar, while its bus content remains centered in the
remaining width. The `dataBusFullRowCountState` atom records the number of
reserved rows, and `getDataBusFullRowsHeight` is the shared height calculation
used by both root layout CSS and canvas coordinate conversion. The complete
stack reserves real vertical space: the canvas surface, node editor, borders,
notices, and top controls all move down and the usable canvas height shrinks by
one fixed row height per bus. `GraphBuilder` itself keeps the full viewport
height while the canvas is shifted and shortened inside it; this ensures
absolutely positioned sibling panels use the window bottom and do not subtract
the bus-row stack a second time. The left sidebar remains beside the rows
instead of moving below them. In this mode, each full-width row is the panel surface;
the centered bus content has no independent card border, radius, shadow, or
background. Detection uses
the summed intrinsic header and channel widths plus inter-shelf gaps rather than
the currently constrained shelf width, which prevents an expand/collapse
measurement loop. The live sidebar width participates in that calculation and
also centers a compact shelf inside the unobstructed canvas area. Rail and channel overflow remain
horizontally scrollable while their scrollbars stay visually hidden, including
while a wire drag exposes larger port hit targets. A vertical wheel gesture
over an overflowing shelf is translated to horizontal scrolling; wheel events
over the shelf never pan or zoom the canvas.
Each populated channel is labelled `<source node> / <source output>`, exposes
the normal input port for rewiring, exposes the paired output port for adding
receivers, and shows the receiver count. Those existing channels scroll only in
the space between the fixed Passthrough header and a fixed **Connect provider**
terminal input. That terminal input is the ordinary next Passthrough slot with
no paired output yet; pinning its presentation does not change its connection
or execution semantics. The settings action selects the hidden node and opens
its ordinary node editor. Search selection and project-comparison node styling
remain visible on the shelf.
Go-to-node navigation recognizes a renderable bus and loads/selects its graph
without panning to the hidden node card's saved spatial coordinates.
The rail is not a spatial node card, so its root deliberately suppresses
right-click context menus across groups, padding, and full-row background.
Shift-click still delegates to normal node selection, preserving
multi-node copy/delete behavior without making the viewport-fixed group
draggable.
The header is shrinkable and title text is ellipsized, so an unusually long
Passthrough title cannot push the fixed **Connect provider** control out of the
available row.
Each group indexes its incoming and outgoing connections once; channel rows do
not repeatedly filter the graph-wide connection list.
The rail and endpoint antenna index consume the same definition-valid preview
connection list as normal node ports. During an input-origin rewire, the
temporarily removed original edge therefore disappears from the provider label,
receiver count, and antenna presentation together instead of leaving a stale
radio marker behind the live drag wire.

Data-bus presentation is enabled only on connection-enabled graph canvases.
Connection-disabled surfaces such as the Node library builder keep the
Passthrough card visible, even if its portable node data enables the mode; this
preserves access to the source node in editors that do not expose graph wiring.

Hidden buses are excluded from box-selection, viewport culling, node drag and
duplicate groups, and alignment operations. Their saved `visualData` is kept
only as the location to restore if data-bus presentation is later turned off;
fixed-rail interaction must not mutate that invisible spatial footprint.

`dataBusModel.ts` is the pure classification boundary. `WireLayer` suppresses a
bus provider or consumer wire only after that exact connection exists in the
definition-valid persisted connection set. The in-progress `draggingWire`
therefore stays an ordinary visible wire. `NodePorts` derives antenna metadata
from one memoized endpoint index built from the same scoped effective-node and
definition-valid preview-connection view. Port rendering performs a direct lookup
instead of rescanning every graph connection for every visible port. Ordinary
wires and compact router-mast antennas can coexist on one source port. Each
mast leaves the port horizontally into the free canvas before angling outward;
input and output ports mirror the same geometry. Linked Node library instances
use their resolved node behavior. For a direct bus-to-bus connection, the same
index lets either rail channel highlight its related channel without rendering
a wire between the two fixed groups.
Hovering a rail channel (or one of its antennas) temporarily reveals every
definition-valid provider and consumer wire for that channel, using the saved
connection geometry. Every revealed segment uses the active wire color, and
the corresponding normal-node antennas are hidden until the hover ends, so the
wire temporarily replaces rather than overlaps the radio presentation. A
direct bus-to-bus link appears when either linked channel is hovered. Those
hover-revealed wires are visual-only: they do not gain a bend handle or wire
hit target because any persisted bend would vanish again when the hover ends.
Only those temporary wires move into a fixed viewport overlay above the bus
rail. The ordinary wire SVG remains below nodes and canvas controls. The
overlay reapplies the canvas root's client offset before the normal pan/zoom
transform, so its endpoints stay attached in compact, full-width, and
sidebar-shifted rail layouts without being clipped by the canvas viewport.

A zero-movement output-port click always starts the normal pending-wire gesture,
even if the compact rail layout places another input inside the drop-target
proximity radius. Only a moved pointer gesture may connect during that initial
press-and-release; the subsequent click-to-connect gesture remains unchanged.

The rail is viewport-fixed, while SVG wires are drawn in canvas coordinates.
`useNodePortPositions` measures rail port rectangles and converts their client
centres into canvas coordinates. `useCanvasPositioning` includes the reserved
full-row Y offset in both conversion directions, so viewport-fixed bus ports,
the shifted wire SVG, pointer interactions, and zoom anchors share one origin.
`useViewportBounds` likewise reports the canvas root's real client rectangle.
A graph fit, focused-node fit, or go-to-node action uses the same reserved top
inset, so the target is centered in the remaining canvas rather than underneath
the fixed row.
A rail-only measurement refreshes on every pan/zoom so project-comparison wires
remain attached to the viewport-fixed rail, while ordinary node ports avoid a
full DOM measurement on every idle canvas movement. A scoped capture listener
schedules the same refresh when horizontal shelf or channel scrolling moves a
rail port. Live node and wire drags continue using the full measurement pass.
Established bus wires have no hit path or bend handle while hidden; their
existing bend metadata remains serialized and reappears if data-bus
presentation is turned off.
Rail-only class/style changes such as selection and hover are ignored by the
layout mutation observer; actual size changes remain covered by ResizeObserver.

Project Compare is an intentional exception to established-wire suppression:
added or changed bus connections render as their normal comparison-colored
wires to the rail, and removed connections keep the existing removed-wire
path. Connection changes must not disappear merely because their steady-state
canvas representation is an antenna.

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
Passthrough slot retention and sparse runtime mapping belong in
`packages/core/test/model/nodes/PassthroughNode.test.ts`; provider/consumer
classification and wire-suppression eligibility belong in
`packages/app/src/components/nodeCanvas/dataBusModel.test.ts`.
