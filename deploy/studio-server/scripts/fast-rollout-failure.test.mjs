import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import {
  runManagedGateCommand as run,
  withManagedGateSignal,
  waitForManagedGateCommands,
} from './lib/managed-gate-command.mjs';
import { fatalStartupReason, monitorFatalStartup } from './lib/fatal-startup-monitor.mjs';

// test-style: fixture-read: runs Node against disposable, deliberately broken packages.
test('actual Node loader failures are recognized without treating ordinary runtime errors as startup proof', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-loader-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [code, entry, metadata] of [
    ['ERR_UNSUPPORTED_DIR_IMPORT', 'import "./directory";'],
    ['ERR_INVALID_PACKAGE_CONFIG', 'import "fixture";', '{invalid json'],
    ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'import "fixture";', '{"name":"fixture","exports":{}}'],
    ['ERR_PACKAGE_IMPORT_NOT_DEFINED', 'import "#missing";'],
    ['ERR_UNKNOWN_FILE_EXTENSION', 'import "./module.unknown";'],
  ])
    await t.test(code, async () => {
      await fs.mkdir(path.join(directory, 'directory'), { recursive: true });
      await fs.mkdir(path.join(directory, 'node_modules/fixture'), { recursive: true });
      await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
      await fs.writeFile(path.join(directory, 'module.unknown'), 'export {};');
      if (metadata) await fs.writeFile(path.join(directory, 'node_modules/fixture/package.json'), metadata);
      const program = path.join(directory, 'entry.mjs');
      await fs.writeFile(program, entry);
      const result = spawnSync(process.execPath, [program], {
        encoding: 'utf8',
        timeout: 3000,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(code), result.stderr);
      assert.equal(fatalStartupReason(result.stderr), 'invalid-program');
    });
  for (const log of ['Error: ECONNREFUSED', 'TypeError: Invalid application setting', 'Error [ERR_STREAM_DESTROYED]'])
    assert.equal(fatalStartupReason(log), undefined);
});

// test-style: fixture-read: reads only the PID and Linux process state of this test's helper subprocess.
test(
  'Linux cancellation closes inherited pipes and stops helpers after their client exits',
  {
    skip: process.platform !== 'linux',
    timeout: 5000,
  },
  async (t) => {
    for (const stdio of ['inherit', 'ignore'])
      await t.test(stdio, async (t) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-command-helper-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const marker = path.join(directory, 'helper-pid');
        const helper =
          'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
        const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(helper)},process.argv[1]],{stdio:${JSON.stringify(stdio)}});setInterval(()=>{},1000)`;
        const stop = new AbortController();
        const failed = assert.rejects(
          run(process.execPath, ['-e', parent, marker], {
            signal: stop.signal,
            capture: true,
            killAfterMs: 50,
          }),
          /stop helper fixture/,
        );
        let pid;
        t.after(async () => {
          stop.abort(new Error('stop helper fixture'));
          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (error) {
              if (error.code !== 'ESRCH') throw error;
            }
          }
          await failed;
          await waitForManagedGateCommands();
        });
        while (!pid) {
          t.signal.throwIfAborted();
          pid = await fs.readFile(marker, 'utf8').then(Number, () => undefined);
          if (!pid) await sleep(5);
        }
        stop.abort(new Error('stop helper fixture'));
        const completed = await Promise.race([failed.then(() => true), sleep(500).then(() => false)]);
        assert.equal(completed, true, 'A helper holding the pipes must not strand command shutdown');
        const deadline = Date.now() + 250;
        let stopped = false;
        while (Date.now() < deadline) {
          const state = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          // PID 1 may not immediately reap an orphan. A zombie has already stopped.
          stopped = state === undefined || /\) [ZX] /.test(state);
          if (stopped) break;
          await sleep(5);
        }
        assert.ok(stopped, 'A cancelled helper without inherited pipes must also stop');
      });
  },
);

test(
  'captured commands receive EOF, preserve input and close after spawn or exit failures',
  { timeout: 5000 },
  async () => {
    const echo = [
      '-e',
      'let text="";process.stdin.on("data",part=>text+=part);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(text)))',
    ];
    assert.equal((await run(process.execPath, echo, { capture: true })).stdout, '""');
    assert.equal((await run(process.execPath, echo, { capture: true, input: 'fixture\n' })).stdout, '"fixture\\n"');
    await assert.rejects(run('rivet-nonexistent-test-command', [], { capture: true, allowFailure: true }), {
      code: 'ENOENT',
    });
    await assert.rejects(
      run(process.execPath, ['-e', 'console.error("fixture failure");process.exit(7)'], { capture: true }),
      /exit code 7.*[\s\S]*fixture failure/,
    );
    assert.equal(
      (await run(process.execPath, ['-e', 'process.exit(7)'], { capture: true, allowFailure: true })).exitCode,
      7,
    );
    await waitForManagedGateCommands();
  },
);

// test-style: fixture-read: reads only a temporary subprocess readiness marker.
test(
  'fatal startup stops the real owned subprocess, waits for closure and leaves cleanup commands usable',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-command-stop-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, 'ready');
    const controller = new AbortController();
    t.after(() => controller.abort());
    const pod = {
      metadata: { ownerReferences: [{ kind: 'ReplicaSet', controller: true }] },
      spec: { containers: [{ name: 'autoscaler', image: 'candidate-api' }] },
      status: {
        containerStatuses: [
          {
            name: 'autoscaler',
            ready: false,
            state: { waiting: { reason: 'CrashLoopBackOff' } },
            lastState: { terminated: { exitCode: 1 } },
          },
        ],
      },
    };
    // Hold the monitor until the subprocess has installed its SIGTERM handler.
    const command = withManagedGateSignal(controller.signal, () =>
      run(
        process.execPath,
        [
          '-e',
          'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),100));require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)',
          marker,
        ],
        { capture: true },
      ),
    );
    const monitor = monitorFatalStartup({
      controller,
      images: ['candidate-api'],
      intervalMs: 5,
      listPods: async () => {
        await fs.access(marker);
        return [pod];
      },
      readLog: async () => 'Error [ERR_MODULE_NOT_FOUND]: cannot find private-file',
    });
    const outcome = assert.rejects(command, { code: 'RIVET_FATAL_STARTUP' });
    await monitor;
    await waitForManagedGateCommands();
    await outcome;
    assert.equal(
      (await run(process.execPath, ['-e', 'console.log("cleanup")'], { capture: true })).stdout.trim(),
      'cleanup',
    );
    await assert.rejects(
      withManagedGateSignal(controller.signal, () => run('must-never-spawn', [])),
      { code: 'RIVET_FATAL_STARTUP' },
    );
  },
);

test(
  'an owned client ignoring SIGTERM is killed and closed before cancellation resolves',
  { timeout: 5000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-stubborn-command-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const marker = path.join(directory, 'ready'),
      stop = new AbortController();
    t.after(() => stop.abort());
    const command = run(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},1000)',
        marker,
      ],
      { signal: stop.signal, capture: true, killAfterMs: 50 },
    );
    const failed = assert.rejects(command, /stop stubborn/);
    while (
      !(await fs.access(marker).then(
        () => true,
        () => false,
      ))
    ) {
      t.signal.throwIfAborted();
      await sleep(5);
    }
    stop.abort(new Error('stop stubborn'));
    await failed;
    await waitForManagedGateCommands();
  },
);

test('unready, recovered, terminating and foreign-image containers do not become fatal startup proof', async (t) => {
  assert.equal(fatalStartupReason('connection refused; CrashLoopBackOff; OOMKilled'), undefined);
  assert.equal(fatalStartupReason('SyntaxError: Unexpected token }'), 'invalid-program');
  const controller = new AbortController();
  t.after(() => controller.abort());
  let reads = 0;
  const base = {
    metadata: { ownerReferences: [{ kind: 'ReplicaSet', controller: true }] },
    spec: { containers: [{ name: 'web', image: 'candidate' }] },
    status: {
      containerStatuses: [
        { name: 'web', state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { exitCode: 1 } } },
      ],
    },
  };
  const pods = Array.from({ length: 8 }, () => structuredClone(base));
  pods[0].status.containerStatuses[0].ready = true;
  pods[1].metadata.deletionTimestamp = 'now';
  pods[2].spec.containers[0].image = 'foreign';
  pods[3].status.containerStatuses[0].lastState = {};
  pods[4].status.containerStatuses[0].state = { running: {} };
  pods[5].status.containerStatuses[0].lastState.terminated.exitCode = 0;
  pods[6].metadata.ownerReferences = [];
  delete pods[7].status.containerStatuses[0].lastState.terminated.exitCode;
  const monitoring = monitorFatalStartup({
    controller,
    images: ['candidate'],
    intervalMs: 1,
    listPods: async () => pods,
    readLog: async () => {
      reads++;
      return 'MODULE_NOT_FOUND';
    },
  });
  await sleep(15);
  assert.equal(reads, 0);
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  await monitoring;
});

test('an unreadable container cannot hide an exited init container failure', { timeout: 5000 }, async (t) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pod = {
    metadata: { ownerReferences: [{ controller: true, kind: 'Job' }] },
    spec: { initContainers: [{ name: 'schema', image: 'candidate-api' }] },
    status: { initContainerStatuses: [{ name: 'schema', ready: false, state: { terminated: { exitCode: 1 } } }] },
  };
  const calls = [];
  await monitorFatalStartup({
    controller,
    images: ['candidate-api'],
    listPods: async () => [pod, pod],
    readLog: async (_pod, name, previous) => {
      calls.push({ name, previous });
      if (calls.length === 1) throw new Error('logs changed during read');
      return 'Error: Cannot find module. code: MODULE_NOT_FOUND';
    },
  });
  assert.deepEqual(calls, [
    { name: 'schema', previous: false },
    { name: 'schema', previous: false },
  ]);
  assert.equal(controller.signal.reason.code, 'RIVET_FATAL_STARTUP');
});

test('canceling one command scope does not terminate an independent command and allowFailure never swallows abort', async () => {
  const a = new AbortController();
  const failed = assert.rejects(
    withManagedGateSignal(a.signal, () =>
      run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { capture: true, allowFailure: true }),
    ),
    /cancel test/,
  );
  const other = run(process.execPath, ['-e', 'setTimeout(()=>console.log("other"),200)'], { capture: true });
  a.abort(new Error('cancel test'));
  await failed;
  assert.equal((await other).stdout.trim(), 'other');
  await waitForManagedGateCommands();
});

test('a command-specific signal cannot override phase cancellation', { timeout: 5000 }, async (t) => {
  const phase = new AbortController(),
    command = new AbortController();
  t.after(() => command.abort());
  const result = assert.rejects(
    withManagedGateSignal(phase.signal, () =>
      run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: command.signal, capture: true }),
    ),
    /phase stopped/,
  );
  phase.abort(new Error('phase stopped'));
  await result;
  assert.equal(command.signal.aborted, false);
  await waitForManagedGateCommands();
});
