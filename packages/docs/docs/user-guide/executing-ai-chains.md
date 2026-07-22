---
title: 'Executing Workflows'
sidebar_label: 'Executing Workflows'
---

## Data Flow

In general, data flows from **left to right** in a graph.

Graph execution will start from every node that does not have any inputs. You can refer to these nodes as **root nodes**.

When a node is executed, it will send its output to all of its connected nodes.

A node must wait for all of its inputs to be received before it can execute.

The following graph will _roughly_ execute in the order of these numbers. Every node with the same number will run in parallel. The arrows show the rough "flow" of the data.

![Data Flow](assets/data-flow.png)

## LLM Tool Continuation

One connection has an intentional request/response interpretation. When an
[LLM Chat Node](../node-reference/llm-chat) has **Tool use** and
**Auto-continue after toolcalls run** enabled, connect its **Tool Calls** output
to the **Tool Call** input of exactly one
[Delegate Tool Call Node](../node-reference/delegate-tool-call). Rivet shows
arrowheads at both ends of this wire because the LLM sends calls to the Delegate
and receives its results before continuing. The connection is still stored as a
normal graph wire; there is no return wire or special execution mode to add.
If LLM Chat uses **Run per item**, Rivet leaves this wire ordinary and uses
internal continuation for each split invocation; parallel split indexes cannot
safely share one connected Delegate result.

The LLM Chat node stays **Running** throughout the loop. The Delegate runs once
for each model tool-call round and also stays **Running** while that round's
handlers execute. Separate Delegate run pages let you inspect repeated rounds.
If more than one eligible Delegate is connected, Rivet marks the candidate wires
red and dashed and reports an ambiguity error. With no connected Delegate, LLM
Chat uses its internal tool delegation.

The Delegate exposes normal text that the assistant produced alongside its tool
calls as **Message (fires before tool call invocation)**. This port activates
automatically once for every tool call, and Rivet runs those branch invocations
before dispatching the shared tool batch.
**Output** and **Tool Result Message** follow ordinary left-to-right execution
after the Delegate finishes. Whitespace-only messages do not activate the
pre-tool branch.

An ordinary pre-tool branch must finish before tool dispatch. Put a **Start Async
Branch** node directly after the message output when the message should only
trigger work such as `setWebAppStatus`. The async node returns immediately, so
its downstream work can overlap the tools and later LLM rounds. The branch
remains managed by the root run. In a web app, the final foreground response is
returned as soon as it is ready even if that async branch is still running; the
processor keeps owning the branch until the full run settles.
Desktop previews and hosted WebSocket actions can show the intermediate status
while work continues; a regular HTTP action cannot display it before the action
response arrives.

A consumer that is still waiting for the final LLM response or another late
input stays in ordinary post-LLM execution. An already-ready pre-tool path
cannot be partially executed through a cycle, Loop Controller, Race Inputs, or
a foreground rejoin; Rivet reports that configuration before invoking tools.
Place **Start Async Branch** before an independently runnable, closed
side-effect subtree when it should overlap the tool work.

Branches can converge on the pre-tool message and final tool-result values
within the same round. Work that also needs the final LLM response or another
late input is deferred and runs once after those inputs are available; an output
from a previous tool round is not a fresh current-round dependency.

If the maximum tool-round limit is reached or the model asks for an unknown
tool, the unresolved raw calls continue through the ordinary downstream path so
you can inspect or handle them. A single-run Delegate accepts one raw call; use
**Run per item** on the Delegate or select one call before it when several raw
calls may remain.

## Freeze Node Output While Editing

When you are iterating on a graph in the editor, you can freeze a node's current output and reuse it during later editor runs. This is useful when a node is slow, expensive, random, or calls an external service, and you want downstream nodes to keep receiving the same value while you work.

To freeze a node output:

1. Run the graph so the node has a successful output.
2. Right-click the node on the canvas.
3. Choose **Freeze node output**.

If a node output has no retained successful run yet, the Freeze action is hidden until there is something to capture. If the output is already frozen, the menu shows **Unfreeze node output** instead. For other blockers, such as an unsupported node type or Remote Debugger/recording playback mode, the Freeze row stays visible but disabled and shows the reason below the label.

Nodes with frozen output show a snowflake **Output is frozen** notice at the top of their successful output preview, and the output area is blue-tinted. During later editor runs, Rivet skips the node's normal implementation and sends the captured output to downstream nodes. To return the node to normal execution, right-click it and choose **Unfreeze node output**.

You can also freeze or unfreeze several selected nodes at once. Right-click any node in the selection and choose **Freeze node outputs** or **Unfreeze node outputs**. Bulk actions use the same rules as freezing one node: Rivet only applies the action to selected nodes that support freezing and currently have a retained successful output, and skips selected nodes that do not.

Freeze state is temporary. It exists only while the project is open in the editor and is not saved into the project file. If you close the project, delete the node, delete its graph, or unfreeze it manually, the frozen output is removed.

Freezing captures the retained successful output runs for that node in the current run selection. When the node with frozen output is invoked again, Rivet replays those captured outputs in order. If the node is invoked more times than there are captured outputs, Rivet reuses the last captured output.

Frozen execution still follows normal graph readiness rules. If a node would not run because an upstream branch did not run, an `If` condition is false, or a required input is missing, freezing does not force it to run.

Frozen outputs replace computation, not every possible side effect. Rivet restores global-variable writes for frozen **Set Global** nodes, but other side effects such as graph-output boundaries, dataset writes, raised events, audio playback, external calls, and graph aborts are not replayed.

Some nodes cannot be frozen because their behavior is not useful or safe to replay as stored output data: **Comment**, **Abort Graph**, **Graph Output**, **Create Dataset**, **Append to Dataset**, **Replace Dataset**, **Raise Event**, **Play Audio**, and **Start Async Branch**. Replaying Start Async Branch could repeat its downstream side effects without executing the scheduling boundary normally. A **Delegate Tool Call** node that is currently the active LLM auto-continuation handler also cannot use frozen or preloaded output, because every tool round must execute its real handler work and return a fresh result to the running LLM. If stale output reaches the runtime anyway, the run fails before tool side effects and asks you to clear it.

Freeze node output is available only for normal editor runs in Browser mode or the built-in Node executor. It is not available while using an external Remote Debugger session or while viewing a loaded recording. When you connect an external Remote Debugger, Rivet hides frozen-output markers because remote runs do not use local frozen outputs. If you disconnect before any remote run happens, the markers come back. After a remote run starts, Rivet clears the frozen outputs for that open project.

When the built-in Node executor is selected, frozen outputs must be safe to send to the executor process. Rivet preserves explicit JavaScript `undefined` values during this transfer, including optional fields inside LLM message objects. If the captured value contains unsupported JavaScript-only values such as `BigInt`, circular references, `NaN`, `Infinity`, typed arrays, or class instances, Rivet will ask you to use Browser mode or freeze a JSON-serializable output instead.

## Chaining LLM Responses

A common flow for chaining model responses will be something like:

- Initialize a system prompt with a [Text Node](../node-reference/text), and connect it to the **System Prompt** port of an [LLM Chat Node](../node-reference/llm-chat).
- Construct your main prompt by using a [Text Node](../node-reference/text) or a [Prompt Node](../node-reference/prompt), and connect it to the **Prompt** port of an [LLM Chat Node](../node-reference/llm-chat). You may also use an [Assemble Prompt Node](../node-reference/assemble-prompt) to construct a series of messages. The Prompt input accepts a string, string array, chat message, or chat-message array.
- Commonly you will want to parse the LLM Chat **Response** output. For text responses, use the [Extract with Regex Node](../node-reference/extract-with-regex), the [Extract JSON Node](../node-reference/extract-json), or the [Extract YAML](../node-reference/extract-yaml) node. For JSON object or JSON schema response formats, LLM Chat outputs the parsed structured value directly when parsing succeeds, so downstream nodes can read it as an object without an extra JSON extraction step. If structured parsing fails, the Response output falls back to the raw string.
- Next, it is common to use an [Extract Object Path](../node-reference/extract-object-path) node to extract a specific value from the structured data using jsonpath. This is useful if you are using the [Extract JSON Node](../node-reference/extract-json) or the [Extract YAML](../node-reference/extract-yaml) node.
- You may want to take different actions depending on what your extracted value is. For this, you can use the [Regex Match Node](../node-reference/regex-match) to match the extracted value against a series of patterns. Or, you can use an [If/Else Node](../node-reference/if-else) to get fallback values.
- Next, you will often use more [Text Nodes](../node-reference/text), [Prompt Nodes](../node-reference/prompt), or Code nodes while interpolating extracted values, then send the result to another LLM Chat node.
- The workflow can continue indefinitely, with the response of one LLM Chat node becoming part of the prompt for another LLM Chat node. Or, you can use a [Loop Controller Node](../node-reference/loop-controller) to pipe the results of this workflow back into itself.

The legacy [Chat Node](../node-reference/chat) is still available for existing projects, but new Rivet 2 workflows should usually start with LLM Chat because it supports OpenAI, Anthropic, Google, custom OpenAI-compatible providers, input-port API keys, reasoning settings, tool use, and response status/error diagnostics from one node.
