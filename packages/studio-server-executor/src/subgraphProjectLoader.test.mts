import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  serializeProject,
  serializeDatasets,
  type Project,
  type ProjectId,
  type DatasetId,
} from '@valerypopoff/rivet2-node';
import { createHostedSubgraphProjectLoader } from './subgraphProjectLoader.mjs';

const target = {
  projectId: 'target /?' as ProjectId,
  version: 'latest' as const,
  callerProjectId: 'caller &?' as ProjectId,
};
const project: Project = { metadata: { id: target.projectId, title: 'Target', description: '' }, graphs: {} };
const artifact = { projectContents: serializeProject(project), revisionKey: 'revision', sourceProjectPath: '/target' };

test('hosted loader preserves caller/version and authenticates both loads and repeated permission checks', async () => {
  const paths: string[] = [];
  const loader = createHostedSubgraphProjectLoader({
    baseUrl: 'http://127.0.0.1:3100/api/workflows/execution-environment',
    headers: () => ({ 'x-rivet-proxy-auth': 'proxy', 'x-rivet-executor-auth': 'executor' }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('callerProjectId'), target.callerProjectId);
      assert.equal(url.searchParams.get('version'), target.version);
      assert.deepEqual(init?.headers, { 'x-rivet-proxy-auth': 'proxy', 'x-rivet-executor-auth': 'executor' });
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      paths.push(url.pathname);
      return url.pathname.endsWith('/access') ? new Response(null, { status: 204 }) : Response.json(artifact);
    },
  });
  const loaded = await loader.loadTarget(target);
  assert.equal(loaded.project.metadata.id, target.projectId);
  assert.equal(loaded.revisionKey, artifact.revisionKey);
  await loader.validateTarget(target);
  await loader.validateTarget(target);
  assert.deepEqual(
    paths,
    ['execution', 'access', 'access'].map((action) => `/api/workflows/subgraph-projects/target%20%2F%3F/${action}`),
  );
});

test('only an explicit API bundle-scope code produces a bundle restriction message', async () => {
  for (const [status, body, expected] of [
    [403, { code: 'subgraph_bundle_scope_forbidden' }, /same bundle/],
    [403, { error: 'Forbidden' }, /service authentication was rejected/],
    [401, { code: 'subgraph_bundle_scope_forbidden' }, /service authentication was rejected/],
    [409, { code: 'subgraph_bundle_scope_forbidden' }, /service request failed/],
    [403, { code: 'workflow_publication_missing' }, /service authentication was rejected/],
    [409, { code: 'workflow_publication_missing' }, /service request failed/],
    [404, {}, /not found/],
    [503, {}, /service request failed/],
  ] as const) {
    const loader = createHostedSubgraphProjectLoader({
      baseUrl: 'http://api',
      headers: () => ({}),
      fetch: async () => Response.json(body, { status }),
    });
    for (const action of [loader.loadTarget, loader.validateTarget]) await assert.rejects(action(target), expected);
  }
  for (const body of [
    '<html>secret</html>',
    JSON.stringify({ code: 'subgraph_bundle_scope_forbidden', padding: 'x'.repeat(8192) }),
  ]) {
    const loader = createHostedSubgraphProjectLoader({
      baseUrl: 'http://api',
      headers: () => ({}),
      fetch: async () => new Response(body, { status: 403 }),
    });
    await assert.rejects(
      loader.validateTarget(target),
      (error: Error) => /authentication/.test(error.message) && !/secret|same bundle/.test(error.message),
    );
  }
});

test('a missing published snapshot has an actionable message, not an authentication or bundle error', async () => {
  const loader = createHostedSubgraphProjectLoader({
    baseUrl: 'http://api',
    headers: () => ({}),
    fetch: async () =>
      Response.json({ code: 'workflow_publication_missing', error: 'private upstream diagnostic' }, { status: 409 }),
  });
  await assert.rejects(
    loader.loadTarget({ ...target, version: 'published' }),
    (error: Error) =>
      /no published version.*Publish.*Saved latest/.test(error.message) &&
      !/private|authentication|same bundle/.test(error.message),
  );
});

test('permission checks fail closed for HTML success, redirects, connection loss and changed live policy', async () => {
  let count = 0;
  const loader = createHostedSubgraphProjectLoader({
    baseUrl: 'http://api',
    headers: () => ({}),
    fetch: async () => {
      count++;
      return count === 1
        ? new Response(null, { status: 204 })
        : Response.json({ code: 'subgraph_bundle_scope_forbidden' }, { status: 403 });
    },
  });
  await loader.validateTarget(target);
  await assert.rejects(loader.validateTarget(target), /same bundle/);
  for (const status of [200, 302]) {
    const invalid = createHostedSubgraphProjectLoader({
      baseUrl: 'http://api',
      headers: () => ({}),
      fetch: async () => new Response('<html>login</html>', { status }),
    });
    await assert.rejects(invalid.validateTarget(target), /invalid permission response|request failed/);
  }
  const disconnected = createHostedSubgraphProjectLoader({
    baseUrl: 'http://api',
    headers: () => ({}),
    fetch: async () => {
      throw new Error('ECONNRESET secret');
    },
  });
  await assert.rejects(disconnected.validateTarget(target), /could not be reached/);
});

test('hosted loader rejects missing artifacts and mismatched project identities', async () => {
  for (const body of [
    {},
    { projectContents: serializeProject({ ...project, metadata: { ...project.metadata, id: 'other' as ProjectId } }) },
  ]) {
    const loader = createHostedSubgraphProjectLoader({
      baseUrl: 'http://api',
      headers: () => ({}),
      fetch: async () => Response.json(body),
    });
    await assert.rejects(loader.loadTarget(target), /no saved artifact|invalid target/);
  }
});

test('malformed artifact responses do not expose upstream contents or parser diagnostics', async () => {
  for (const response of [
    new Response('<html>private diagnostic</html>'),
    Response.json({ projectContents: 'private diagnostic' }),
  ]) {
    const loader = createHostedSubgraphProjectLoader({
      baseUrl: 'http://api',
      headers: () => ({}),
      fetch: async () => response,
    });
    await assert.rejects(
      loader.loadTarget(target),
      (error: Error) => /invalid.*artifact/.test(error.message) && !/private diagnostic/.test(error.message),
    );
  }
});

test('published snapshots retain their datasets and revision identity', async () => {
  const datasets = [
    {
      meta: { id: 'dataset' as DatasetId, projectId: target.projectId, name: 'Snapshot data', description: '' },
      data: { id: 'dataset' as DatasetId, rows: [{ id: 'row', data: ['snapshot value'] }] },
    },
  ];
  const published = { ...target, version: 'published' as const };
  const loader = createHostedSubgraphProjectLoader({
    baseUrl: 'http://api',
    headers: () => ({}),
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('version'), 'published');
      assert.equal(url.searchParams.get('callerProjectId'), published.callerProjectId);
      return url.pathname.endsWith('/access')
        ? new Response(null, { status: 204 })
        : Response.json({ ...artifact, datasetsContents: serializeDatasets(datasets) });
    },
  });
  const loaded = await loader.loadTarget(published);
  await loader.validateTarget(published);
  assert.equal(loaded.revisionKey, artifact.revisionKey);
  assert.equal(loaded.sourceProjectPath, artifact.sourceProjectPath);
  assert.deepEqual(await loaded.datasetProvider.exportDatasetsForProject(published.projectId), datasets);
});

test(
  'oversized and stalled denial streams are cancelled without exposing their contents',
  { timeout: 6000 },
  async (t) => {
    {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('private'.repeat(2000)));
        },
        cancel() {
          cancelled = true;
        },
      });
      const loader = createHostedSubgraphProjectLoader({
        baseUrl: 'http://api',
        headers: () => ({}),
        fetch: async () => new Response(body, { status: 403 }),
      });
      await assert.rejects(
        loader.validateTarget(target),
        (error: Error) => /authentication/.test(error.message) && !/private/.test(error.message),
      );
      assert.equal(cancelled, true, 'the bounded error read must release the response body');
    }
    // A real socket, not an artificial stream, keeps the response lifetime alive
    // on Node 22 and 24 without changing the production timeout's unref policy.
    let upstreamClosed: Promise<unknown> | undefined;
    const server = createServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.write('{"private":');
      upstreamClosed = once(res, 'close');
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const loader = createHostedSubgraphProjectLoader({
      baseUrl: `http://127.0.0.1:${address.port}`,
      headers: () => ({}),
    });
    const started = Date.now();
    await assert.rejects(
      loader.validateTarget(target),
      (error: Error) => /authentication/.test(error.message) && !/private/.test(error.message),
    );
    assert.ok(Date.now() - started >= 2500, 'the real response must stall until the error-body deadline');
    assert.ok(upstreamClosed);
    await upstreamClosed;
  },
);
