import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';
import { createBlankProjectFile } from '../../routes/workflows/fs-helpers.js';
import { getRecordingArtifactPath } from '../../routes/workflows/recordings-artifacts.js';
import { stageLocalMetadataCandidate } from '../../local-metadata/stage-local-metadata-candidate.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-bounded-conversion-'));
process.env.RIVET_EXTRA_ROOTS = root;
try {
  const source = Object.fromEntries(
    ['workflows', 'recordings', 'appData', 'runtimeLibraries'].map((name) => [name, path.join(root, name)]),
  ) as Record<'workflows' | 'recordings' | 'appData' | 'runtimeLibraries', string>;
  for (const directory of Object.values(source)) await fs.mkdir(directory);
  const project = createBlankProjectFile('bounded');
  const workflowId = loadProjectAndAttachedDataFromString(project)[0].metadata.id;
  await fs.writeFile(path.join(source.workflows, 'bounded.rivet-project'), project);
  const count = 192;
  for (let index = 0; index < count; index++) {
    const id = `run-${index}`;
    const bundle = path.join(source.recordings, workflowId, id);
    await fs.mkdir(bundle, { recursive: true });
    // Distinct bytes prevent artifact deduplication from disguising the test.
    const contents = JSON.stringify({ id, input: 'x'.repeat(1048576) });
    await fs.writeFile(getRecordingArtifactPath(bundle, 'recording', 'gzip'), gzipSync(contents));
    await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'identity'), project);
    await fs.writeFile(
      path.join(bundle, 'metadata.json'),
      JSON.stringify({
        version: 1,
        id,
        sourceProjectMetadataId: workflowId,
        sourceProjectName: 'bounded',
        sourceProjectPath: path.join(source.workflows, 'bounded.rivet-project'),
        sourceProjectRelativePath: 'bounded.rivet-project',
        endpointNameAtExecution: 'bounded',
        createdAt: '2026-01-01T00:00:00.000Z',
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        recordingPath: 'recording.rivet-recording.gz',
        replayProjectPath: 'replay.rivet-project',
      }),
    );
  }
  process.env.RIVET_EXTRA_ROOTS = root;
  process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB = '2';
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot: path.join(root, 'candidate', 'objects'),
  };
  const report = await stageLocalMetadataCandidate({
    source,
    candidate,
    settingsEncryptionKey: 'test-only',
    assertFrozen: async () => {},
  });
  assert.equal(report.recordings, count);
  assert.equal(report.servingChecks.recordings, count);
  const peakRssKiB = process.resourceUsage().maxRSS;
  assert.ok(peakRssKiB < 512 * 1024, `Peak RSS exceeded 512 MiB: ${peakRssKiB} KiB`);
  console.log(
    JSON.stringify({ recordings: count, decodedRecordingBytes: count * 1048576, heapLimitMiB: 192, peakRssKiB }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
