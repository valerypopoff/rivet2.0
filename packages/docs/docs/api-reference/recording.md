# Recording

Enabling recording of your rivet graph executions is simple and straightforward.

First, instantiate a new `ExecutionRecorder` instance:

```ts
const recorder = new ExecutionRecorder(options);
```

You can optionally pass in an options object to include partial outputs (streaming responses, default `false`) and debugging `trace` events (default `false`). Both options increase the file size of recordings.

Terminal node errors still retain any display-only outputs that a node explicitly
checkpointed before failing. For example, an LLM Chat node can preserve enabled
request/response bodies, usage, attempt diagnostics, request messages, partial
responses, tool calls, and enabled reasoning with its error even when streaming
partial outputs are not recorded. A split node error can likewise retain pages
for completed siblings and failed-item checkpoints. Those values are inspection
evidence, not successful graph outputs or downstream inputs. An old recording
can show only the evidence it originally captured; replay never invents missing
partial values.

```ts
export type ExecutionRecorderOptions = {
  includePartialOutputs?: boolean;
  includeTrace?: boolean;
};
```

Next, call `recorder.record()` on your `GraphProcessor` instance. You will have to use [createProcessor](./node/createProcessor.mdx) rather than [runGraph](./node/runGraph.mdx) to get a `GraphProcessor` instance.

```ts
const processor = createProcessor({ etc });
recorder.record(processor);
```

Once the processor has finished executing, you can call `recorder.getRecording()` to get a `Recording` object, or more simply, you can call `recorder.serialize()` to get a string serialized recording. You can then save your recording to a file, or any other storage medium:

```ts
const serializedRecording = recorder.serialize();
await writeFile('my-recording.rivet-recording', serializedRecording, { encoding: 'utf8' });
```

`abort` means cancellation has been requested; it does not mean node cleanup has
finished. Both successful and error aborts can emit late node terminals before
the root `done` or `error` event. `ExecutionRecorder` therefore keeps recording
through every abort and finishes only when that root terminal event arrives. A
socket that closes or whose recording owner is disposed settles its capture
without fabricating a completed recording. `getRecording()` returns a stable
event-array snapshot, so it is safe to persist after the recorder finishes.

## Recording Format

The recording format is subject to change. However, at the moment the recording format is a JSONL file, where each line is a JSON object representing a single event in the recording.

When replaying a recording, a `GraphProcessor` simply replays every event in the recording as if it were running and emitting events itself.
