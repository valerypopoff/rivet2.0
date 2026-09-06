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

## Node Output Surfaces

Inline output is part of the node card, not a detached panel. For a node with several
recorded runs, `NodeOutputMultiProcess` places the run pager and the selected output
inside one `.multi-node-output` surface. The pager remains separated from the selected
output by the normal output divider, but the outer multi-run surface alone owns the
bottom corners and clipping. Do not restore an extra `.node-output.multi` wrapper
around the selected output: it creates a rounded pager card followed by a visually
detached output section.

## Node Body Previews

Text-like node-card bodies use core's `buildNodeBodyPreview(...)` formatter. It shows no more than 15 source lines, clips each source line at 240 characters, and caps the resulting preview at 3,000 characters with an ellipsis when content is omitted. This is presentation-only: the node data and editor retain the complete value. Tool's core `getToolNodeBodyPreview(...)` limits its combined name/description preview to 14 source lines: the header separator uses the remaining Text-height line. Its app-level `ToolNodeBody` presents `Name: <toolname>` using the LLM field-label color, followed by the standard LLM-style separator and the same `ColorizedNodeBody` renderer, monospace metrics, zero preformatted margin, and wrapping rules as Text. Do not route Tool through Markdown or independently reapply preview limits: that reintroduces the formatting and height mismatch.

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
defense in depth for serialized graphs and non-editor callers. When a persisted
graph, stale frozen output, or preload state reaches one of those runtime
checks, the root execution error is shown as a deduplicated editor toast as
well as in the failed run. This is deliberately limited to `Start Async
Branch` safety messages: ordinary node failures remain node-local so an editor
run does not produce a global toast for every failed node. Browser execution
and Node/remote executor transports use the same classification even though
the latter serializes errors with one or more `Error:` prefixes. The same
targeted toast is also emitted from a node error when the unsafe state is only
known during execution, such as a frozen async trigger. Its later wrapped root
error is not toasted a second time.

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
`Message` and requires no editor toggle.
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

## Data Buses

`dataBus` is a dedicated topology-only node. It uses paired `inputN` /
`outputN` channels in the saved graph, but it never receives an ordinary
`GraphProcessor` invocation. `compileDataBusTopology(...)` expands each
populated channel into an independent direct provider-to-consumer dependency
before definitions, cycle detection, and scheduling run. Reusing a later output
on a separate channel therefore does not make an earlier consumer wait for it.
Async-branch validation and graph dependency/reachability discovery use those
same compiled effective connections, so unrelated channels cannot create a
false async path or a false Delegate Tool Call linkage.

Tool-continuation branch safety keeps a separate complete preprocessed
connection view for cycle detection. It must include valid edges shadowed by
the scheduler's one-provider-per-input projection, so a persisted self-loop
cannot be hidden merely because another connection currently supplies that
input.

Each Data Bus channel accepts at most one provider and any number of consumers.
An absent provider remains visible and repairable but creates no dependency;
duplicate providers and relay-only cycles fail preprocessing with an actionable
error. Relay validation and source resolution are iterative and memoized, so a
large valid relay chain cannot overflow the JavaScript stack or repeat the same
source walk for every receiver. Data Bus nodes cannot be disabled, conditional, split, frozen, or
variant-driven because these are execution concepts and a bus has no execution.
Preflight compilation failures are emitted through the root processor `error`
event before normal graph-start events, so every executor can surface the
configuration error. A Data Bus cannot be preloaded/frozen or selected as a
run-from or run-to target, nor can dependency inspection target it, including
through a Node Library instance: those APIs must address an executable provider
or consumer instead. Preload and dependency-inspection entry points resolve the
authored Node Library source directly and deliberately do not seed a reusable
runtime plan before referenced project boundaries have been loaded; a later
real run always preprocesses against the complete reference set.
If hand-edited project data puts one of those execution settings on a
dedicated bus, the canvas shows its ordinary card and the node editor exposes a
single repair action that clears the incompatible settings without changing its
title, geometry, or connections.
Passthrough has no Data Bus presentation mode and the editor does not convert a
Passthrough into topology. Designers add the dedicated Data Bus node explicitly.
Because a Data Bus is rendered as a rail instead of a movable node card, the
content area of its settings exposes a compact, top-aligned **Delete Data Bus**
action instead of mounting the empty default node editor. The global-controls
header deliberately does not contain that destructive action. Deletion uses the
ordinary node-deletion command, so it removes incident connections, clears
editor/execution state, and participates in undo history. Data Bus settings do
not offer type conversion. When the same editor is hosted by the Node Library,
the action delegates to the library's existing usage-guarded prefab deletion
instead of mutating the active graph.

New projects persist `dataBus` with ordinary `NodeConnection` records:

```yaml
'[bus]:dataBus "Shared values"':
  outgoingConnections:
    - output1->"Receiver" input
```

The provider is another ordinary connection into `input1`. Sparse channels are
valid, bounded by the shared Data Bus port limit, and output-only channels stay
visible as **Missing provider**. Deserialization performs the only remaining
legacy cleanup step: it discards a retired `data.renderAsDataBus` flag and keeps
the node as an ordinary executable Passthrough, regardless of its execution
settings. It never converts that node into a dedicated Data Bus. Runtime
topology compilation and canvas presentation recognize only the explicit
`dataBus` type; directly constructed or hand-edited Passthrough data cannot
re-enable the retired mode.

`DataBusRail` always renders one pinned, full-width row per Data Bus immediately
below the project tabs. A Data Bus never switches to a floating shelf or waits
for content measurement before reserving space. Each bus retains its own panel
row; rows stack vertically in graph order rather than flattening several buses
into one strip. Every row begins at the live right edge of an open left sidebar,
while its bus content remains centered in the remaining width. The
`dataBusFullRowCountState` atom records the number of reserved rows, and
`getDataBusFullRowsHeight` is the shared height calculation used by both root
layout CSS and canvas coordinate conversion. The complete stack reserves real
vertical space: the canvas surface, node editor, borders, notices, and top
controls all move down and the usable canvas height shrinks by one fixed row
height per bus. `GraphBuilder` itself keeps the full viewport height while the
canvas is shifted and shortened inside it; this ensures absolutely positioned
sibling panels use the window bottom and do not subtract the bus-row stack a
second time. The left sidebar remains beside the rows instead of moving below
them. Each full-width row is the panel surface; the centered bus content has no
independent card border, radius, shadow, or background. Channel overflow remains
horizontally scrollable while its scrollbar stays visually hidden, including
while a wire drag exposes larger port hit targets. A vertical wheel gesture over
an overflowing channel list is translated to horizontal scrolling; wheel events
over the rail never pan or zoom the canvas.
Each populated channel labels `<source node>` and `<source output>` on separate
lines so more channels fit within the available rail width. The source-node
line is a smaller uppercase heading, separated slightly from the output label.
Its tooltip retains the combined `<source node> / <source output>` form. The
channel exposes the normal input port for rewiring, exposes the paired output
port for adding receivers, and shows the receiver count. Those existing
channels scroll only in the space between the fixed Data Bus header and a fixed
**Connect provider** terminal input. That terminal input is the next Data Bus
channel with no paired output yet; pinning its presentation does not change its
connection topology.
Data Bus IO derivation is sparse: it emits definitions only for channel indices
that still have a provider or receiver, plus the first unused input index for
**Connect provider**. A pair therefore disappears as soon as both sides are
disconnected, without renumbering surviving connections or recording a
render-time graph mutation. The group-presentation model defensively filters
fully empty non-terminal channels as well. Rail ports are absolutely positioned
with their centers on each pair's lower boundary and a reserved transparent
gutter contains the lower half of each circle. They remain ordinary measurable
and interactive ports without consuming label-grid columns or requiring
overflow that could introduce rail scrollbars. The receiver count is likewise
removed from the label grid and rendered as a non-interactive overlay inside the
output port, leaving the two-line provider label the channel's only in-flow
content with dedicated clearance above the pair's lower boundary.
The settings action selects the hidden node and opens
its ordinary node editor (or the library source when the bus is a linked Node
Library instance). Search selection and project-comparison node styling
remain visible on the shelf.
Go-to-node navigation recognizes a renderable bus and loads/selects its graph
without panning to the hidden node card's saved spatial coordinates.
The rail is not a spatial node card, so its root deliberately suppresses
right-click context menus across groups, padding, and full-row background.
The canvas's keyboard context-menu shortcut (`Space`) applies the same target
guard, so a pointer resting over a bus rail cannot open a blank-canvas menu.
Shift-click still delegates to normal node selection, preserving
multi-node copy/delete behavior without making the viewport-fixed group
draggable.
The header is shrinkable and title text is ellipsized, so an unusually long
Data Bus title cannot push the fixed **Connect provider** control out of the
available row.
`createDataBusTopology(...)` is the canvas-scoped, preview-connection
interpretation boundary. It indexes data-bus provider and consumer endpoints,
per-channel connections, normal-port antenna references, active channel keys, and each
connection's bus-channel membership exactly once. `DataBusRail`, `NodePorts`,
and `WireLayer` consume that same topology rather than each rescanning the graph
connections. `buildDataBusGroupPresentation(...)` then combines that stable
topology with the rail group's _live_ `useCanvasNodeIO(...)` definitions. The
definitions intentionally stay reactive: plugin, prefab, and variadic-port
changes must update the rail without rebuilding a stale canvas snapshot.
During an input-origin rewire, the temporarily removed original edge therefore
disappears from the provider label, receiver count, antenna presentation, and
wire suppression together instead of leaving a stale radio marker behind the
live drag wire.

Data-bus presentation is enabled only on connection-enabled graph canvases.
Connection-disabled surfaces such as the Node library builder keep the Data Bus
card visible, even though graph canvases render its fixed rail; this
preserves access to the source node in editors that do not expose graph wiring.

Hidden buses are excluded from box-selection, viewport culling, node drag and
duplicate groups, and alignment operations. Their saved `visualData` is kept
only as an editor fallback position; fixed-rail interaction must not mutate
that invisible spatial footprint.

`dataBusModel.ts` owns pure topology and per-group presentation derivation;
`useDataBusRailLayout(...)` publishes the always-pinned row count, and
`dataBusRailStyles.ts` owns the rail CSS. `WireLayer` suppresses a
bus provider or consumer wire only after that exact connection exists in the
definition-valid persisted connection set. The in-progress `draggingWire`
therefore stays an ordinary visible wire. A drag whose source or current drop
target is a Data Bus channel is drawn in the same short-lived fixed overlay as
revealed bus routes, above the rail; normal drags remain in the ordinary wire
SVG. `NodePorts` derives antenna metadata
from the shared topology's memoized endpoint index. Port rendering performs a
direct lookup instead of rescanning every graph connection for every visible
port. Ordinary wires and router-mast antennas can coexist on one source port. Each
mast leaves the port horizontally into the free canvas before angling outward;
input and output ports mirror the same geometry. Linked Node library instances
use their resolved node behavior. For a direct bus-to-bus connection, the same
index lets either rail channel highlight its related channel without rendering
a wire between the two fixed groups.
Hovering a rail channel (or one of its antennas) temporarily reveals every
definition-valid provider and consumer wire for that channel and every
transitively relayed Data Bus channel, using the saved connection geometry.
At a rail port, the temporary path uses a downward endpoint tangent instead of
the horizontal tangent used by normal node ports, so its curve enters the
canvas below the fixed shelf rather than protruding along the shelf. Every
revealed segment uses the active wire color, and
the corresponding normal-node antennas are hidden until the hover ends, so the
wire temporarily replaces rather than overlaps the radio presentation. A
multi-hop `Data Bus A -> Data Bus B -> Data Bus C` route therefore reveals in
full when any linked channel is hovered. Explicitly revealed connections bypass
ordinary viewport candidate and line-clipping culling for the duration of that
hover, so off-screen provider/consumer endpoints do not leave a broken partial
route. Those
hover-revealed wires are visual-only: they do not gain a bend handle or wire
hit target because any persisted bend would vanish again when the hover ends.
Only those temporary wires move into a fixed viewport overlay above the bus
rail. The ordinary wire SVG remains below nodes and canvas controls. The
overlay reapplies the canvas root's client offset before the normal pan/zoom
transform, so its endpoints stay attached in pinned full-width and
sidebar-shifted rail layouts without being clipped by the canvas viewport.

A zero-movement output-port click always starts the normal pending-wire gesture,
even if another rail input lies inside the drop-target proximity radius. Only a
moved pointer gesture may connect during that initial
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
existing bend metadata remains serialized and reappears if the node is converted
to an ordinary Passthrough.
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
Data Bus compilation and scheduler behavior belong in
`packages/core/test/model/DataBusTopology.test.ts`; provider/consumer
classification and wire-suppression eligibility belong in
`packages/app/src/components/nodeCanvas/dataBusModel.test.ts`.
