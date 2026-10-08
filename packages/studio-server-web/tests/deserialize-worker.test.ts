import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeProject, type Project } from '@valerypopoff/rivet2-core';
import { parseHostedProjectPayload } from '../overrides/utils/hostedProjectPayload.js';

test('worker preparation parses the sidecar once and retains datasets and legacy Evaluation attachments', (t) => {
  const contents = serializeProject({ metadata: { id: 'worker', title: 'Worker' }, graphs: {} } as Project);
  const datasets = [
    { meta: { id: 'data', projectId: 'worker' }, data: { id: 'data', rows: [{ id: 'row', data: ['value'] }] } },
  ];
  const evaluationDatasets = [{ id: 'legacy-evaluation', projectId: 'worker' }];
  const sidecar = JSON.stringify({ datasets, evaluationDatasets });
  const parse = t.mock.method(JSON, 'parse');
  const result = parseHostedProjectPayload(contents, 'worker.rivet-project', sidecar);
  assert.deepEqual(result.datasets, datasets);
  assert.deepEqual(result.evaluationDatasets, evaluationDatasets);
  assert.equal(parse.mock.calls.filter((call) => call.arguments[0] === sidecar).length, 1);
  assert.deepEqual(parseHostedProjectPayload(contents).datasets, []);
  for (const invalid of ['null', '{}', '{"datasets":{}}', '{"datasets":[],"evaluationDatasets":{}}', 'broken']) {
    assert.throws(() => parseHostedProjectPayload(contents, undefined, invalid));
  }
});

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  request?: { id: string; type: string };
  terminated = false;
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage(request: { id: string; type: string }) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  respond(result: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: { id: this.request!.id, type: this.request!.type + ':result', result } }),
    );
  }
}
Object.defineProperty(globalThis, 'Worker', { value: TestWorker, configurable: true });
const { deserializeProjectAsync } = await import('../overrides/utils/deserializeProject.js');

test('cancelling deserialization terminates obsolete work and a new request can complete', async () => {
  const controller = new AbortController();
  const request = deserializeProjectAsync('old', undefined, { signal: controller.signal });
  const obsolete = TestWorker.instances.at(-1)!;
  controller.abort();
  await assert.rejects(request, /abort/i);
  assert.equal(obsolete.terminated, true);
  obsolete.respond({ metadata: { id: 'old' } });
  const next = deserializeProjectAsync('new');
  TestWorker.instances.at(-1)!.respond({ metadata: { id: 'new' } });
  assert.equal((await next).metadata.id, 'new');
});

test('a stalled worker is replaced on its deadline and subsequent requests remain usable', async () => {
  const request = deserializeProjectAsync('stalled', undefined, { timeoutMs: 5 });
  const stalled = TestWorker.instances.at(-1)!;
  await assert.rejects(request, /parsing timed out/);
  assert.equal(stalled.terminated, true);
  const next = deserializeProjectAsync('new');
  TestWorker.instances.at(-1)!.respond({ metadata: { id: 'next' } });
  assert.equal((await next).metadata.id, 'next');
});

test('cancelling one parse preserves another request sharing the worker', async () => {
  const controller = new AbortController();
  const cancelled = deserializeProjectAsync('cancelled', undefined, { signal: controller.signal });
  const worker = TestWorker.instances.at(-1)!;
  const next = deserializeProjectAsync('next');
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  assert.equal(worker.terminated, false);
  worker.respond({ metadata: { id: 'next' } });
  assert.equal((await next).metadata.id, 'next');
});

test('hosted preparation and deferred import share one configurable deadline', async (t) => {
  const { HostedIOProvider } = await import('../io/HostedIOProvider.js');
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(JSON.stringify({ contents: 'fixture', datasetsContents: null, revisionId: 'test-revision' })),
  );
  let imports = 0;
  const provider = new HostedIOProvider(
    {
      importDatasetsForProject: async () => {
        imports++;
      },
    } as ConstructorParameters<typeof HostedIOProvider>[0],
    {} as ConstructorParameters<typeof HostedIOProvider>[1],
    { loadTimeoutMs: 1_000 },
  );
  const loading = provider.loadProjectDataNoPrompt('/workflows/test.rivet-project', { deferCommit: true });
  // Wait for the fetch/JSON preparation, then deliver the controlled worker reply.
  await new Promise((resolve) => setImmediate(resolve));
  TestWorker.instances.at(-1)!.respond({
    project: { metadata: { id: 'deadline', title: 'Deadline' }, graphs: {} },
    serializedEvaluationData: null,
    datasets: [],
    evaluationDatasets: [],
  });
  const result = await loading;
  t.mock.timers.setTime(2_001);
  await assert.rejects(
    result.commit!(() => true),
    /loading timed out/,
  );
  assert.equal(imports, 0);
});

test('a pre-cancelled hosted load performs no fetch, parsing or dataset work', async (t) => {
  const { HostedIOProvider } = await import('../io/HostedIOProvider.js');
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not fetch');
  });
  const controller = new AbortController();
  controller.abort();
  const provider = new HostedIOProvider(
    {} as ConstructorParameters<typeof HostedIOProvider>[0],
    {} as ConstructorParameters<typeof HostedIOProvider>[1],
  );
  await assert.rejects(
    provider.loadProjectDataNoPrompt('/workflows/test.rivet-project', { signal: controller.signal }),
    /abort/i,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('hosted loading sends the sidecar to its worker and commits exactly the prepared datasets', async (t) => {
  const { HostedIOProvider } = await import('../io/HostedIOProvider.js');
  const sidecar = '{"datasets":[]}';
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(JSON.stringify({ contents: 'fixture', datasetsContents: sidecar })),
  );
  const datasets = [{ meta: { id: 'prepared', projectId: 'prepared-project' }, data: { id: 'prepared', rows: [] } }];
  let imported: unknown;
  const provider = new HostedIOProvider(
    {
      importDatasetsForProject: async (_id: unknown, value: unknown) => {
        imported = value;
      },
    } as ConstructorParameters<typeof HostedIOProvider>[0],
    {} as ConstructorParameters<typeof HostedIOProvider>[1],
  );
  const loading = provider.loadProjectDataNoPrompt('/workflows/prepared.rivet-project');
  await new Promise((resolve) => setImmediate(resolve));
  const worker = TestWorker.instances.at(-1)!;
  assert.equal((worker.request as unknown as { data: { datasetsContents: string } }).data.datasetsContents, sidecar);
  worker.respond({
    project: { metadata: { id: 'prepared-project' }, graphs: {} },
    serializedEvaluationData: null,
    datasets,
    evaluationDatasets: [],
  });
  await loading;
  assert.deepEqual(imported, datasets);
});
