---
title: 'Working with Nodes'
---

## Adding Nodes

To add a node to the current graph, right click in the empty space on the graph (or press space!), and enter the Add menu.

![Add Menu](./assets/add-menu.png)

You can search for a node by starting to type after the menu is open.

Nodes are grouped by their category. Selecting a node will add it to the graph where you right clicked.

See the [Node Reference](../node-reference) for more information about all possible nodes that can be added.

## Moving Nodes

Click and drag on the title bar of a node to move it on the node canvas. You can also select multiple nodes by holding shift and clicking on the title bars of multiple nodes. You can then move all of the selected nodes as a group.

When moving a Comment node, hold **Ctrl** on Windows/Linux or **Cmd** on macOS to also move every node that is fully inside the Comment node's bounds. Nodes that only partially overlap the comment stay where they are. Release the key during the drag to move only the Comment node again.

## Deleting Nodes

Right click on a node and select **Delete** to delete it. **Warning: There is no undo at this time!**

## Connecting Nodes

Nodes are connected by left-clicking and dragging from a port on one node to a port on another node. Ports are the connection points on the node. Ports can be inputs or outputs. Inputs are on the left side of the node and outputs are on the right side of the node. Right-clicking a port opens the normal context menu behavior and does not remove or rewire existing connections.

![connecting a node](../getting-started/assets/chat-to-text-node.gif)

The output port of a node can connect to multiple input ports on other nodes.

The input port of a node can only connect to one output port on another node.

For nodes that are far apart, you can start a connection from an output port and release it on empty canvas. Rivet keeps the connection line attached to your mouse while you pan or zoom the canvas, so you can move across the graph and finish by dropping it on an input port. Press **Esc**, right click the canvas, or click outside the canvas to cancel the pending connection. Dragging an already connected input port to empty canvas still disconnects that existing connection.

To manually bend a connection, hover the wire and click the ghost circle that appears. The circle becomes a bend handle; drag it anywhere on the canvas to route the wire through that point. Double-click the bend handle to remove it and return the connection to its automatic route. Bend handles are saved in the project file as visual layout only: they do not change which ports are connected or how the graph runs.

Some nodes create numbered ports as you connect more wires, such as Did Run, Array, Join, Coalesce, Assemble Prompt, Assemble Message, Race Inputs, Passthrough, and Delay. To clean up crossed wires on these nodes, right-click the node and choose **Rearrange inputs** or **Rearrange inputs/outputs**, then drag the rounded port labels into the order you want. The port circles still create and rewire connections; only the labels drag in rearrange mode. For Passthrough and Delay, each input's matching output moves with it. For order-sensitive nodes like Array, Join, Assemble Prompt, Assemble Message, and Coalesce, rearranging ports is equivalent to reconnecting those wires by hand and can change the value the node produces.

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

Click the gear icon on the top right of a node to edit it. This will open the Node Editor. See the [interface overview](./overview-of-interface) for more information about the Node Editor.
