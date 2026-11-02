import assert from 'node:assert/strict';
import test from 'node:test';
import { runRuntimeProbe } from './run-runtime-probe.mjs';

test('isolated probe and cleanup have separate host deadlines and one owned container identity', () => {
  const calls = [];
  runRuntimeProbe('fixture:local', [{ source: '/fixture.mjs', target: '/probe.mjs' }], ['/probe.mjs'], {
    spawn(program, args, options) {
      calls.push({ program, args, options });
      return args[0] === 'run'
        ? { status: 0 }
        : { status: 1, stderr: 'Error response from daemon: No such container: already-removed' };
    },
  });
  const [probe, cleanup] = calls;
  assert.equal(calls.length, 2);
  assert.equal(probe.program, 'docker');
  const name = probe.args[probe.args.indexOf('--name') + 1];
  assert.match(name, /^rivet-runtime-probe-[a-f0-9-]{36}$/);
  assert.deepEqual(cleanup.args, ['rm', '--force', name]);
  assert.equal(probe.options.timeout, 30000);
  assert.equal(cleanup.options.timeout, 10000);
  assert.equal(probe.options.killSignal, 'SIGKILL');
  for (const flag of ['--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL'])
    assert.ok(probe.args.includes(flag));
});

test('failed, timed out or unlaunchable probes still remove their own container', async (t) => {
  for (const mode of ['exit', 'timeout', 'throw'])
    await t.test(mode, () => {
      let removed = false;
      const primary = Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' });
      assert.throws(
        () =>
          runRuntimeProbe('fixture:local', [], ['-e', 'while(true){}'], {
            spawn(_program, args) {
              if (args[0] === 'rm') {
                removed = true;
                return { status: 0 };
              }
              if (mode === 'throw') throw primary;
              return mode === 'timeout' ? { status: null, error: primary } : { status: 7 };
            },
          }),
        mode === 'exit' ? /probe failed/ : (error) => error === primary,
      );
      assert.equal(removed, true);
    });
});

test('cleanup failure cannot become a passing probe or replace its primary failure', () => {
  for (const failedProbe of [false, true]) {
    const primary = new Error('fixture probe failure');
    assert.throws(
      () =>
        runRuntimeProbe('fixture:local', [], [], {
          spawn(_program, args) {
            if (args[0] === 'rm') return { status: 1, stderr: 'permission denied' };
            return failedProbe ? { error: primary, status: null } : { status: 0 };
          },
        }),
      (error) =>
        failedProbe
          ? error instanceof AggregateError && error.errors[0] === primary
          : /cleanup is unconfirmed/.test(error.message),
    );
  }
  let launched = false;
  assert.throws(() =>
    runRuntimeProbe('fixture:local', [], [], {
      timeoutMs: 0,
      spawn: () => {
        launched = true;
      },
    }),
  );
  assert.equal(launched, false);
  const cleanupError = new Error('fixture cleanup could not launch');
  assert.throws(
    () =>
      runRuntimeProbe('fixture:local', [], [], {
        spawn(_program, args) {
          if (args[0] === 'rm') throw cleanupError;
          return { status: 0 };
        },
      }),
    (error) => error === cleanupError,
  );
});
