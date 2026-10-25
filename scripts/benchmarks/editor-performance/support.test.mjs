import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  summarize,
  listenLocal,
  closeLocal,
  resourceSummary,
  navigationSummary,
  sourceIdentity,
  interruptOwnedCommand,
  findModuleAssetRequests,
  finalizeBenchmark,
} from './support.mjs';

test('interruption targets only the retained live command and its owned group/tree', () => {
  const calls = [];
  const child = { pid: 123, exitCode: null, signalCode: null };
  const signal = (...args) => calls.push(args);
  interruptOwnedCommand(child, { platform: 'linux', signal });
  assert.deepEqual(calls, [[-123, 'SIGTERM']]);
  const launch = (...args) => {
    calls.push(args);
    return { once() {} };
  };
  interruptOwnedCommand(child, { platform: 'win32', launch });
  assert.deepEqual(calls[1], ['taskkill.exe', ['/PID', '123', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]);
  interruptOwnedCommand({ ...child, exitCode: 0 }, { platform: 'win32', launch });
  interruptOwnedCommand({ ...child, signalCode: 'SIGTERM' }, { platform: 'linux', signal });
  assert.equal(calls.length, 2);
});

test('finalization settles every owned resource and preserves both primary and cleanup failures', async () => {
  const primary = new Error('output assertion failed');
  const exportFailure = new Error('disk full');
  const contextFailure = new Error('context already disconnected');
  const settled = [];
  await assert.rejects(
    finalizeBenchmark(
      [
        () => {
          throw exportFailure;
        },
        async () => {
          settled.push('context');
          throw contextFailure;
        },
        async () => {
          await Promise.resolve();
          settled.push('debugger');
        },
        () => {
          settled.push('http');
        },
      ],
      primary,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, exportFailure, contextFailure]);
      return true;
    },
  );
  assert.deepEqual(settled.sort(), ['context', 'debugger', 'http']);
  await finalizeBenchmark([
    () => {
      settled.push('successful');
    },
  ]);
  assert.equal(settled.at(-1), 'successful');
  await assert.rejects(
    finalizeBenchmark([
      () => {
        throw exportFailure;
      },
    ]),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [exportFailure]);
      return true;
    },
  );
});

test('startup module guard uses exact emitted assets and fails closed when attribution is missing', () => {
  const modulePath = '/node_modules/monaco-editor/';
  const chunks = [
    { fileName: 'assets/shared.js', modules: [{ id: '/repo/node_modules/monaco-editor/editor.js' }] },
    {
      fileName: 'assets/second-a-longer-hash.js',
      modules: [{ id: 'C:\\repo\\node_modules\\monaco-editor\\worker.js' }],
    },
    { fileName: 'assets/shared-helper.js', modules: [{ id: '/repo/helper.js' }] },
  ];
  const requests = [
    { url: '/assets/shared.js?retry=1' },
    { url: 'http://localhost/assets/second-a-longer-hash.js' },
    { url: '/assets/shared-helper.js' },
    { url: '/another/assets/shared.js' },
  ];
  assert.deepEqual(findModuleAssetRequests(chunks, modulePath, requests), requests.slice(0, 2));
  assert.deepEqual(findModuleAssetRequests(chunks, modulePath, requests.slice(2)), []);
  assert.throws(() => findModuleAssetRequests([], modulePath, requests), /No emitted module attribution/);
  assert.throws(() => findModuleAssetRequests(chunks, '/node_modules/missing/', []), /No emitted module attribution/);
});

test('samples retain cache state and use a genuine median without changing inputs', () => {
  const cold = [8, 2, 6, 4],
    warm = [0, 0];
  assert.deepEqual(summarize(cold), { samples: 4, min: 2, median: 5, max: 8 });
  assert.deepEqual(cold, [8, 2, 6, 4]);
  assert.equal(summarize(warm).median, 0);
  assert.equal(summarize([]), null);
  assert.throws(() => summarize([NaN]));
  assert.deepEqual(resourceSummary([{ decodedBodySize: 10, transferSize: 0 }]), {
    requests: 1,
    decodedBytes: 10,
    transferBytes: 0,
  });
});

test('whole navigation accounts for iframe and worker costs without double-counting unique modules', () => {
  const shared = { name: 'http://localhost/shared.js', decodedBodySize: 10, transferSize: 0 };
  assert.deepEqual(
    navigationSummary({
      frames: [{ entries: [shared] }, { entries: [shared] }],
      workers: [{ entries: [] }],
      servedAssets: [],
    }),
    {
      unique: { requests: 1, decodedBytes: 10, transferBytes: 0 },
      allFrames: { requests: 2, decodedBytes: 20, transferBytes: 0 },
      servedJsBytes: 0,
    },
  );
});

test('an occupied port fails without disturbing its owner and cleanup releases only the test server', async () => {
  const first = createServer((_, res) => res.end('owner')),
    second = createServer();
  try {
    const port = await listenLocal(first);
    await assert.rejects(listenLocal(second, port), { code: 'EADDRINUSE' });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'owner');
    await closeLocal(first);
    assert.equal(await listenLocal(second, port), port);
  } finally {
    await closeLocal(first);
    await closeLocal(second);
  }
});

test('source identity changes for tracked and untracked source but not ignored artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rivet-benchmark-'));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init']);
    await writeFile(path.join(root, '.gitignore'), 'ignored\n');
    await writeFile(path.join(root, 'source'), 'base');
    git(['add', '.']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const base = await sourceIdentity(root);
    assert.equal(base.dirty, false);
    await writeFile(path.join(root, 'ignored'), 'artifact');
    assert.deepEqual(await sourceIdentity(root), base);
    await writeFile(path.join(root, 'source'), 'changed');
    const changed = await sourceIdentity(root);
    assert.equal(changed.sha, base.sha);
    assert.notEqual(changed.diffDigest, base.diffDigest);
    await writeFile(path.join(root, 'new'), 'new source');
    assert.notEqual((await sourceIdentity(root)).diffDigest, changed.diffDigest);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('rivet-benchmark-'));
    await rm(root, { recursive: true, force: true });
  }
});
