import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { connectionResetResources, diagnosticNginx, diagnosticProxyImage } from './lib/connection-reset-resources.mjs';

// There is intentionally no Kubernetes execution mode. Preparation writes an
// offline bundle; the operator must obtain staging approval before applying it.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: 'string' },
    'tools-image': { type: 'string' },
    'truncate-response': { type: 'boolean', default: false },
  },
});
const [mode] = positionals;
assert.ok(positionals.length === 1 && ['local', 'prepare'].includes(mode), 'Use local or prepare');
assert.ok(values['tools-image'], 'Select an existing local Node 24.22.1 + OpenSSL tools image');
assert.ok(!values['truncate-response'] || mode === 'local', 'Fault injection is local-only');
const namespace = 'rivet-reset-' + randomUUID().replaceAll('-', '').slice(0, 12);
const artifacts = path.join(root, 'artifacts');
const directory = path.resolve(root, values.output ?? `artifacts/${namespace}`);
assert.ok(directory.startsWith(artifacts + path.sep), 'Output must be a new directory under this checkout artifacts/');
const execute = promisify(execFile);
const docker = async (args, timeout = 30000) =>
  execute('docker', args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
for (const image of [values['tools-image'], diagnosticProxyImage]) await docker(['image', 'inspect', image]);
await fs.mkdir(directory); // Refuse to overwrite an earlier diagnostic or key.
await Promise.all(['fixtures', 'lib', 'tls'].map((name) => fs.mkdir(path.join(directory, name))));
const sourceFiles = {
  'fixtures/connection-reset-runtime.mjs': 'runtime.mjs',
  'lib/connection-reset-diagnostic.mjs': 'diagnostic.mjs',
  'lib/continuity-http-transport.mjs': 'transport.mjs',
};
const sources = {};
for (const [file, key] of Object.entries(sourceFiles)) {
  sources[key] = await fs.readFile(path.join(root, 'deploy/studio-server/scripts', file), 'utf8');
  await fs.writeFile(path.join(directory, file), sources[key]);
}
const mount = `type=bind,source=${directory},target=/diagnostic`;
const tlsMount = `type=bind,source=${path.join(directory, 'tls')},target=/tls`;
await docker([
  'run',
  '--rm',
  '--pull=never',
  '--network=none',
  '--user',
  `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
  '--mount',
  tlsMount,
  '--entrypoint',
  '/bin/sh',
  values['tools-image'],
  '-ec',
  'openssl req -x509 -newkey rsa:2048 -nodes -keyout /tls/key.pem -out /tls/cert.pem -subj /CN=proxy -addext subjectAltName=DNS:proxy -days 1 >/dev/null 2>&1 && chmod 644 /tls/key.pem',
]);

if (mode === 'prepare') {
  const tls = {
    cert: await fs.readFile(path.join(directory, 'tls/cert.pem'), 'utf8'),
    key: await fs.readFile(path.join(directory, 'tls/key.pem'), 'utf8'),
  };
  const bundle = connectionResetResources({ namespace, sources, tls });
  const list = (items) => ({ apiVersion: 'v1', kind: 'List', items });
  const edge = bundle.items.filter((r) => r.metadata.name === 'proxy');
  const job = bundle.items.find((r) => r.kind === 'Job');
  const infrastructure = bundle.items.filter((r) => r !== job && !edge.includes(r));
  const sha256 = {};
  for (const [file, value] of Object.entries({
    'infrastructure.private.json': list(infrastructure),
    'proxy.private.json': list(edge),
    'client.private.json': job,
  })) {
    const bytes = JSON.stringify(value, null, 2);
    await fs.writeFile(path.join(directory, file), bytes);
    sha256[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await fs.writeFile(
    path.join(directory, 'identity.private.json'),
    JSON.stringify(
      { namespace, qualification: false, cloudStarted: false, preparedAt: new Date().toISOString(), sha256 },
      null,
      2,
    ),
  );
  console.log(`Prepared offline diagnostic for ${namespace} in ${directory}. No Kubernetes command ran.`);
} else {
  const label = `rivet.connection-diagnostic=${namespace}`;
  const names = ['a', 'b', 'execution', 'proxy', 'client'].map((role) => `${namespace}-${role}`);
  let failure, report;
  await fs.writeFile(
    path.join(directory, 'resources.private.json'),
    JSON.stringify({ namespace, containers: names, cloudOperation: false }, null, 2),
  );
  try {
    await docker(['network', 'create', '--internal', '--label', label, namespace]);
    await fs.writeFile(path.join(directory, 'nginx.conf'), diagnosticNginx);
    for (const role of ['a', 'b', 'execution', 'proxy', 'client']) {
      const name = `${namespace}-${role}`;
      const common = [
        '--pull=never',
        '--name',
        name,
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
        '--memory=128m',
        '--cpus=0.5',
        '--mount',
        mount + ',readonly',
        '--mount',
        tlsMount + ',readonly',
      ];
      const command =
        role === 'proxy'
          ? [
              '--user',
              '101:101',
              '--entrypoint',
              'nginx',
              diagnosticProxyImage,
              '-c',
              '/diagnostic/nginx.conf',
              '-g',
              'daemon off;',
            ]
          : [
              '-e',
              `POD_UID=local-${role}`,
              '-e',
              `LOCAL_TRUNCATE=${role === 'a' && values['truncate-response'] ? 1 : 0}`,
              '-e',
              'NODE_EXTRA_CA_CERTS=/tls/cert.pem',
              '--entrypoint',
              '/bin/sh',
              values['tools-image'],
              '-ec',
              // Exercise the same resolved-file/argv difference as ConfigMap mounts.
              'mkdir -p /tmp/projected; ln -s /diagnostic /tmp/projected/..data; ln -s ..data/fixtures /tmp/projected/fixtures; ln -s ..data/lib /tmp/projected/lib; exec node /tmp/projected/fixtures/connection-reset-runtime.mjs "$1"',
              'diagnostic-entry',
              role === 'client' ? 'client-local' : role === 'execution' ? 'router' : 'backend',
            ];
      const result = await docker(
        ['run', ...(role === 'client' ? [] : ['-d']), ...common, ...command],
        role === 'client' ? 90000 : 30000,
      );
      if (role === 'client') report = JSON.parse(result.stdout.trim());
    }
  } catch (error) {
    failure = error;
    if (error.stdout) {
      try {
        report = JSON.parse(error.stdout.trim());
      } catch {
        /* Setup failure has no report. */
      }
    }
  } finally {
    const cleanupErrors = [];
    for (const name of names.reverse()) {
      try {
        const inspected = await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
        if (!inspected.stdout.trim()) continue;
        const info = JSON.parse((await docker(['inspect', name])).stdout)[0];
        assert.equal(info.Config.Labels['rivet.connection-diagnostic'], namespace);
        const logs = await docker(['logs', name]);
        await fs.writeFile(path.join(directory, name + '.private.log'), logs.stdout + logs.stderr);
        await docker(['rm', '-f', name]);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      const found = await docker(['network', 'ls', '--filter', `name=^${namespace}$`, '--format', '{{.ID}}']);
      if (found.stdout.trim()) {
        const network = JSON.parse((await docker(['network', 'inspect', namespace])).stdout)[0];
        assert.equal(network.Labels['rivet.connection-diagnostic'], namespace);
        await docker(['network', 'rm', namespace]);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const file of ['tls/key.pem', 'tls/cert.pem']) await fs.unlink(path.join(directory, file));
    await fs.writeFile(
      path.join(directory, 'result.private.json'),
      JSON.stringify({ namespace, qualification: false, report, cleanupVerified: cleanupErrors.length === 0 }, null, 2),
    );
    if (cleanupErrors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        'Local diagnostic or cleanup failed',
      );
  }
  console.log(
    JSON.stringify({
      directory,
      outcome: report?.outcome ?? 'setup-failed',
      cleanupVerified: !(failure instanceof AggregateError),
    }),
  );
  if (failure) throw failure;
}
