---
id: run
sidebar_label: run
---

# Rivet CLI - `run` Command

Run a Rivet graph in a project using provided input values.

## Quick Start

```bash
# Run with basic input
npx @valerypopoff/rivet2-cli run my-project.rivet-project --input name=Alice

# Run with JSON input
echo '{"name": "Alice"}' | npx @valerypopoff/rivet2-cli run my-project.rivet-project --inputs-stdin

# Run with inputs from a file
npx @valerypopoff/rivet2-cli run my-project.rivet-project --inputs-file ./input.json

# Run specific graph
npx @valerypopoff/rivet2-cli run my-project.rivet-project "My Graph" --input name=Alice

# Print only one output's value
npx @valerypopoff/rivet2-cli run my-project.rivet-project --unwrap-output answer
```

## Description

The `run` command executes a Rivet graph with specified inputs. This is particularly useful for:

- Testing graphs with specific inputs
- Integrating Rivet into command-line scripts and tools
- Automating graph execution from other programming languages
- Development and debugging of graph implementations

## Usage

The basic usage will run the main graph in the provided project file, with no input values:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project
```

You can also specify a specific graph in the file to run:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project "My Graph"
```

## Inputs

Inputs can be provided in several ways. Use only one input source per run.

The first way is to use the `--input` flag for each string input value:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --input input1=5 --input input2=10
```

This is useful for basic input values and allows for easy testing of various scenarios.

Use `--input-json` when a single command-line input should be parsed as JSON:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --input-json count=5 --input-json payload='{"name":"Alice"}'
```

The second way is to provide the inputs using a JSON object from standard input. This is useful for more complex input values:

```bash
echo '{"input1": 5, "input2": 10}' | npx @valerypopoff/rivet2-cli run my-project.rivet-project --inputs-stdin
```

This is useful for more complex input values, such as arrays or objects, as well as piping input values from other commands or scripts.

Standard-input JSON must be an object. Arrays, strings, numbers, booleans, and `null` are rejected because Rivet graph inputs are keyed by input name.

You can also read that object from a file:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --inputs-file ./input.json
```

`--inputs-stdin`, `--inputs-file`, and `--input` / `--input-json` are mutually exclusive. This keeps scripted runs predictable.

Raw JSON objects are sent as `object` Data Values. Raw homogeneous JSON arrays are sent as typed array Data Values, such as `string[]`, `number[]`, `boolean[]`, or `object[]`. Mixed, empty, null-containing, or nested arrays are sent as `any[]` so the CLI does not guess a misleading narrower type.

For `--input` and `--context`, the CLI splits on the first `=`. Empty string values are allowed, and additional `=` characters stay inside the value:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --input query="name=Alice" --input optional=
```

Context values support the same split between string values and JSON/file values:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --context requestId=abc123
npx @valerypopoff/rivet2-cli run my-project.rivet-project --context-json headers='{"x-request-id":"abc123"}'
npx @valerypopoff/rivet2-cli run my-project.rivet-project --context-file ./context.json
```

## Project References and Datasets

The CLI passes the resolved `.rivet-project` path into the Node runtime, so project references are resolved relative to the project file just like normal Node execution.

The CLI also loads the adjacent `.rivet-data` file when one exists:

```text
my-project.rivet-project
my-project.rivet-data
```

If the data file does not exist, the run starts with no datasets unless `--require-dataset-file` is passed. Dataset mutations stay in memory by default. Pass `--save-datasets` to write mutations back to the dataset file.

You can point at a custom dataset file:

```bash
npx @valerypopoff/rivet2-cli run my-project.rivet-project --dataset-file ./fixtures/test.rivet-data
```

## Outputs

The Rivet CLI outputs JSON data to standard output. Each Graph Output node in the graph will correspond to a key in the output JSON object.

The value of each property will be a [Data Value](../user-guide/data-types.md) object, with a `type` property and a `value` property.

For example, if a graph has two Graph Output Nodes, `output1` (a string) and `output2` (a number), the output JSON object will look like this:

```json
{
  "output1": {
    "type": "string",
    "value": "Hello, World!"
  },
  "output2": {
    "type": "number",
    "value": 42
  }
}
```

## Options

### Input Configuration

- `--input` - Specify an input value for the graph. Can be used multiple times.
- `--input-json` - Specify an input value parsed as JSON using `key=json`. Can be used multiple times.
- `--inputs-stdin` - Read input values from standard input as a JSON object.
- `--inputs-file` - Read input values from a JSON file.
- `--context` - Specify a single [context value](../node-reference/context.mdx) for the graph. Can be used multiple times. Context can be used to pass global values to the graph. Context is specified using the same format as `--input`.
- `--context-json` - Specify a context value parsed as JSON using `key=json`. Can be used multiple times.
- `--context-file` - Read context values from a JSON file.

### Dataset Configuration

- `--dataset-file` - Use a specific `.rivet-data` file instead of the adjacent project data file.
- `--save-datasets` - Persist dataset mutations back to the dataset file.
- `--require-dataset-file` - Fail if the dataset file does not exist.

### Output Configuration

- `--include-cost` - Includes the cost of the graph execution in the output JSON object. The cost is included as a `cost` property on the output JSON.
- `--output-key` - Prints only one named output as a Data Value object.
- `--unwrap-output` - Prints only the `.value` field from one named output.
- `--output-file` - Writes the final JSON payload to a file instead of standard output.
