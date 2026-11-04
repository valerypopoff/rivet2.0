import assert from 'node:assert/strict';

// Discovery and server-side field validation are fixture responses, not an
// emulation of Kubernetes admission/controllers. Native clients own all command
// parsing, document serialization and exit status handling.
const apiResources = {
  v1: [
    'Namespace',
    'Node',
    'Pod',
    'ConfigMap',
    'Secret',
    'Service',
    'PersistentVolumeClaim',
    'PersistentVolume',
    'ServiceAccount',
  ],
  'apps/v1': ['Deployment', 'StatefulSet', 'ReplicaSet'],
  'batch/v1': ['Job'],
  'autoscaling/v2': ['HorizontalPodAutoscaler'],
  'policy/v1': ['PodDisruptionBudget'],
  'rbac.authorization.k8s.io/v1': ['Role', 'RoleBinding'],
  'gateway.networking.k8s.io/v1': ['HTTPRoute', 'Gateway'],
  'networking.gke.io/v1': ['HealthCheckPolicy', 'GCPBackendPolicy'],
};
const resourceName = (kind) =>
  kind.endsWith('Policy') ? `${kind.slice(0, -1).toLowerCase()}ies` : `${kind.toLowerCase()}s`;
const apiPath = (version) => (version === 'v1' ? '/api/v1' : `/apis/${version}`);

export function cliDiscovery({ req, res, url, result }) {
  if (req.method !== 'GET') return false;
  const groups = Object.keys(apiResources)
    .filter((v) => v !== 'v1')
    .map((v) => {
      const [name, version] = v.split('/');
      return { name, versions: [{ groupVersion: v, version }], preferredVersion: { groupVersion: v, version } };
    });
  const respond = (value) => {
    result(value);
    return true;
  };
  if (url.pathname === '/api') return respond({ kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'] });
  if (url.pathname === '/apis') return respond({ kind: 'APIGroupList', apiVersion: 'v1', groups });
  if (url.pathname === '/version') return respond({ gitVersion: 'v1.36.6', major: '1', minor: '36' });
  if (url.pathname === '/openapi/v2') {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.alloc(0));
    return true;
  }
  for (const [version, kinds] of Object.entries(apiResources)) {
    if (url.pathname === apiPath(version))
      return respond({
        kind: 'APIResourceList',
        apiVersion: 'v1',
        groupVersion: version,
        resources: kinds.map((kind) => ({
          name: resourceName(kind),
          singularName: kind.toLowerCase(),
          kind,
          namespaced: !['Namespace', 'Node', 'PersistentVolume'].includes(kind),
          verbs: ['create', 'get', 'list', 'update', 'patch', 'delete', 'watch'],
        })),
      });
  }
  if (url.pathname === '/openapi/v3')
    return respond({
      paths: Object.fromEntries(
        Object.keys(apiResources).map((v) => [apiPath(v).slice(1), { serverRelativeURL: `/openapi/v3${apiPath(v)}` }]),
      ),
    });
  for (const [version, kinds] of Object.entries(apiResources)) {
    if (url.pathname !== `/openapi/v3${apiPath(version)}`) continue;
    return respond({
      openapi: '3.0.0',
      info: { title: 'local native CLI fixture', version: '1' },
      paths: Object.fromEntries(
        kinds.map((kind) => [
          `${apiPath(version)}/namespaces/{namespace}/${resourceName(kind)}`,
          {
            post: {
              parameters: [{ name: 'fieldValidation', in: 'query', schema: { type: 'string' } }],
              responses: { 201: { description: 'created' } },
            },
          },
        ]),
      ),
      components: {
        schemas: Object.fromEntries(
          kinds.map((kind) => [
            kind,
            {
              type: 'object',
              'x-kubernetes-group-version-kind': [
                { group: version.includes('/') ? version.split('/')[0] : '', version: version.split('/').at(-1), kind },
              ],
              properties: { apiVersion: { type: 'string' }, kind: { type: 'string' }, metadata: { type: 'object' } },
            },
          ]),
        ),
      },
    });
  }
  return false;
}

export function assertFixtureRequest(req) {
  assert.ok(
    !req.headers.authorization || req.headers.authorization === 'Bearer local-test-only',
    'Tools must not load ambient credentials',
  );
}

// Helm's typed Secret client writes Kubernetes protobuf, while kubectl's
// unstructured create writes JSON. Decode only the actual Secret wire shape
// used by Helm release storage; unknown messages fail the fixture explicitly.
export function decodeKubernetesBody(bytes) {
  if (bytes.subarray(0, 4).toString() !== 'k8s\0') return JSON.parse(bytes);
  const fields = (bytes) => {
    let offset = 0;
    const read = () => {
      let n = 0,
        shift = 0,
        b;
      do {
        b = bytes[offset++];
        assert.ok(b !== undefined && shift < 56);
        n += (b & 127) * 2 ** shift;
        shift += 7;
      } while (b & 128);
      return n;
    };
    const result = new Map();
    while (offset < bytes.length) {
      const tag = read(),
        wire = tag & 7;
      assert.ok(wire === 0 || wire === 2, 'Unexpected fixture protobuf field');
      let value;
      if (wire === 0) value = read();
      else {
        const length = read();
        value = bytes.subarray(offset, (offset += length));
        assert.ok(offset <= bytes.length);
      }
      const values = result.get(tag >> 3) ?? [];
      values.push(value);
      result.set(tag >> 3, values);
    }
    return result;
  };
  const unknown = fields(bytes.subarray(4)),
    type = fields(unknown.get(1)[0]);
  assert.equal(type.get(2)[0].toString(), 'Secret');
  const secret = fields(unknown.get(2)[0]),
    metadata = fields(secret.get(1)[0]);
  const map = (entries = [], decode = (b) => b.toString()) =>
    Object.fromEntries(
      entries.map((entry) => {
        const item = fields(entry);
        return [item.get(1)[0].toString(), decode(item.get(2)[0])];
      }),
    );
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: metadata.get(1)[0].toString(),
      namespace: metadata.get(3)[0].toString(),
      uid: metadata.get(5)?.[0].toString(),
      resourceVersion: metadata.get(6)?.[0].toString(),
      labels: map(metadata.get(11)),
      annotations: map(metadata.get(12)),
    },
    data: map(secret.get(2), (bytes) => bytes.toString('base64')),
    type: secret.get(3)?.[0].toString(),
  };
}

// Instant fixture controller outcomes keep this a tool contract check. GKE
// scheduling, CSI and NEG propagation remain live qualification evidence.
export function nativeKubernetes(packet) {
  const { req, res, url, input, result, objects, store } = packet;
  const pathname = url.pathname;
  const namespace = pathname.match(/\/namespaces\/([^/]+)\//)?.[1];
  const status = (code, reason) => {
    res.statusCode = code;
    result({ apiVersion: 'v1', kind: 'Status', status: 'Failure', code, reason, message: reason });
    return true;
  };
  const save = (pathname, input) => {
    const value = structuredClone(input);
    if (!value.metadata.uid) delete value.metadata.uid;
    if (!value.metadata.namespace && namespace) value.metadata.namespace = namespace;
    value.metadata.generation ??= 1;
    const name = value.metadata.name;
    if (value.kind === 'Secret' && value.stringData) {
      value.data = Object.fromEntries(
        Object.entries(value.stringData).map(([key, text]) => [key, Buffer.from(text).toString('base64')]),
      );
      delete value.stringData;
    }
    if (['Deployment', 'StatefulSet'].includes(value.kind)) {
      const replicas = value.spec.replicas ?? 1;
      value.status = {
        observedGeneration: value.metadata.generation,
        replicas,
        updatedReplicas: replicas,
        readyReplicas: replicas,
        availableReplicas: replicas,
        currentReplicas: replicas,
        currentRevision: 'fixture',
        updateRevision: 'fixture',
      };
      for (const [key, pod] of objects)
        if (pod.kind === 'Pod' && pod.metadata.labels?.['fixture-owner'] === name) objects.delete(key);
      for (let i = 0; i < replicas; i++)
        store(`/api/v1/namespaces/${namespace}/pods/${name}-${i}`, {
          apiVersion: 'v1',
          kind: 'Pod',
          metadata: {
            name: `${name}-${i}`,
            namespace,
            labels: { ...value.spec.template.metadata?.labels, 'fixture-owner': name },
          },
          spec: value.spec.template.spec,
          status: {
            phase: 'Running',
            conditions: [{ type: 'Ready', status: 'True' }],
            containerStatuses: value.spec.template.spec.containers.map((c) => ({
              name: c.name,
              ready: true,
              restartCount: 0,
            })),
          },
        });
    }
    if (value.kind === 'Job') value.status = { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] };
    if (value.kind === 'Service') {
      value.spec.clusterIP ??= '10.0.0.7';
      if (value.metadata.labels?.['app.kubernetes.io/component'] === 'proxy')
        (value.metadata.annotations ??= {})['cloud.google.com/neg'] = '{"exposed_ports":{"80":{}}}';
      if (value.metadata.annotations?.['cloud.google.com/neg'])
        value.metadata.annotations['cloud.google.com/neg-status'] = JSON.stringify({
          zones: ['europe-central2-a', 'europe-central2-b'],
          network_endpoint_groups: { 80: 'fixture-neg' },
        });
    }
    if (value.kind === 'PersistentVolumeClaim') {
      value.spec.volumeName = `pv-${name}`;
      value.status = { phase: 'Bound' };
    }
    const saved = store(pathname, value);
    if (value.kind === 'Deployment')
      store(`/apis/apps/v1/namespaces/${namespace}/replicasets/${name}-fixture`, {
        apiVersion: 'apps/v1',
        kind: 'ReplicaSet',
        metadata: {
          name: `${name}-fixture`,
          namespace,
          labels: value.spec.template.metadata?.labels,
          ownerReferences: [
            { apiVersion: 'apps/v1', kind: 'Deployment', name, uid: saved.metadata.uid, controller: true },
          ],
        },
        spec: { replicas: value.spec.replicas ?? 1, selector: value.spec.selector, template: value.spec.template },
        status: { readyReplicas: value.spec.replicas ?? 1 },
      });
    if (value.kind === 'PersistentVolumeClaim')
      store(`/api/v1/persistentvolumes/pv-${name}`, {
        apiVersion: 'v1',
        kind: 'PersistentVolume',
        metadata: { name: `pv-${name}`, annotations: { 'pv.kubernetes.io/provisioned-by': 'pd.csi.storage.gke.io' } },
        spec: {
          claimRef: { uid: saved.metadata.uid, namespace },
          persistentVolumeReclaimPolicy: 'Delete',
          csi: {
            driver: 'pd.csi.storage.gke.io',
            volumeHandle: `projects/isolated-staging/zones/europe-central2-a/disks/pv-${name}`,
          },
        },
      });
    return saved;
  };
  if (req.method === 'GET' && !objects.has(pathname)) {
    const resource = pathname.split('/').at(-1);
    if (
      !Object.values(apiResources)
        .flat()
        .some((kind) => resourceName(kind) === resource)
    )
      return status(404, 'NotFound');
    const items = [...objects]
      .filter(([key]) => key.startsWith(`${pathname}/`) && !key.slice(pathname.length + 1).includes('/'))
      .map(([, value]) => value)
      .filter(
        (value) =>
          (!url.searchParams.has('fieldSelector') ||
            url.searchParams.get('fieldSelector') === `metadata.name=${value.metadata.name}`) &&
          (url.searchParams.get('labelSelector') ?? '')
            .split(',')
            .filter(Boolean)
            .every((selector) => {
              const [name, expected] = selector.split('=');
              return expected === undefined
                ? value.metadata.labels?.[name] !== undefined
                : value.metadata.labels?.[name] === expected;
            }),
      );
    if (['true', '1'].includes(url.searchParams.get('watch'))) {
      const events = items.map((object) => ({ type: 'ADDED', object }));
      if (url.searchParams.get('sendInitialEvents') === 'true')
        events.push({
          type: 'BOOKMARK',
          object: {
            apiVersion: items[0]?.apiVersion ?? 'v1',
            kind: items[0]?.kind ?? 'Pod',
            metadata: { resourceVersion: '1', annotations: { 'k8s.io/initial-events-end': 'true' } },
          },
        });
      res.end(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      return true;
    }
    const [version, kinds] = Object.entries(apiResources).find(([, kinds]) =>
      kinds.some((kind) => resourceName(kind) === resource),
    );
    const kind = kinds.find((kind) => resourceName(kind) === resource);
    result({ apiVersion: version, kind: `${kind}List`, metadata: { resourceVersion: '1' }, items });
    return true;
  }
  if (req.method === 'POST') {
    const target = `${pathname}/${input.metadata.name}`;
    if (objects.has(target)) return status(409, 'AlreadyExists');
    res.statusCode = 201;
    result(save(target, input));
    return true;
  }
  if (req.method === 'DELETE') {
    const current = objects.get(pathname);
    if (!current) return status(404, 'NotFound');
    if (!input?.preconditions) {
      assert.ok(
        current.metadata.annotations?.['helm.sh/hook'],
        'Only Helm hook garbage collection omits exact preconditions',
      );
      objects.delete(pathname);
      result({ apiVersion: 'v1', kind: 'Status', status: 'Success' });
      return true;
    }
  }
  if (req.method === 'PATCH' && !Array.isArray(input)) {
    const merge = (target, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete target[key];
        else if (typeof value === 'object' && !Array.isArray(value)) merge((target[key] ??= {}), value);
        else target[key] = value;
      }
      return target;
    };
    result(save(pathname, merge(structuredClone(objects.get(pathname)), input)));
    return true;
  }
  if (req.method === 'PUT' && input.kind === 'Secret') {
    const current = objects.get(pathname);
    if (!current) return status(404, 'NotFound');
    if (input.metadata.resourceVersion && input.metadata.resourceVersion !== current.metadata.resourceVersion)
      return status(409, 'Conflict');
    input.metadata.uid = current.metadata.uid;
    result(save(pathname, input));
    return true;
  }
  if (req.method === 'PATCH' && Array.isArray(input)) {
    const current = objects.get(pathname);
    assert.deepEqual(input.slice(0, 2), [
      { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
      { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    ]);
    assert.equal(input[2].path, '/spec/replicas');
    current.spec.replicas = input[2].value;
    result(save(pathname, current));
    return true;
  }
  // Let the shared fixture enforce resourceVersion/UID preconditions for all
  // registry CAS, controller JSON patches and destructive cleanup requests.
  return false;
}
