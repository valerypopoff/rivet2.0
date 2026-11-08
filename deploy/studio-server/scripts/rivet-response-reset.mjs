import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { diagnosticProxyImage, diagnosticNodeImage } from './lib/connection-reset-resources.mjs';
import { cleanupConnectionResetLocal } from './lib/connection-reset-local-cleanup.mjs';
import {
  rivetResetResources,
  completeRivetResetResources,
  createRivetResetProxy,
  rivetResetPhases,
} from './lib/rivet-response-reset-resources.mjs';

// All Kubernetes output is offline. This command cannot activate a cloud test.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const scripts = path.join(root, 'deploy/studio-server/scripts');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    'api-image': { type: 'string' },
    'tools-image': { type: 'string' },
    'pod-inventory': { type: 'string' },
    'truncate-response': { type: 'boolean', default: false },
    'retain-backend': { type: 'boolean', default: false },
  },
});
const [mode] = positionals;
assert.ok(
  positionals.length === 1 && ['local', 'prepare', 'complete'].includes(mode),
  'Use local, prepare or complete',
);
assert.ok(!values['truncate-response'] || mode === 'local', 'Failure injection is local-only');
assert.ok(!values['retain-backend'] || mode === 'prepare', 'Retained-backend variant is offline preparation only');
const directory = path.resolve(
  root,
  values.output ?? `artifacts/rivet-reset-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
);
assert.ok(directory.startsWith(path.join(root, 'artifacts') + path.sep));
const write = (file, value) => fs.writeFile(path.join(directory, file), JSON.stringify(value, null, 2), { flag: 'wx' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const list = (items) => ({ apiVersion: 'v1', kind: 'List', items });

if (mode === 'complete') {
  assert.ok(values.output && values['pod-inventory']);
  const identity = JSON.parse(await fs.readFile(path.join(directory, 'identity.private.json'), 'utf8'));
  const raw = await fs.readFile(path.join(directory, 'pending.private.json'));
  assert.equal(hash(raw), identity.pendingSha256);
  const inventory = JSON.parse(await fs.readFile(values['pod-inventory'], 'utf8'));
  const { bundle, owners } = completeRivetResetResources(JSON.parse(raw), inventory);
  assert.equal(bundle.items.find((r) => r.kind === 'Namespace').metadata.name, identity.namespace);
  await write('proxy.private.json', list(rivetResetPhases(bundle).proxy));
  await write(
    'client.private.json',
    bundle.items.find((r) => r.kind === 'Job'),
  );
  await write('owners.private.json', owners);
  console.log('Completed offline proxy/client manifests. No Kubernetes command ran.');
} else {
  assert.ok(values['api-image'] && values['tools-image'], 'Select cached pinned API and tools images');
  assert.match(values['api-image'], /^ghcr\.io\/valerypopoff\/rivet2\.0-studio-server\/api@sha256:[a-f0-9]{64}$/);
  const execute = promisify(execFile);
  const docker = (args, timeout = 30000) =>
    execute('docker', args, { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  for (const image of [values['api-image'], values['tools-image'], diagnosticProxyImage])
    await docker(['image', 'inspect', image]);
  for (const image of [values['api-image'], values['tools-image']]) {
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--entrypoint',
      'node',
      image,
      '-e',
      'if(process.versions.node!=="24.22.1")throw Error("Diagnostic requires Node 24.22.1")',
    ]);
  }
  await docker([
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--entrypoint',
    'openssl',
    values['tools-image'],
    'version',
  ]);
  await fs.mkdir(directory);
  await Promise.all(['fixtures', 'lib', 'tls'].map((name) => fs.mkdir(path.join(directory, name))));
  const files = [
    'fixtures/rivet-response-reset-runtime.mjs',
    'lib/rivet-response-reset.mjs',
    'lib/connection-reset-diagnostic.mjs',
    'lib/continuity-http-transport.mjs',
    'lib/kubernetes-response-error.mjs',
  ];
  const contents = {};
  for (const file of files) {
    contents[file] = await fs.readFile(path.join(scripts, file), 'utf8');
    await fs.writeFile(path.join(directory, file), contents[file]);
  }
  const namespace = 'rivet-reset-' + randomUUID().replaceAll('-', '').slice(0, 12);
  const mount = `type=bind,source=${directory},target=/diagnostic`;
  await docker([
    'run',
    '--rm',
    '--pull=never',
    '--network=none',
    '--user',
    '10001:10001',
    '--mount',
    mount,
    '--entrypoint',
    '/bin/sh',
    values['tools-image'],
    '-ec',
    'openssl req -x509 -newkey rsa:2048 -nodes -keyout /diagnostic/tls/key.pem -out /diagnostic/tls/cert.pem -subj /CN=proxy -addext subjectAltName=DNS:proxy -days 1 >/dev/null 2>&1 && chmod 644 /diagnostic/tls/key.pem',
  ]);
  const tls = {
    cert: await fs.readFile(path.join(directory, 'tls/cert.pem'), 'utf8'),
    key: await fs.readFile(path.join(directory, 'tls/key.pem'), 'utf8'),
  };
  const bundle = rivetResetResources({
    namespace,
    apiImage: values['api-image'],
    tls,
    retainBackend: values['retain-backend'],
    sources: {
      'runtime.mjs': contents[files[0]],
      'real-diagnostic.mjs': contents[files[1]],
      'diagnostic.mjs': contents[files[2]],
      'transport.mjs': contents[files[3]],
      'error.mjs': contents[files[4]],
    },
  });
  if (mode === 'prepare') {
    const raw = JSON.stringify(bundle, null, 2);
    await fs.writeFile(path.join(directory, 'pending.private.json'), raw, { flag: 'wx' });
    await write('infrastructure.private.json', list(rivetResetPhases(bundle).infrastructure));
    await write('identity.private.json', {
      namespace,
      qualification: false,
      cloudStarted: false,
      apiImage: values['api-image'],
      nodeImage: diagnosticNodeImage,
      pendingSha256: hash(raw),
    });
    console.log(`Prepared offline real-Rivet diagnostic for ${namespace} in ${directory}. No Kubernetes command ran.`);
  } else {
    const names = ['a', 'b', 'execution', 'proxy', 'client'].map((role) => `${namespace}-${role}`);
    const label = `rivet.connection-diagnostic=${namespace}`;
    let failure, report, cleanupVerified;
    let localClient, localProxy;
    await write('resources.private.json', { namespace, containers: names, cloudOperation: false });
    try {
      await docker(['network', 'create', '--internal', '--label', label, namespace]);
      const startRole = async (role) => {
        const realBackend = ['a', 'b'].includes(role);
        const common = [
          '--pull=never',
          '--name',
          `${namespace}-${role}`,
          '--label',
          label,
          '--network',
          namespace,
          '--network-alias',
          role,
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--read-only',
          '--tmpfs',
          '/tmp',
          '--memory',
          realBackend ? '512m' : '128m',
          '--cpus=0.5',
          '--mount',
          (role === 'proxy' ? `type=bind,source=${path.join(directory, 'proxy-config')},target=/diagnostic` : mount) +
            ',readonly',
          '--mount',
          `type=bind,source=${path.join(directory, 'tls')},target=/tls,readonly`,
        ];
        const command =
          role === 'proxy'
            ? [
                '--user',
                '101:101',
                '--entrypoint',
                'nginx',
                diagnosticProxyImage,
                ...localProxy.spec.containers[0].command.slice(1),
              ]
            : role === 'execution'
              ? [
                  '--user',
                  '10001:10001',
                  '--mount',
                  `type=bind,source=${scripts},target=/wire,readonly`,
                  '--entrypoint',
                  'node',
                  values['tools-image'],
                  '/wire/fixtures/connection-reset-runtime.mjs',
                  'router',
                ]
              : [
                  '--user',
                  '10001:10001',
                  '-e',
                  `POD_UID=local-${role}`,
                  '-e',
                  `BACKEND_A=${localClient?.env.find((v) => v.name === 'BACKEND_A').value ?? 'http://a:8080'}`,
                  '-e',
                  `BACKEND_B=${localClient?.env.find((v) => v.name === 'BACKEND_B').value ?? 'http://b:8080'}`,
                  '-e',
                  'NODE_EXTRA_CA_CERTS=/diagnostic/tls/cert.pem',
                  '-e',
                  `LOCAL_TRUNCATE=${role === 'a' && values['truncate-response'] ? '1' : '0'}`,
                  '--entrypoint',
                  '/bin/sh',
                  realBackend ? values['api-image'] : values['tools-image'],
                  '-ec',
                  'mkdir -p /tmp/projected; ln -s /diagnostic /tmp/projected/..data; ln -s ..data/fixtures /tmp/projected/fixtures; ln -s ..data/lib /tmp/projected/lib; exec node /tmp/projected/fixtures/rivet-response-reset-runtime.mjs "$1"',
                  'diagnostic-entry',
                  realBackend ? 'backend' : 'client-local',
                ];
        const result = await docker(
          ['run', ...(role === 'client' ? [] : ['-d']), ...common, ...command],
          role === 'client' ? 90000 : 30000,
        );
        if (role === 'client') report = JSON.parse(result.stdout.trim());
        if (realBackend || role === 'proxy') {
          let ready = false;
          for (let n = 0; n < 100; n++) {
            const status = JSON.parse(
              (await docker(['inspect', '--format', '{{json .State}}', `${namespace}-${role}`])).stdout,
            );
            assert.equal(status.Running, true, 'Diagnostic container exited before readiness');
            const logs = await docker(['logs', `${namespace}-${role}`]);
            if ((logs.stdout + logs.stderr).includes(realBackend ? 'backend-ready' : 'start worker process')) {
              ready = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(ready, true, 'Diagnostic container did not become ready');
        }
      };
      for (const role of ['a', 'b', 'execution']) await startRole(role);
      const inventory = { items: [] };
      for (const role of ['a', 'b']) {
        const info = JSON.parse((await docker(['inspect', `${namespace}-${role}`])).stdout)[0];
        assert.equal(info.State.Running, true);
        const pod = structuredClone(bundle.items.find((r) => r.kind === 'Pod' && r.metadata.name === role));
        pod.metadata.uid = `local-${role}`;
        pod.spec.nodeName = `local-container-${role}`;
        pod.status = {
          phase: 'Running',
          podIP: info.NetworkSettings.Networks[namespace].IPAddress,
          conditions: [{ type: 'Ready', status: 'True' }],
        };
        inventory.items.push(pod);
      }
      const creates = [];
      const completed = await createRivetResetProxy({
        bundle,
        inventory,
        create: async (resource) => {
          creates.push({ method: 'POST', kind: resource.kind, name: resource.metadata.name });
          if (resource.kind === 'ConfigMap') {
            assert.equal(resource.metadata.name, 'proxy-config');
            assert.equal(resource.immutable, true);
            await fs.mkdir(path.join(directory, 'proxy-config'));
            await fs.writeFile(path.join(directory, 'proxy-config/nginx.conf'), resource.data['nginx.conf'], {
              flag: 'wx',
            });
          } else if (resource.kind === 'Pod') {
            const source = resource.spec.volumes.find((v) => v.name === 'source').configMap;
            assert.equal(source.name, 'proxy-config');
            localProxy = resource;
            await startRole('proxy');
          } else assert.equal(resource.kind, 'Service');
        },
      });
      localClient = rivetResetPhases(completed.bundle).client.spec.template.spec.containers[0];
      await write('proxy-creation.private.json', creates);
      await startRole('client');
    } catch (error) {
      failure = error;
      if (error.stdout) {
        try {
          report = JSON.parse(error.stdout.trim());
        } catch {
          /* Setup can fail before a report exists. */
        }
      }
    } finally {
      const cleanup = await cleanupConnectionResetLocal({
        docker,
        names,
        namespace,
        writeLog: (name, logs) => fs.writeFile(path.join(directory, name + '.private.log'), logs),
        removeTls: async () => {
          const outcomes = await Promise.allSettled(
            ['key.pem', 'cert.pem'].map((file) => fs.rm(path.join(directory, 'tls', file), { force: true })),
          );
          const errors = outcomes.filter((r) => r.status === 'rejected').map((r) => r.reason);
          if (errors.length) throw new AggregateError(errors);
        },
      });
      cleanupVerified = cleanup.cleanupVerified;
      failure ??= cleanup.errors[0];
      await write('result.private.json', {
        report,
        cleanupVerified,
        ...(failure ? { failure: { name: failure.name, code: failure.code } } : {}),
      });
    }
    console.log(JSON.stringify({ directory, outcome: report?.outcome ?? 'inconclusive', cleanupVerified }));
    if (failure || report?.outcome !== 'passed' || !cleanupVerified) process.exitCode = 1;
  }
}
