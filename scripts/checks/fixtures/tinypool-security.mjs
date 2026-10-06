import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const docsRequire = createRequire(new URL('../../../packages/docs/package.json', import.meta.url));
const docusaurusRequire = createRequire(docsRequire.resolve('@docusaurus/core/package.json'));
const { Tinypool } = docusaurusRequire('tinypool');
const vector = process.argv[2];
assert.ok(['env', 'execArgv', 'filename'].includes(vector));

const inherited = {
  env: { ...process.env, RIVET_WORKER_SECURITY_FIXTURE: 'inherited' },
  // Harmless invalid options/paths fail the old implementation without ever
  // executing an attacker-controlled command or module.
  execArgv: ['--rivet-invalid-security-fixture'],
  filename: fileURLToPath(new URL('./missing-worker.mjs', import.meta.url)),
};
const original = Object.getOwnPropertyDescriptor(Object.prototype, vector);
process.env.RIVET_WORKER_SECURITY_FIXTURE = 'parent';
let pool;
try {
  Object.defineProperty(Object.prototype, vector, { value: inherited[vector], configurable: true, writable: true });
  pool = new Tinypool({
    filename: fileURLToPath(new URL('./tinypool-worker.mjs', import.meta.url)),
    minThreads: 1,
    maxThreads: 1,
  });
  const expected = { doubled: 42, environment: 'parent' };
  assert.deepEqual(await pool.run(21, { signal: new AbortController().signal }), expected);
  // An explicit own option still works, and the pool remains reusable.
  assert.deepEqual(
    await pool.run(21, {
      filename: fileURLToPath(new URL('./tinypool-worker.mjs', import.meta.url)),
    }),
    expected,
  );
} finally {
  if (original) Object.defineProperty(Object.prototype, vector, original);
  else delete Object.prototype[vector];
  await pool?.destroy();
}
