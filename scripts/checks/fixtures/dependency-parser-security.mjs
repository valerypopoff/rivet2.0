import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const docsRequire = createRequire(new URL('../../../packages/docs/package.json', import.meta.url));
const coreRequire = createRequire(docsRequire.resolve('@docusaurus/core/package.json'));
const vector = process.argv[2];
assert.ok(['braces', 'http-cache', 'image-size'].includes(vector));

if (vector === 'braces') {
  const consumers = [createRequire(coreRequire.resolve('chokidar'))];
  for (const workspace of ['app-executor', 'studio-server-executor']) {
    let workspaceRequire = createRequire(new URL(`../../../packages/${workspace}/package.json`, import.meta.url));
    if (workspace === 'studio-server-executor') {
      workspaceRequire = createRequire(workspaceRequire.resolve('@valerypopoff/rivet-app-executor/package.json'));
    }
    const copyRequire = createRequire(workspaceRequire.resolve('esbuild-plugin-copy'));
    consumers.push(createRequire(copyRequire.resolve('chokidar')));
  }
  for (const consumer of consumers) {
    const braces = consumer('braces');
    for (const kind of ['{', '(']) {
      const closing = kind === '{' ? '}' : ')';
      for (const pattern of [kind.repeat(4000) + 'a,b' + closing.repeat(4000), kind.repeat(4000)]) {
        for (const method of ['parse', 'compile', 'expand', 'stringify']) {
          assert.throws(() => braces[method](pattern), { name: 'SyntaxError', message: /maximum nesting depth/ });
        }
      }
    }
    // Public methods also accept ASTs, bypassing the parser guard.
    const ast = { type: 'root', nodes: [] };
    let parent = ast;
    for (let depth = 0; depth < 1000; depth++) {
      const child = { type: 'brace', nodes: [], parent };
      parent.nodes.push(child);
      parent = child;
    }
    parent.nodes.push({ type: 'text', value: 'a' });
    for (const method of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[method](ast), { name: 'SyntaxError', message: /maximum nesting depth/ });
    }
    assert.deepEqual(braces.expand('src/{app,core}/{a,b}.ts'), [
      'src/app/a.ts',
      'src/app/b.ts',
      'src/core/a.ts',
      'src/core/b.ts',
    ]);
    assert.equal(braces.compile('src/{a,b}.ts'), 'src/(a|b).ts');
    assert.equal(braces.stringify(braces.parse('src/{a,b}.ts')), 'src/{a,b}.ts');
    assert.deepEqual(braces.expand('a'.repeat(9000)), ['a'.repeat(9000)]);
    assert.deepEqual(braces.expand('\\{literal\\}'), ['{literal}']);
    assert.deepEqual(braces.expand('{'.repeat(64) + 'a' + '}'.repeat(64)), ['{'.repeat(64) + 'a' + '}'.repeat(64)]);
  }
}

if (vector === 'http-cache') {
  let consumer = coreRequire;
  for (const module of ['update-notifier', 'latest-version', 'package-json', 'got', 'cacheable-request']) {
    consumer = createRequire(consumer.resolve(module));
  }
  const CachePolicy = consumer('http-cache-semantics');
  const request = { url: 'https://registry.npmjs.org/example', method: 'GET', headers: { host: 'registry.npmjs.org' } };
  for (const headers of [
    { 'set-cookie': 'session=private', 'cache-control': 'max-age=60' },
    { 'cache-control': 'proxy-revalidate, max-age=60' },
    { 'cache-control': 'private, max-age=60' },
    { 'cache-control': 'no-store, max-age=60' },
    { 'cache-control': 'no-cache, max-age=60, stale-while-revalidate=9999' },
    { vary: '*', 'cache-control': 'max-age=60' },
  ]) {
    const original = new CachePolicy(request, { status: 200, headers });
    for (const policy of [original, CachePolicy.fromObject(original.toObject())]) {
      assert.equal(policy.maxAge(), 0);
      for (const directive of ['max-stale=99999', 'max-stale', '']) {
        const incoming = { ...request, headers: { ...request.headers, 'cache-control': directive } };
        assert.equal(policy.satisfiesWithoutRevalidation(incoming), false);
        const result = policy.evaluateRequest(incoming);
        assert.equal(result.response, undefined);
        assert.equal(result.revalidation.synchronous, true);
      }
    }
  }
  const publicPolicy = new CachePolicy(request, { status: 200, headers: { 'cache-control': 'public, max-age=60' } });
  assert.equal(publicPolicy.satisfiesWithoutRevalidation(request), true);
  publicPolicy.age = () => 120;
  assert.equal(publicPolicy.satisfiesWithoutRevalidation(request), false);
  assert.equal(
    publicPolicy.satisfiesWithoutRevalidation({
      ...request,
      headers: { ...request.headers, 'cache-control': 'max-stale=99999' },
    }),
    true,
  );
  const privatePolicy = new CachePolicy(
    request,
    { status: 200, headers: { 'set-cookie': 'session=private', 'cache-control': 'max-age=60' } },
    { shared: false },
  );
  assert.equal(privatePolicy.satisfiesWithoutRevalidation(request), true);
}

if (vector === 'image-size') {
  const mdxRequire = createRequire(coreRequire.resolve('@docusaurus/mdx-loader'));
  const { imageSize } = mdxRequire('image-size');
  const { imageSizeFromFile } = mdxRequire('image-size/fromFile');
  // Zero-length ICNS chunks previously prevented forward progress forever.
  const icns = Buffer.alloc(16);
  icns.write('icns');
  icns.writeUInt32BE(16, 4);
  icns.write('icp4', 8);
  assert.throws(() => imageSize(icns), /Invalid ICNS/);
  // Zero-sized ISO boxes previously hung the JXL/HEIF box search.
  for (const type of ['JXL ', 'ftyp']) {
    const input = Buffer.alloc(32);
    input.write(type, 4);
    assert.throws(() => imageSize(input));
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1EAAAAASUVORK5CYII=',
    'base64',
  );
  assert.deepEqual(imageSize(png), { height: 1, width: 1, type: 'png' });
  const directory = await mkdtemp(join(tmpdir(), 'rivet-image-security-'));
  try {
    const file = join(directory, 'pixel.png');
    await writeFile(file, png);
    assert.deepEqual(await imageSizeFromFile(file), { height: 1, width: 1, type: 'png' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
