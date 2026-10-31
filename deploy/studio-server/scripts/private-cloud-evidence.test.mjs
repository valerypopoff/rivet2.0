import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { privateCloudEvidence, persistDeploymentArtifact } from './lib/private-cloud-evidence.mjs';

async function fixture(t) {
  const objects = new Map(),
    requests = [];
  let generation = 0,
    loseNext = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-fixture-token');
    const url = new URL(req.url, 'http://localhost');
    const name =
      req.method === 'POST' ? url.searchParams.get('name') : decodeURIComponent(url.pathname.split('/o/')[1]);
    requests.push({ method: req.method, name });
    const current = objects.get(name);
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST') {
      assert.equal(url.searchParams.get('ifGenerationMatch'), '0');
      const parts = [];
      for await (const part of req) parts.push(part);
      if (current) return json(412, {});
      const bytes = Buffer.concat(parts),
        object = {
          generation: String(++generation),
          size: String(bytes.length),
          md5Hash: createHash('md5').update(bytes).digest('base64'),
        };
      objects.set(name, object);
      if (loseNext) {
        loseNext = false;
        res.destroy();
        return;
      }
      return json(200, object);
    }
    if (req.method === 'GET') return json(current ? 200 : 404, current ?? {});
    if (req.method === 'DELETE') {
      if (current?.generation !== url.searchParams.get('ifGenerationMatch')) return json(412, {});
      objects.delete(name);
      res.writeHead(204);
      return res.end();
    }
    return json(405, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const cloud = privateCloudEvidence({
    bucket: 'private-test-bucket',
    prefix: 'qualification',
    token: () => 'local-fixture-token',
    origin: `http://127.0.0.1:${server.address().port}`,
  });
  return {
    cloud,
    objects,
    requests,
    lose: () => {
      loseNext = true;
    },
  };
}

test('private uploads reconcile duplicate and lost acknowledgements without overwriting bytes', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.from('private journal receipt');
  const generation = await f.cloud.put('operation.json', bytes);
  assert.equal(await f.cloud.put('operation.json', bytes), generation);
  assert.equal(f.objects.size, 1);
  f.lose();
  const acknowledged = await f.cloud.put('next.json', bytes);
  assert.ok(acknowledged);
  assert.equal(f.objects.size, 2);
  const existing = [...f.objects.values()][0];
  existing.md5Hash = 'corrupt';
  await assert.rejects(f.cloud.put('operation.json', bytes), /different bytes/);
  assert.equal(existing.md5Hash, 'corrupt');
});

test('admission locks are exclusive, owner-bound and deleted only by their exact generation', async (t) => {
  const f = await fixture(t),
    owner = Buffer.from('first operation');
  const generation = await f.cloud.acquire(owner);
  await f.cloud.assertOwner(generation, owner);
  await assert.rejects(f.cloud.acquire(Buffer.from('second operation')), /no overwrite/);
  await assert.rejects(f.cloud.assertOwner(generation, Buffer.from('different operation')), /another run/);
  await assert.rejects(f.cloud.release(Number(generation) + 1), /unconfirmed/);
  assert.equal(f.objects.size, 1);
  await f.cloud.release(generation);
  assert.equal(f.objects.size, 0);
  f.lose();
  await assert.rejects(f.cloud.acquire(owner), /acknowledgement is uncertain/);
  assert.equal(f.objects.size, 1);
  assert.equal(f.requests.at(-1).method, 'POST', 'An uncertain lock is not silently adopted');
});

test('hosted-runner journal survives local file changes and never follows a link outside its directory', async (t) => {
  const f = await fixture(t),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'receipts'));
  const file = path.join(dir, 'receipts', 'phase.json');
  await fs.writeFile(file, 'first');
  await f.cloud.saveDirectory(dir);
  const calls = f.requests.length;
  await f.cloud.saveDirectory(dir);
  assert.equal(f.requests.length, calls);
  await fs.writeFile(file, 'second');
  await f.cloud.saveDirectory(dir);
  assert.equal(f.objects.size, 2);
  await fs.symlink(os.tmpdir(), path.join(dir, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.cloud.saveDirectory(dir), /redirect outside/);
});

test('all online recovery files are durable before the deployment admission marker is acknowledged', async (t) => {
  const f = await fixture(t),
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-checkpoint-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'backup'));
  await fs.writeFile(path.join(dir, 'backup', 'snapshot.bin'), Buffer.from('recovery payload'));
  const marker = JSON.stringify({ state: 'deploying' });
  await persistDeploymentArtifact(f.cloud, dir, 'deployment-result.json', marker);
  const writes = f.requests.filter((r) => r.method === 'POST');
  assert.ok(writes[0].name.startsWith('qualification/backup/snapshot.bin/'));
  assert.ok(writes.at(-1).name.startsWith('qualification/deployment-result.json/'));
  assert.equal(f.objects.size, 2);
});
