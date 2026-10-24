import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { describeBuildFailure, createBuildFailurePolicy } from './build-failure.mjs';

const workspace = path.resolve('fixture workspace');
const source = path.join(workspace, 'packages/evaluations/src/assertions.ts');
const eio = { code: 'PLUGIN_ERROR', pluginCode: 'EIO', syscall: 'open', hook: 'load', path: source };
const cssEio = {
  code: 'PLUGIN_ERROR',
  errno: -5,
  plugin: 'vite:css',
  pluginCode: '@import "./fixture.css";',
  syscall: 'open',
  hook: 'transform',
  path: path.join(workspace, 'packages/studio-server-web/dashboard/fixture.css'),
};

test('direct and Vite-wrapped source read EIO has bounded recovery and actionable exhaustion', () => {
  for (const error of [
    eio,
    { ...eio, code: 'EIO', pluginCode: undefined },
    { ...eio, syscall: 'read' },
    { ...eio, syscall: 'stat', hook: 'transform', plugin: 'vite:esbuild' },
    cssEio,
  ]) {
    const failure = describeBuildFailure(error, workspace);
    assert.equal(failure.failureKind, 'source-read');
    const policy = createBuildFailurePolicy();
    assert.equal(policy.failed(failure).retryAfterMs, 1_000);
    assert.equal(policy.failed(failure).retryAfterMs, 3_000);
    for (let i = 0; i < 3; i++) {
      const exhausted = policy.failed(failure);
      assert.equal(exhausted.retryAfterMs, undefined);
      assert.match(exhausted.error, /exhausted.*Docker Desktop/);
    }
    policy.reset();
    assert.equal(policy.failed(failure).retryAfterMs, 1_000, 'a real edit/success resets the budget');
  }
});

test('syntax, missing files, permissions, output IO and unrelated errors do not become retryable source reads', () => {
  for (const error of [
    new Error('EIO is only text'),
    null,
    'invalid throw',
    { ...eio, code: 'PARSE_ERROR', pluginCode: undefined },
    { ...eio, pluginCode: 'ENOENT' },
    { ...eio, pluginCode: 'EACCES' },
    { ...eio, syscall: 'write' },
    { ...eio, hook: 'writeBundle' },
    { ...eio, hook: undefined },
    { ...eio, code: 'EACCES' },
    { ...eio, path: undefined },
    { ...cssEio, errno: -13 },
    { ...cssEio, errno: undefined },
    { ...cssEio, plugin: 'unknown-plugin' },
    { ...cssEio, syscall: 'write' },
    { ...cssEio, hook: 'writeBundle' },
    ...[
      '../outside.ts',
      'packages-other/evaluations/src/file.ts',
      'packages/app/src-other/file.ts',
      'packages/app/src/node_modules/file.ts',
      'packages/studio-server-web/dist/file.js',
      'packages/studio-server-web/tests/test.ts',
      'packages/evaluations/dist/assertions.js',
    ].map((file) => ({ ...eio, path: path.resolve(workspace, file) })),
  ]) {
    const failure = describeBuildFailure(error, workspace);
    assert.equal(failure.failureKind, undefined, JSON.stringify(error));
    assert.equal(createBuildFailurePolicy().failed(failure).retryAfterMs, undefined);
  }
});

test('cache-busy policy is preserved and deterministic errors do not acquire an exhausted IO retry', () => {
  const policy = createBuildFailurePolicy();
  const cache = describeBuildFailure(
    { code: 'RIVET_DEV_CACHE_BUSY', message: 'Tunnel bundle cache is full' },
    workspace,
  );
  assert.equal(policy.failed(cache), cache);
  assert.equal(cache.retryAfterMs, 300_000);
  assert.equal(cache.error, 'Tunnel bundle cache is full');
  policy.failed(describeBuildFailure(eio, workspace));
  const syntax = describeBuildFailure(new SyntaxError('bad source'), workspace);
  assert.equal(policy.failed(syntax).retryAfterMs, undefined);
  assert.equal(policy.failed(describeBuildFailure(eio, workspace)).retryAfterMs, 3_000);
});
