import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** The deadline must live outside the program under test: a synchronous loop
 * can block an in-process watchdog. Never leave its disposable container behind. */
export function runRuntimeProbe(image, mounts, command, { timeoutMs = 30000, spawn = spawnSync } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  const name = `rivet-runtime-probe-${randomUUID()}`;
  let failure;
  try {
    const result = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--pull=never',
        '--network=none',
        '--read-only',
        '--user=10001:10001',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        ...mounts.flatMap((mount) => ['--mount', `type=bind,source=${mount.source},target=${mount.target},readonly`]),
        '--entrypoint',
        'node',
        image,
        ...command,
      ],
      { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'Packaged runtime probe failed');
  } catch (error) {
    failure = error;
  } finally {
    try {
      const removed = spawn('docker', ['rm', '--force', name], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 10000,
        killSignal: 'SIGKILL',
        windowsHide: true,
      });
      if (removed.error || (removed.status !== 0 && !/No such container:/i.test(removed.stderr ?? '')))
        throw new Error('Packaged runtime probe container cleanup is unconfirmed', { cause: removed.error });
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], 'Runtime probe failed and container cleanup is unconfirmed')
        : error;
    }
  }
  if (failure) throw failure;
}
