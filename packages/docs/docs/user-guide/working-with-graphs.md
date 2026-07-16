---
title: 'Working with Graphs'
---

A Rivet project contains a set of named graphs. Each of these graphs contains a set of nodes connected together, forming the graph.

If you are used to code, a graph is analogous to a function. A function is a set of code that can be called from other code. A graph is a set of nodes that can be called from other graphs.

## Creating a Graph

To create a new graph, right click in the blank space in the graph list in the sidebar, and select "New Graph". This will create a new blank graph. The new graph is unsaved by default.

Right click the new graph in the graph list and choose **Graph info** to give your graph a new name. Then save the project by pressing **Ctrl+S** or **Cmd+S**. Your new graph will now appear in the graph list with its updated name.

## Navigating Between Graphs

To navigate between graphs, click on the graph in the graph list in the sidebar. This will open the graph in the main graph area.

After visiting more than one graph, use the previous and next graph buttons on the left side of the canvas toolbar row to move through your graph navigation history. If only one direction is available, Rivet keeps the other button visible but disabled so the pair stays in the same place.

Rivet marks graphs as reachable from the project's Main Graph through supported static graph-call relationships, such as Subgraph nodes and static graph references. A graph directly called by a web-app Button or Chat also counts as reachable, along with its supported graph-call relationships. A graph with the broken-thread icon is still editable, but it is not called from either reachable graph flow or a web app.

## Deleting a Graph

To delete a graph, right click on it in the graph list in the sidebar and select "Delete". This will delete the graph from your project. (**Warning** there is no undo at this time!)

## Running a Graph

To run the currently selected graph, press the **Run** button in the top right of Rivet. You can then watch the graph execute live.

When connected to a remote debugger, whenever the graph executes remotely, it will automatically show the result of the run in the current graph. The editor disables its normal run controls while the remote debugger is connected, so start the graph from the remote process and use **Stop Remote Debugger** when you want to return to normal editor-run controls.

## Viewing Node Outputs

After a graph runs, node outputs appear directly on the canvas. Use the output actions on a node to copy the displayed output, page through multiple runs, or open the output in the fullscreen modal. The regular copy button copies the value as Rivet displays it. In the fullscreen output modal, each named output section also has its own copy button next to the words/characters counters, so you can copy just that section's displayed value. **Copy as JSON** copies Rivet's internal output representation instead, including typed output wrappers. The fullscreen output view also adds search, lets you toggle line wrapping or Markdown rendering, and supports folding for JSON/code-style output, including parsed code/expression sections, when foldable regions are available. In fullscreen JSON output, hover or place the cursor on escaped or long string values and use the inline preview button to view and copy the decoded, unescaped text without changing the JSON output itself; drag the preview's bottom-left corner to adjust its width and maximum text height, and click elsewhere or press Escape to close it.

### Run from Here

To rerun part of a graph while editing, right click a node that already has the required upstream results and choose **Run from here**.

Rivet reruns the selected node and the nodes downstream from it. Upstream and unrelated node outputs stay visible from the previous run, and Rivet reuses only the already-computed boundary inputs needed by the partial rerun. Reused upstream outputs do not create extra previous/next output pages because they did not actually execute again.

If **Run from here** is unavailable, run the graph first so Rivet has the upstream outputs it needs to reuse.

## Graph Inputs

A graph has a set of inputs that can be thought of as the "arguments" to the graph. When calling the graph as a subgraph, or when calling the graph from your integrated code, you can pass in these inputs, which will be available to the nodes in the graph.

To add an input to the graph, add a new [Graph Input Node](../node-reference/graph-input). The ID of the Graph Input node will be the name of the input on the graph. You may give default values for inputs in the node editor for the input.

The output port of the Graph Input will contain the value of the input (from the parent graph or code) when the graph is called.

A useful pattern is to toggle on the input port for the default value input, and pass in some testing data to the default value port. Then, when this graph is executed in isolation.

## Graph Outputs

Similar to graph inputs, a graph can have outputs that can be thought of as the "return value" of the graph. When calling the graph as a subgraph, or when calling the graph from your integrated code, you can read the values of these outputs.

To add an output to the graph, add a new [Graph Output Node](../node-reference/graph-output). The ID of the Graph Output node will be the name of the output on the graph.

Connect a node to the input port of the Graph Output node. The value of the output port of the node will be the value of the output of the graph.

Once the graph has finished executing, the code or parent graph will be able to proceed with the outputs of the graph.

## Exporting Graphs

To export a single graph from your project, open the graph by clicking on it, and choose **Export Graph** from the top-bar **Menu** dropdown. This will open a file dialog where you can choose a location to save the graph. The graph will be saved as a `.rivet-graph` file.

## Importing Graphs

To import a graph into the current project (merging it into the current project), choose **Import Graph** from the top-bar **Menu** dropdown. This will open a file dialog where you can choose a graph to import. The graph will be imported into the current project.
