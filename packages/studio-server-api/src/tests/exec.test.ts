import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';

import {
  buildChildProcessEnv,
  resolveSpawnInvocation,
  stripProxyBootstrapNodeOptions,
  terminateChildProcess,
} from '../utils/exec.js';

test(
  'Windows termination closes the pipes held by an owned child descendant',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async () => {
    const descendant = 'setInterval(() => {}, 1000);';
    const script = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
    child.once('spawn', () => console.log('ready'));
    setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once('data', () => resolve());
        child.once('error', reject);
      });
      terminateChildProcess(child, 'SIGTERM');
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Descendant retained the output pipes after cancellation')),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      terminateChildProcess(child, 'SIGKILL');
      // A restricted test host can deny process-tree termination. Report the
      // failure without allowing inherited pipes to hang the entire test run.
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.unref();
    }
  },
);

test('resolveSpawnInvocation keeps normal programs unchanged on non-Windows platforms', () => {
  assert.deepEqual(resolveSpawnInvocation('npm', ['--version'], 'linux'), {
    program: 'npm',
    args: ['--version'],
  });
  assert.deepEqual(resolveSpawnInvocation('python', ['--version'], 'linux'), {
    program: 'python',
    args: ['--version'],
  });
});

test('resolveSpawnInvocation wraps known CLI shims through cmd.exe on Windows', () => {
  assert.deepEqual(resolveSpawnInvocation('npm', ['install'], 'win32', 'cmd.exe'), {
    program: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm', 'install'],
  });
  assert.deepEqual(resolveSpawnInvocation('pnpm', ['install'], 'win32', 'cmd.exe'), {
    program: 'cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm', 'install'],
  });
  assert.deepEqual(resolveSpawnInvocation('corepack', ['pnpm', '--version'], 'win32', 'cmd.exe'), {
    program: 'cmd.exe',
    args: ['/d', '/s', '/c', 'corepack', 'pnpm', '--version'],
  });
});

test('resolveSpawnInvocation preserves direct executables and still wraps explicit batch shims on Windows', () => {
  assert.deepEqual(resolveSpawnInvocation('npm.cmd', ['install'], 'win32', 'cmd.exe'), {
    program: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd', 'install'],
  });
  assert.deepEqual(resolveSpawnInvocation('node.exe', ['--version'], 'win32', 'cmd.exe'), {
    program: 'node.exe',
    args: ['--version'],
  });
  assert.deepEqual(resolveSpawnInvocation('python', ['--version'], 'win32', 'cmd.exe'), {
    program: 'python',
    args: ['--version'],
  });
});

test('stripProxyBootstrapNodeOptions removes the injected bootstrap import and preserves other options', () => {
  assert.equal(
    stripProxyBootstrapNodeOptions(
      ' --max-old-space-size=2048 --import=/opt/proxy-bootstrap/bootstrap.mjs --trace-warnings ',
    ),
    '--max-old-space-size=2048 --trace-warnings',
  );
  assert.equal(stripProxyBootstrapNodeOptions('--import file:///opt/proxy-bootstrap/bootstrap.mjs'), undefined);
});

test('buildChildProcessEnv removes proxy bootstrap NODE_OPTIONS while preserving other environment variables', () => {
  const env = buildChildProcessEnv({
    NODE_OPTIONS: '--import=/opt/proxy-bootstrap/bootstrap.mjs --trace-warnings',
    FOO: 'bar',
  });

  assert.equal(env.NODE_OPTIONS, '--trace-warnings');
  assert.equal(env.FOO, 'bar');
});
