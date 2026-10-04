import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationStore } from './generations.mjs';
import { createTunnelServer } from './server.mjs';
import { createCompilerOwner } from './compiler-owner.mjs';
import { observeBuilder } from './observe-builder.mjs';

const root = process.env.RIVET_DEV_BUNDLE_ROOT;
if (!root || !path.isAbsolute(root))
  throw new Error('RIVET_DEV_BUNDLE_ROOT must be an absolute, development-only cache path.');
const store = new GenerationStore(root);
const state = { session: randomUUID(), generation: null, phase: 'building', error: null, durationMs: null };
const { server, publish, closeClients } = createTunnelServer(store, state);
await new Promise((resolve) => server.listen(5174, '0.0.0.0', resolve));
// Claim the service port before cleaning shared cache staging. A duplicate
// invocation must fail without deleting a running compiler's pending files.
await store.initialize();
let child;
let stopping = false;
let retry;
const compiler = createCompilerOwner();
function restart(error) {
  if (stopping || retry) return;
  // Retire ownership before any delayed message/error/exit can be delivered.
  child = undefined;
  compiler.stop();
  state.phase = 'failed';
  state.error =
    error?.code === 'RIVET_DEV_BUILD_TIMEOUT'
      ? error.message
      : 'Frontend builder stopped. Retrying; the previous bundle remains available.';
  publish();
  retry = setTimeout(() => {
    retry = undefined;
    start();
  }, 5_000);
}
function start() {
  try {
    child = fork(fileURLToPath(new URL('./builder.mjs', import.meta.url)), [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
  } catch (error) {
    console.error('[tunnel-build]', error);
    restart();
    return;
  }
  observeBuilder(child, {
    isCurrent: (builder) => !stopping && child === builder,
    compiler,
    onStatus(message) {
      if (message.phase === 'ready') {
        store.latest = message.generation;
        state.generation = message.generation;
      }
      Object.assign(state, {
        phase: message.phase,
        error: message.error ?? null,
        durationMs: message.durationMs ?? state.durationMs,
      });
      publish();
    },
    onFailure(error) {
      if (error) console.error('[tunnel-build]', error);
      restart(error);
    },
  });
}
start();
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry);
  child?.kill('SIGTERM');
  closeClients();
  server.close();
  const deadline = setTimeout(() => {
    compiler.stop();
    child?.kill('SIGKILL');
  }, 5_000);
  deadline.unref();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
