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
