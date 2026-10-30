import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { temporaryHash } from './temporary-staging-contract.mjs';

export async function stagingRegistryConfig(plan, file, images) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 65536);
  const bytes = await fs.readFile(file);
  assert.equal(temporaryHash(bytes), plan.registrySecretSha256);
  const config = JSON.parse(bytes);
  assert.deepEqual(Object.keys(config), ['auths']);
  const hosts = new Set(
    images.map((image) => {
      const parts = image.split('/');
      return parts.length > 1 && parts[0].includes('.') ? parts[0] : 'docker.io';
    }),
  );
  assert.ok(Object.keys(config.auths).length > 0);
  for (const [host, credentials] of Object.entries(config.auths)) {
    assert.ok(hosts.has(host), 'Unrelated registry credentials are forbidden');
    assert.deepEqual(
      Object.keys(credentials),
      ['auth'],
      'Only explicit, reviewed pull credentials are supported; no credential helpers',
    );
    const value = Buffer.from(credentials.auth, 'base64').toString('utf8'),
      colon = value.indexOf(':');
    assert.ok(colon > 0 && colon < value.length - 1);
    const password = value.slice(colon + 1);
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GH_ENTERPRISE_TOKEN',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    ])
      if (process.env[key])
        assert.notEqual(password, process.env[key], 'Do not forward an Actions/control token into GKE');
  }
  return bytes;
}
export async function verifyPrivateStagingImages(bytes, images, exec) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-pull-preflight-'));
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(path.join(directory, 'config.json'), bytes, { flag: 'wx', mode: 0o600 });
    for (const image of images)
      await exec('docker', ['--config', directory, 'manifest', 'inspect', image], {
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
      });
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rivet-pull-preflight-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Never copy Actions tokens or broad registry credentials into test Pods. */
export async function verifyAnonymousStagingImage(reference, { fetchImpl = fetch } = {}) {
  const [image, digest] = reference.split('@');
  assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/);
  const parts = image.split('/');
  let registry = parts.length > 1 && parts[0].includes('.') ? parts.shift() : 'docker.io';
  if (registry === 'docker.io') registry = 'registry-1.docker.io';
  assert.ok(['ghcr.io', 'registry-1.docker.io', 'quay.io'].includes(registry), 'Unsupported anonymous image registry');
  if (registry === 'registry-1.docker.io' && parts.length === 1) parts.unshift('library');
  const repository = parts.join('/').replace(/:[a-zA-Z0-9_.-]+$/, '');
  assert.match(repository, /^[a-z0-9._/-]+$/);
  const endpoint = `https://${registry}/v2/${repository}/manifests/${digest}`;
  const options = {
    method: 'HEAD',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      accept:
        'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json',
    },
  };
  let response = await fetchImpl(endpoint, options);
  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate');
    assert.match(challenge ?? '', /^Bearer /i);
    const fields = Object.fromEntries([...challenge.matchAll(/([a-z]+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const auth = new URL(fields.realm);
    assert.ok(['https://ghcr.io', 'https://auth.docker.io', 'https://quay.io'].includes(auth.origin));
    assert.ok(!auth.username && !auth.password);
    auth.searchParams.set('service', fields.service);
    auth.searchParams.set('scope', `repository:${repository}:pull`);
    const tokenResponse = await fetchImpl(auth, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(tokenResponse.status, 200, 'Image is not anonymously pullable');
    const text = await tokenResponse.text();
    assert.ok(text.length < 65536);
    const value = JSON.parse(text),
      token = value.token ?? value.access_token;
    assert.ok(typeof token === 'string' && token.length < 32768);
    response = await fetchImpl(endpoint, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });
  }
  assert.equal(response.status, 200, 'Required image is private/unavailable; stop before billable setup');
  assert.equal(response.headers.get('docker-content-digest'), digest, 'Registry image identity changed');
}
