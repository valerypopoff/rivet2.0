---
title: 'Working with Nodes'
---

## Adding Nodes

To add a node to the current graph, right click in the empty space on the graph (or press space!), and enter the Add menu.

![Add Menu](./assets/add-menu.png)

You can search for a node by starting to type after the menu is open.

Nodes are grouped by their category. Selecting a node will add it to the graph where you right clicked.

See the [Node Reference](../node-reference) for more information about all possible nodes that can be added.

## Reusing Nodes with the Node library

Use the **Node library** entry in the graph tree when you have one configured node that you want to reuse in several graphs. Nodes created there are **library nodes**. They are saved in the project file, but they are not executable graphs and cannot be wired together inside the library. Their input and output ports are shown only to help you verify their setup. Graph Input, Graph Output, Referenced Graph Alias, Comment, and linked nodes cannot be added to the library.

The library canvas uses the same spatial editing tools as normal graphs. You can select several library nodes, align them, resize them, delete unused ones, open their settings, close settings by clicking the canvas, and Alt-drag a library node to duplicate it. To turn existing duplicated graph nodes into library nodes, copy nodes in a normal graph, open the Node library, and paste them there. Rivet creates one library node per supported pasted node; graph connections are not pasted into the library, and Graph Input, Graph Output, Referenced Graph Alias, Comment, and linked nodes are skipped.

To use a library node in a graph, right-click the graph canvas, open the **Library** section of the add-node menu, and choose it. Rivet creates a **linked node**. The linked node keeps its own position, size, and graph connections, but its title, color, settings, ports, split/conditional/disabled behavior, and runtime behavior all come from the library node.

Editing a library node updates every linked node. Per-link overrides are not supported yet, so linked nodes do not open their own settings panel, do not show their own gear icon, and any controls shown in the linked node body are display-only. Double-clicking a linked node, clicking its link icon, or choosing **Open library node** opens the Node library, centers the library node, and opens its settings. To make one linked node independent again, right-click it and choose **Detach from library node**. Rivet replaces that link with an ordinary node using the library node's current settings while keeping the linked node's position, size, and graph connections. You cannot delete a library node while any graph still links to it.

Side-effect library nodes still run separately for every link. For example, two linked nodes for the same Set Global, HTTP Call, Code, or LLM node each execute at their own place in the graph.

## Moving Nodes

Click and drag on the title bar of a node to move it on the node canvas. You can also select multiple nodes by holding shift and clicking on the title bars of multiple nodes. You can then move all of the selected nodes as a group.

When moving a Comment node, hold **Ctrl** on Windows/Linux or **Cmd** on macOS to also move every node that is fully inside the Comment node's bounds. Nodes that only partially overlap the comment stay where they are. Release the key during the drag to move only the Comment node again.

## Deleting Nodes

Right click on a node and select **Delete** to delete it. You can also select one or more nodes and press **Delete**. On macOS keyboards without a dedicated Delete key, press **Backspace** instead.

## Connecting Nodes

Nodes are connected by left-clicking and dragging from a port on one node to a port on another node. Ports are the connection points on the node. Ports can be inputs or outputs. Inputs are on the left side of the node and outputs are on the right side of the node. Right-clicking a port opens the normal context menu behavior and does not remove or rewire existing connections.

![connecting a node](../getting-started/assets/chat-to-text-node.gif)

The output port of a node can connect to multiple input ports on other nodes.

The input port of a node can only connect to one output port on another node.

For nodes that are far apart, you can start a connection from an output port and release it on empty canvas. Rivet keeps the connection line attached to your mouse while you pan or zoom the canvas, so you can move across the graph and finish by dropping it on an input port. Press **Esc**, right click the canvas, or click outside the canvas to cancel the pending connection. Dragging an already connected input port to empty canvas still disconnects that existing connection.

To manually bend a connection, hover the wire and click the ghost circle that appears. The circle becomes a bend handle; drag it anywhere on the canvas to route the wire through that point. Double-click the bend handle to remove it and return the connection to its automatic route. Bend handles are saved in the project file as visual layout only: they do not change which ports are connected or how the graph runs.

Some nodes create numbered ports as you connect more wires, such as Did Run, Array, Join, Coalesce, Assemble Prompt, Assemble Message, Race Inputs, Passthrough, Delay, and Start Async Branch. To clean up crossed wires on these nodes, right-click the node and choose **Rearrange inputs** or **Rearrange inputs/outputs**, then drag the rounded port labels into the order you want. This also works on linked nodes whose library source has rearrangeable variadic ports, because the command only rewires the graph-local connections. The port circles still create and rewire connections; only the labels drag in rearrange mode. For Passthrough, Delay, and Start Async Branch, each input's matching output moves with it. For order-sensitive nodes like Array, Join, Assemble Prompt, Assemble Message, and Coalesce, rearranging ports is equivalent to reconnecting those wires by hand and can change the value the node produces.

The data type of every port is available in the documentation for each node in the [Node Reference](../node-reference).

## Disconnecting Nodes

Click and drag on a connected port to move the connection to a different port, or click and drag to an empty space for an existing connection to delete the connection.

## Creating a Subgraph

To create a subgraph, select multiple nodes by holding shift and clicking on the title bars of multiple nodes. Then right click on one of the selected nodes and select **Create Subgraph**. This will create a new (_unsaved!_) graph containing the nodes you selected, as well as additional input and output nodes to connect the subgraph to the parent graph.

![creating a subgraph](assets/create-subgraph.gif)

Make sure you go into the graph info section for the subgraph and give it a name and description, or else it will be Untitled graph.

Make sure you save your new graph! (CMD+S or CTRL+S)

The source nodes will **not** be removed from the parent graph at this time. It is up to you to replace them with your newly created subgraph.

## Editing a Node

Click the gear icon on the top right of a node to edit it. This will open the Node Editor. Linked nodes show a link icon instead; double-click them or click that icon to edit the source library node. See the [interface overview](./overview-of-interface) for more information about the Node Editor.
