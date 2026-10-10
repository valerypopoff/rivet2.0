---
title: 'Working with Projects'
---

A Rivet project contains a set of graphs. These graphs can call each other by using a [Subgraph Node](../node-reference/subgraph). Any graph can call any other graph in the project (including itself).

Projects can also contain project-level resources such as the Node library and [Rivet web apps](./rivet-web-apps). Web apps are declarative UI screens that can call ordinary graphs in the same project.

## Creating a Project

To create a new project, choose **New Project** in the top-bar **Menu** dropdown. This will create a new blank project with one empty graph named **Main graph**. The new project is unsaved by default.

## Project Settings

Use **Project settings** at the top of the graph tree panel to give your project a new name and optionally a description. This is simply metadata and does not affect the execution of the project.

The Main Graph setting controls where Rivet starts its unreachable-graph analysis. A graph that is called by a Button or Chat in a web app also counts as reachable, along with the graphs it calls. Rivet also checks enabled Tool-to-**Delegate Tool Call** paths across the project: manual delegation uses its configured handler, while Auto delegate uses the matching name of a connected Tool with a stored name. Graphs that are reachable from none of those paths can show a broken-thread icon in the graph tree. To hide those markers, turn off **Show unreachable graph indicators** in **Rivet settings** > **Graphs**.

### Comparing Projects

Use **Project settings** -> **Compare to an older version** to compare the currently opened project with another `.rivet-project` file. This is useful when you have a newer copy of a project open and want to see what changed since an older version.

After you choose the older project file, the current project stays open and enters compare mode. The open project is treated as the current version, and the selected file is treated as the previous version. Rivet compares all graphs in the two projects, including subgraphs. It also compares project-level library nodes and Rivet web apps.

Compare mode highlights changes in the graph tree and on the canvas:

- green marks graphs, nodes, and connections that exist only in the current project
- amber marks graphs or nodes that exist in both projects but changed
- red ghost graph rows mark graphs that existed in the previous project but are missing from the current project
- red ghost nodes and dashed red connections mark nodes and connections that existed in the previous project but are missing from the current graph

The compare banner shows what changed in the whole project and in the currently opened graph. Categories with no changes are hidden, so the summary only mentions what matters. If nothing changed, the line says **No changes**.

For the whole project, the summary can include changed graphs, nodes, library nodes, web apps, and connections. For the currently opened graph, the summary includes only node and connection changes because the graph context is already known.

Node counts only include current non-comment nodes that are new or whose own configuration changed. If a node is merely connected to a new or changed wire, the wire is highlighted but the node is not counted or framed as changed. Comment nodes are ignored because they are canvas annotations.

Changed nodes are shown with a yellow highlight. New nodes are shown with a green highlight. If a node is marked as changed, click the compare-details button in the node header to inspect the node config side by side. The modal shows only the attributes that changed, with the previous value on the left and the current value on the right. Removed text is highlighted in red, current text is highlighted in green, and long values show matching markers near the scrollbar so changes outside the visible area are easier to find.

Some visual-only edits are intentionally ignored. Moving nodes around the canvas, changing their stacking order, and rearranging Subgraph port order do not count as node config changes.

Compare mode is temporary editor state. It is not saved to the project file and does not change how the project runs. Use the compare banner or **Stop comparing** in Project settings to exit compare mode.

## Saving a Project

Press **Ctrl+S** or **Cmd+S** to save the project, or choose **Save Project** in the top-bar **Menu** dropdown. This will save the project to the file system. If the project has not been saved before, you will be prompted to choose a location to save the project.

You can press **Ctrl+Shift+S** or **Cmd+Shift+S** (or choose **Save Project As**) to save the project to a new location.

In Studio Server, Save writes through the server rather than asking for a local file destination. The tab's dirty dot tracks unsaved project changes. A failed server save leaves the project dirty; edits made while a save is pending remain unsaved after that earlier save completes. Browser recovery is separate from Save and does not publish an endpoint or save a new server version.

## Downloading a Studio Server project for local execution

Right-click a project in the server's project tree and choose **Download bundle**.
Choose **Published** or **Saved latest** for every project in the
bundle, then **Prepare bundle**. Published uses saved latest for projects that have
no publication. Progress continues if you close the dialog;
reopen the same action to download the ready ZIP. After fixing a reported issue,
use **Retry export** to replace a failed or interrupted export with a fresh attempt.
Reopening and retrying retain the export's version choice. Ready exports offer
**Prepare another bundle** if you want a different bundle-wide version choice.
Ready bundles are retained for 24 hours. If a browser download is interrupted,
resume it using the browser's download controls while the export remains available;
after it expires, prepare a new bundle.

The ZIP includes recursively called projects and their matching datasets, with
one selected version per project. This selection overrides individual Subgraph
version choices only inside the bundle; it does not change the server project.
An incompatible target graph interface fails export rather than removing wires.
Unsaved editor edits are excluded. Extract the whole ZIP and use
[`loadProjectBundle`](../api-reference/node/loadProjectBundle) to run it with the
Node package. Simply placing individual project files next to each other does not
provide the required version mapping.

Configure API credentials, external plugins, services, Code-node npm dependencies
and local file paths separately. Project/dataset content may contain sensitive
values; inspect the bundle before sharing it. **Download project** still downloads
only one `.rivet-project` file.

### Opening and running a bundle in desktop Rivet

Extract the complete ZIP, then use **Open Project** to open `rivet-bundle.json`.
Rivet opens all bundled projects in separate tabs and selects the root project.
Already-open projects at those same paths keep their unsaved edits and datasets.
Opening a declared `.rivet-project` inside the bundle's `projects/` directory
opens just that member, while retaining its bundle dependency mapping.
Projects opened through the manifest retain that mapping when switching tabs
and running, even when the manifest declares nested project folders. If the
bundle is moved, reopen `rivet-bundle.json` at its new location before running.

Run the entry project in **Browser** or desktop **Node** mode. Dependency dataflow
appears in the matching project tabs, including tabs that are not selected.
Run controls and errors remain owned by the entry project's run. External debugger
mode does not resolve local bundles.

The entry project uses its current editor content and datasets. Other projects
are read from their saved bundle files for each run, so save edits in dependency
tabs before running the caller. You can edit and save extracted files without
recalculating checksums. Saves update the project and its data sidecar, not the
manifest; adding another project or a new dataset sidecar requires updating the
manifest or exporting a new bundle. Renaming an existing Graph Input or Graph
Output preserves its connections and updates the caller's visible port label,
including cross-project calls. Removing or replacing the node, changing its type,
or creating a conflicting port ID requires reviewing the caller before running.

Keep the directory structure when moving the bundle. Existing older bundles with
multiple versions of one project cannot open all versions as desktop tabs;
re-export with a bundle-wide version choice, or open an individual member.

## Opening a Project

To open a project, choose **Open Project** in the top-bar **Menu** dropdown or press **Ctrl+O**/**Cmd+O**. This will open a file dialog where you can choose a project to open. The project will be loaded into Rivet as the current project.

### Studio Server project tabs

In Studio Server's project tree, a single click opens a preview tab. Double-clicking, editing, saving or running the project makes that tab persistent. Opening a different clean preview can replace the previous preview; dirty work is not silently discarded. Clicking or double-clicking an already-open project activates its existing tab without reloading its content or clearing unsaved changes. Switching A → B → A preserves each project's edits and dirty indicator.

Folding or unfolding folders, including the selected project's parent, and clicking whitespace in the tree keep the selected project and its details. Clicking another project changes selection; activating an editor tab also updates the matching tree selection. Node settings follow the active project, even for duplicated projects with matching graph/node IDs.

### Automatic browser recovery

The editor checkpoints the workspace in the background and normally restores its latest committed checkpoint after reload. Healthy or pending recovery does not show a popup. Separate browser tabs have independent recovery writers; recovery is local to that browser and is not a server backup or cross-device sync.

Transient recovery failures retry automatically. If unsaved work cannot be protected, the editor asks you to save before closing or reloading; a browser unload warning may also appear. Successfully saved server projects remain saved even if browser recovery fails. If startup cannot restore a previous workspace, use **Retry loading** or, when offered, **Recover workspace** to choose a retained checkpoint. Choosing another checkpoint replaces the current workspace, so review the confirmation before proceeding. Recovery cannot promise to preserve edits after an uncommitted write, unavailable browser storage or a browser crash.
