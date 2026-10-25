import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const require = createRequire(import.meta.url);
assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(manifest.rivetSourceEntrypoints).sort());
assert.equal(manifest.src, manifest.rivetSourceEntrypoints['.']);
assert.equal(`./${manifest.main}`, manifest.exports['.'].node.require);
assert.equal(`./${manifest.module}`, manifest.exports['.'].node.import);
assert.equal(`./${manifest.types}`, manifest.exports['.'].node.types);
for (const condition of ['browser', 'default']) {
  assert.deepEqual(manifest.exports['.'][condition], manifest.exports['.'].node, `${condition} root API mapping`);
}
for (const [subpath, source] of Object.entries(manifest.rivetSourceEntrypoints)) {
  const entry = manifest.exports[subpath].node ?? manifest.exports[subpath];
  const stem = source.replace(/^src\//, '').replace(/\.ts$/, '');
  assert.equal(entry.import, `./dist/esm/${stem}.js`, `${subpath} ESM source mapping`);
  assert.equal(entry.types, `./dist/types/${stem}.d.ts`, `${subpath} declaration mapping`);
  const esm = await import(new URL(entry.import, root));
  const cjs = require(fileURLToPath(new URL(entry.require, root)));
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort(), `${subpath} ESM/CommonJS API parity`);
  if (subpath === '.') {
    for (const api of [esm, cjs]) {
      const result = await new api.IsomorphicCodeRunner().runCode(
        'return {output: {type:"any", value: [typeof Rivet.GraphProcessor, typeof Rivet.ExecutionRecorder, Rivet.coerceType({type:"number",value:42}, "string")]}}',
        {},
        {
          includeRivet: true,
          includeConsole: false,
          includeFetch: false,
          includeProcess: false,
          includeRequire: false,
        },
      );
      assert.deepEqual(result.output.value, ['function', 'function', '42']);
    }
  }
}
console.log('Core source/export mapping and built ESM/CommonJS execution APIs verified.');
