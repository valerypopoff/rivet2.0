import { parentPort, workerData } from 'node:worker_threads';
import { serveRecordingTransitionGuard } from '../lib/recording-transition-guard.mjs';

// Fixture setup uses synchronous Git/Helm calls on its parent thread. Keep
// the actual guard HTTP server responsive while other fixtures are prepared.
const guard = await serveRecordingTransitionGuard(async () => {}, workerData);
parentPort.postMessage(guard.url);
parentPort.once('message', async () => {
  await guard.close();
  parentPort.close();
});
