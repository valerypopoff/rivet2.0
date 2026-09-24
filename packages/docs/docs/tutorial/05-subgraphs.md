---
title: 05 - Subgraphs
---

# Subgraphs

Subgraphs let one graph call another graph. This tutorial uses two graphs in the same project; Rivet Studio Server can also call a graph in another project.

In this tutorial, you will make a helper graph with explicit inputs and outputs, then call it from another graph with a [Subgraph Node](../node-reference/subgraph.mdx).

## What a Subgraph Is

A Rivet project can contain many graphs. Any graph can be used as a subgraph by another graph.

The callable interface of a graph is defined by:

- [Graph Input Nodes](../node-reference/graph-input.mdx), which become input ports on the Subgraph node.
- [Graph Output Nodes](../node-reference/graph-output.mdx), which become output ports on the Subgraph node.

If you change the inputs or outputs inside the called graph, the Subgraph node updates to match.

## Create a Helper Graph

1. Create a new graph in the current project.
2. Name it `Format Greeting`.
3. Add a Graph Input node.
4. Set the Graph Input ID to `name`.
5. Set its data type to `String`.
6. Add a Text node.
7. Set the Text node template to:

```text
Hello, {{name}}.
```

8. Connect the Graph Input output to the Text node `name` input.
9. Add a Graph Output node.
10. Set the Graph Output ID to `greeting`.
11. Connect the Text node output to the Graph Output node.

You now have a graph that accepts `name` and returns `greeting`.

## Call the Helper Graph

1. Open your main graph.
2. Add a Text node with the value:

```text
Rivet
```

3. Add a Subgraph node.
4. In the Subgraph node settings, choose `Format Greeting`.
5. Connect the Text node output to the Subgraph node `name` input.
6. Run the graph.

The Subgraph node output `greeting` should contain:

```text
Hello, Rivet.
```

The important part is that the Subgraph node did not need custom code. Its ports came from the Graph Input and Graph Output nodes in the called graph.

## Reuse the Same Graph

You can add another Subgraph node and point it to `Format Greeting` again. Each Subgraph node can receive different inputs, but both use the same graph definition.

This is useful for:

- formatting repeated prompt sections
- normalizing API responses
- wrapping a group of nodes that you use in several places
- keeping large workflows readable

## Error Handling

The Subgraph node has a `Use Error Output` setting.

When it is off, an error inside the called graph fails the Subgraph node. When it is on, the Subgraph node produces the error text on its `Error` output instead.

Use the error output when a subgraph call is optional or when you want the parent graph to decide how to recover.

## Notes

- In Rivet Studio Server, **Graph source** in the node settings can be **This project** or **Other projects**. For another project, browse its folders and graphs, then choose **Saved latest** or **Published** under **Version**. Desktop Rivet supports only this-project calls. See the [Subgraphs guide](../user-guide/subgraphs.md) for the version and connection rules.
- A graph can call another subgraph, so you can build layers of reusable workflow pieces.
- Avoid accidental recursion unless you intentionally combine subgraphs with loop control.
- When renaming a Graph Input or Graph Output ID, keep its underlying node: existing cross-project wires can then retain their port IDs. Removing a port or changing its type still requires reviewing callers.
