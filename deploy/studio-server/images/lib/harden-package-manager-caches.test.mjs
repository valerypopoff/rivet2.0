import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { cacheSecurityGuard, hardenCachePolicy } from './harden-package-manager-caches.mjs';

// test-style: fixture-read: installed third-party policy is copied into generated patch fixtures; no Rivet source inspection.
test('package-manager cache hardening fixes the actual policy and rejects unreviewed source', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-cache-hardening-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let consumer = createRequire(new URL('../../../../packages/docs/package.json', import.meta.url));
  consumer = createRequire(consumer.resolve('@docusaurus/core/package.json'));
  for (const module of ['update-notifier', 'latest-version', 'package-json', 'got', 'cacheable-request'])
    consumer = createRequire(consumer.resolve(module));
  const source = await fs.readFile(consumer.resolve('http-cache-semantics'), 'utf8');
  const file = path.join(root, 'cache-policy.cjs');
  await fs.writeFile(file, source.replace(cacheSecurityGuard, ''));
  const receipt = await hardenCachePolicy(file);
  assert.equal(receipt.vulnerability, 'CVE-2026-93748');
  assert.deepEqual(await hardenCachePolicy(file), receipt);
  await fs.appendFile(file, '\n// unreviewed source change\n');
  await assert.rejects(hardenCachePolicy(file), /Unknown cache-policy source/);
});
