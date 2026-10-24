import { createServer } from 'vite';
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuildFailurePolicy } from './build-failure.mjs';

const webRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = path.resolve(webRoot, '../..');
// Use Vite's polling watcher, but not its incremental build lifecycle. Some
// hosted plugins dispose resolver state in closeBundle; a fresh compiler child
// avoids stale plugin caches and releases the previous build's large heap.
const watcher = await createServer({
  // Watch-only Vite instance: do not install hosted build plugins or Vite's
  // config-restart handler, which would replace our watcher listeners.
  configFile: false,
  root: webRoot,
  publicDir: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: {
    middlewareMode: true,
    hmr: false,
    watch: {
      usePolling: true,
      interval: 500,
      ignored: [
        '**/dist/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/*.test.*',
        '**/*.spec.*',
        `${webRoot.replaceAll('\\', '/')}/dev/**`,
        `${webRoot.replaceAll('\\', '/')}/tests/**`,
        `${webRoot.replaceAll('\\', '/')}/playwright-observe/**`,
      ],
    },
  },
});
watcher.watcher.add([
  path.join(workspace, 'package.json'),
  path.join(workspace, 'yarn.lock'),
  path.join(workspace, 'tsconfig.base.json'),
  ...['app', 'core', 'node', 'evaluations'].flatMap((name) => [
    path.join(workspace, 'packages', name, 'package.json'),
    path.join(workspace, 'packages', name, 'tsconfig.json'),
  ]),
  ...[
    'app/src',
    'app/public',
    'app/scripts',
    'app/graphs',
    'core/src',
    'node/src',
    'evaluations/src',
    'studio-server-shared',
  ].map((directory) => path.join(workspace, 'packages', directory)),
]);
let stopped = false;
let dirty = false;
let child;
let timer;
const failures = createBuildFailurePolicy();
const send = (message) => process.send?.(message);
function schedule(event, file) {
  if (stopped) return;
  if (child && !dirty && typeof file === 'string')
    console.log(`[tunnel-build] Source ${event}: ${path.relative(workspace, file)}; superseding active build.`);
  failures.reset();
  dirty = true;
  if (child?.connected) {
    child.send({ type: 'source-changed' });
    send({ type: 'source-changed', pid: child.pid });
  }
  clearTimeout(timer);
  if (!child) timer = setTimeout(compile, 350);
}
function compile() {
  if (stopped || child || !dirty) return;
  dirty = false;
  send({ phase: 'building' });
  child = fork(fileURLToPath(new URL('./compile.mjs', import.meta.url)), [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  const compilerPid = child.pid;
  send({ type: 'compiler-started', pid: compilerPid });
  let published = false;
  let failed = false;
  let retryAfterMs;
  child.on('message', (message) => {
    if (message?.type === 'publish-build') {
      if (dirty) child.send({ type: 'publication-result', error: 'Frontend publication was superseded.' });
      else send({ type: 'publish-build', pid: compilerPid });
      return;
    }
    if (message.phase === 'ready') {
      published = true;
      if (!dirty) failures.reset();
    }
    if (message.discarded) published = true; // completed, deliberately not selected
    if (message.phase === 'failed') {
      failed = true;
      // A superseded build must not consume the new source revision's budget.
      if (!dirty) message = failures.failed(message);
      retryAfterMs = message.retryAfterMs;
    }
    // A source edit observed during compilation/publication supersedes it.
    if (message.phase === 'ready' && dirty) return;
    send(message);
  });
  child.on('error', (error) => console.error('[tunnel-build]', error));
  child.on('exit', () => {
    send({ type: 'compiler-stopped', pid: compilerPid });
    child = undefined;
    if (stopped) return;
    if (!published && !failed)
      send({
        phase: 'failed',
        error: 'Frontend build failed. Check the web container logs; the previous bundle remains available.',
      });
    if (dirty) timer = setTimeout(compile, 350);
    else if ([1_000, 3_000, 5 * 60_000].includes(retryAfterMs))
      timer = setTimeout(() => {
        // This path deliberately does not reset the unchanged-source retry budget.
        // It runs only after the previous child exited and released its working tree.
        dirty = true;
        compile();
      }, retryAfterMs);
  });
}
watcher.watcher.on('all', schedule);
process.on('message', (message) => {
  if (message?.type === 'compiler-tracked' && message.pid === child?.pid && child.connected)
    child.send({ type: 'compile' });
  if (message?.type === 'publication-result' && message.pid === child?.pid && child.connected) child.send(message);
});
schedule();
const stop = async () => {
  stopped = true;
  clearTimeout(timer);
  child?.kill('SIGTERM');
  const deadline = setTimeout(() => {
    child?.kill('SIGKILL');
    process.exit(0);
  }, 4_000);
  await watcher.close();
  if (!child) {
    clearTimeout(deadline);
    process.exit(0);
  }
  child.once('exit', () => {
    clearTimeout(deadline);
    process.exit(0);
  });
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('disconnect', stop);
