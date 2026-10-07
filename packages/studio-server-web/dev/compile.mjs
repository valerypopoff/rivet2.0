import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenerationStore } from './generations.mjs';

const webRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = process.env.RIVET_DEV_BUNDLE_ROOT;
const started = Date.now();
let obsolete = false;
let finished = false;
// A crashed watcher must not leave an orphan compiler writing the same working
// directory while its replacement starts. IPC closes when the parent exits.
process.once('disconnect', () => {
  if (!finished) process.exit(1);
});
process.on('message', (message) => {
  if (message.type === 'source-changed') obsolete = true;
});
try {
  // Do not enter CPU-heavy work until the HTTP supervisor owns our PID. If the
  // watcher crashes before acknowledgement, disconnect can terminate us at once.
  await new Promise((resolve) => {
    process.on('message', function begin(message) {
      if (message?.type !== 'compile') return;
      process.removeListener('message', begin);
      resolve();
    });
  });
  const store = new GenerationStore(root);
  await store.initialize();
  // No other compiler can start until this child exits, after publication.
  await build({
    configFile: path.join(webRoot, 'vite.config.ts'),
    base: './',
    build: {
      outDir: path.join(root, 'working'),
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      reportCompressedSize: false,
      watch: null,
    },
  });
  if (obsolete) {
    console.log('[tunnel-build] Discarded superseded source build.');
    process.send?.({ phase: 'building', discarded: true });
  } else {
    const generation = await store.publish(path.join(root, 'working'));
    const durationMs = Date.now() - started;
    console.log(`[tunnel-build] Published ${generation} in ${durationMs} ms; cache ${store.bytes} bytes.`);
    process.send?.({ phase: 'ready', generation, durationMs });
  }
} catch (error) {
  console.error('[tunnel-build]', error);
  process.send?.({
    phase: 'failed',
    error: error.message.startsWith('Tunnel bundle cache')
      ? error.message
      : 'Frontend build failed. Check the web container logs; the previous bundle remains available.',
  });
  process.exitCode = 1;
} finally {
  finished = true;
  process.disconnect?.();
}
