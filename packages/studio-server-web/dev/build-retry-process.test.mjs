import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// test-style: fixture-read: reads only its own temporary attempt trace, never implementation text.

const here = path.dirname(fileURLToPath(import.meta.url));
for (const mode of ['transient', 'css-transient', 'stat-transient', 'persistent', 'syntax'])
  test(`real compiler processes handle ${mode} failure without overlapping or replaying publication`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rivet-build-retry-'));
    const control = path.join(directory, 'control.json');
    const trace = path.join(directory, 'trace.ndjson');
    await writeFile(control, JSON.stringify({ mode }));
    await writeFile(trace, '');
    const child = fork(path.join(here, 'builder.mjs'), [], {
      execArgv: ['--import', pathToFileURL(path.join(here, 'fixtures/build-retry-preload.mjs')).href],
      env: {
        ...process.env,
        RIVET_DEV_BUNDLE_ROOT: directory,
        RIVET_BUILD_RETRY_CONTROL: control,
        RIVET_BUILD_RETRY_TRACE: trace,
        RIVET_BUILD_RETRY_SOURCE: path.resolve(here, '../../evaluations/src/assertions.ts'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exit = once(child, 'exit');
    const messages = [];
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr = (stderr + data.toString()).slice(-4_000);
    });
    let active;
    let overlap = false;
    let publications = 0;
    child.on('message', (message) => {
      messages.push(message);
      if (message.type === 'compiler-started') {
        overlap ||= active !== undefined;
        active = message.pid;
        child.send({ type: 'compiler-tracked', pid: message.pid });
      }
      if (message.type === 'compiler-stopped') {
        if (active !== message.pid) overlap = true;
        active = undefined;
      }
      if (message.type === 'publish-build') {
        publications++;
        child.send({
          type: 'publication-result',
          pid: message.pid,
          generation: '11111111-1111-4111-8111-111111111111',
          bytes: 1,
        });
      }
    });
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        assert.equal(child.exitCode, null, `watcher exited unexpectedly: ${stderr}`);
        assert.ok(Date.now() < deadline, `timed out: ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const attempts = () => messages.filter((message) => message.type === 'compiler-started').length;
    const failed = () => messages.filter((message) => message.phase === 'failed');
    try {
      if (['transient', 'css-transient', 'stat-transient'].includes(mode)) {
        await waitFor(() => messages.some((message) => message.phase === 'ready') && active === undefined);
        assert.equal(attempts(), 2);
        assert.deepEqual(
          failed().map((message) => message.retryAfterMs),
          [1_000],
        );
        assert.equal(publications, 1, 'failed attempts never publish');
      } else {
        const expected = mode === 'persistent' ? 3 : 1;
        await waitFor(() => failed().length === expected && active === undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(attempts(), expected, 'failed unchanged source must not loop forever');
        assert.equal(publications, 0);
        assert.deepEqual(
          failed().map((message) => message.retryAfterMs),
          mode === 'persistent' ? [1_000, 3_000, undefined] : [undefined],
        );
        if (mode === 'persistent') assert.match(failed().at(-1).error, /retries are exhausted/);
        await writeFile(control, JSON.stringify({ mode: 'success' }));
        child.send({ type: 'fixture-edit' });
        await waitFor(() => messages.some((message) => message.phase === 'ready') && active === undefined);
        assert.equal(attempts(), expected + 1, 'a real source edit can recover after failure');
        assert.equal(publications, 1);
      }
      assert.equal(overlap, false, 'retry must wait for the exact previous compiler to exit');
      assert.equal((await readFile(trace, 'utf8')).trim().split('\n').length, attempts());
    } finally {
      child.kill('SIGTERM');
      const deadline = setTimeout(() => child.kill('SIGKILL'), 3_000);
      await exit;
      clearTimeout(deadline);
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('rivet-build-retry-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
