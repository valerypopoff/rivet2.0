import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Run inside the final API/executor image, non-root, with only temporary scratch.
const require = createRequire('/app/package.json');
assert.equal(process.versions.node, '24.22.1');
const esbuild = require('esbuild');
assert.equal(esbuild.version, '0.25.12');
const cli = require.resolve('esbuild/bin/esbuild');
const executable = await fs.readFile(cli);
assert.equal(executable.subarray(0, 4).toString('hex'), '7f454c46', 'esbuild CLI must be a Linux executable');
assert.equal(
  executable.readUInt16LE(18),
  { x64: 62, arm64: 183 }[process.arch],
  'esbuild CLI architecture differs from Node',
);
assert.equal(execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), esbuild.version);
const transformed = esbuild.transformSync('const value: number = 42; value', { loader: 'ts' });
assert.equal(Function(`${transformed.code}; return value`)(), 42);
const bundle = await esbuild.build({
  stdin: { contents: 'import value from "fixture:answer"; export default value;', resolveDir: '/tmp' },
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'fixture',
      setup(build) {
        build.onResolve({ filter: /^fixture:/ }, () => ({ path: 'answer', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default 42' }));
      },
    },
  ],
});
assert.equal(
  (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)).default,
  42,
);

const autoevals = createRequire(require.resolve('autoevals'));
const converter = createRequire(autoevals.resolve('zod-to-json-schema'));
const { z } = converter('zod/v3');
const schema = autoevals('zod-to-json-schema').zodToJsonSchema(z.object({ value: z.string() }));
assert.equal(schema.properties.value.type, 'string');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-package-manager-smoke-'));
try {
  const fixture = path.join(directory, 'fixture');
  await fs.mkdir(fixture);
  await fs.writeFile(
    path.join(fixture, 'package.json'),
    JSON.stringify({ name: 'rivet-security-fixture', version: '1.0.0', main: 'index.cjs' }),
  );
  await fs.writeFile(path.join(fixture, 'index.cjs'), 'module.exports = 42;');
  const managers = process.argv.slice(2);
  assert.ok(managers.length);
  for (const manager of managers) {
    assert.ok(['npm', 'pnpm'].includes(manager));
    const project = path.join(directory, manager);
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'package.json'), '{"private":true}');
    const args =
      manager === 'npm'
        ? ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--package-lock=false', fixture]
        : ['add', '--offline', '--ignore-scripts', '--store-dir', path.join(directory, 'store'), fixture];
    execFileSync(manager, args, {
      cwd: project,
      env: { ...process.env, HOME: directory },
      timeout: 30_000,
      stdio: 'pipe',
    });
    assert.equal(createRequire(path.join(project, 'package.json'))('rivet-security-fixture'), 42);
  }
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('Final-image esbuild transform/plugin bundle, Zod converter and offline package installation passed.');
