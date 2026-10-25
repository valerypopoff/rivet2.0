import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const originalHash = 'ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca';
const fixedHash = 'dfa4a879ecdae2073aace2beeb996bd022abe582edd74cd9ff8f2c55327d8f6b';
export const cacheSecurityGuard = `
        // A security-zeroed entry must not be revived by max-stale or SWR.
        // Conservatively revalidate every zero-lifetime entry.
        if (this.maxAge() === 0) {
            return this._evaluateRequestMissResult(req);
        }
`;
const hash = (source) => createHash('sha256').update(source).digest('hex');

export async function hardenCachePolicy(file) {
  const source = await fs.readFile(file, 'utf8');
  const before = hash(source);
  assert.ok([originalHash, fixedHash].includes(before), 'Unknown cache-policy source: review before patching');
  if (before !== fixedHash) {
    const anchor = '    evaluateRequest(req) {\n        this._assertRequestHasHeaders(req);\n';
    const fixed = source.replace(anchor, anchor + cacheSecurityGuard);
    assert.equal(hash(fixed), fixedHash, 'Cache-policy patch did not produce the reviewed bytes');
    await fs.writeFile(file, fixed);
  }
  const require = createRequire(file);
  delete require.cache[require.resolve(file)];
  const CachePolicy = require(file);
  const request = { url: 'https://cache-security.invalid/', method: 'GET', headers: {} };
  for (const headers of [
    { 'set-cookie': 'fixture=private', 'cache-control': 'max-age=60' },
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store, max-age=60' },
    { 'cache-control': 'no-cache, max-age=60, stale-while-revalidate=9999' },
    { 'cache-control': 'proxy-revalidate, max-age=60' },
  ]) {
    const original = new CachePolicy(request, { status: 200, headers });
    for (const policy of [original, CachePolicy.fromObject(original.toObject())]) {
      assert.equal(policy.maxAge(), 0);
      for (const directive of ['max-stale=999999', 'max-stale', '']) {
        const incoming = { ...request, headers: { 'cache-control': directive } };
        assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
        assert.equal(policy.evaluateRequest(incoming).revalidation.synchronous, true);
      }
    }
  }
  const publicPolicy = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=60' } });
  assert.equal(publicPolicy.satisfiesWithoutRevalidation(request), true);
  publicPolicy.age = () => 120;
  assert.equal(
    publicPolicy.satisfiesWithoutRevalidation({ ...request, headers: { 'cache-control': 'max-stale=9999' } }),
    true,
  );
  return { file, vulnerability: 'CVE-2026-93748', originalSha256: originalHash, patchedSha256: fixedHash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const receipts = [];
  for (const manager of process.argv.slice(2)) {
    assert.ok(['npm', 'pnpm'].includes(manager));
    const file = `/usr/local/lib/node_modules/${manager}/${manager === 'pnpm' ? 'dist/' : ''}node_modules/http-cache-semantics/index.js`;
    receipts.push(await hardenCachePolicy(file));
  }
  assert.ok(receipts.length, 'Select at least one installed package manager');
  await fs.writeFile('/opt/rivet/cache-security-patches.json', JSON.stringify(receipts, null, 2) + '\n');
}
