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

In Studio Server, the **This project / Other projects** switch in Subgraph settings is labeled **Graph source**. If switching **Saved latest / Published** changes the graph's ports, the connection-review warning appears directly below **Version**.

To call a subgraph, add a [Subgraph Node](../node-reference/subgraph) to your graph. Connect any required data to the input ports of the subgraph, and connect any output data of the subgraph to the next nodes in your chain.

In Rivet Studio Server, open the Subgraph node settings and choose **This project** or **Other projects**. The graph field in both the node body and settings is a searchable dropdown. **This project** lists graphs under folder headings in the same order as the graph panel. For **Other projects**, expand server folders and projects in place, then select a graph from the selected project's graph-folder list; that list loads when you expand the project. Choose **Saved latest** or **Published** below the graph field in settings. **Saved latest** is the default and works even if the target project has never been published. It reads that project's latest saved version for each new run, not unsaved changes in another editor tab. **Published** requires a published version and follows its currently published snapshot. Saving or publishing the target later can change future runs without updating the caller project, so choose **Published** when you want a reviewed target and republish the target deliberately. A run keeps the selected target snapshot for its duration. Outside Studio Server, new Subgraphs use **This project** without the project/version controls; existing cross-project targets remain unsupported there rather than silently running a different graph.

Cross-project Subgraphs execute the target graph with its saved datasets and expose its Graph Input and Graph Output ports on the caller. Their direct named output streams can be watched by the caller just like same-project streams. As with a same-project Subgraph, the called graph shares the caller run's global and stored-value state; it is not an isolated workflow invocation. The called project's authored global defaults are not installed into that run, so pass required values through Graph Inputs or initialize them in the caller. When Run recordings are enabled, an invoked target graph gets a separate recording under the called project, in addition to the caller's run. The server's dataset-snapshot setting determines whether a replay retains the called project's datasets. A skipped Subgraph does not create a target run. The graph selector in both the node body and settings shows **Project name > graph name** for an external target. The **Go to subgraph** icon opens or focuses that project and selects the graph; if the graph is missing from its saved version, Rivet reports that instead of opening a different graph. Cross-project selection and execution require Studio Server; a project with such a target cannot execute it in the desktop-only host.

For cross-project Subgraphs, the selected Graph Input and Graph Output nodes retain their underlying node IDs when their editable **ID** fields are renamed. Rivet keeps the caller's existing port IDs and wires, shows the new names as labels, and translates values and streams to the target's new names at runtime. Switching **Saved latest / Published** also preserves wires for ports backed by those same nodes. If a port is removed, its type changes, or a rename collides with a different port's ID, Rivet warns instead of guessing; review and reselect the graph before running. A legacy saved Graph Input boundary without a node ID cannot be matched safely after that input has already been renamed, so it may need one manual reselection. Once a legacy boundary is reselected and saved before a later rename, future renames preserve its wires.

Opening the dropdown refreshes the target; choosing a graph explicitly accepts a changed boundary. If the chosen version cannot be loaded or lacks that graph, the current version remains selected. A deleted graph requires choosing another one. If preview refresh temporarily fails, the last known graph stays visible with a refresh warning; it is not labeled as deleted and cannot be reselected until refresh succeeds. Cross-project dependency cycles are rejected before a run starts; ordinary same-project recursion retains its existing behavior. Project Settings warns when a draft contains **Saved latest** cross-project calls, because later saves to those targets can change a published endpoint or web app without updating the caller. Parent and called-project recordings share a **Related run key** when both were captured, so you can identify the recordings from one invocation across projects.

Subgraph nodes run the full child graph by default, including work that produces unconnected outputs and any side effects or errors in that work.

For independent output branches, expand **Outputs** in a Subgraph node's settings and enable **Skip unused outputs** to avoid work that its connected outputs do not need. **Use Error Output** is in the same section. Skip unused outputs is off by default and applies only to that caller node. Shared dependencies still run, and callers still calculate their inputs normally. If no outputs are needed, the child graph is not started.

Skipped work also skips global or stored-value writes, events, dataset changes, async work, and errors. Do not enable the setting when a needed branch relies on such work without an explicit graph connection. Unused returned values are marked excluded. Rivet runs the full child graph for **Run to here** on the Subgraph itself, partial-output forwarding, or an enabled Error output with an active connection. See [Subgraph Node execution behavior](../node-reference/subgraph#execution-behavior) for details.

The same setting applies when running headlessly through Node, the CLI, or Studio Server, and when the Subgraph is inside a loop or uses **Many parallel runs** / **Many sequential runs**. Each item and iteration keeps its own child execution; pruning does not change result order. Recordings contain only work that actually started and can be replayed normally. A deployed server or executor must be updated to a version that includes this feature; updating the browser editor alone does not update a separately deployed Node executor.

### Streaming a named output to a parent graph

A child graph can expose an LLM Chat stream to its caller. Connect the LLM
Chat **Response** directly to a named **Graph Output**, then connect that named
port on the **Subgraph** or **Referenced Graph Alias** node to
[Watch Streaming Output](../node-reference/watch-streaming-output.mdx) in the
parent graph. The child does not need a special streaming setting beyond LLM
Chat's **Stream response** option, and the pattern can continue through nested
Subgraphs and referenced graphs. An ordinary node between the LLM and Graph
Output remains final-only, so use the direct connection when the parent needs
partial chunks.
Conditional and **Many** Graph Outputs, duplicate output names, frozen saved
outputs, **Many** producers, and a Subgraph or Referenced Graph Alias with
**Use Error Output** enabled are final-only too: the caller first applies its
selection, aggregation, or error-handling rule, then sends the ordinary
completed value. If a conditional output is false, the parent Watch receives
no chunks and can continue through its normal excluded-output fallback. If the
child fails with **Use Error Output** enabled, no partial chunks escape; the
caller receives the normal excluded outputs and its Error output instead.

**Call Graph**, **Cron**, and **Loop Until** do not relay direct child Graph
Output chunks through this route: their outputs aggregate or transform
child-graph results instead of exposing named Graph Output ports directly.
**Loop Until** can still emit its own per-iteration output updates.

### Rearranging Subgraph ports

To change the visual order of a Subgraph node's graph input and graph output ports, right-click the Subgraph node and choose **Rearrange inputs/outputs**. The draggable port labels get rounded backgrounds while rearrange mode is active. Drag a port label or row up and down; the other labels shift while you drag, so you can drop a port between existing ports. Click outside the node to leave rearrange mode. The circular port handles still create and rewire connections. Port ordering is saved for that Subgraph node instance only; it does not change port IDs, connections, or output object keys. The optional error output stays after the graph outputs.

Subgraphs can call other subgraphs, allowing you to create a hierarchy of subgraphs. You can also call the current graph as a subgraph, however be careful to avoid infinite loops!

### Output Metrics

The Subgraph node output view can show runtime metrics such as duration and cost above the subgraph's returned values. When a Subgraph node runs many parallel or sequential items, Rivet shows total duration/cost plus one line per run instead of hiding the metric arrays.
