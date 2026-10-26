import assert from 'node:assert/strict';
import test from 'node:test';
import {
  namespaceIdentity,
  requestRecoverableMutation,
  requestStructuralMutation,
} from '../dashboard/workflowNamespaceMutations.js';
import { createHash } from 'node:crypto';
import { mutationRequestText } from '../../studio-server-shared/workflow-mutation-contract.js';
import { reconcileNamespaceMove } from '../dashboard/workflowNamespaceReconciliation.js';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../dashboard/types.js';

test('receipt hashing preserves input semantics while ignoring object key insertion order', () => {
  const receipt = { operationId: 'fixed', expiresAt: 'fixed' };
  const hash = (input: unknown) => mutationRequestText(receipt, input);
  assert.equal(hash({ b: 2, a: { y: 1, x: 0 } }), hash({ a: { x: 0, y: 1 }, b: 2 }));
  assert.equal(hash({ a: undefined }), hash({}));
  for (const [left, right] of [
    [{ a: null }, {}],
    [{ contents: 'private bytes' }, { contents: 'private bytes ' }],
    [{ name: ' A ' }, { name: 'A' }],
    [{ files: ['A', 'B'] }, { files: ['B', 'A'] }],
  ])
    assert.notEqual(hash(left), hash(right));
});

test('recovered historical moves acknowledge a commit without reviving stale tree or tab paths', async (t) => {
  const historical = {
    folder: { id: 'old-destination', relativePath: 'old-destination' },
    movedProjectPaths: [{ fromAbsolutePath: '/old', toAbsolutePath: '/old-destination' }],
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/write') throw new Error('Lost acknowledgement');
    return Response.json({ state: 'committed', result: historical });
  });
  const result = await requestRecoverableMutation<any>({
    mutateUrl: '/write',
    recoverUrl: '/recover',
    input: {},
    headers: {},
  });
  let reconciliations = 0;
  await reconcileNamespaceMove({
    result,
    sourceFolder: { id: 'source', relativePath: 'source' } as WorkflowFolderItem,
    folders: [],
    rootProjects: [],
    setFolders: () => assert.fail('Old receipt must not overwrite the tree'),
    setRootProjects: () => assert.fail('Old receipt must not overwrite the tree'),
    applyProjectPathMoves: async () => assert.fail('Old paths cannot rebind tabs'),
    reconcileTree: () => {
      reconciliations++;
    },
  });
  assert.equal(reconciliations, 1);
});

test('uncertain namespace responses only recover receipts, never replay writes', async (t) => {
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  for (const scenario of ['network', 'gateway', 'invalid-json', 'unknown', 'lookup-failed', 'rejected'] as const) {
    await t.test(scenario, async (t) => {
      const calls: Array<{ url: string; body: string }> = [];
      t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        calls.push({ url, body: String(init.body) });
        if (url === '/recover') {
          if (scenario === 'lookup-failed') throw new Error('Disconnected');
          return json(scenario === 'unknown' ? { state: 'unknown' } : { state: 'committed', result: { id: 'saved' } });
        }
        if (scenario === 'rejected') return json({ error: 'Identity changed' }, 409);
        if (scenario === 'gateway') return new Response('Unavailable', { status: 502 });
        if (scenario === 'invalid-json') return new Response('{', { headers: { 'Content-Type': 'application/json' } });
        throw new Error('Lost acknowledgement');
      });
      const result = requestRecoverableMutation({
        mutateUrl: '/write',
        recoverUrl: '/recover',
        headers: {},
        input: { operationId: 'exact' },
      });
      if (scenario === 'rejected') await assert.rejects(result, { message: 'Identity changed', status: 409 });
      else if (scenario === 'unknown' || scenario === 'lookup-failed')
        await assert.rejects(result, /outcome is unknown/);
      else assert.deepEqual(await result, { id: 'saved' });
      assert.deepEqual(
        calls.map((call) => call.url),
        scenario === 'rejected' ? ['/write'] : ['/write', '/recover'],
      );
      assert.ok(calls.every((call) => call.body === '{"operationId":"exact"}'));
    });
  }
});

test('managed identity is immutable; missing managed identity does not fall back to paths', () => {
  assert.deepEqual(namespaceIdentity({ namespaceId: 'folder-id' } as WorkflowFolderItem), { id: 'folder-id' });
  assert.deepEqual(
    namespaceIdentity({
      namespaceProtocol: 1,
      projectMetadataId: 'project-id',
      revisionId: 'rev',
    } as WorkflowProjectItem),
    { id: 'project-id', revisionId: 'rev' },
  );
  assert.throws(() => namespaceIdentity({ namespaceProtocol: 1 } as WorkflowProjectItem), /identity is unavailable/);
  assert.equal(namespaceIdentity({} as WorkflowProjectItem), undefined);
});

test('receipt recovery preserves admitted bytes across asynchronous digest and response boundaries', async (t) => {
  await t.test('a changed caller object cannot alter the write after its digest was captured', async (t) => {
    const input = { parentRelativePath: '', fileName: 'Original.rivet-project', contents: 'original bytes' };
    const command = { operation: 'upload-project' as const, input };
    const original = structuredClone(command);
    const preconditions = { expectedDestinationId: null as string | null };
    let release!: () => void;
    const digestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    t.mock.method(crypto.subtle, 'digest', async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      await digestGate;
      return digest(algorithm, data);
    });
    const calls: Array<{ url: string; input: any; header: string | null }> = [];
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      calls.push({
        url,
        input: JSON.parse(String(init.body)),
        header: new Headers(init.headers).get('X-Capture-Test'),
      });
      if (calls.length === 1) throw new Error('Lost acknowledgement');
      return Response.json({ state: 'committed', result: { id: 'saved' } });
    });
    const headers = { 'X-Capture-Test': 'admitted' };
    const options = { api: '/api', url: '/write', command, input, preconditions, headers };
    const saved = requestStructuralMutation(options);
    input.fileName = 'Later.rivet-project';
    input.contents = 'later bytes';
    preconditions.expectedDestinationId = 'later-folder';
    options.api = '/later-api';
    options.url = '/later-write';
    headers['X-Capture-Test'] = 'later';
    release();
    assert.deepEqual(await saved, { id: 'saved' });
    assert.equal(calls[0]!.input.fileName, original.input.fileName);
    assert.equal(calls[0]!.input.contents, original.input.contents);
    assert.equal(calls[0]!.input.mutation.expectedDestinationId, null);
    assert.equal(
      calls[1]!.input.requestHash,
      createHash('sha256').update(mutationRequestText(calls[0]!.input.mutation, original)).digest('hex'),
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map(({ url, header }) => ({ url, header })),
      [
        { url: '/write', header: 'admitted' },
        { url: '/api/workflows/namespace/receipt', header: 'admitted' },
      ],
    );
  });
  await t.test('a lost acknowledgement cannot reserialize a changed namespace command', async (t) => {
    const input = { command: { relativePath: 'Original' }, operationId: 'fixed' };
    const original = JSON.stringify(input);
    const bodies: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      if (bodies.length === 1) {
        input.command.relativePath = 'Later';
        throw new Error('Lost acknowledgement');
      }
      return Response.json({ state: 'committed', result: { id: 'saved' } });
    });
    assert.deepEqual(
      await requestRecoverableMutation({ mutateUrl: '/write', recoverUrl: '/recover', input, headers: {} }),
      { id: 'saved' },
    );
    assert.deepEqual(bodies, [original, original]);
  });
});

test('structural upload recovery sends only a digest and returns the exact committed HTTP envelope', async (t) => {
  const calls: Array<{ url: string; input: any }> = [];
  const contents = 'private project bytes '.repeat(1000);
  const command = {
    operation: 'upload-project' as const,
    input: { parentRelativePath: '', fileName: 'Sample.rivet-project', contents },
  };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    calls.push({ url, input });
    if (calls.length === 1) throw new Error('Lost acknowledgement');
    return Response.json({ state: 'committed', result: { project: { id: 'accepted' } } });
  });
  assert.deepEqual(
    await requestStructuralMutation({
      api: '/api',
      url: '/write',
      command,
      input: command.input,
      preconditions: { expectedDestinationId: null },
    }),
    { project: { id: 'accepted' } },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, '/api/workflows/namespace/receipt');
  assert.deepEqual(calls[1]!.input, {
    operationId: calls[0]!.input.mutation.operationId,
    requestHash: createHash('sha256').update(mutationRequestText(calls[0]!.input.mutation, command)).digest('hex'),
  });
  assert.ok(JSON.stringify(calls[1]).length < 300);
  assert.ok(!JSON.stringify(calls[1]).includes('private project bytes'));
});

test('one reconciliation policy preserves compatibility but avoids path-only rebinding for managed results', async () => {
  for (const mode of ['guarded', 'compatibility', 'bridge-failed'] as const) {
    let bridgeCalls = 0,
      refreshes = 0;
    const reconcile = reconcileNamespaceMove({
      result: {
        folder: { namespaceId: mode === 'guarded' ? 'immutable-folder' : undefined } as WorkflowFolderItem,
        movedProjectPaths: [],
      },
      folders: [],
      rootProjects: [],
      setFolders: () => {},
      setRootProjects: () => {},
      applyProjectPathMoves: async () => {
        bridgeCalls++;
        if (mode === 'bridge-failed') throw new Error('Detached editor');
      },
      reconcileTree: () => {
        refreshes++;
      },
    });
    if (mode === 'bridge-failed') await assert.rejects(reconcile, /saved on the server/);
    else await reconcile;
    assert.equal(bridgeCalls, mode === 'guarded' ? 0 : 1);
    assert.equal(refreshes, 1, 'Authoritative reconciliation is always scheduled exactly once.');
  }
});
