import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { runDeploymentAdapterPreflight } from './lib/deployment-adapter-preflight.mjs';
// test-style: fixture-read: Inspect only generated private prerequisite fixtures and receipts.
const hash = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-readiness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'artifacts');
  await fs.mkdir(directory);
  const dependencies = [];
  for (const name of ['probe.mjs', 'config.json']) {
    await fs.writeFile(path.join(root, name), 'synthetic reviewed fixture');
    dependencies.push({ path: name, sha256: hash('synthetic reviewed fixture') });
  }
  const installation = {
    release: 'rivet',
    namespace: 'rivet',
    context: 'fixture-context',
    namespaceUid: 'namespace-uid',
    installedManifestDigest: hash('installed'),
  };
  const requirements = {
    installation,
    dependencies,
    capacity: { databaseBytes: 100, objectDeltaBytes: 200, copies: 4, reserveBytes: 100 },
    tools: {
      helm: path.join(root, 'helm'),
      kubectl: path.join(root, 'kubectl'),
      cloudSqlProxy: path.join(root, 'proxy'),
      postgresImageId: hash('image'),
    },
    probeScript: 'probe.mjs',
    probeConfiguration: 'config.json',
  };
  const request = {
    formatVersion: 1,
    stage: 'preflight',
    requestId: 'request',
    operationId: 'operation',
    startedAt: new Date().toISOString(),
    ...installation,
    candidateManifestDigest: hash('candidate'),
    valuesDigest: hash('values'),
    operationPlanDigest: hash('policy'),
  };
  const calls = [];
  const options = {
    statfs: async () => ({ bavail: 100000n, bsize: 1n }),
    command: async (executable, args) => {
      calls.push({ executable, args });
      return {
        stdout:
          executable === 'docker'
            ? requirements.tools.postgresImageId
            : executable === process.execPath
              ? JSON.stringify({
                  localOnly: true,
                  imports: true,
                  esbuild: true,
                  browser: true,
                  uiRunner: true,
                  keyProtection: true,
                })
              : 'local version',
      };
    },
  };
  return { root, requirements, request, receiptPath: path.join(directory, 'receipt.json'), options, calls };
}
test('local adapter preflight verifies bounded storage, scratch readback and fixed non-cluster commands', async (t) => {
  const f = await fixture(t);
  const result = await runDeploymentAdapterPreflight(f, f.options);
  assert.equal(result.localOnly, true);
  assert.equal(result.requiredBytes, '1300');
  const receipt = JSON.parse(await fs.readFile(f.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'rivet-deployment-preflight');
  assert.equal(receipt.requestId, 'request');
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls.find((c) => c.executable === f.requirements.tools.kubectl).args, [
    'version',
    '--client=true',
    '--output=json',
  ]);
  assert.deepEqual(f.calls.find((c) => c.executable === 'docker').args, [
    'image',
    'inspect',
    hash('image'),
    '--format',
    '{{.Id}}',
  ]);
  assert.equal(
    f.calls.some((c) => c.args.some((a) => ['pull', 'apply', 'get', 'restore', 'run'].includes(a))),
    false,
  );
  const files = await fs.readdir(path.dirname(f.receiptPath));
  assert.equal(
    files.some((file) => file.startsWith('.readiness-')),
    false,
  );
});
test('changed identities, dependencies and insufficient capacity fail before any local child starts', async (t) => {
  for (const flaw of ['stage', 'installation', 'dependency', 'capacity', 'unbound-probe']) {
    const f = await fixture(t);
    if (flaw === 'stage') f.request.stage = 'backup';
    if (flaw === 'installation') f.request.namespaceUid = 'different';
    if (flaw === 'dependency') await fs.writeFile(path.join(f.root, 'probe.mjs'), 'changed');
    if (flaw === 'capacity') f.options.statfs = async () => ({ bavail: 1300n, bsize: 1n });
    if (flaw === 'unbound-probe') f.requirements.dependencies = f.requirements.dependencies.slice(1);
    await assert.rejects(
      runDeploymentAdapterPreflight(f, f.options),
      /request identity|dependency changed|headroom|probe files must be/,
    );
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.receiptPath), { code: 'ENOENT' });
  }
});
test('wrong cached image, missing import evidence or failed executable cannot produce a successful receipt', async (t) => {
  for (const flaw of ['image', 'imports', 'tool']) {
    const f = await fixture(t),
      original = f.options.command;
    f.options.command = async (executable, args) => {
      if (flaw === 'image' && executable === 'docker') return { stdout: hash('replacement') };
      if (flaw === 'imports' && executable === process.execPath)
        return { stdout: JSON.stringify({ localOnly: true, imports: true }) };
      if (flaw === 'tool') throw Error('synthetic missing tool');
      return original(executable, args);
    };
    await assert.rejects(
      runDeploymentAdapterPreflight(f, f.options),
      /image identity changed|required prerequisite|Local prerequisite/,
    );
    await assert.rejects(fs.stat(f.receiptPath), { code: 'ENOENT' });
  }
});
