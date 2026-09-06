---
title: Subgraphs
---

Subgraphs are a powerful tool for composing graphs together. They allow you to create a graph that can be used as a node in another graph. This allows you to create reusable components, and to create graphs that are easier to understand.

If you are familiar with code, a graph is like a function, and a subgraph is like a function call. You can pass inputs into a subgraph, and it will return outputs. The inputs can be thought of as function arguments, and the outputs can be thought of as the return value. A graph can output multiple values, however.

### Creating a Subgraph

To create a subgraph, simply create a new graph in your project and add nodes to it.

You may want to add [Graph Input Nodes](../node-reference/graph-input) to the graph to allow you to pass in values to the subgraph. You may also want to add [Graph Output Nodes](../node-reference/graph-output) to the graph to allow you to return values from the subgraph.

### Create Subgraph Helper

If you select multiple nodes by holding shift and clicking on them, you can right click on the selection and choose **Create Subgraph**. This will create a new subgraph with the selected nodes in it. The nodes will not be removed from the current graph at this time. See [working with nodes](./adding-connecting-nodes) for more information on how to use this.

### Calling a Subgraph

To call a subgraph, add a [Subgraph Node](../node-reference/subgraph) to your graph. Connect any required data to the input ports of the subgraph, and connect any output data of the subgraph to the next nodes in your chain.

Subgraph nodes run the full child graph by default, including work that produces unconnected outputs and any side effects or errors in that work.

For independent output branches, enable **Skip unused outputs** in a Subgraph node's settings to avoid work that its connected outputs do not need. The setting is off by default and applies only to that caller node. Shared dependencies still run, and callers still calculate their inputs normally. If no outputs are needed, the child graph is not started.

Skipped work also skips global or stored-value writes, events, dataset changes, async work, and errors. Do not enable the setting when a needed branch relies on such work without an explicit graph connection. Unused returned values are marked excluded. Rivet runs the full child graph for **Run to here** on the Subgraph itself, partial-output forwarding, or an enabled Error output with an active connection. See [Subgraph Node execution behavior](../node-reference/subgraph#execution-behavior) for details.

The same setting applies when running headlessly through Node, the CLI, or Studio Server, and when the Subgraph is inside a loop or uses **Many parallel runs** / **Many sequential runs**. Each item and iteration keeps its own child execution; pruning does not change result order. Recordings contain only work that actually started and can be replayed normally. A deployed server or executor must be updated to a version that includes this feature; updating the browser editor alone does not update a separately deployed Node executor.

### Rearranging Subgraph ports

To change the visual order of a Subgraph node's graph input and graph output ports, right-click the Subgraph node and choose **Rearrange inputs/outputs**. The draggable port labels get rounded backgrounds while rearrange mode is active. Drag a port label or row up and down; the other labels shift while you drag, so you can drop a port between existing ports. Click outside the node to leave rearrange mode. The circular port handles still create and rewire connections. Port ordering is saved for that Subgraph node instance only; it does not change port IDs, connections, or output object keys. The optional error output stays after the graph outputs.

Subgraphs can call other subgraphs, allowing you to create a hierarchy of subgraphs. You can also call the current graph as a subgraph, however be careful to avoid infinite loops!

### Output Metrics

The Subgraph node output view can show runtime metrics such as duration and cost above the subgraph's returned values. When a Subgraph node runs many parallel or sequential items, Rivet shows total duration/cost plus one line per run instead of hiding the metric arrays.
