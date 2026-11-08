import assert from 'node:assert/strict';
import { diagnosticLabel, diagnosticNamespace } from './connection-reset-diagnostic.mjs';

export const diagnosticNodeImage =
  'node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53';
export const diagnosticProxyImage =
  'nginx:1.30.6-alpine@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951';
export const diagnosticNginx = `worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr info;
events { worker_connections 128; }
http {
  log_format diagnostic '$time_iso8601 $http_x_diagnostic_request $status $body_bytes_sent $request_time $upstream_addr $upstream_status';
  access_log /dev/stdout diagnostic;
  resolver 127.0.0.11 valid=1s ipv6=off;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;
  upstream rivet_execution { zone execution 64k; keepalive 0; server execution:8080 resolve; }
  upstream rivet_control { zone control 64k; keepalive 0; server a:8080 resolve; }
  server {
    listen 8443 ssl;
    http2 on;
    ssl_certificate /tls/cert.pem;
    ssl_certificate_key /tls/key.pem;
    location /control/ {
      proxy_pass http://rivet_control/;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_buffering off;
      proxy_read_timeout 360s;
      proxy_next_upstream off;
    }
    location / {
      proxy_pass http://rivet_execution;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_buffering off;
      proxy_read_timeout 360s;
      proxy_next_upstream off;
    }
  }
}
`;

/** Offline bundle only. Applying it requires separate staging authorization.
 * The only delegated mutation is one selector on this disposable Service. */
export function connectionResetResources({
  namespace,
  nodeImage = diagnosticNodeImage,
  proxyImage = diagnosticProxyImage,
  sources,
  tls,
}) {
  assert.match(namespace, diagnosticNamespace);
  for (const image of [nodeImage, proxyImage]) assert.match(image, /^[\w./:-]+@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(sources).sort(), ['diagnostic.mjs', 'runtime.mjs', 'transport.mjs']);
  const labels = { [diagnosticLabel]: namespace };
  const object = (kind, name, spec) => ({ apiVersion: 'v1', kind, metadata: { namespace, name, labels }, ...spec });
  const volumes = [
    {
      name: 'source',
      configMap: {
        name: 'diagnostic',
        items: [
          { key: 'runtime.mjs', path: 'fixtures/connection-reset-runtime.mjs' },
          { key: 'diagnostic.mjs', path: 'lib/connection-reset-diagnostic.mjs' },
          { key: 'transport.mjs', path: 'lib/continuity-http-transport.mjs' },
          { key: 'nginx.conf', path: 'nginx.conf' },
        ],
      },
    },
    { name: 'tls', secret: { secretName: 'diagnostic-tls', defaultMode: 292 } },
    { name: 'tmp', emptyDir: { sizeLimit: '16Mi' } },
  ];
  const mounts = [
    { name: 'source', mountPath: '/diagnostic', readOnly: true },
    { name: 'tls', mountPath: '/tls', readOnly: true },
    { name: 'tmp', mountPath: '/tmp' },
  ];
  const container = (mode, image = nodeImage) => ({
    name: 'diagnostic',
    image,
    imagePullPolicy: 'IfNotPresent',
    command: ['node', '/diagnostic/fixtures/connection-reset-runtime.mjs', mode],
    resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '128Mi' } },
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    },
    volumeMounts: mounts,
    env: [
      { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
      { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
      { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
      { name: 'POD_IP', valueFrom: { fieldRef: { fieldPath: 'status.podIP' } } },
    ],
  });
  const pod = (name, c, extraLabels = {}, token = false) =>
    object('Pod', name, {
      metadata: { name, namespace, labels: { ...labels, ...extraLabels } },
      spec: {
        automountServiceAccountToken: token,
        activeDeadlineSeconds: 900,
        restartPolicy: 'Never',
        securityContext: { fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [c],
        volumes,
      },
    });
  const service = (name, selector, port = 8080) =>
    object('Service', name, {
      spec: { type: 'ClusterIP', selector: { ...labels, ...selector }, ports: [{ port, targetPort: port }] },
    });
  const backend = (pool) => {
    const c = container('backend');
    c.readinessProbe = { httpGet: { path: '/readyz', port: 8080 }, periodSeconds: 1 };
    return pod(pool, c, { pool, 'rivet.dev/diagnostic-wire': '1' });
  };
  const proxy = container('unused', proxyImage);
  proxy.command = ['nginx', '-c', '/diagnostic/nginx.conf', '-g', 'daemon off;'];
  proxy.securityContext.runAsUser = 101;
  proxy.readinessProbe = { httpGet: { path: '/readyz', port: 8443, scheme: 'HTTPS' }, periodSeconds: 1 };
  const client = container('client-kubernetes');
  client.env.push({ name: 'NODE_EXTRA_CA_CERTS', value: '/tls/cert.pem' });
  const clientSpec = pod('client', client, {}, true).spec;
  clientSpec.serviceAccountName = 'diagnostic';
  const wirePods = [
    backend('a'),
    backend('b'),
    pod('proxy', proxy, { role: 'proxy', 'rivet.dev/diagnostic-wire': '1' }),
  ];
  for (const item of wirePods)
    item.spec.affinity = {
      podAntiAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: [
          {
            labelSelector: { matchLabels: { ...labels, 'rivet.dev/diagnostic-wire': '1' } },
            topologyKey: 'kubernetes.io/hostname',
          },
        ],
      },
    };
  return {
    apiVersion: 'v1',
    kind: 'List',
    items: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels } },
      // The ClusterIP stays fixed while its selector changes. Resolve it once,
      // after infrastructure creation, rather than introducing a DNS experiment.
      object('ConfigMap', 'diagnostic', {
        data: {
          ...sources,
          'nginx.conf': diagnosticNginx
            .replace('  resolver 127.0.0.11 valid=1s ipv6=off;\n', '')
            .replaceAll(' resolve;', ';'),
        },
      }),
      object('Secret', 'diagnostic-tls', {
        type: 'Opaque',
        data: {
          'cert.pem': Buffer.from(tls.cert).toString('base64'),
          'key.pem': Buffer.from(tls.key).toString('base64'),
        },
      }),
      object('ServiceAccount', 'diagnostic', { automountServiceAccountToken: false }),
      {
        ...object('Role', 'diagnostic', {
          rules: [{ apiGroups: [''], resources: ['services'], resourceNames: ['execution'], verbs: ['get', 'patch'] }],
        }),
        apiVersion: 'rbac.authorization.k8s.io/v1',
      },
      {
        ...object('RoleBinding', 'diagnostic', {
          subjects: [{ kind: 'ServiceAccount', name: 'diagnostic', namespace }],
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'diagnostic' },
        }),
        apiVersion: 'rbac.authorization.k8s.io/v1',
      },
      ...wirePods,
      service('a', { pool: 'a' }),
      service('b', { pool: 'b' }),
      service('execution', { pool: 'a' }),
      service('proxy', { role: 'proxy' }, 8443),
      {
        ...object('Job', 'client', {
          spec: { backoffLimit: 0, activeDeadlineSeconds: 420, template: { metadata: { labels }, spec: clientSpec } },
        }),
        apiVersion: 'batch/v1',
      },
    ],
  };
}
