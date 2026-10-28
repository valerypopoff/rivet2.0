import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { stringify } from 'yaml';
import { reusableStagingSettings } from './lib/reusable-staging-state.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
export function stagingJanitorObjects(settings, { image, code, driverDigest, googleServiceAccount }) {
  assert.match(image, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  assert.match(driverDigest, /^[a-f0-9]{64}$/);
  assert.match(googleServiceAccount, /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/);
  assert.equal(googleServiceAccount.split('@')[1].split('.')[0], settings.projectId);
  const namespace = settings.controlNamespace,
    name = 'rivet-qualification-janitor';
  const metadata = { name, namespace };
  return [
    {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { ...metadata, annotations: { 'iam.gke.io/gcp-service-account': googleServiceAccount } },
    },
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { ...metadata, name: `${name}-health` }, data: { health: '{}' } },
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { ...metadata, name: `${name}-code` },
      immutable: true,
      data: {
        'janitor.mjs': code,
        'settings.json': JSON.stringify({ ...settings, approvedDriverDigest: driverDigest }),
      },
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name },
      rules: [
        {
          apiGroups: [''],
          resources: [
            'namespaces',
            'pods',
            'services',
            'persistentvolumeclaims',
            'persistentvolumes',
            'secrets',
            'configmaps',
          ],
          verbs: ['get', 'list'],
        },
        { apiGroups: [''], resources: ['nodes'], verbs: ['get'] },
        { apiGroups: ['apps'], resources: ['statefulsets', 'deployments'], verbs: ['get', 'list', 'patch'] },
        { apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'list'] },
        { apiGroups: ['gateway.networking.k8s.io'], resources: ['gateways', 'httproutes'], verbs: ['get', 'list'] },
        { apiGroups: ['networking.gke.io'], resources: ['healthcheckpolicies'], verbs: ['get', 'list'] },
        { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
        { apiGroups: [''], resources: ['pods', 'namespaces'], verbs: ['delete'] },
        { apiGroups: ['gateway.networking.k8s.io'], resources: ['httproutes'], verbs: ['delete'] },
      ],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name },
      subjects: [{ kind: 'ServiceAccount', name, namespace }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata,
      rules: [{ apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list', 'update'] }],
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'RoleBinding',
      metadata,
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name },
      subjects: [{ kind: 'ServiceAccount', name, namespace }],
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata,
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: { 'app.kubernetes.io/name': name } },
        template: {
          metadata: {
            labels: { 'app.kubernetes.io/name': name },
            annotations: { 'rivet.dev/code-sha256': createHash('sha256').update(code).digest('hex') },
          },
          spec: {
            serviceAccountName: name,
            terminationGracePeriodSeconds: 240,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001 },
            containers: [
              {
                name: 'janitor',
                image,
                command: ['node', '/qualification/janitor.mjs'],
                env: [
                  { name: 'RIVET_QUALIFICATION_SETTINGS_FILE', value: '/qualification/settings.json' },
                  ...['NAME', 'UID'].map((k) => ({
                    name: `POD_${k}`,
                    valueFrom: { fieldRef: { fieldPath: `metadata.${k.toLowerCase()}` } },
                  })),
                ],
                securityContext: {
                  readOnlyRootFilesystem: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '250m', memory: '256Mi' } },
                volumeMounts: [{ name: 'code', mountPath: '/qualification', readOnly: true }],
              },
            ],
            volumes: [{ name: 'code', configMap: { name: `${name}-code` } }],
          },
        },
      },
    },
  ];
}
export async function packageReusableStaging({ settings, output, janitorImage, googleServiceAccount }) {
  settings = reusableStagingSettings(settings);
  await fs.mkdir(output, { recursive: false }); // A package is immutable; never replace an existing one.
  const bundle = path.join(output, 'driver');
  await fs.mkdir(bundle);
  const entries = ['qualification/provider-entry.mjs', 'reusable-staging-janitor.mjs'].map((file) =>
    path.join(root, 'deploy/studio-server/scripts', file),
  );
  const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';import {pathToFileURL as __fileURL} from 'node:url';import {resolve as __resolve} from 'node:path';const require=__createRequire(import.meta.url);const __rivetSourceFile=(file)=>__fileURL(__resolve(process.env.RIVET_QUALIFICATION_SOURCE_ROOT||'.',file)).href;",
    },
    plugins: [
      {
        name: 'retain-cli-module-identities',
        setup(context) {
          context.onLoad({ filter: /\.mjs$/ }, async (args) => {
            if (entries.includes(args.path) || !args.path.startsWith(root)) return;
            const relative = path.relative(root, args.path).split(path.sep).join('/');
            return {
              loader: 'js',
              contents: (await fs.readFile(args.path, 'utf8')).replaceAll(
                'import.meta.url',
                `__rivetSourceFile(${JSON.stringify(relative)})`,
              ),
            };
          });
        },
      },
    ],
  };
  await build({
    ...common,
    entryPoints: [path.join(root, 'deploy/studio-server/scripts/qualification/provider-entry.mjs')],
    outfile: path.join(bundle, 'provider.mjs'),
  });
  const janitor = await build({
    ...common,
    entryPoints: [path.join(root, 'deploy/studio-server/scripts/reusable-staging-janitor.mjs')],
    write: false,
  });
  await fs.writeFile(path.join(bundle, 'settings.json'), JSON.stringify(settings));
  for (const name of ['fault-transport.mjs', 'fault-transport-entry.mjs'])
    await fs.copyFile(path.join(root, 'deploy/studio-server/scripts/qualification', name), path.join(bundle, name));
  const files = {};
  for (const name of (await fs.readdir(bundle)).sort())
    files[name] = createHash('sha256')
      .update(await fs.readFile(path.join(bundle, name)))
      .digest('hex');
  const manifest = {
    protocol: 1,
    suite: 'compact-seven-v1',
    provider: 'gke',
    scope: 'isolated-provider',
    entrypoint: 'provider.mjs',
    files,
  };
  await fs.writeFile(path.join(bundle, 'driver.json'), JSON.stringify(manifest));
  const digest = qualificationHash(manifest);
  const objects = stagingJanitorObjects(settings, {
    image: janitorImage,
    code: janitor.outputFiles[0].text,
    driverDigest: digest,
    googleServiceAccount,
  });
  await fs.writeFile(path.join(output, 'janitor.yaml'), objects.map((o) => stringify(o)).join('\n---\n'));
  await fs.writeFile(
    path.join(output, 'package.json'),
    JSON.stringify({
      protocol: 1,
      driverDigest: digest,
      janitorImage,
      janitorManifestSha256: createHash('sha256')
        .update(await fs.readFile(path.join(output, 'janitor.yaml')))
        .digest('hex'),
    }),
  );
  return { driverDigest: digest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [settings, output, janitorImage, googleServiceAccount] = process.argv.slice(2);
  assert.ok(settings && output && janitorImage && googleServiceAccount);
  console.log(
    JSON.stringify(
      await packageReusableStaging({
        settings: JSON.parse(await fs.readFile(settings, 'utf8')),
        output,
        janitorImage,
        googleServiceAccount,
      }),
    ),
  );
}
