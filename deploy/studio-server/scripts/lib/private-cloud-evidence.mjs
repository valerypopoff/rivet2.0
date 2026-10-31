import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

let cachedToken,
  tokenAt = 0;
export function deploymentGoogleToken() {
  if (!cachedToken || Date.now() - tokenAt > 240000) {
    try {
      cachedToken = execFileSync(process.env.RIVET_GCLOUD_BIN || 'gcloud', ['auth', 'print-access-token'], {
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
        timeout: 30000,
      }).trim();
      assert.ok(cachedToken);
      tokenAt = Date.now();
    } catch {
      throw Error('Cloud credentials are unavailable; no credential output was logged');
    }
  }
  return cachedToken;
}

/** Online recovery files must survive runner loss before workload mutation.
 * The deployment workflow awaits this artifact immediately before run(safety). */
export async function persistDeploymentArtifact(cloud, directory, name, contents) {
  if (name === 'deployment-result.json' && JSON.parse(contents).state === 'deploying')
    await cloud.saveDirectory(directory);
  await cloud.put(name, Buffer.from(contents));
}

/** Private immutable objects survive hosted-runner loss. A lock is exclusive;
 * evidence is content addressed and a lost upload acknowledgement is reconciled
 * by reading its exact checksum, never by overwriting another operation. */
export function privateCloudEvidence({
  bucket,
  prefix,
  token = deploymentGoogleToken,
  fetchImpl = fetch,
  origin = 'https://storage.googleapis.com',
}) {
  assert.match(bucket, /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/);
  assert.match(prefix, /^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/);
  const nameOf = (name) => {
    assert.ok(name && !name.includes('..') && !name.startsWith('/') && !name.includes('\\'));
    return `${prefix}/${name}`;
  };
  const request = (url, options) =>
    fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
      headers: { ...options.headers, authorization: `Bearer ${token()}` },
    });
  const objectUrl = (name) => `${origin}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
  const saved = new Set();
  async function upload(name, body, { md5, size, exclusive = false, stream = false } = {}) {
    const url = `${origin}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(name)}`;
    let response;
    try {
      response = await request(url, {
        method: 'POST',
        body,
        ...(stream ? { duplex: 'half' } : {}),
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      });
    } catch {
      if (exclusive)
        throw Error('Cloud admission acknowledgement is uncertain; inspect the exact lock before any retry');
    }
    if (response?.ok) {
      const result = await response.json();
      assert.equal(result.md5Hash, md5, 'Private evidence checksum differs');
      assert.equal(Number(result.size), size, 'Private evidence size differs');
      assert.match(result.generation, /^[1-9][0-9]*$/);
      return result.generation;
    }
    if (!exclusive && (!response || response.status === 412)) {
      const observed = await request(objectUrl(name), { method: 'GET' });
      assert.equal(observed.status, 200, 'Private evidence upload remains unconfirmed');
      const result = await observed.json();
      assert.equal(result.md5Hash, md5, 'An existing private evidence object has different bytes');
      assert.equal(Number(result.size), size);
      return result.generation;
    }
    throw Error(
      `Private cloud evidence/admission failed (HTTP ${response?.status ?? 'unknown'}); no overwrite attempted`,
    );
  }
  async function put(name, bytes, { exclusive = false } = {}) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    return upload(nameOf(exclusive ? name : `${name}/${hash}`), bytes, {
      md5: createHash('md5').update(bytes).digest('base64'),
      size: bytes.length,
      exclusive,
    });
  }
  return {
    put,
    acquire: (bytes) => put('active.lock', bytes, { exclusive: true }),
    async assertOwner(generation, bytes) {
      assert.match(String(generation), /^[1-9][0-9]*$/);
      const response = await request(objectUrl(nameOf('active.lock')), { method: 'GET' });
      assert.equal(response.status, 200, 'Private operation lock is missing');
      const result = await response.json();
      assert.equal(result.generation, String(generation), 'Private operation lock changed');
      assert.equal(
        result.md5Hash,
        createHash('md5').update(bytes).digest('base64'),
        'Private operation lock belongs to another run',
      );
    },
    async release(generation) {
      assert.match(String(generation), /^[1-9][0-9]*$/);
      const response = await request(`${objectUrl(nameOf('active.lock'))}?ifGenerationMatch=${generation}`, {
        method: 'DELETE',
      });
      assert.equal(response.status, 204, 'Cloud lock release is unconfirmed; inspect before another operation');
    },
    async saveDirectory(directory) {
      async function walk(relative = '') {
        for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
          assert.ok(!entry.isSymbolicLink(), 'Private evidence cannot redirect outside its directory');
          const name = path.posix.join(relative, entry.name),
            file = path.join(directory, name);
          if (entry.isDirectory()) {
            await walk(name);
            continue;
          }
          assert.ok(entry.isFile());
          const sha = createHash('sha256'),
            md5 = createHash('md5');
          let size = 0;
          for await (const part of createReadStream(file)) {
            sha.update(part);
            md5.update(part);
            size += part.length;
          }
          const objectName = nameOf(`${name}/${sha.digest('hex')}`);
          if (saved.has(objectName)) continue;
          const body = createReadStream(file);
          try {
            await upload(objectName, body, { md5: md5.digest('base64'), size, stream: true });
          } finally {
            body.destroy();
          }
          saved.add(objectName);
        }
      }
      await walk();
    },
  };
}
