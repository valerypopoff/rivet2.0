import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBuildFailure } from './build-failure.mjs';

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
    // The HTTP supervisor owns publication and live-tab pins. Keep this child
    // alive (and its working directory stable) until publication settles.
    const { generation, bytes } = await new Promise((resolve, reject) => {
      process.on('message', function published(message) {
        if (message?.type !== 'publication-result') return;
        process.removeListener('message', published);
        if (message.error) reject(Object.assign(new Error(message.error), { code: message.code }));
        else resolve(message);
      });
      process.send({ type: 'publish-build' });
    });
    const durationMs = Date.now() - started;
    console.log(`[tunnel-build] Published ${generation} in ${durationMs} ms; cache ${bytes} bytes.`);
    process.send?.({ phase: 'ready', generation, durationMs });
  }
} catch (error) {
  console.error('[tunnel-build]', error);
  process.send?.(describeBuildFailure(error, path.resolve(webRoot, '../..')));
  process.exitCode = 1;
} finally {
  finished = true;
  process.disconnect?.();
}
