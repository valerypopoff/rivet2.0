# Data Types

Internally, the data the passes through Rivet is marked as a number of data types. When integrating Rivet with your own application, you will need to know what these data types are and how to handle them.

## DataValue

A DataValue is a value that can be passed through Rivet. It is a union of all the possible data types that can be passed through Rivet. It is represented as an object with a `type` property and a `value` property. The `type` key is in the table below, except when additional type decorators are present on the type.

## Decorators

A type may have the following decorators applied to it, which change the type. Decorators can be combined on a type name, for example a type can be `fn<string[]>`. Valid decorators are:

| Decorator  | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `[]`       | The type is an array of the type before the brackets.                   |
| `fn<type>` | The type is a function that returns the type inside the angle brackets. |

## Types

| Type                    | Description                                                              | TypeScript Type                            | Notes                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `any`                   | A special type of data that can store _anything_.                        | `unknown`                                  | Often, the value contained will be attempted to be either inferred based on the JavaScript type of the value, or it will be attempted to be coerced into a desired data type. Avoid using `any` in most cases, especially when you already know the type of a value. |
| `boolean`               | A boolean true or false.                                                 | `boolean`                                  | Equivalent to the JavaScript `boolean` type.                                                                                                                                                                                                                         |
| `string`                | A string value.                                                          | `string`                                   | Equivalent to the JavaScript `string` type.                                                                                                                                                                                                                          |
| `number`                | A number value.                                                          | `number`                                   | Equivalent to the JavaScript `number` type.                                                                                                                                                                                                                          |
| `date`                  | A date value.                                                            | `string`                                   | ISO-8601 date string.                                                                                                                                                                                                                                                |
| `time`                  | A time value.                                                            | `string`                                   | ISO-8601 time string.                                                                                                                                                                                                                                                |
| `datetime`              | A datetime value.                                                        | `string`                                   | ISO-8601 datetime string.                                                                                                                                                                                                                                            |
| `chat-message`          | A message sent to an LLM, including its role.                            | `ChatMessage`                              | Roles are `system`, `developer`, `user`, `assistant`, and `function`.                                                                                                                                                                                                |
| `object`                | An object value.                                                         | `Record<string, unknown>`                  | Roughly equivalent to the JavaScript `object` type. Often used interchangeably with `any`, and may be an array sometimes.                                                                                                                                            |
| `control-flow-excluded` | A value that is excluded from control flow.                              | `undefined`                                |
| `gpt-function`          | A JSON-schema-backed tool/function definition that an LLM can evaluate.  | (See Rivet source)                         | Used by LLM Chat tool inputs and legacy Chat function inputs.                                                                                                                                                                                                        |
| `vector`                | A vector of numbers.                                                     | `number[]`                                 | Used when generating and using embeddings.                                                                                                                                                                                                                           |
| `image`                 | An image value.                                                          | `{ mediaType: string; data: Uint8Array; }` |
| `audio`                 | An audio value.                                                          | `{ mediaType: string; data: Uint8Array; }` |
| `binary`                | A binary value.                                                          | `Uint8Array`                               |
| `knowledge-source`      | A named-store connection, logical source ID, and optional exact version. | `RivetKnowledgeSourceReference`            |
| `knowledge-document`    | Searchable text with optional identity, title, and metadata.             | `RivetKnowledgeDocument`                   |
| `knowledge-evidence`    | A normalized retrieved passage with source and document attribution.     | `RivetKnowledgeEvidence`                   |

## `any`, `null`, and `undefined`

The `any` type can carry JavaScript `null` or an explicit `undefined` value. Nodes such as Expression and Code can produce these values directly. When an output is a real `any` payload, Rivet displays the literal words `null` and `undefined` in the node output. `any[]` outputs use the same display rule for each item.

This is different from `control-flow-excluded`. A `control-flow-excluded` output also uses `undefined` as its runtime value, but it means the output did not run and Rivet displays it as `Not ran`.

## Interpolation-aware editors

Editors that support Rivet `{{name}}` interpolation treat those tokens as Rivet syntax while you type. Code-style editors such as Code, Expression, and the JS Filter / JS Map Callback Body editors still use JavaScript highlighting and diagnostics for the surrounding code. JSON-template editors such as Object JSON Template and GPT Function Schema validate the surrounding JSON live, but valid interpolation tokens can appear as JSON values, object keys, or string fragments without being shown as JSON syntax errors.

## Interpolation paths

Interpolation can select a value inside an object or array with the same JSONPath syntax used by [Extract Object Path](../node-reference/extract-object-path.mdx) and Destructure. For example:

```text
{{customer.name}}
{{order.items[0].price}}
{{orders[?(@.paid)].id}}
```

Rivet also tolerates whitespace around JSONPath structural separators consistently. For example, `{{order . items [ 0 ] . price}}` selects the same value as `{{order.items[0].price}}`, and `$ . items [ 0 ] . price` works the same way in Extract Object Path. Whitespace inside quoted values, regular expressions, filters, and object literals is preserved.

Each expression creates only one dynamic input: its base name. The examples above create `customer`, `order`, and `orders` inputs—not ports named `customer.name` or `order.items[0].price`. Connect the whole object or array to that base port, then Rivet selects the requested value when the node runs. A JSONPath query with no match behaves as an absent value; a query with one match returns that value, and a query with multiple matches returns an array.

`{{@graphInputs.profile.name}}`, `{{@context.session.user.name}}`, and `{{@globals.profile.name}}` use the same path syntax, but continue to read their graph, context, or global roots directly and do not create node inputs. `@globals` reads the current value from the same per-run global store used by [Get Global](../node-reference/get-global.mdx) and Set Global. It does not wait for another branch to assign a value or create an execution dependency, so connect a writer explicitly when ordering matters.

Text-like fields turn a selected value into text. JSON-template and JavaScript fields preserve the selected value's JSON/JavaScript shape when their normal interpolation rules allow it. You can still apply a text formatter after a path, for example `{{customer.name | uppercase}}`.

If an older project deliberately used a literal dynamic port name containing `.` or `[]`, it is now read as a path expression. Reconnect that value to the base port; Rivet does not silently migrate or guess those historical literal names.
