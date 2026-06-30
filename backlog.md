
- "Node library" item should have the node counter just like the folders in the graph tree. If zero, don't show teh counter at all
- In the empty node library, there's "Right-click to add library nodes". Include a short explanation on how the linked nodes work. And make this block in the horizontal center of the canvas. Now it's in the middle of the whole rivet window which is not the same

- While the workflow is running, send some kind of a number of run nodes that can be a progress indicator

- Markdown in the text editor in the node settings should be foldable just like the json structures

- Code editor: show a hint that Ctrl++ and Ctrl+- are working here. Also add Ctrl/Cmd+scroll to scale the font size

- A special node mode that works like a filter: in this mode the node can accept multiple connections from different nodes into one port. Without such mode, I have to copy-paste the same node multiple times. Probably, for each connection set there should be a separate execution path. Like, "add path". Or! Allow connecting an auxiliary node as a filter for selected inputs/outputs of a node.

- Node from rivet project. Should be compatible with rivet wrappers. Isn't "Project References" the same thing?

- Rework ChatViewer workspace into an actual chat interface that is connected to a specific graph with cpecific inputs and outputs so the user can test their graph in a chat-like interface.

- After graph or project running (in the editor or via remote debugger) highlight the input nodes that got no input. Like, it can indicate that the subgraph node hasn't passed all the needed inputs to the subgraph.

- Need to show the curent graph name somewhere. When there's many and they are in the folders and you click through subgraphs, the user gets lost. It's already shown in the run button. maybe make it more noticeable?

- When I need to gather a lot of inputs into one node, it looks messy and it's easy to look over some connections. like in the "setGlobals" graph. We need to do something about this UX. maybe introduce a "Group" node that will contain many same type nodes and combine their outputs into one so I can later pipe it into just one node and be sur ethat all the nodes are connected?

- Reassess templates for the Ctrl+N window

- Apply a style where there's a straight line and another line in parallel close to it, just like in the Rivet logo

- Get back to MCP and see if it works and how it works. I don't see an MCP node. I think we need it
- Reassess all the "Generate using AI" in different nodes. The model picker is clipped by the section border

- In nodes that have variadic inputs, when an input in the middle is removed, the remaining inputs look weird. Do we need to automatically remove them? It should we allow the user to remove them if needed?

- Reassess Loop until node. Definitely can make the end conditions better

- Human readable Loop node

- In the node output when there's yellow headers, without hover the headers are not visible. I want them to be visible

- A setting for LLM chat node to race several LLM calls and return the fastest. Need to think through how it works along with retries

- Reassess rivet example project
  rivet2.0/packages/app/src/assets/tutorials
  /documentation-tutorial.rivet-project

- Code node (and Expression node) should have a "Catch failures" switcher so I can safely fallback with coalesce

- Check the AI workflow generation feature

- Convenient node type browser, just like in n8n
- I want to be able to adjust the node height when it's not hovered so I can see this much of the content in the output section

- Support Python in all nodes that support javascript
