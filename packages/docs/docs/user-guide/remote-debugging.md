---
title: 'Remote Debugging'
---

Remote debugging allows you to integrate the Rivet Core or Rivet Node libraries in another application, run your graphs in that other application, but see the live graph execution in the Rivet application! This is useful for debugging graphs that are running in a production environment, or for debugging graphs that are running in a different environment than the Rivet application. This is very useful when using the [External Call Node](../node-reference/external-call), as the default executor cannot call into your own application's code.

## Connecting the Remote Debugger

### Studio Server channels and run selection

Use matching channel codes in the latest endpoint URL and the Remote Debugger
WebSocket URL:

```text
Admin A:
POST /workflows-latest/endpoint@12345
wss://your-server/ws/latest-debugger@12345

Admin B:
POST /workflows-latest/endpoint@67890
wss://your-server/ws/latest-debugger@67890
```

Give your application/test client the endpoint URL and enter the matching
WebSocket URL in Remote Debugger. If your server uses a custom latest-workflow
base path, use that instead of `/workflows-latest`. No extra channel header or
registration is required; existing endpoint and debugger authentication still
apply. Codes are case-sensitive routing labels, **not passwords**, containing
1–32 ASCII letters, digits, underscores or hyphens. Leading zeroes matter.

Different codes separate events, replay and controls. Admins using the same code
intentionally share observation and controls, but select runs independently on
their own computers. Unsuffixed URLs use a separate default channel containing
only untagged executions. Published endpoints are not observed. Latest web-app
actions retain their usual URLs and use the default channel.

#### Choosing a run

Open **?** in the action bar to see the channel and a run picker with start time,
short ID and status in **Remote Debugger details**. It follows the newest relevant
run automatically:

- Choose a historical run to inspect it. The next new relevant run automatically
  becomes selected, even after you select history or pause another run.
- Existing runs' late outputs, completion events and replay do not interrupt
  history inspection. There is no follow/pin mode or **Follow newest** button.
- Switching the view does not resume, abort or rerun the previously selected run.
- Open bundle members share the selected root. The graph's **Execution n/N**
  selector still chooses invocations within that root.
- Unrelated projects do not steal selection. Called-project tabs are
  observation-only; use the debugger source tab for controls.

Controls target the run selected when clicked, not whichever run becomes newest
afterward. Prompt replies target the original question; the first valid answer
wins, even if two admins see it. A rejected control or lost acknowledgement is
never automatically retried. Inspect the observed run state before acting again.

#### History, reconnects and stopping

When you explicitly connect to an updated Rivet Server debugger, it waits for a
new run and does not import older server runs. Open **?** to select a run observed
in this browser session; completed runs are labelled **History**. Selecting a run
does not restart it. The next new relevant run automatically replaces that view.

Rivet retains at most **eight selectable runs**, with the selected run protected
when older entries are removed. This history is kept only in memory: refreshing
the page clears it, and older server runs do not refill it. Stopping or changing
the connection also starts a fresh list. Saved **Run recordings** are unaffected.

The event history is bounded too. **Retained history is incomplete** means details
were evicted, unsupported or unavailable;
Rivet does not rerun workflows or borrow another run's output to fill gaps.
Incomplete canvas history does not prevent a live source run retaining its
appropriate controls.

Returning to history restores an answer form only when the question is still
known to be waiting. Answered questions do not reopen. Every independent history
gap withdraws answer forms whose pending state is no longer trustworthy, even
after an earlier warning. A question can remain in activity history without an
answer form. This never stops the workflow or affects another admin's intact
connection.

If saved runtime definitions differ from unsaved editor content, Rivet warns
without replacing your edits. Missing graph/node identities are not painted onto
unrelated content. Reconnect preserves selection where possible, with controls
disabled until verified ready. An incompatible managed-server handshake closes
observation without stopping execution.

**Stop Remote Debugger** disconnects observation only. Accepted work, recordings
and AI cost accounting continue, independently of the number of viewers.
Outputs-ready does not mean background work has physically stopped.
Connecting again after Stop waits for new runs; existing displayed results may
remain as a static view. An accidental network disconnection is different: Rivet
automatically recovers your observation and selection, including missed events,
without restarting work. Older servers without history markers retain their
previous connection behavior.

If a server backend recovers an unavailable peer link, previously unseen runs
from that recovery are not imported. Rivet cannot prove those runs belong to
your current observation. Runs you were already observing continue
recovering automatically; the workflows themselves are never restarted.

Older editors can observe the default channel but must be upgraded for scoped
controls; named channels require the managed protocol. Generic third-party
debuggers retain their legacy behavior and do not gain channel isolation from
these URL conventions. Operators can inspect sanitized server diagnostics for
control/owner failures without exposing channel codes, answers or graph contents.

Select the **Remote Debugger** menu option in the Action Bar's menu dropdown, or press the **F5** key to open the remote debugger dialog. You must enter a WebSocket URI here to connect to. This URI must be a WebSocket server that uses `startDebuggerServer` from `@valerypopoff/rivet2-node`. You can use this function to start a WebSocket server that will allow the Rivet application to connect to it.

![remote debugger](assets/remote-debugger.png)

By default, `startDebuggerServer` will listen for all WebSocket connections on port **21888**. You can change this by passing a port number to the options argument to `startDebuggerServer`.

Remote Debugger connections can sit idle between graph runs. Rivet debugger servers keep these idle WebSocket connections alive with lightweight ping frames by default, and active debugger traffic resets pending heartbeat waits, so proxied or CDN-fronted deployments do not disconnect simply because no graph events are flowing.

Remote Debugger output values are sent over a display-safe JSON channel. If a workflow produces a value that cannot be represented as JSON, such as a circular object or `BigInt`, Rivet keeps the run lifecycle visible and shows a placeholder at that value branch instead of leaving nodes stuck as running. This only affects the debugger display payload; the workflow's runtime value is not changed.

## Running a Graph

While Rivet is connected to a remote debugger, the editor disables its normal run controls, including the **Run** buttons and node run context-menu actions. Start the graph from the remote process that owns the debugger server; Rivet will show that live execution as it happens. Use **Stop Remote Debugger** in the action bar when you want to disconnect and return to the normal Browser or Node executor run controls.

## Using the Remote Debugger

With a generic debugger server, attached graph executions are visible through that
server's existing observation policy. Studio Server managed debugging instead
shows the selected relevant root in your subscribed channel, as described above.

When `Show node run durations` is enabled in Rivet settings, Remote Debugger node outputs show `Duration: ...ms` if the remote debugger server sends duration metadata. Current `@valerypopoff/rivet2-node` processors attached with `remoteDebugger` send this metadata by default; older or custom debugger servers may omit it.

If you see an output placeholder that says an unserializable value was sent, the remote workflow still produced its original value. The placeholder means the Remote Debugger replaced only the displayed branch so the editor could continue receiving terminal node and graph events.

Pause and abort controls are available when the connected debugger supports them.
For Studio Server managed channels, use the source tab: these controls act only
on the explicitly selected root, not every workflow currently running on the
server. Generic debugger controls retain their server-defined behavior.

## Following calls across project tabs

Open the projects you want to inspect **before** starting the remote run, then
connect Remote Debugger from **any** open project in the bundle. If A calls B and B calls C,
switch between those tabs to see their live node inputs, streaming outputs,
completed results and Run Activity. In Studio Server they must belong to the same
explicit bundle, including its ordinary subfolders.
Only projects actually executed by the admitted run receive data.
All open bundle members show the same **Stop Remote Debugger** button immediately.
For example, you can connect from C, start A in the runtime, and stop the debugger
from B. One connection serves the bundle; unrelated open projects stay independent.
Bundle membership follows your Studio Server bundle container, or an explicitly
opened desktop bundle manifest. References alone do not group projects. Standalone
projects connect independently; external dependencies are not automatically observed.

Dependency tabs show an **Observing Remote Debugger** banner identifying the
source project and runtime target version when available. These are view-only
observations: pause, abort and user-input responses remain in the source project.
Use **Go to debugger source** to return there. **Stop Remote Debugger** disconnects
the whole bundle without stopping the remote execution. Each tab returns to its
previous Browser/Node executor mode. Closing the tab that opened the connection
does not disconnect the other open bundle members.

A local execution, recording playback or separate debugger connection takes
priority. The banner explains a conflict, and that tab can join a later run after
the conflict ends. Tabs opened or reopened during a run can share debugger controls
immediately, but wait for the next run's execution data.
The editor never replaces unsaved graph definitions with runtime versions; it
warns when matching graph/node data cannot be displayed. Older runtimes without
project ownership metadata retain single-project debugging. Completed output is
retained after disconnect, but an interrupted observation is not proof that the
remote execution itself stopped.

## Supporting Remote Debugging

See the [remote debugging](../api-reference/remote-debugging) section of the API Reference for more information on how to support remote debugging in your application.
