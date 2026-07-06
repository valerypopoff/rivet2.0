---
title: 'Overview of the Interface'
---

## Project Sidebar

### Project Settings

Use **Project settings** at the top of the graph tree panel to set the name and description of your project. This data is saved with your project file and used for documenting your project.

You can also use **Project settings** to compare the open project to an older `.rivet-project` file. See [Working with Projects](./working-with-projects.md#comparing-projects) for how compare mode highlights added, changed, and removed graphs, nodes, and connections.

Project plugin declarations are shown separately as "Plugins used by this project". In Rivet 2, plugins are installed into the app from Settings > Plugins, and the project list is derived from actual plugin-node usage. See the [Plugins](./plugins.md) documentation for more information.

![Project Info](./assets/project-info.png)

### Graph Tree

The graph tree is where you can navigate between all graphs in your project, filter graph names, add new graphs, and delete/duplicate existing graphs.

![Graphs](./assets/graphs.png)

Clicking on a graph in the list will open it in the main graph area. When the graph tree has focus, press **F2** to rename the currently open graph; press **Enter** to save the rename, or press **Escape** or click anywhere else, including the canvas, to cancel it. To add a new graph, right click in the blank space in the graph list and select "New Graph". To collapse or expand every folder without adding permanent toolbar buttons, right click the blank space in the graph list or right click a folder and choose **Collapse all folders** or **Expand all folders**.

Use the search button in the top bar, or press **Ctrl+F** or **Cmd+F**, to search across graph names and node content in the current project. When matches are found, Rivet shows how many text occurrences were found and how many graphs contain them.

To delete a graph, right click on it and select "Delete". This will delete the graph from your project.

:::caution

There is no undo at this time! Deleting a graph is permanent! We recommend you store your rivet project files in source control.

:::

To duplicate a graph, right click on it and select "Duplicate Graph". This will create a new graph with the same nodes and connections as the original graph.

### Graph Info

Right click a graph in the graph tree and choose **Graph info** to set the name and description of your graph. This data is saved with your project file and used for documenting your graph and organizing your graphs in the graph list.

![Graph Info](./assets/graph-info.png)

## Graph

You will mainly be working in the Graph area of the interface. It contains all of your nodes in the current graph and the connections between them.

![Graph area](./assets/graph-area.png)

### Nodes

For information on how to manipulate nodes, see [Working with Nodes](./adding-connecting-nodes.md).

### Canvas

The canvas is the main area of the graph. You can click and drag on the canvas to move the graph around. You can also use the scroll wheel to zoom in and out.

Right click to open the context menu to add new nodes.

Hold shift and drag to create a selection box. Any nodes inside the selection box will be selected. You can keep holding shift and drag another selection box to add a separate group to the same selection. You can then move all of the selected nodes as a group, or create a subgraph from the selected nodes. You can also hold shift and click the title bar of a node to add it to the selection.

In **Rivet settings** > **UI**, you can choose a built-in dark theme, the built-in **Bright** theme, or choose **Custom** and pick primary and secondary theme colors. Primary controls accents, while secondary tints the main UI surfaces. Under **Canvas**, you can change the canvas color and choose the canvas background pattern. **Theme** uses the current theme's canvas surface, and **Custom** lets you pick your own canvas color. Dark themes use a pale canvas pattern; the Bright theme uses a dark pattern so the grid, dots, or crosses stay visible on the light canvas.

## Node Editor

The node editor is visible when you click the edit node icon on a node. It is used to edit the data on the node.

![Node editor](./assets/node-editor.png)

You can close the node editor by clicking the close button in the top right, by pressing the escape key, or by clicking on any blank space in the graph.

### Node Title & Description

You can edit the title of the node in the node editor (changes the title shown on the graph). You can also edit the description of the node in the node editor, for documentation purposes.

### Run Mode

The run-mode control decides whether the selected node runs once or runs over many input items. For more information, see the [Running Many Items](./splitting) documentation.

When **Many parallel runs** or **Many sequential runs** is enabled, the settings underneath the run-mode control limit how many items can run and, for parallel mode, how many item runs can be active at once.

### Variants

Variants are used to create multiple versions of the same node. The button on the right allows you to save the current node configuration as a new variant. The dropdown on the left allows you to apply existing variants to the current data on the node.

Variants allow you to save slight differences to a node, and test them without losing the data. For example, you may have a [Text Node](../node-reference/text) with a message to an LLM. You may want to test different variations of the message to see which one performs better and gives better AI results.

### Node Data Editor

This area contains the editors for the currently selected node. The editor will change depending on the type of node you are editing. For example, the shown [Text Node](../node-reference/text) has a text editor, and the [LLM Chat Node](../node-reference/llm-chat) has provider, model, reasoning, response-format, tools, and technical-details sections.

Text and code editors have their own font-size control, separate from the main app UI font size. Use the **+** and **-** buttons in the editor footer to change the editor font size, or press **Ctrl + +** / **Cmd + +** and **Ctrl + -** / **Cmd + -** while focus is inside the editor. **Ctrl + 0** / **Cmd + 0** resets the size. You can also hold **Ctrl** or **Cmd** and use the mouse wheel or trackpad scroll while the pointer is over the editor to scale the editor font.

Text and code editors show **Generate using AI** on the left side of the editor footer. Use it to open the AI generation modal without leaving the editor. Some nodes use a node-specific drafting helper, while other editors use a generic helper that replaces the current editor content. If text is selected in the editor when you open the modal, Rivet sends that selection as extra context for the request. Enter what Rivet should generate in the main text area, drag its bottom edge if you need more height, and use **Generate** at the bottom. While generation is running, use **Cancel** or close the modal to stop the request without applying a late result. The drafting modal shows the provider and model currently selected in **Settings > LLM** directly under that request field. Change the drafting provider, drafting model, custom provider API URL, or custom provider model in **Settings > LLM**. For built-in drafting providers, use **Re-fetch Model List** in that same settings tab to load the provider's current model list with your configured key; Rivet shows the same success and warning messages as the LLM Chat node model picker. The modal also uses the provider keys configured there, so you do not need to duplicate OpenAI/Anthropic/Google/custom provider keys in plugin settings for this helper.

Markdown editors in node settings can fold heading sections and fenced code blocks, similar to code and JSON editors that show fold controls for structured content.

Monaco text and code editors include editor tools in the right-click menu. **Check spelling** runs a local English spellcheck only when triggered, highlights possible misspellings in the editor, and does not send text anywhere. **Prettify** uses the editor's built-in formatter when one is available, and **JSON escape** / **JSON unescape** work on the selected text.

In JSON editors, hover or place the cursor on a string value and use the inline preview button at the end of that string to view and copy the decoded, unescaped text without changing the editor content. This works on complete string values even while the surrounding JSON is still being edited. In the full output modal, the same preview is shown only for escaped or long string values. Drag the preview's bottom-left corner to adjust its width and maximum text height; Rivet remembers the size.

When the **Bright** theme is active, node text and code editors use Monaco's light editor theme so Comment, Code, Expression, JS Filter, and LLM Chat technical-option editors match the rest of the light interface.

## Workspaces

The top app bar contains workspace tabs. Canvas is the normal graph-editing workspace. Other workspaces, such as Trivet Tests, Chat Viewer, and Data Studio, open full-screen workspace views. When no project is open, the top bar shows a Welcome screen tab so you can return to the centered welcome screen after opening a project-independent workspace. Run/debug controls are shown only while Canvas is active.

### Prompt Designer

The prompt designer allows you to tweak an individual prompt to get the output you are looking for. It is opened from a Chat or LLM Chat node's flask icon, and Rivet shows a top-bar tab for it only while it is open. See the [Prompt Designer](./features/prompt-designer.md) documentation for more information.

### Trivet Tests

Trivet allows you to set up test suites and test cases for your project. See the [Trivet](../trivet.md) documentation for more information.

### Chat Viewer

The chat viewer gives you a full-screen view of Chat and LLM Chat nodes that have produced chat content. Its top-bar tab appears only when there is something to view.

This view can give you a quick overview of how your AI is performing, and what it is doing at any given time. It can also be used to debug issues with your AI.

## Action Bar

The action bar is in the top-right of the Canvas workspace. It contains buttons for running, pausing, aborting, and debugger-related actions for the current graph, plus the Run context menu.

![Action bar](./assets/action-bar.png)

### Run

Clicking the run button will run the current graph.

### Abort

Visible while a graph is running. Clicking the abort button will abort the current graph.

### Pause/Resume

Visible while a graph is running. Clicking the pause button will pause the current graph, and clicking the resume button will resume the current graph from where it was paused.

### Menu

Access run-related options by clicking the menu '...' button next to the run controls. App-level settings are available from the app menu.
