---
title: 'Remote Debugging'
---

Remote debugging allows you to integrate the Rivet Core or Rivet Node libraries in another application, run your graphs in that other application, but see the live graph execution in the Rivet application! This is useful for debugging graphs that are running in a production environment, or for debugging graphs that are running in a different environment than the Rivet application. This is very useful when using the [External Call Node](../node-reference/external-call), as the default executor cannot call into your own application's code.

## Connecting the Remote Debugger

Select the **Remote Debugger** menu option in the Action Bar's menu dropdown, or press the **F5** key to open the remote debugger dialog. You must enter a WebSocket URI here to connect to. This URI must be a WebSocket server that uses `startDebuggerServer` from `@valerypopoff/rivet2-node`. You can use this function to start a WebSocket server that will allow the Rivet application to connect to it.

![remote debugger](assets/remote-debugger.png)

By default, `startDebuggerServer` will listen for all WebSocket connections on port **21888**. You can change this by passing a port number to the options argument to `startDebuggerServer`.

Remote Debugger connections can sit idle between graph runs. Rivet debugger servers keep these idle WebSocket connections alive with lightweight ping frames by default, and active debugger traffic resets pending heartbeat waits, so proxied or CDN-fronted deployments do not disconnect simply because no graph events are flowing.

Remote Debugger output values are sent over a display-safe JSON channel. If a workflow produces a value that cannot be represented as JSON, such as a circular object or `BigInt`, Rivet keeps the run lifecycle visible and shows a placeholder at that value branch instead of leaving nodes stuck as running. This only affects the debugger display payload; the workflow's runtime value is not changed.

## Running a Graph

While Rivet is connected to a remote debugger, the editor disables its normal run controls, including the **Run** buttons and node run context-menu actions. Start the graph from the remote process that owns the debugger server; Rivet will show that live execution as it happens. Use **Stop Remote Debugger** in the action bar when you want to disconnect and return to the normal Browser or Node executor run controls.

## Using the Remote Debugger

Whenever a graph is started on the server, its execution will immediately be visible in Rivet if it is connected as a remote debugger.

When `Show node run durations` is enabled in Rivet settings, Remote Debugger node outputs show `Duration: ...ms` if the remote debugger server sends duration metadata. Current `@valerypopoff/rivet2-node` processors attached with `remoteDebugger` send this metadata by default; older or custom debugger servers may omit it.

If you see an output placeholder that says an unserializable value was sent, the remote workflow still produced its original value. The placeholder means the Remote Debugger replaced only the displayed branch so the editor could continue receiving terminal node and graph events.

By default, you can both pause and abort the current execution in Rivet, and the execution will be paused or aborted on the remote server. This can be useful if you want to pause the execution to inspect the current state of the graph, or if you want to abort the execution because you detect some incorrect behavior.

## Following calls across project tabs

Open the projects you want to inspect **before** starting the remote run, then
connect Remote Debugger from **any** open project in the bundle. If A calls B and B calls C,
switch between those tabs to see their live node inputs, streaming outputs,
completed results and Run Activity. Projects do not need to be in the same folder.
Only projects actually executed by the admitted run receive data.
All open bundle members show the same **Stop Remote Debugger** button immediately.
For example, you can connect from C, start A in the runtime, and stop the debugger
from B. One connection serves the bundle; unrelated open projects stay independent.
Bundle membership follows explicit project references or an opened bundle manifest,
not simply projects being in the same folder.

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
