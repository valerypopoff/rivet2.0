import assert from 'node:assert/strict';
import test from 'node:test';
import { withLauncherProgress } from './lib/launcher-progress.mjs';
import { runArgsCapture, runCapture } from './lib/docker-launcher.mjs';
import { spawnProgram } from './dev-kubernetes.mjs';

for (const fails of [false, true]) {
  test(`startup progress reports elapsed time and clears its timer on ${fails ? 'failure' : 'success'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const lines = [];
    let now = 0;
    let finish;
    const failure = new Error('original failure');
    const pending = withLauncherProgress(
      'fixture',
      'Checking startup',
      () =>
        new Promise((resolve, reject) => {
          finish = fails ? () => reject(failure) : () => resolve('result');
        }),
      { log: (line) => lines.push(line), now: () => now },
    );
    assert.deepEqual(lines, ['[fixture] Checking startup…']);
    now = 10_000;
    t.mock.timers.tick(10_000);
    assert.equal(lines.at(-1), '[fixture] Checking startup: still running (10s elapsed).');
    finish();
    if (fails) await assert.rejects(pending, (error) => error === failure);
    else assert.equal(await pending, 'result');
    assert.equal(lines.at(-1), `[fixture] Checking startup: ${fails ? 'failed' : 'completed'} (10s).`);
    const count = lines.length;
    t.mock.timers.tick(30_000);
    assert.equal(lines.length, count, 'no heartbeat survives a settled phase');
  });
}

test('a synchronous startup failure preserves its error and clears the progress timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const lines = [];
  const error = new Error('synchronous failure');
  await assert.rejects(
    withLauncherProgress(
      'fixture',
      'Check',
      () => {
        throw error;
      },
      {
        log: (line) => lines.push(line),
        now: () => 0,
      },
    ),
    (received) => received === error,
  );
  t.mock.timers.tick(20_000);
  assert.deepEqual(lines, ['[fixture] Check…', '[fixture] Check: failed (0s).']);
});

test('captured image output is also streamed before the child completes, without losing digest data', async (t) => {
  const output = [];
  let complete = false;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, ...args) => {
      if (String(chunk).startsWith('LAUNCHER-')) output.push({ text: String(chunk), complete });
      return original(chunk, ...args);
    });
  }
  const result = await runArgsCapture(
    process.execPath,
    [
      '-e',
      'console.log("LAUNCHER-progress"); console.error("LAUNCHER-warning"); setTimeout(() => console.log("Digest: sha256:fixture"), 100);',
    ],
    process.env,
    { streamOutput: true },
  );
  complete = true;
  assert.ok(output.some((line) => line.text.includes('progress') && !line.complete));
  assert.ok(output.some((line) => line.text.includes('warning') && !line.complete));
  assert.match(result.stdout, /Digest: sha256:fixture/);
  assert.match(result.stderr, /LAUNCHER-warning/);
});

test('config and inspection capture remains silent unless explicitly opted into streaming', async (t) => {
  const writes = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    t.mock.method(stream, 'write', (chunk, ...args) => {
      if (String(chunk).includes('PRIVATE-CONFIG')) writes.push(chunk);
      return original(chunk, ...args);
    });
  }
  for (const runChild of [
    () => runArgsCapture(process.execPath, ['-e', 'console.log("PRIVATE-CONFIG")'], process.env),
    () => runCapture(`"${process.execPath}" -e "console.log('PRIVATE-CONFIG')"`, process.env),
  ]) {
    const result = await runChild();
    assert.match(result.stdout, /PRIVATE-CONFIG/);
  }
  assert.deepEqual(writes, []);
});

test('Kubernetes tool progress retains complete captured output before reporting completion', async () => {
  const result = await spawnProgram(
    process.execPath,
    [
      '-e',
      'process.stdout.write("x".repeat(512 * 1024) + "stdout-end"); process.stderr.write("y".repeat(256 * 1024) + "stderr-end");',
    ],
    { capture: true },
  );
  assert.equal(result.stdout, 'x'.repeat(512 * 1024) + 'stdout-end');
  assert.equal(result.stderr, 'y'.repeat(256 * 1024) + 'stderr-end');
});

test('Kubernetes tool failures preserve the nonzero status and captured diagnostics', async () => {
  await assert.rejects(
    spawnProgram(process.execPath, ['-e', 'console.error("tool-failure-evidence"); process.exitCode = 17'], {
      capture: true,
    }),
    /exit code 17:.*tool-failure-evidence/s,
  );
});
