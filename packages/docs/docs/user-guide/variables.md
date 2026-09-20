---
title: Variables
sidebar_label: Variables
---

Variables let you reuse values in prompts, text, objects, code, and Match case **Cases**. In a field that supports Rivet interpolation, write `{{name}}` to insert a value when the node runs. This is Rivet syntax, not JavaScript template-string syntax, and it is not supported by every settings field.

For a guided exercise, see [Variables in the tutorial](../tutorial/variables.md).

## Interpolation and input ports

In a [Text](../node-reference/text.mdx) or [Prompt](../node-reference/prompt.mdx) node, enter:

```text
Hello {{name}}! Your order is {{order.id}}.
```

Rivet creates inputs named `name` and `order`. Connect a string to `name` and the whole order object to `order`. If they contain `Ada` and `{ "id": "A-42" }`, the result is `Hello Ada! Your order is A-42.`

Repeating a variable reuses the same port. Paths such as `{{order.id}}` and `{{order.total}}` also share the `order` port. These variables are node inputs, not assignments to a project-wide variable. Connections supply their values.

## JSONPath: select inside a value

Use a path after the input name to select nested data. Array indexes start at zero.

| Expression | Selects |
| --- | --- |
| `{{customer.name}}` | The customer's name |
| `{{order.items[0].price}}` | The first item's price |
| `{{order["delivery.address"].city}}` | A property whose literal name contains a dot, then its city |
| `{{order.items[*].name}}` | Every item's name |
| `{{orders[?(@.paid)].id}}` | IDs from orders matching the filter |
| `{{order..price}}` | Prices found recursively beneath the order |

This is the same JSONPath syntax used by [Extract Object Path](../node-reference/extract-object-path.mdx) and Destructure. There a complete path starts with `$`, for example `$.items[0].price`. Inside interpolation, the base variable replaces that root: `{{order.items[0].price}}`.

The `@` **inside a JSONPath filter** means the current item being tested. It is different from Rivet's runtime roots below.

A path with no matches resolves to an absent value; one match returns that value; multiple matches return an array. Do not assume a wildcard always produces an array when only one value matches. Text interpolation serializes selected objects and arrays as JSON. Bare inputs retain the receiving node's normal text conversion rules.

Whitespace around path separators is allowed: `{{order . items [ 0 ] . price}}` is equivalent to `{{order.items[0].price}}`. Whitespace inside quoted property names and filter expressions remains meaningful.

## Runtime variables: the `@` roots

These references read execution data directly and **do not create input ports**:

| Root | Source | Example |
| --- | --- | --- |
| `@graphInputs` | Values resolved by Graph Input nodes in this execution | `{{@graphInputs.order.id}}` |
| `@context` | Context values supplied by the execution caller | `{{@context.session.user.name}}` |
| `@globals` | The run's global-value store | `{{@globals.environment}}` |

Use an actual key after the root; these are not arbitrary `@name` variables. Names are case-sensitive. Paths and quoted keys work here too: `{{@globals["customer.profile"].names[0]}}` reads the global whose ID is literally `customer.profile`.

### Graph inputs and context

Use [Graph Input](../node-reference/graph-input.mdx) to define the inputs your graph accepts. Each Graph Input node records its resolved value, including its type conversion and default, when it runs. `@graphInputs` reads those recorded values, not arbitrary upstream outputs. Establish execution order with connections when a reader depends on an input node having run; the reference itself creates no dependency. Pass required inputs into subgraphs rather than assuming every subgraph can read the main graph's inputs.

`@context` is caller-provided execution context. It does not automatically expose operating-system environment variables, browser globals, or every HTTP request field. The caller must supply the key you reference; see [integration setup](../api-reference/getting-started-integration.mdx).

### Globals and execution order

`@globals` reads the same per-run store as [Get Global](../node-reference/get-global.mdx) and [Set Global](../node-reference/set-global.mdx). Initial values can be configured in **Project settings → General**, and Set Global can update them during execution. This is not a durable database or a way to share mutable state between independent runs.

A direct reference reads the value when its node starts. It does **not** wait for Set Global, make the writer execute, or order parallel branches. If a read must follow a write, connect the nodes to establish that dependency. Use Get Global when you need an explicit typed output, a missing-value default, **Wait**, or **On Demand** behavior.

## Text formatting

Text interpolation supports a pipe-separated formatter chain. Formatters run left to right after resolving the value:

```text
Hello {{customer.name | trim | uppercase}}!
{{article.summary | truncate 120}}
```

Numeric arguments use a space, not function-call parentheses.

| Formatter | Effect and default argument |
| --- | --- |
| `uppercase`, `lowercase` | Change letter case |
| `trim` | Remove surrounding whitespace |
| `indent 4` | Prefix each line with spaces; default 0 |
| `dedent` | Remove common indentation |
| `quote 1` | Prefix each line with Markdown quote markers; default 1 |
| `list 1` | Format lines as Markdown bullets; default nesting level 1 |
| `sort` | Sort newline-separated lines lexicographically |
| `truncate 50` | Keep this many characters, adding `...` if shortened; default 50 |
| `wrap 80` | Wrap words to a target line width; default 80 |

Use sensible nonnegative lengths and widths, and a positive list level. These are text formatters, not JavaScript functions or JSONPath operators. Do not rely on them in typed Object or JavaScript interpolation; transform typed data with the appropriate node or JavaScript instead.

## Text versus typed values

- **Text and prompts:** interpolation produces text. A missing or undefined reference becomes an empty string, so validate required data before constructing an important prompt or request.
- **Object JSON Template:** an unquoted token such as `{ "price": {{order.items[0].price}} }` inserts a JSON value and preserves its type. A token embedded in a longer JSON string inserts escaped text. Use unquoted tokens when you intend to retain numbers, booleans, objects, or arrays; see [Object](../node-reference/object.mdx).
- **Expression and Code:** tokens stand for JavaScript values. For example, `{{order.items[0].price}} * 2` computes a number in an [Expression](../node-reference/expression.mdx) node. Do not wrap the token in quotes to obtain a string; use JavaScript conversion when necessary. Keep surrounding JavaScript valid and handle missing values explicitly.

JSON and JavaScript fields have their own missing-value and serialization rules; do not assume Text's empty-string behavior applies everywhere. Interpolation-aware editors highlight the tokens separately from the surrounding language.

## Literal braces and troubleshooting

To output literal `{{name}}` in an interpolated template, author `{{{name}}}` (triple braces). It does not create a `name` input. Inserted text is not recursively expanded: if an input itself contains `{{other}}`, that text does not trigger another lookup.

If a value is missing:

1. Check spelling and case of the base input or runtime key.
2. Connect the whole object to the base port, not a port named after the full path.
3. Check array indexes, quoted property names, and whether a filter matches.
4. For globals, check that the writer runs before the reader starts.
5. Check whether the field supports interpolation and expects text, JSON, or JavaScript.

An invalid JSONPath can resolve as missing. Use Extract Object Path to inspect a query independently. Historical ports with literal dots or brackets are interpreted as paths now; reconnect their values to the base input rather than relying on those old names.
