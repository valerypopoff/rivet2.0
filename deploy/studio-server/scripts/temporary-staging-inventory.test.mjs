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
    { name: 'serviceaccounts', kind: 'ServiceAccount', namespaced: true, verbs: ['get', 'list', 'delete'] },
    { name: 'configmaps', kind: 'ConfigMap', namespaced: true, verbs: ['get', 'list', 'delete'] },
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

// test-style: fixture-read: These two standard APIs mirror the same persisted Events.
function eventFixture({
  namespaceUid,
  eventNamespace = 'qualification',
  customKind,
  customOwners = [],
  savedEvents = [],
} = {}) {
  const [defaults, record] = fixture({ namespaceUid });
  record.bootstrapChildren = savedEvents;
  const references = [
    { kind: 'Pod', name: 'qualification-actor', namespace: 'qualification' },
    ...[1, 2, 3].map((number) => ({
      apiVersion: 'networking.gke.io/v1beta1',
      kind: 'ServiceNetworkEndpointGroup',
      name: 'garbage-collected-neg-' + number,
      namespace: 'qualification',
      uid: 'deleted-neg-uid-' + number,
    })),
  ];
  const eventType = { name: 'events', kind: 'Event', namespaced: true, verbs: ['get', 'list', 'delete'] };
  return [
    {
      async json(method, path) {
        assert.equal(method, 'GET');
        if (path === '/api/v1') {
          const core = await defaults.json(method, path);
          return { resources: [...core.resources, eventType] };
        }
        if (path === '/apis')
          return {
            groups: [
              { preferredVersion: { groupVersion: 'events.k8s.io/v1' } },
              ...(customKind ? [{ preferredVersion: { groupVersion: 'example.test/v1' } }] : []),
            ],
          };
        if (path === '/apis/events.k8s.io/v1') return { resources: [eventType] };
        if (path === '/apis/example.test/v1')
          return {
            resources: [{ name: 'widgets', kind: customKind, namespaced: true, verbs: ['get', 'list', 'delete'] }],
          };
        if (path === '/apis/example.test/v1/namespaces/qualification/widgets')
          return {
            items: [
              {
                metadata: {
                  name: 'unknown-widget',
                  namespace: 'qualification',
                  uid: 'widget-uid',
                  ownerReferences: customOwners.map((uid) => ({ uid })),
                },
                involvedObject: { uid: 'namespace-uid' },
              },
            ],
          };
        if (path.endsWith('/namespaces/qualification/events'))
          return {
            items: references.map((reference, index) => ({
              metadata: {
                name: 'provider-event-' + index,
                namespace: eventNamespace,
                uid: 'event-uid-' + index,
                ownerReferences: [{ uid: 'namespace-uid' }],
              },
              ...(path.startsWith('/apis/') ? { regarding: reference } : { involvedObject: reference }),
            })),
          };
        return defaults.json(method, path);
      },
    },
    record,
  ];
}

test('owned namespace retains UID-less Pod and deleted-NEG diagnostic Events through both standard APIs', async () => {
  const children = await captureTemporaryBootstrap(...eventFixture());
  const events = children.filter((item) => item.kind === 'Event');
  assert.equal(events.length, 8);
  assert.equal(new Set(events.map((item) => item.uid)).size, 4);
  for (const uid of new Set(events.map((item) => item.uid))) {
    const aliases = events.filter((item) => item.uid === uid);
    assert.equal(aliases.length, 2);
    assert.ok(aliases.some((item) => item.apiPath.startsWith('/api/v1/')));
    assert.ok(aliases.some((item) => item.apiPath.startsWith('/apis/events.k8s.io/v1/')));
    assert.ok(aliases.every((item) => item.namespaceUid === 'namespace-uid'));
  }
});

test('diagnostic Event admission still rejects namespace replacement and foreign namespace contents', async () => {
  await assert.rejects(captureTemporaryBootstrap(...eventFixture({ namespaceUid: 'replacement-uid' })));
  await assert.rejects(captureTemporaryBootstrap(...eventFixture({ eventNamespace: 'foreign-namespace' })));
});

test('live diagnostic Event ownership cannot authorize an unknown custom object', async () => {
  await assert.rejects(
    captureTemporaryBootstrap(...eventFixture({ customKind: 'Widget', customOwners: ['event-uid-0'] })),
    (error) => {
      assert.deepEqual(
        error.resources.map((item) => item.uid),
        ['widget-uid'],
      );
      return true;
    },
  );
});

test('saved diagnostic Event ownership cannot authorize another object after the Event is gone', async () => {
  for (const kind of ['Event', undefined]) {
    const inputs = eventFixture({
      customKind: 'Widget',
      customOwners: ['old-event-uid'],
      savedEvents: [
        {
          apiPath: '/api/v1/namespaces/qualification/events/old',
          uid: 'old-event-uid',
          namespaceUid: 'namespace-uid',
          ...(kind ? { kind } : {}),
        },
      ],
    });
    await assert.rejects(captureTemporaryBootstrap(...inputs), (error) => {
      assert.deepEqual(
        error.resources.map((item) => item.uid),
        ['widget-uid'],
      );
      return true;
    });
  }
});

test('a recorded standard Event resource never becomes a new ownership root', async () => {
  const inputs = eventFixture({ customKind: 'Widget', customOwners: ['old-event-uid'] });
  inputs[1].resources.push({
    key: 'old-event',
    kind: 'kubernetes',
    apiPath: '/apis/events.k8s.io/v1/namespaces/qualification/events/old',
    identity: { id: 'old-event-uid' },
  });
  await assert.rejects(captureTemporaryBootstrap(...inputs), /Unowned bootstrap/);
});

test('an unrelated custom kind named Event is not a standard diagnostic Event', async () => {
  await assert.rejects(
    captureTemporaryBootstrap(...eventFixture({ customKind: 'Event', customOwners: ['namespace-uid'] })),
    (error) => {
      assert.deepEqual(
        error.resources.map((item) => ({ uid: item.uid, kind: item.kind })),
        [{ uid: 'widget-uid', kind: 'Event' }],
      );
      return true;
    },
  );
});

test('unowned custom resources remain blocked beside admitted diagnostic Events', async () => {
  await assert.rejects(captureTemporaryBootstrap(...eventFixture({ customKind: 'Widget' })), (error) => {
    assert.deepEqual(
      error.resources.map((item) => item.uid),
      ['widget-uid'],
    );
    assert.deepEqual(Object.keys(error.resources[0]).sort(), ['apiPath', 'kind', 'name', 'namespaceUid', 'uid']);
    return true;
  });
});

test('read-only PodMetrics discovery is inspected but its UID-less virtual list is never requested', async () => {
  const [defaults, record] = fixture();
  let discovered = false,
    requested = false;
  const virtual = {
    apiVersion: 'metrics.k8s.io/v1beta1',
    kind: 'PodMetrics',
    metadata: { name: 'qualification-actor', namespace: 'qualification' },
    timestamp: '2026-10-30T20:53:00Z',
    window: '30s',
    containers: [{ name: 'actor', usage: { cpu: '1m', memory: '1Mi' } }],
  };
  const api = {
    async json(method, path) {
      assert.equal(method, 'GET');
      if (path === '/apis') return { groups: [{ preferredVersion: { groupVersion: 'metrics.k8s.io/v1beta1' } }] };
      if (path === '/apis/metrics.k8s.io/v1beta1') {
        discovered = true;
        return { resources: [{ name: 'pods', kind: 'PodMetrics', namespaced: true, verbs: ['get', 'list'] }] };
      }
      if (path === '/apis/metrics.k8s.io/v1beta1/namespaces/qualification/pods') {
        requested = true;
        return { items: [virtual] };
      }
      return defaults.json(method, path);
    },
  };
  const children = await captureTemporaryBootstrap(api, record);
  assert.equal(discovered, true);
  assert.equal(requested, false, 'A virtual read-only projection must not enter cleanup inventory');
  assert.deepEqual(
    children.map((item) => item.kind),
    ['ServiceAccount', 'ConfigMap'],
  );
});

test('a persisted deletable Pod with missing metadata UID still blocks cleanup and identifies its path', async () => {
  const [defaults, record] = fixture();
  let requested = false;
  const api = {
    async json(method, path) {
      assert.equal(method, 'GET');
      if (path === '/api/v1')
        return { resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list', 'delete'] }] };
      if (path === '/api/v1/namespaces/qualification/pods') {
        requested = true;
        return { items: [{ metadata: { name: 'malformed-pod', namespace: 'qualification' } }] };
      }
      return defaults.json(method, path);
    },
  };
  await assert.rejects(
    captureTemporaryBootstrap(api, record),
    /Bootstrap resource UID is missing: \/api\/v1\/namespaces\/qualification\/pods\/malformed-pod/,
  );
  assert.equal(requested, true);
});
