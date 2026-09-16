---
title: Variables
sidebar_label: Variables
---

This exercise teaches interpolation, JSONPath, and runtime `@` variables without calling an AI provider. Create a new graph; no tutorial-project changes are required. See the [Variables reference](../user-guide/variables.md) for the complete syntax and text formatters.

## 1. Insert an input into text

Add two [Text](../node-reference/text.mdx) nodes. Enter `Ada` in the first and this template in the second:

```text
Hello {{name}}!
```

The second node gains a `name` input. Connect the first node's output to it and run the graph. The second output is `Hello Ada!`. Change its template to `Hello {{name | uppercase}}!` and run again to get `Hello ADA!`.

## 2. Select fields with JSONPath

Add an [Object](../node-reference/object.mdx) node with this JSON template:

```json
{
  "customer": { "name": "Ada" },
  "items": [
    { "name": "Notebook", "price": 12 },
    { "name": "Pen", "price": 3 }
  ]
}
```

Add a Text node containing:

```text
Customer: {{order.customer.name}}
First price: {{order.items[0].price}}
Items: {{order.items[*].name}}
```

Connect the Object output to the single `order` input. All three paths share it. Run the graph; the output should be:

```text
Customer: Ada
First price: 12
Items: ["Notebook","Pen"]
```

Try `{{order.items[?(@.price > 5)].name}}`. It selects `Notebook`. Here `@` means the current item in a JSONPath filter, not a global variable. With one match, the selected result is one value, not a one-item array.

## 3. Keep a value typed

Add an [Expression](../node-reference/expression.mdx) node:

```text
{{order.items[0].price}} * 2
```

Connect the same Object output to its `order` input. The result is the number `24`. In Expression, a token is a value rather than a text replacement. For an Object node, use an unquoted token to keep the type:

```text
{ "firstPrice": {{order.items[0].price}} }
```

## 4. Read a global without another wire

In **Project settings → General**, configure a global with ID `environment` and string value `training`. Add this line to a Text node:

```text
Environment: {{@globals.environment}}
```

No new input port appears. Run the graph to see `Environment: training`.

[Set Global](../node-reference/set-global.mdx) can change the value during a run, but a parallel reader is not guaranteed to see the change. Connect the writer before the reader when order matters, or use [Get Global](../node-reference/get-global.mdx) for its explicit waiting/default behavior. `@globals` by itself does not wait.

## 5. Recognize the other runtime roots

Define an `order` input with [Graph Input](../node-reference/graph-input.mdx), then supply it from a parent graph or integration. Once that Graph Input node has run, `{{@graphInputs.order.customer.name}}` reads its resolved value. Connect dependencies so the reader runs afterward. Merely creating an Object node named Order does not populate `@graphInputs`.

If the caller supplies context containing `session: { "user": { "name": "Ada" } }`, `{{@context.session.user.name}}` reads `Ada`. This is caller-provided context, not an automatic browser or HTTP-request variable. Both roots support JSONPath and neither creates a node input.

## 6. Check missing values and literal braces

In a Text node, try `Missing: {{order.unknown}}` with the Object connected. The missing property becomes empty text. Validate required fields instead of treating an empty result as proof that data is correct.

Enter `{{{name}}}` to produce literal `{{name}}` without a `name` port. Triple braces are useful when explaining template syntax or asking an LLM to produce a template.

Next, continue with [Interpolation & More Node Types](./02-interpolation-more-node-types.md) to use interpolation in the supplied AI tutorial graph.
