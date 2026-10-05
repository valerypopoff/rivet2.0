// Manual, test-owned capacity probe; deliberately not part of the fast CI suite.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serializeDatasets, serializeProject, type ProjectId, type DatasetId } from '@valerypopoff/rivet2-node';
import { ProjectBundleJobs } from '../../routes/workflows/project-bundle-jobs.js';
import type { BundleSnapshot } from '../../routes/workflows/project-bundle.js';
import { projectBundleFixture } from './project-bundle-fixture.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bundle-capacity-'));
const jobsRoot = path.join(temporary, 'jobs');
const jobs = new ProjectBundleJobs(jobsRoot);
let sampler: ReturnType<typeof setInterval> | undefined;
try {
  const fixture = projectBundleFixture();
  const snapshots = new Map<string, { snapshot: BundleSnapshot; dataPath: string }>();
  for (let index = 0; index < 6; index++) {
    const snapshot = structuredClone(fixture.child);
    if (index) snapshot.project.metadata.id = `capacity-${index}` as ProjectId;
    snapshot.projectContents = serializeProject(snapshot.project) as string;
    const dataPath = path.join(temporary, `${index}.rivet-data`);
    await fs.writeFile(
      dataPath,
      serializeDatasets([
        {
          meta: {
            id: 'capacity' as DatasetId,
            projectId: snapshot.project.metadata.id,
            name: 'Synthetic',
            description: '',
          },
          data: {
            id: 'capacity' as DatasetId,
            rows: [{ id: 'row', data: [randomBytes(12 * 1024 * 1024).toString('base64')] }],
          },
        },
      ]),
    );
    snapshots.set(snapshot.project.metadata.id, { snapshot, dataPath });
  }
  fixture.root.project.references = [...snapshots.keys()].map((id) => ({ id: id as ProjectId }));
  fixture.root.projectContents = serializeProject(fixture.root.project) as string;
  const read = async (id: string): Promise<BundleSnapshot> => {
    const entry = snapshots.get(id);
    if (!entry) throw new Error('Missing capacity fixture project');
    return { ...entry.snapshot, datasetsContents: await fs.readFile(entry.dataPath, 'utf8') };
  };
  global.gc?.();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss,
    peakHeap = baseline.heapUsed,
    peakScratchBytes = 0;
  const directoryBytes = async (directory: string): Promise<number> => {
    let bytes = 0;
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) bytes += await directoryBytes(location);
      else bytes += (await fs.stat(location).catch(() => ({ size: 0 }))).size;
    }
    return bytes;
  };
  sampler = setInterval(() => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }, 20);
  const startedAt = performance.now();
  const started = await jobs.start(
    { root: async () => fixture.root, target: (target) => read(target.projectId), reference: read },
    'latest',
  );
  let status = await jobs.status(started.id);
  const deadline = Date.now() + 120_000;
  while (['collecting', 'packaging'].includes(status.phase) && Date.now() < deadline) {
    peakScratchBytes = Math.max(peakScratchBytes, await directoryBytes(jobsRoot));
    await delay(50);
    status = await jobs.status(started.id);
  }
  assert.equal(status.phase, 'ready', JSON.stringify(status));
  const download = await jobs.download(started.id);
  assert.equal((await fs.stat(download.archive)).size, status.archiveBytes);
  download.release();
  await jobs.cancel(started.id);
  await jobs.cleanup();
  const scratchBytesAfterCleanup = await directoryBytes(jobsRoot);
  assert.equal(scratchBytesAfterCleanup, 0);
  console.log(
    JSON.stringify(
      {
        payloadBytes: status.bytes,
        archiveBytes: status.archiveBytes,
        durationMs: Math.round(performance.now() - startedAt),
        baselineRss: baseline.rss,
        peakRss,
        peakHeap,
        peakScratchBytes,
        scratchBytesAfterCleanup,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sampler);
  await jobs.dispose();
  await fs.rm(temporary, { recursive: true, force: true });
}
