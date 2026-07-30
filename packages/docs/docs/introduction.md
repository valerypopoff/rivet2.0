---
slug: /user-guide
---

# Introduction to Rivet

Welcome to the Rivet User Guide. Rivet 2 is a desktop app for building, debugging, testing, and running AI workflows visually.

You create `.rivet-project` files by placing nodes on a canvas, connecting them with wires, configuring each node, and running the graph while Rivet shows you the data moving through it.

Rivet is built for creating AI workflows, but non-AI workflows work well too. You can build workflows without writing code at all, or use special code nodes when a particular operation is easier to express in JavaScript. That makes Rivet a low-code tool: visual by default, code-friendly when you want it.

Rivet can be used for quick experiments and for production-ready workflows that power high-load products and features. It can also run as a self-hosted web app through [Rivet Studio Server](https://github.com/valerypopoff/Rivet-Studio-Server).

This guide is written for people using the Rivet desktop app. If you are integrating Rivet into another TypeScript, JavaScript, server, or wrapper application, start with the [Rivet API Reference](/api-reference).

## What You Can Do In The App

### Build Graphs Visually

Rivet's node-based editor helps you create AI workflows without hiding the flow of data. You can inspect every node, follow each wire, and see intermediate values while a graph is running.

Start with the [overview of the interface](/user-guide/overview-of-interface), then learn how to [add and connect nodes](/user-guide/adding-connecting-nodes).

### Use Built-In Nodes

Rivet includes built-in nodes for text, LLM chat, HTTP calls, JSON and YAML extraction, loops, matching, subgraphs, datasets, files, MCP tools, and code. These nodes can be combined into larger workflows and reused across projects.

Documentation for every built-in node is available in the [Node Reference](/node-reference).

### Run And Debug Workflows

You can run graphs directly from the desktop app in Browser or Node executor mode. Browser mode is convenient for simple workflows. Node mode is better for serious local workflows that need local files, MCP, package-backed code, or fewer browser limitations.

Rivet also gives you live run data, node outputs, run history, and debugging views so you can see what happened at each step.

### Work With Projects

Rivet projects can contain multiple graphs, datasets, plugin usage, and app-specific workflow settings. The graph tree, project sidebar, and workspace tools help you organize larger projects without leaving the app.

See [working with projects](/user-guide/working-with-projects), [working with graphs](/user-guide/working-with-graphs), and [executing workflows](/user-guide/executing-ai-chains).

### Use App Workspaces

The desktop app includes workspaces for Prompt Designer, Chat Viewer, Data Studio, and Trivet tests. These tools help you tune prompts, inspect chat outputs, manage datasets, and test graphs from the same Rivet window.

### Extend Rivet With Plugins

Plugins add node types to the desktop app. You install plugins in Settings > Plugins, then add their nodes to any graph. Rivet tracks which plugin nodes a project actually uses when the project is saved.

See [Plugins](/user-guide/plugins) for more information.

## Get Started

1. [Install Rivet](/getting-started/installation)
2. [Set up providers and app settings](/getting-started/setup)
3. [Build your first AI workflow](/getting-started/first-ai-agent)
4. [Learn the interface](/user-guide/overview-of-interface)
5. [Browse the node library](/node-reference)
