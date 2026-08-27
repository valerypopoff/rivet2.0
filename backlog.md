- Image node should be able to accept base64


# Evaluations

- On the dataset page, Ctrl/Cmd+click on any case's "enable" switcher should toggle all the cases enabled/disabled


# Other

- Montecarlo system to emulate using endpoints? To see how many tokens will be spent?


- In nodes that have variadic inputs, when an input in the middle is removed, the remaining inputs look weird. Do we need to automatically remove them? It should we allow the user to remove them if needed?


- Need to show the curent graph name somewhere. Like, by pressing some button?

- Сделать чтобы можно было стримить аутпут из ЛЛМ чат нода прям в веб апп в компонент чата

- Добавить агенту эвернесс о конструкции втоих тулов? Чтобы он в случае чего мог посмотреть а как именно работает тул. Это поможет ему правильнее им пользоваться

- A main page for the github website that says that it is a yet another workflow builder for AI but: free, developer oriented (not for everyone) so there's no bullshit, it's for professional work, it's good and optimized for production use (not only for POCs)

- A setting for LLM chat node to race several LLM calls and return the fastest. Need to think through how it works along with retries

- Bind certain graphs to Ctrl+1, Ctrl+2, etc.

- Recorded actions in the Editor? Like, record connecting some nodes. Then record disconnecting them. Like some chore that needs to be done before saving for example

- When zooming out the canvas, the main buttons in teh output area should scale down slower than the nod eitself. Like, when the node zoomed out 2x, the buttons in the output area should only zoom out 1.5x. Or should work when the scale is lower than some threshold. Choose the threshold wisely.

- Node from a rivet project. Should be compatible with rivet wrappers. Isn't "Project References" the same thing?

- A special node mode that works like a filter: in this mode the node can accept multiple connections from different nodes into one port. Without such mode, I have to copy-paste the same node multiple times. Probably, for each connection set there should be a separate execution path. Like, "add path". Or! Allow connecting an auxiliary node as a filter for selected inputs/outputs of a node.

- After graph or project running (in the editor or via remote debugger) highlight the input nodes that got no input. Like, it can indicate that the subgraph node hasn't passed all the needed inputs to the subgraph.

- While the workflow is running, send some kind of a number of run nodes that can be a progress indicator

- AWS marketplace ready to launch thing for Rivet 2

- When I need to gather a lot of inputs into one node, it looks messy and it's easy to look over some connections. like in the "setGlobals" graph. We need to do something about this UX. maybe introduce a "Group" node that will contain many same type nodes and combine their outputs into one so I can later pipe it into just one node and be sur ethat all the nodes are connected?

- Reassess templates for the Ctrl+N window

- Apply a style where there's a straight line and another line in parallel close to it, just like in the Rivet logo

- Get back to MCP and see if it works and how it works. I don't see an MCP node. I think we need it


- Reassess Loop until node. Definitely can make the end conditions better

- Human readable Loop node

- In the node output when there's yellow headers, without hover the headers are not visible. I want them to be visible

- Reassess rivet example project
  rivet2.0/packages/app/src/assets/tutorials
  /documentation-tutorial.rivet-project

- Code node (and Expression node) should have a "Catch failures" switcher so I can safely fallback with coalesce

- Check the AI workflow generation feature

- Convenient node type browser, just like in n8n
- I want to be able to adjust the node height when it's not hovered so I can see this much of the content in the output section

- Support Python in all nodes that support javascript
