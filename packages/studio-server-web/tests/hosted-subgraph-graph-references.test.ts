import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedSubgraphProjectCatalog } from '../dashboard/hostedSubgraphProjects.js';
import type { ProjectId, GraphId } from '@valerypopoff/rivet2-core';

const target = { projectId: 'target' as ProjectId, graphIds: ['one', 'two'] as GraphId[] };
const result = () => ({
  projectId: 'target',
  complete: false,
  graphReferences: [
    {
      sourceGraphId: 'main',
      sourceGraphName: 'Caller',
      nodeId: 'node',
      nodeTitle: 'Subgraph',
      targetProjectId: 'target',
      targetGraphId: 'one',
      targetVersion: 'latest',
      projectId: 'caller',
      projectName: 'Caller project',
      relativePath: 'caller.rivet-project',
      source: { kind: 'published-endpoint', label: 'live' },
    },
  ],
});

test('graph reference provider preserves partial results, explicit identity, body IDs and cancellation', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://localhost');
    assert.equal(parsed.search, '');
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.projectId, 'target');
    assert.deepEqual(body.graphIds, ['one', 'two']);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.signal, controller.signal);
    return Response.json(result());
  });
  const response = await hostedSubgraphProjectCatalog.graphReferences!(target, controller.signal);
  assert.equal(response.complete, false);
  assert.equal(response.references[0]!.sourceDescription, 'Published endpoint: live');
});

test('legacy filesystem fallback resolves one fresh path and retains expected project ID', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url), 'http://localhost');
    requests++;
    if (requests === 1) return Response.json({ error: 'Project not found' }, { status: 404 });
    if (parsed.pathname.endsWith('/tree'))
      return Response.json({
        projects: [],
        folders: [
          {
            folders: [],
            projects: [
              {
                id: 'path-hash',
                projectMetadataId: 'target',
                relativePath: 'Folder/target.rivet-project',
                name: 'Target',
              },
            ],
          },
        ],
      });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.relativePath, 'Folder/target.rivet-project');
    assert.equal(body.projectId, 'target');
    return Response.json(result());
  });
  assert.equal(
    (await hostedSubgraphProjectCatalog.graphReferences!(target, new AbortController().signal)).references.length,
    1,
  );
  assert.equal(requests, 3);
});

for (const [name, response] of [
  ['old server without graph details', { projectId: 'target', complete: true, references: [] }],
  ['changed target identity', { projectId: 'other', complete: true, graphReferences: [] }],
] as const) {
  test(`rejects ${name} rather than claiming a safe empty result`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(
      hostedSubgraphProjectCatalog.graphReferences!(target, new AbortController().signal),
      /unavailable|changed/,
    );
  });
}

test('empty folders require no server scan', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Must not fetch');
  });
  assert.deepEqual(
    await hostedSubgraphProjectCatalog.graphReferences!({ ...target, graphIds: [] }, new AbortController().signal),
    { projectId: 'target', complete: true, references: [] },
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('an ambiguous filesystem fallback never chooses an arbitrary project path', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({}, { status: 404 })
      : Response.json({
          folders: [],
          projects: [
            { id: 'one', projectMetadataId: 'target', relativePath: 'one.rivet-project' },
            { id: 'two', projectMetadataId: 'target', relativePath: 'two.rivet-project' },
          ],
        }),
  );
  await assert.rejects(
    hostedSubgraphProjectCatalog.graphReferences!(target, new AbortController().signal),
    /could not be identified/,
  );
  assert.equal(calls, 2);
});
