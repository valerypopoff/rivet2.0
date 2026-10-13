import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const mode = args[0];
const iterations = Number(args[1] ?? 100);
if (
  !['compare', 'direct', 'worker'].includes(mode ?? '') ||
  !Number.isInteger(iterations) ||
  iterations < 10 ||
  iterations > 500
)
  throw new Error('Usage: benchmark-serving-workload <compare|direct|worker> [10..500 iterations]');

if (mode === 'compare') {
  for (const childMode of ['direct', 'worker']) {
    // Isolated processes keep each RSS high-water independent of prior phases.
    await new Promise<void>((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), [childMode, String(iterations)], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${childMode} workload exited ${code}`))));
    });
  }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-serving-workload-'));
  for (const key of Object.keys(process.env)) if (key.startsWith('RIVET_')) delete process.env[key];
  Object.assign(process.env, {
    RIVET_APP_DATA_ROOT: path.join(root, 'app'),
    RIVET_WORKFLOWS_ROOT: path.join(root, 'virtual'),
    RIVET_WORKFLOW_RECORDINGS_ROOT: path.join(root, 'recordings'),
    RIVET_RECORDINGS_ENABLED: 'true',
    RIVET_METRICS_ENABLED: 'true',
    DOTENV_CONFIG_PATH: path.join(root, 'absent.env'),
  });
  const { LocalWorkflowCatalog } = await import('../local-metadata/workflow-catalog.js');
  const { SqliteWorkflowBackend } = await import('../local-metadata/sqlite-workflow-backend.js');
  const { measureServingWorkload } = await import('./serving-workload.js');
  const { getStudioMetrics } = await import('../metrics.js');
  const options = {
    databasePath: path.join(root, 'catalog.sqlite'),
    artifactRoot: path.join(root, 'artifacts'),
    virtualRoot: path.join(root, 'virtual'),
  };
  const catalog = new LocalWorkflowCatalog(options);
  let backend: InstanceType<typeof SqliteWorkflowBackend> | undefined;
  try {
    catalog.initialize();
    catalog.close();
    backend = new SqliteWorkflowBackend({
      ...options,
      worker: mode === 'worker',
      withWrite: (operation) => operation(),
      getRecordingRetentionHolds: async () => new Set(),
    });
    const startupAt = performance.now();
    await backend.initialize();
    const startupMs = performance.now() - startupAt;
    const measured = await measureServingWorkload(backend, () => backend!.checkHealth(), iterations);
    console.log(
      JSON.stringify(
        { mode, nodeVersion: process.version, startupMs, ...measured, metrics: getStudioMetrics().render() },
        null,
        2,
      ),
    );
  } finally {
    await backend?.dispose();
    catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
