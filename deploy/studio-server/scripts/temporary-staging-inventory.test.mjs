import assert from 'node:assert/strict';
import test from 'node:test';
import { captureTemporaryBootstrap } from './lib/temporary-staging-inventory.mjs';

// test-style: fixture-read: Discovery and typed List responses match Kubernetes' wire format.
function fixture({ ca = 'cluster-ca', kind, namespaceUid = 'namespace-uid' } = {}) {
  const record = {
    plan: { operationId: 'qualification' },
    resources: [
      { key: 'cluster', identity: { ca: Buffer.from('cluster-ca').toString('base64') } },
      {
        kind: 'kubernetes',
        apiPath: '/api/v1/namespaces/qualification',
        identity: { id: 'namespace-uid' },
      },
    ],
  };
  const resources = [
    { name: 'serviceaccounts', kind: 'ServiceAccount', namespaced: true, verbs: ['list'] },
    { name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['list'] },
  ];
  const api = {
    async json(method, path) {
      assert.equal(method, 'GET');
      if (path === '/api/v1') return { resources };
      if (path === '/apis') return { groups: [] };
      if (path === '/api/v1/namespaces/qualification')
        return { metadata: { name: 'qualification', uid: namespaceUid } };
      const account = path.endsWith('/serviceaccounts');
      assert.ok(account || path.endsWith('/configmaps'));
      return {
        items: [
          {
            ...(kind ? { kind } : {}),
            metadata: {
              name: account ? 'default' : 'kube-root-ca.crt',
              namespace: 'qualification',
              uid: account ? 'account-uid' : 'ca-uid',
            },
            ...(!account ? { data: { 'ca.crt': ca } } : {}),
          },
        ],
      };
    },
  };
  return [api, record];
}

test('bootstrap inventory derives omitted typed List item kinds from API discovery', async () => {
  const children = await captureTemporaryBootstrap(...fixture());
  assert.deepEqual(
    children.map(({ uid, kind }) => ({ uid, kind })),
    [
      { uid: 'account-uid', kind: 'ServiceAccount' },
      { uid: 'ca-uid', kind: 'ConfigMap' },
    ],
  );
});

test('typed List inference preserves namespace identity, CA and explicit-kind checks', async () => {
  await assert.rejects(captureTemporaryBootstrap(...fixture({ namespaceUid: 'replacement' })));
  await assert.rejects(captureTemporaryBootstrap(...fixture({ kind: 'Secret' })), /differs from API discovery/);
  await assert.rejects(captureTemporaryBootstrap(...fixture({ ca: 'unrelated-ca' })), (error) => {
    assert.equal(error.message, 'Unowned bootstrap objects block cleanup');
    assert.deepEqual(
      error.resources.map(({ uid }) => uid),
      ['ca-uid'],
    );
    return true;
  });
});
