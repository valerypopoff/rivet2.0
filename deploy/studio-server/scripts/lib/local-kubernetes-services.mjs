// Namespace-owned dependencies shared by local development and single-machine
// release installation. Not owned by the application Helm release: data persists.
import { localStorageFingerprint } from './kubernetes-launcher-config.mjs';
export const localOwnerLabel = 'rivet.dev/local-launcher-owner';
const minioImage =
  'alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4';

export function localNamespaceManifest(config) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.namespace,
      labels: { [localOwnerLabel]: config.release },
    },
  };
}

export function assertLocalNamespaceOwner(namespace, config) {
  if (namespace.metadata?.labels?.[localOwnerLabel] !== config.release) {
    throw new Error(
      `Namespace ${config.namespace} is not owned by this Rivet dependency installation. Choose a new namespace; nothing was changed.`,
    );
  }
  if (namespace.metadata?.deletionTimestamp)
    throw new Error('Local namespace is terminating; wait before starting again.');
}

export function localDependencyResources(config) {
  const local = config.localServices;
  if (!local) return [];
  const labels = { [localOwnerLabel]: config.release };
  const metadata = (name) => ({ name, namespace: config.namespace, labels });
  const resources = [];
  for (const [name, size, port, container] of [
    [
      local.postgresName,
      local.postgresSize,
      5432,
      {
        name: 'postgres',
        image: 'postgres:16.8-alpine',
        args: ['-c', 'max_connections=200'],
        env: [
          { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
          ...[
            ['POSTGRES_DB', 'database'],
            ['POSTGRES_USER', 'username'],
            ['POSTGRES_PASSWORD', 'password'],
          ].map(([name, key]) => ({
            name,
            valueFrom: { secretKeyRef: { name: config.secrets.postgresName, key } },
          })),
        ],
        readinessProbe: {
          exec: { command: ['sh', '-ec', 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'] },
          periodSeconds: 3,
        },
        volumeMounts: [{ name: 'data', mountPath: '/var/lib/postgresql/data' }],
      },
    ],
    [
      local.minioName,
      local.minioSize,
      9000,
      {
        name: 'minio',
        image: minioImage,
        // The disposable PVC may be root-owned. This does not alter Rivet's pod security policy.
        securityContext: { runAsUser: 0 },
        args: ['server', '/data', '--console-address', ':9001'],
        env: [
          { name: 'MINIO_REGION_NAME', value: config.objectStorage.region },
          ...[
            ['MINIO_ROOT_USER', 'accessKeyId'],
            ['MINIO_ROOT_PASSWORD', 'secretAccessKey'],
          ].map(([name, key]) => ({
            name,
            valueFrom: { secretKeyRef: { name: config.secrets.objectStorageName, key } },
          })),
        ],
        readinessProbe: { httpGet: { path: '/minio/health/ready', port: 9000 }, periodSeconds: 3 },
        volumeMounts: [{ name: 'data', mountPath: '/data' }],
      },
    ],
  ]) {
    const selector = { ...labels, 'app.kubernetes.io/name': name };
    resources.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: metadata(`${name}-data`),
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: size } },
        ...(local.storageClassName ? { storageClassName: local.storageClassName } : {}),
      },
    });
    resources.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: metadata(name),
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selector },
        template: {
          metadata: { labels: selector },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                ...container,
                ports: [{ containerPort: port }],
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '2', memory: '1Gi' },
                },
              },
            ],
            volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }],
          },
        },
      },
    });
    resources.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: metadata(name),
      spec: {
        type: 'ClusterIP',
        selector,
        ports: [{ port, targetPort: port }],
      },
    });
  }
  return resources;
}

async function readResource(run, config, kind, name, clusterScoped = false) {
  const result = await run(
    [...(clusterScoped ? [] : ['-n', config.namespace]), 'get', kind, name, '-o', 'json', '--ignore-not-found=true'],
    { capture: true },
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export async function ensureLocalNamespace(config, run) {
  let namespace = await readResource(run, config, 'namespace', config.namespace, true);
  if (!namespace) {
    // create, not apply: never adopt an existing unrelated namespace, including a creation race.
    await run(['create', '-f', '-'], { input: JSON.stringify(localNamespaceManifest(config)), allowFailure: true });
    namespace = await readResource(run, config, 'namespace', config.namespace, true);
    if (!namespace) throw new Error(`Could not create local namespace ${config.namespace}.`);
  }
  assertLocalNamespaceOwner(namespace, config);
}

export async function assertLocalResources(config, run, { checkVolumeSettings = true } = {}) {
  const namespace = await readResource(run, config, 'namespace', config.namespace, true);
  if (!namespace) return false;
  assertLocalNamespaceOwner(namespace, config);
  for (const name of Object.values(config.secrets)) {
    const existing = await readResource(run, config, 'secret', name);
    if (existing && existing.metadata?.labels?.[localOwnerLabel] !== config.release) {
      throw new Error(`Secret ${name} has another owner; nothing was changed.`);
    }
  }
  for (const resource of localDependencyResources(config)) {
    const existing = await readResource(run, config, resource.kind, resource.metadata.name);
    if (existing && existing.metadata?.labels?.[localOwnerLabel] !== config.release) {
      throw new Error(
        `Local dependency ${resource.kind}/${resource.metadata.name} has another owner; nothing was changed.`,
      );
    }
    if (
      existing &&
      checkVolumeSettings &&
      resource.kind === 'PersistentVolumeClaim' &&
      (existing.spec.resources.requests.storage !== resource.spec.resources.requests.storage ||
        (config.localServices.storageClassName &&
          existing.spec.storageClassName !== config.localServices.storageClassName))
    ) {
      throw new Error(
        'Dependency volume size/class changed. Restore the original .env values; data migration or resizing requires an explicit operator procedure.',
      );
    }
  }
  return true;
}

export async function assertLocalCredentials(config, run) {
  const expected = [
    [
      config.secrets.postgresName,
      {
        connectionString: config.databaseConnectionString,
        password: config.localServices.password,
        username: config.localServices.username,
        database: config.localServices.database,
      },
    ],
    [
      config.secrets.objectStorageName,
      {
        accessKeyId: config.objectStorage.accessKeyId,
        secretAccessKey: config.objectStorage.secretAccessKey,
        localStorageFingerprint: localStorageFingerprint(config),
      },
    ],
    [config.secrets.authName, { RIVET_KEY: config.sharedKey }],
  ];
  for (const [name, fields] of expected) {
    const existing = await readResource(run, config, 'secret', name);
    if (!existing) {
      if (
        (await readResource(run, config, 'PersistentVolumeClaim', `${config.localServices.postgresName}-data`)) ||
        (await readResource(run, config, 'PersistentVolumeClaim', `${config.localServices.minioName}-data`))
      ) {
        throw new Error(
          'Dependency credentials are missing but persistent data exists. Recover the original secrets; no credentials or data were replaced.',
        );
      }
      continue;
    }
    if (existing.metadata?.labels?.[localOwnerLabel] !== config.release) {
      throw new Error(`Secret ${name} has another owner; no secrets were overwritten.`);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (Buffer.from(existing.data?.[key] ?? '', 'base64').toString('utf8') !== value) {
        throw new Error(
          'Dependency credentials changed. Keep the original .env credentials or use a verified credential-rotation procedure; no secrets were overwritten.',
        );
      }
    }
  }
}

export async function prepareLocalServices(config, run, applySecrets) {
  await ensureLocalNamespace(config, run);
  await assertLocalResources(config, run);
  await assertLocalCredentials(config, run);
  await applySecrets();
  await provisionLocalServices(config, run);
}

export async function provisionLocalServices(config, run) {
  const items = localDependencyResources(config);
  await run(['apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }) });
  for (const name of [config.localServices.postgresName, config.localServices.minioName]) {
    await run(['-n', config.namespace, 'rollout', 'status', `deployment/${name}`, '--timeout=180s']);
  }
}

export async function removeLocalServices(config, run, { eraseData = false } = {}) {
  if (!(await assertLocalResources(config, run, { checkVolumeSettings: false }))) return;
  const kinds = ['Deployment', 'Service', ...(eraseData ? ['PersistentVolumeClaim'] : [])];
  // Stop all writers before deleting claims; mounted PVCs retain a protection finalizer.
  const resources = kinds.flatMap((kind) =>
    localDependencyResources(config).filter((resource) => resource.kind === kind),
  );
  for (const resource of resources) {
    await run([
      '-n',
      config.namespace,
      'delete',
      resource.kind,
      `--field-selector=metadata.name=${resource.metadata.name}`,
      '-l',
      `${localOwnerLabel}=${config.release}`,
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=180s',
    ]);
  }
  if (eraseData) {
    for (const name of Object.values(config.secrets)) {
      await run([
        '-n',
        config.namespace,
        'delete',
        'secret',
        `--field-selector=metadata.name=${name}`,
        '-l',
        `${localOwnerLabel}=${config.release}`,
        '--ignore-not-found=true',
      ]);
    }
  }
  // Never delete a namespace, host directory, cluster, or any external database/bucket.
}
