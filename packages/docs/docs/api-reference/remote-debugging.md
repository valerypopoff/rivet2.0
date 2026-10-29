# Remote Debugging with Rivet

## Introduction

One of the powerful features of Rivet is the ability to debug your graphs remotely. This means that you can execute a graph in your application and connect to it from Rivet to inspect the graph execution in real-time. This is achieved by using the `RivetDebuggerServer` which is included in the `@valerypopoff/rivet2-node` package.

## Setting Up Remote Debugging

In order to set up remote debugging, you need to create an instance of `RivetDebuggerServer` and pass it to the `runGraph` or `runGraphInFile` functions. This will allow the graph execution to communicate with the debugger server.

You should only call `startDebuggerServer` once in your application. You can then pass the same instance to multiple `runGraph` or `runGraphInFile` calls.

Here's an example of how you can do this:

```typescript
import { startDebuggerServer, runGraphInFile } from '@valerypopoff/rivet2-node';

// Start the debugger server
const debuggerServer = startDebuggerServer({
  port: 8080, // Optional: default 21888
});

// Run the graph with the debugger server
await runGraphInFile('./myProject.rivet', {
  graph: 'My Graph Name',
  remoteDebugger: debuggerServer, // Pass the debugger server
  // other options...
});
```

In this example, the `startDebuggerServer` function is used to start the debugger server. The `port` option is used to specify the port number on which the server will listen. The `runGraphInFile` function is then used to run the graph, and the debugger server is passed as the `remoteDebugger` option.

`startDebuggerServer` sends lightweight WebSocket ping frames every 30 seconds by default and terminates clients that do not answer within 10 seconds. Inbound debugger messages and successful workflow-event broadcasts also count as websocket activity while a heartbeat is pending. This keeps idle remote-debugger connections alive through common proxy and CDN idle timeouts without letting an older ping timeout interrupt a post-idle workflow broadcast. If your host owns WebSocket liveness itself, you can adjust `heartbeatIntervalMs` and `heartbeatTimeoutMs`, or disable the built-in heartbeat by setting `heartbeatIntervalMs: 0`.

Server-to-client Remote Debugger messages are serialized as display-safe JSON. Runtime graph values are not mutated, but non-JSON-safe debugger payload branches are replaced with placeholder strings before sending so lifecycle events such as `nodeFinish` and `graphFinish` are not dropped. Explicit `undefined` is preserved through a debugger-transport sentinel that Rivet decodes on receipt.

## Connecting to the Debugger Server from Rivet

Once the debugger server is running and a graph is being executed, you can connect to it from Rivet by clicking on the "Remote Debugging" button in the toolbar.

The syntax uses a WebSocket URL with the following format by default:

```
ws://<host>:<port>
```

To connect to a locally running server, you can use

```
ws://localhost:21888
```

However, you may use your own remote debugger WebSocket server and any URL you like in your application, but that is out of scope for this documentation.

## Advanced Options

### Studio Server managed latest protocol

Every independent history-loss notice invalidates pending prompt proof, including
a second loss on one connection. Toast deduplication does not suppress invalidation.
Peer readers accept property reordering; writers preserve the historical envelope.
The Core managed-message union includes handshake, scoped execution, prompt
closure, physical settlement, diagnostics, commands and acknowledgements. Shared
readers validate routing/control fields without rewriting authored values. The
wire version and sentinel encoding are unchanged. Unknown messages do not fall
through to legacy controls; invalid or mismatched acknowledgements cannot confirm
a command and never authorize replay.

Operational control failures are observable through existing logs and optional
metrics using finite `ownership`/`unavailable` categories, alongside history and
publication-failure categories. Labels contain no channel/run/prompt identifiers,
answers or payloads; a failing sink does not affect execution or control replies.

Studio Server pairs `POST /workflows-latest/endpoint@12345` with
`wss://host/ws/latest-debugger@12345`. The configured latest-workflow base replaces
`/workflows-latest` when customized. `@code` is the only channel interface; query
parameters do not select a channel. Ordinary authentication/body/response contracts
remain unchanged. Codes are case-sensitive routing labels, not passwords.
The base endpoint still owns publication, recordings, retention and statistics.
Codes contain 1–32 ASCII letters, digits, underscores or hyphens; leading zeroes
are preserved. Empty codes, multiple `@` separators and encoded path separators
are rejected. Decode each route segment exactly once. Sharing a code deliberately
shares observation/control access among already authenticated admins, not a secret
authorization boundary. Each viewer selects its run independently.

Unsuffixed URLs subscribe to an isolated default channel. Published executions
remain outside latest debugging. Latest web-app actions use their existing URLs
and default channel. Called projects inherit the root's debugging ownership.

The server announces `latest-session` with `protocol: 2`, exact `channel`,
`channelIsolation: true` and `runScopedControls: true`. Each managed event has
`rivetScope: { channel, rootRunId, projectId, owner, incarnation, admittedAt }`;
prompt events also include `promptId`. Graph/child ancestry stays in `data.execution`.
An owner may additionally advertise `rivetScope.promptLifecycle: 1` for its entire
root lifetime. It emits `latest-prompt-closed` with `data: { promptId }` in the same
scoped stream before consuming that exact callback. This is per execution owner,
not a promise about all peers made by the relay handshake. Closure contains no
answers or callbacks. An editor restoring history must not reopen consumed
prompts. Without this capability, or after a stream gap, retained prompt events
are activity-only unless fresh pending evidence is available.
History-gap, truncation and oversize diagnostics immediately invalidate displayed
pending proof as well. An unavailable control owner alone does not prove a history
gap. Failure to publish observer notifications does not block a consumed answer
callback or execution-registration cleanup; it never permits replaying the answer.
The editor validates this binding before display admission. The typed internal
contract lives in Core's `LatestDebuggerProtocol`; authored formats do not change.
Both capability flags must be literal `true`. Named channels admit no events
before a verified handshake; an established v2 logical session cannot downgrade
after reconnect. Managed observation does not service the viewer's dataset
provider or accept project-upload permission frames.

Managed controls use an exact target, for example:

```json
{
  "type": "latest-control",
  "data": {
    "commandId": "client-generated-unique-id",
    "target": {
      "channel": "12345",
      "rootRunId": "run",
      "projectId": "project",
      "owner": "backend-0",
      "incarnation": "process"
    },
    "action": "pause"
  }
}
```

Other actions are `resume`, `abort` and `user-input` (with the exact `promptId` and
`answers: { "type": "string[]", "value": ["answer"] }`). A
`latest-control-result` echoes the command ID with `accepted`, `rejected` or
`outcome-unknown`. Never resend a modifying command to conceal a transport gap.
No graph upload, preload or execution dispatch is admitted on this connection.
`latest-settled` follows physical completion; outputs-ready is not settlement.
Observer count, history replay and observer disconnects do not change recording
capture or AI accounting. The server retains the original execution owner until
physical settlement; it does not transfer accepted work on reconnect.

Channel/run/control isolation applies only to this managed transport, not arbitrary
`startDebuggerServer` instances. Generic debugger options below remain unchanged.

The `startDebuggerServer` function provides several advanced options for handling multiple processors and clients, dynamic graph running, graph uploading, and WebSocket heartbeat behavior. For more details about these options, see the [startDebuggerServer API documentation](./node/startDebuggerServer).

## See Also

- [Getting Started with Rivet Integration](./getting-started-integration)
- [Rivet Node API Reference](./node/overview)
