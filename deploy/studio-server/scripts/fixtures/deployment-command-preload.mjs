import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import filePromises from 'node:fs/promises';

// Test-only process boundary: the production entrypoint runs unchanged. Only
// the two explicitly selected fixture executables become local child programs.
if (process.argv[1]?.endsWith('deploy-kubernetes-release.mjs')) {
  const writeFile = filePromises.writeFile.bind(filePromises);
  filePromises.writeFile = async (file, ...args) => {
    if (path.basename(String(file)) === 'history.json') {
      const stateFile = path.join(process.env.RIVET_COMMAND_FIXTURE, 'state.json');
      const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
      if (state?.fault === 'lostTemplateDiagnostics' && state.injected)
        throw Object.assign(Error('fixture diagnostics disk unavailable'), { code: 'ENOSPC' });
    }
    return writeFile(file, ...args);
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = (program, args, options) => {
    const kind =
      program === process.env.RIVET_K8S_HELM_BIN
        ? 'helm'
        : program === process.env.RIVET_K8S_KUBECTL_BIN
          ? 'kubectl'
          : null;
    return kind
      ? spawn(process.execPath, [path.join(import.meta.dirname, 'deployment-command-tool.mjs'), kind, ...args], options)
      : spawn(program, args, options);
  };
  syncBuiltinESMExports();
}

// Every Node process in this isolated fixture (including the private backup
// adapter) observes the same clock. Otherwise its new receipt would appear stale
// to a resumed CLI even though it was captured moments earlier.
if (process.env.RIVET_COMMAND_FIXTURE) {
  // Advance only explicit polling waits, not command execution or receipts.
  // Heartbeats use the same simulated clock. This tests routing/stability
  // wiring without spending real minutes on the disposable stand-in cluster.
  // Reconnects observe the same simulated wall clock as the interrupted
  // command; resetting it would make an already released lease look live.
  const clockFile = path.join(process.env.RIVET_COMMAND_FIXTURE, 'clock-offset.json');
  let offset = fs.existsSync(clockFile) ? JSON.parse(fs.readFileSync(clockFile, 'utf8')) : 0;
  const realNow = Date.now,
    timeout = globalThis.setTimeout;
  const monotonicNow = performance.now.bind(performance);
  Object.defineProperty(performance, 'now', { value: () => monotonicNow() + offset });
  const intervals = new Set();
  Date.now = () => realNow() + offset;
  globalThis.Date = new Proxy(Date, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [realNow() + offset], newTarget);
    },
    apply(target) {
      return new target(realNow() + offset).toString();
    },
  });
  if (process.argv[1]?.endsWith('deploy-kubernetes-release.mjs')) {
    globalThis.setInterval = (fn, delay) => {
      const timer = { fn, delay, next: Date.now() + delay, unref() {} };
      intervals.add(timer);
      return timer;
    };
    globalThis.clearInterval = (timer) => intervals.delete(timer);
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay >= 500 && delay <= 1000) {
        offset += 5_000;
        fs.writeFileSync(clockFile, JSON.stringify(offset));
        for (const timer of intervals)
          if (timer.next <= Date.now()) {
            timer.next = Date.now() + timer.delay;
            timer.fn();
          }
        return timeout(fn, 10, ...args);
      }
      return timeout(fn, delay, ...args);
    };
  }
}
