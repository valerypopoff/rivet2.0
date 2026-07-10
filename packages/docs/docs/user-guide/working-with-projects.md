---
title: 'Working with Projects'
---

A Rivet project contains a set of graphs. These graphs can call each other by using a [Subgraph Node](../node-reference/subgraph). Any graph can call any other graph in the project (including itself).

Projects can also contain project-level resources such as the Node library and [Rivet web apps](./rivet-web-apps). Web apps are declarative UI screens that can call ordinary graphs in the same project.

## Creating a Project

To create a new project, choose **New Project** in the top-bar **Menu** dropdown. This will create a new blank project with one empty graph named **Main graph**. The new project is unsaved by default.

## Project Settings

Use **Project settings** at the top of the graph tree panel to give your project a new name and optionally a description. This is simply metadata and does not affect the execution of the project.

The Main Graph setting controls where Rivet starts its unreachable-graph analysis. Graphs that cannot be reached from the Main Graph can show a broken-thread icon in the graph tree. To hide those markers, turn off **Show unreachable graph indicators** in **Rivet settings** > **Graphs**.

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

## Opening a Project

To open a project, choose **Open Project** in the top-bar **Menu** dropdown or press **Ctrl+O**/**Cmd+O**. This will open a file dialog where you can choose a project to open. The project will be loaded into Rivet as the current project.
