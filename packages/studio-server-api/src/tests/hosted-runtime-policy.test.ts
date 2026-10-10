import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NodeProjectReferenceLoader,
  ExecutionRecorder,
  type DatasetProvider,
  type NodeCreatedProcessor,
  type ProjectReferenceLoader,
} from '@valerypopoff/rivet2-node';
import {
  createHostedRuntimeOptions,
  type HostedRuntimeDependencies,
} from '../routes/workflows/hosted-runtime-policy.js';
import { ExecutionSession } from '../routes/workflows/execution-session.js';

const input = { projectPath: '/workflows/main.rivet-project', datasetProvider: {} as DatasetProvider };

test('hosted runtime policy gives each execution independent configuration and preserves explicit loaders', async () => {
  const environment = { KEY: 'original' };
  const reference = new NodeProjectReferenceLoader();
  const subgraph = {
    loadTarget: async () => {
      throw new Error('not invoked during preparation');
    },
  };
  const dependencies: HostedRuntimeDependencies = {
    readEnvironment: async () => environment,
    createProjectReferenceLoader: async (projectPath) => {
      assert.equal(projectPath, input.projectPath);
      return reference;
    },
    createSubgraphProjectLoader: () => subgraph,
    getProfileHealth: async () => undefined,
  };
  const first = await createHostedRuntimeOptions(input, dependencies);
  const second = await createHostedRuntimeOptions(input, dependencies);
  assert.notEqual(first.codeRunner, second.codeRunner);
  assert.notEqual(first.nativeApi, second.nativeApi);
  assert.notEqual(first.executionEnvironment, second.executionEnvironment);
  (first.executionEnvironment as Record<string, string>).KEY = 'modified';
  assert.equal(second.executionEnvironment!.KEY, 'original');
  assert.equal(environment.KEY, 'original');
  assert.equal(first.projectReferenceLoader, reference);
  assert.equal(first.subgraphProjectLoader, subgraph);
});

test('cancellation stops policy preparation at each asynchronous boundary', async () => {
  for (const boundary of ['before', 'environment', 'references', 'health'] as const) {
    const controller = new AbortController();
    const seen: string[] = [];
    if (boundary === 'before') controller.abort(new Error(boundary));
    const step = (name: string) => {
      seen.push(name);
      if (name === boundary) controller.abort(new Error(boundary));
    };
    await assert.rejects(
      createHostedRuntimeOptions(
        { ...input, abortSignal: controller.signal },
        {
          readEnvironment: async () => {
            step('environment');
            return {};
          },
          createProjectReferenceLoader: async () => {
            step('references');
            return {} as ProjectReferenceLoader;
          },
          getProfileHealth: async () => {
            step('health');
            return undefined;
          },
          createSubgraphProjectLoader: () => {
            throw new Error('must not create a loader after cancellation');
          },
        },
      ),
      new RegExp(boundary),
    );
    assert.deepEqual(
      seen,
      ['environment', 'references', 'health'].slice(
        0,
        ['before', 'environment', 'references', 'health'].indexOf(boundary),
      ),
    );
  }
});

function processorFixture(tail: () => Promise<Record<string, { type: 'string'; value: string }>>) {
  let disposals = 0;
  const foreground = { output: { type: 'string' as const, value: 'early' } };
  const processor = {
    run: async () => foreground,
    processor: { waitForRunCompletion: tail },
    dispose: () => {
      disposals++;
    },
  } as unknown as NodeCreatedProcessor;
  return { processor, disposals: () => disposals };
}

test('a failed foreground delivery does not dispose or release a still-running execution', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = processorFixture(async () => {
    await gate;
    return { output: { type: 'string', value: 'terminal' } };
  });
  const session = new ExecutionSession(f.processor, { recording: false });
  const failure = new Error('response disconnected');
  const running = session.run(() => {
    throw failure;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.disposals(), 0);
  finish();
  const result = await running;
  assert.equal(result.outputs!.output!.value, 'terminal');
  assert.equal(result.failure!.error, failure);
  assert.equal(result.status, 'succeeded', 'delivery failure is not a graph failure');
  assert.equal(f.disposals(), 1);
  await assert.rejects(session.run(), /only once/);
});

test('late execution failure owns terminal status and cleanup even after foreground success', async () => {
  const failure = new Error('background graph failed');
  const f = processorFixture(async () => {
    throw failure;
  });
  let delivered = false;
  const result = await new ExecutionSession(f.processor, { recording: false }).run(() => {
    delivered = true;
  });
  assert.equal(delivered, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorMessage, failure.message);
  assert.equal(result.failure!.error, failure);
  assert.equal(f.disposals(), 1);
});

test('failed recorder attachment closes a prepared processor before any graph invocation', (t) => {
  const f = processorFixture(async () => ({}));
  const run = t.mock.method(f.processor, 'run');
  const failure = new Error('Recorder setup failed');
  t.mock.method(ExecutionRecorder.prototype, 'record', () => {
    throw failure;
  });
  assert.throws(
    () => new ExecutionSession(f.processor, { recording: true }),
    (error) => error === failure,
  );
  assert.equal(run.mock.callCount(), 0);
  assert.equal(f.disposals(), 1);
});

test('recorder construction failure also closes its prepared processor', () => {
  const f = processorFixture(async () => ({}));
  const failure = new Error('Invalid recorder configuration');
  assert.throws(
    () =>
      new ExecutionSession(f.processor, {
        recording: true,
        recorderOptions: {
          get includePartialOutputs(): boolean {
            throw failure;
          },
        },
      }),
    (error) => error === failure,
  );
  assert.equal(f.disposals(), 1);
});

test('processor cleanup errors preserve terminal success/failure and do not expose exception contents', async (t) => {
  const reported = t.mock.method(console, 'error', () => {});
  for (const failed of [false, true]) {
    const graphFailure = new Error('Graph failed');
    const f = processorFixture(async () => {
      if (failed) throw graphFailure;
      return { output: { type: 'string', value: 'complete' } };
    });
    const dispose = f.processor.dispose.bind(f.processor);
    t.mock.method(f.processor, 'dispose', () => {
      dispose();
      throw new Error('secret-provider-key');
    });
    const outcome = await new ExecutionSession(f.processor, { recording: false }).run();
    assert.equal(outcome.status, failed ? 'failed' : 'succeeded');
    assert.equal(outcome.failure?.error, failed ? graphFailure : undefined);
    if (!failed) assert.equal(outcome.outputs!.output!.value, 'complete');
    assert.equal(f.disposals(), 1);
  }
  assert.equal(reported.mock.callCount(), 2);
  assert.ok(reported.mock.calls.every((call) => !JSON.stringify(call.arguments).includes('secret-provider-key')));
});
