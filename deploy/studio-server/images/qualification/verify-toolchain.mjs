import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http2 from 'node:http2';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';

// Mandatory final-image regression: real CLIs, local TLS/HTTP2 and synthetic
// data only. Never use ambient kubeconfig, credentials, proxy or cluster state.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-toolchain-'));
const env = {
  ...process.env,
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  http_proxy: '',
  https_proxy: '',
  all_proxy: '',
};
let server;
const sessions = new Set();
const fixtureErrors = [];
async function cli(program, args, success = true) {
  const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [],
    errors = [];
  child.stdout.on('data', (b) => output.push(b));
  child.stderr.on('data', (b) => errors.push(b));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 15000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false, 'Toolchain fixture command timed out');
    assert.equal(signal, null, 'Toolchain fixture command did not settle normally');
    if (success)
      assert.equal(
        code,
        0,
        [Buffer.concat(errors).toString(), ...fixtureErrors.map((error) => error.stack)].join('\n'),
      );
    else assert.notEqual(code, 0, 'Unsafe modifying command unexpectedly succeeded');
    return Buffer.concat(output).toString();
  } finally {
    clearTimeout(timer);
  }
}
try {
  const client = JSON.parse(await cli('kubectl', ['version', '--client', '-o', 'json']));
  assert.equal(client.clientVersion.gitVersion, 'v1.36.6+rivet.go1.27.3');
  assert.equal(client.clientVersion.goVersion, 'go1.27.3');
  const helm = await cli('helm', ['version', '--template', '{{.Version}}|{{.GoVersion}}']);
  assert.equal(helm.trim(), 'v3.22.1+rivet.go1.27.3|go1.27.3');
  const key = path.join(directory, 'key.pem'),
    cert = path.join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'pipe' },
  );
  const endpoint = '/api/v1/namespaces/fixture/configmaps/receipt';
  const receipt = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'receipt', namespace: 'fixture', uid: 'fixture-uid', resourceVersion: '7' },
    data: { value: 'before' },
  };
  let writes = 0,
    committed = 0,
    h2 = 0;
  server = http2.createSecureServer(
    { key: await fs.readFile(key), cert: await fs.readFile(cert), allowHTTP1: true },
    async (request, response) => {
      try {
        assert.equal(request.headers.authorization, 'Bearer fixture-only');
        const url = new URL(request.url, 'https://fixture.invalid');
        assert.equal(url.pathname, endpoint);
        assert.ok([...url.searchParams.keys()].every((name) => name === 'timeout'));
        if (request.httpVersionMajor === 2) h2++;
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET') return response.end(JSON.stringify(receipt));
        assert.equal(request.method, 'PUT');
        writes++;
        const chunks = [];
        for await (const b of request) chunks.push(b);
        const value = JSON.parse(Buffer.concat(chunks));
        if (
          value.metadata.uid !== receipt.metadata.uid ||
          value.metadata.resourceVersion !== receipt.metadata.resourceVersion
        ) {
          response.writeHead(409);
          return response.end(
            JSON.stringify({
              kind: 'Status',
              apiVersion: 'v1',
              status: 'Failure',
              reason: 'Conflict',
              code: 409,
              message: 'Stale exact fixture identity',
            }),
          );
        }
        receipt.metadata.resourceVersion = '8';
        receipt.data = value.data;
        committed++;
        // Commit then lose the acknowledgement. The client must not resend it.
        response.destroy();
      } catch (error) {
        fixtureErrors.push(error);
        response.destroy(error);
      }
    },
  );
  server.on('session', (session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const kubeconfig = path.join(directory, 'kubeconfig.json');
  await fs.writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'fixture',
          cluster: {
            server: `https://127.0.0.1:${server.address().port}`,
            'certificate-authority-data': (await fs.readFile(cert)).toString('base64'),
          },
        },
      ],
      users: [{ name: 'fixture', user: { token: 'fixture-only' } }],
      contexts: [{ name: 'fixture', context: { cluster: 'fixture', user: 'fixture' } }],
      'current-context': 'fixture',
    }),
  );
  const args = ['--kubeconfig', kubeconfig, '--request-timeout=5s'];
  assert.equal(
    JSON.parse(await cli('kubectl', [...args, 'get', '--raw', endpoint])).metadata.uid,
    receipt.metadata.uid,
  );
  const input = path.join(directory, 'replace.json');
  await fs.writeFile(input, JSON.stringify({ ...receipt, data: { value: 'after' } }));
  await cli('kubectl', [...args, 'replace', '--raw', endpoint, '-f', input], false);
  assert.equal(writes, 1, 'An uncertain modifying command was replayed');
  assert.equal(committed, 1);
  assert.equal(JSON.parse(await cli('kubectl', [...args, 'get', '--raw', endpoint])).data.value, 'after');
  await cli('kubectl', [...args, 'replace', '--raw', endpoint, '-f', input], false);
  assert.equal(writes, 2);
  assert.equal(committed, 1, 'Stale identity committed a second mutation');
  assert.ok(h2 >= 3, 'The actual patched HTTP2 path was not exercised');
  assert.deepEqual(fixtureErrors, []);
  console.log(
    'Final-image Helm/kubectl identity, trusted TLS/HTTP2, file-backed mutation, lost acknowledgement and stale identity passed.',
  );
} finally {
  if (server) {
    for (const session of sessions) session.destroy();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.rm(directory, { recursive: true, force: true });
}
