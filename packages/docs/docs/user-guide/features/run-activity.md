# Run Activity

Run Activity is Rivet's run-level debugging view. It brings activity from the
root graph, subgraphs, model calls, delegated tools, and failures into one live
timeline while keeping the graph canvas available.

Use it when a workflow spans several graphs or invokes the same node more than
once and inspecting nodes individually no longer tells the whole story.

## Open Run Activity

Click **Runtime** in the lower-right status bar to open or close Run Activity.
The view is available before the first run and updates as soon as an execution
starts.

Run Activity is a drawer attached to the editor rather than a separate
workspace. You can resize it, or close and reopen it, without losing the current
filters or selection. On a narrow window, Rivet presents the same information
in a larger sheet.

Before a graph has run, the drawer explains that there is no activity yet.
While executions are active, it follows the newest active root execution. If
that execution finishes while an older root is still active, the active root
becomes visible again. When no roots remain active, Run Activity shows the
latest completed root execution. Use an
[execution recording](../recordings.md) when you need durable history that can
be saved and replayed later.

## Read the timeline

Each primary row represents one exact node invocation. A row includes the
node's graph, title, status, start time, duration, and a compact result or error
preview. Repeated subgraph calls, split runs, and multiple invocations of the
same node remain separate rows.

Expand a row to inspect the metadata available for that invocation, including
declared context-input previews and recorded model-call or tool-call metadata.
Rivet calls out result origin only when a value was replayed, preloaded, or came
from an older runtime whose origin cannot be verified; ordinary executions do
not repeat that expected detail on every row.
The collapsed result preview and **Open full output** action reuse Rivet's
normal execution-data storage instead of copying values into the activity
journal. If a value has already been removed from in-memory execution storage,
Run Activity reports that it is no longer available instead of showing an
invented empty value.

While a graph is running, existing rows update in place. Parallel operations
keep their original order when they finish. **Follow live** keeps the newest
activity visible while you remain at the bottom; if you scroll upward, Rivet
pauses automatic scrolling and tells you when newer activity is available.

The run-level status distinguishes graph outputs becoming available from the
whole execution becoming terminal. This matters when an async branch continues
after the graph's outputs are ready.

## Filter activity

Use the filters to focus on:

- **All** activity
- **LLM and tools**
- **Errors**

When several graphs participated in the run, you can also select a graph.
Search matches node titles as well as graph names, node types, tool names, and
short error text. Multiple search terms may match different metadata fields.
It does not load every large output merely to search it.

## Return to the exact invocation

Open a row's actions and choose **Locate on canvas** to return to the graph and
node invocation represented by that row. Rivet restores the matching graph run
and node process page before centering the node, so repeated subgraph calls do
not all lead to whichever invocation happened most recently.

Depending on the row, the actions can also include:

- **Open full output** for the existing node-output viewer
- **Inspect response** for the metadata-only LLM response inspector

Use **Copy diagnostics** in the drawer header when low-level run identities are
needed for a bug report.

Run Activity does not show internal IDs in its normal presentation.

## Scope and retention

Run Activity is an editor debugging surface, not conversation history and not a
web-app Chat component. Its journal keeps bounded metadata for every active
root execution and the latest completed root execution; the drawer presents one
of those roots at a time using the selection rules above. The underlying input
and output values remain owned by Rivet's normal execution-data storage rather
than being duplicated in the activity view.

Browser, Node, and Remote Debugger executions use the same activity model.
Replayed recordings use it as well; older recordings may show partial or
unknown provenance when they do not contain newer execution metadata.
