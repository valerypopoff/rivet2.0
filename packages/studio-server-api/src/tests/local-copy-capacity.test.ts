import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import { inspectLocalCopyCapacity } from '../local-metadata/copy-capacity.js';
import { stageLocalMetadataCandidate } from '../local-metadata/stage-local-metadata-candidate.js';
import { collectSourceWorkflows } from '../local-metadata/filesystem-workflow-source.js';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { materializeLocalRuntimeLibraries } from '../local-metadata/runtime-library-authority.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

// test-style: fixture-read: measures only generated source/candidate fixtures, never repository implementation text.

async function fixture(
  run: (
    source: { workflows: string; recordings: string; appData: string; runtimeLibraries: string },
    root: string,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-capacity-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const previous = process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB;
  process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB = '16';
  try {
    for (const directory of Object.values(source)) await fs.mkdir(directory);
    await run(source, root);
  } finally {
    if (previous === undefined) delete process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB;
    else process.env.RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('capacity counts expanded legacy gzip instead of trusting declared recording sizes', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.recordings, 'recording.gz'), gzipSync(Buffer.alloc(17 * 1024 * 1024)));
    await fs.writeFile(
      path.join(source.recordings, 'metadata.json'),
      JSON.stringify({ version: 1, recordingUncompressedBytes: 1 }),
    );
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.fits, false);
    assert.equal(capacity.measurementComplete, false);
    assert.ok(capacity.reasons.includes('payload-budget'));
  });
});

test('capacity permits an aggregate larger than the bundle budget without scaling its memory estimate', async () => {
  await fixture(async (source, root) => {
    for (let index = 0; index < 20; index++) {
      const bundle = path.join(source.recordings, String(index));
      await fs.mkdir(bundle);
      await fs.writeFile(path.join(bundle, 'recording.gz'), gzipSync(Buffer.alloc(1024 * 1024)));
    }
    const capacity = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1024 * 1024 * 1024,
      heapLimitBytes: 1024 * 1024 * 1024,
      freeDiskBytes: 1024 * 1024 * 1024,
    });
    assert.ok(capacity.payloadBytes > capacity.maxPayloadBytes);
    assert.equal(capacity.measurementComplete, true);
    assert.equal(capacity.fits, true);
    assert.equal(capacity.estimatedWorkingBytes, 8 * 16 * 1048576 + 64 * 1048576);
  });
});

test('capacity stops before gzip decoding once on-disk bytes already exceed the budget', async () => {
  await fixture(async (source, root) => {
    // Deliberately invalid gzip must never be decoded after capacity refusal.
    await fs.writeFile(path.join(source.recordings, 'oversized.gz'), Buffer.alloc(17 * 1024 * 1024));
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.fits, false);
    assert.equal(capacity.measurementComplete, false);
    assert.ok(capacity.reasons.includes('payload-budget'));
  });
});

test('capacity cannot approve corrupt gzip or invalid resource measurements', async () => {
  await fixture(async (source, root) => {
    const artifact = path.join(source.recordings, 'recording.gz');
    await fs.writeFile(artifact, 'not gzip');
    await assert.rejects(inspectLocalCopyCapacity(source, root), { code: 'Z_DATA_ERROR' });
    await fs.writeFile(artifact, gzipSync('valid fixture'));
    for (const freeDiskBytes of [NaN, Infinity, -1])
      await assert.rejects(
        inspectLocalCopyCapacity(source, root, {
          availableMemoryBytes: 1024 ** 3,
          heapLimitBytes: 1024 ** 3,
          freeDiskBytes,
        }),
        /Invalid resource capacity measurement/,
      );
  });
});

test('capacity refuses disk and memory exhaustion independently, even inside the payload budget', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.workflows, 'small'), Buffer.alloc(1024));
    const memory = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1,
      heapLimitBytes: 1024 * 1024 * 1024,
    });
    assert.deepEqual(memory.reasons, ['memory-headroom']);
    const disk = await inspectLocalCopyCapacity(source, root, {
      availableMemoryBytes: 1024 * 1024 * 1024,
      heapLimitBytes: 1024 * 1024 * 1024,
      freeDiskBytes: 1,
    });
    assert.deepEqual(disk.reasons, ['disk-space']);
    assert.equal(disk.fits, false);
  });
});

test('capacity includes committed WAL and recovery-journal storage without opening databases', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.appData, 'evaluation-runs.sqlite'), Buffer.alloc(100));
    await fs.writeFile(path.join(source.appData, 'evaluation-runs.sqlite-wal'), Buffer.alloc(200));
    await fs.writeFile(path.join(source.appData, 'llm-profile-health.sqlite-journal'), Buffer.alloc(300));
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.operationalBytes, 600);
    assert.equal(capacity.diskEstimate.operationalSnapshotsBytes, 1200);
    assert.equal(
      capacity.requiredBytes,
      Object.values(capacity.diskEstimate).reduce((sum, value) => sum + value, 0),
    );
    assert.equal(capacity.fits, true);
  });
});

test('expanded recordings require one artifact copy, not four copies plus their compressed source', async () => {
  await fixture(async (source, root) => {
    const expanded = Buffer.alloc(8 * 1048576, 'x');
    const compressed = gzipSync(expanded);
    const metadata = JSON.stringify({ version: 1, recordingUncompressedBytes: 1 });
    for (let index = 0; index < 12; index++) {
      const bundle = path.join(source.recordings, String(index));
      await fs.mkdir(bundle);
      await fs.writeFile(path.join(bundle, 'recording.gz'), compressed);
      await fs.writeFile(path.join(bundle, 'metadata.json'), metadata);
    }
    const resources = {
      availableMemoryBytes: 1024 ** 3,
      heapLimitBytes: 1024 ** 3,
      freeDiskBytes: 170 * 1048576,
    };
    const capacity = await inspectLocalCopyCapacity(source, root, resources);
    assert.equal(capacity.diskEstimate.recordingArtifactsBytes, 12 * expanded.length);
    assert.equal(capacity.diskEstimate.metadataAndLibrariesBytes, 4 * 12 * Buffer.byteLength(metadata));
    assert.equal(capacity.payloadBytes, 12 * (expanded.length + compressed.length + Buffer.byteLength(metadata)));
    assert.equal(capacity.fits, true);
    assert.ok(4 * capacity.payloadBytes > resources.freeDiskBytes, 'The former estimate would refuse this fixture.');
    assert.deepEqual(
      (
        await inspectLocalCopyCapacity(source, root, {
          ...resources,
          freeDiskBytes: capacity.requiredBytes - 1,
        })
      ).reasons,
      ['disk-space'],
    );
    assert.equal(
      (
        await inspectLocalCopyCapacity(source, root, {
          ...resources,
          freeDiskBytes: capacity.requiredBytes,
        })
      ).fits,
      true,
    );
  });
});

test('identity artifacts, metadata, libraries and tiny-file allocation have separate disk allowances', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.recordings, 'recording.json'), Buffer.alloc(1024));
    await fs.writeFile(path.join(source.recordings, 'metadata.json'), '{}');
    await fs.writeFile(path.join(source.workflows, 'project'), Buffer.alloc(100));
    await fs.writeFile(path.join(source.runtimeLibraries, 'library'), Buffer.alloc(200));
    const capacity = await inspectLocalCopyCapacity(source, root);
    assert.equal(capacity.diskEstimate.recordingArtifactsBytes, 1024);
    assert.equal(capacity.diskEstimate.metadataAndLibrariesBytes, 4 * 302);
    assert.equal(capacity.diskEstimate.transientArtifactBytes, 16 * 1048576);
    assert.ok(capacity.diskEstimate.filesystemAllowanceBytes >= 7 * 4 * 4096);
    assert.equal(capacity.measurementComplete, true);
  });
});

test('capacity covers sampled candidate allocation through real compressed-recording staging and runtime extraction', async () => {
  await fixture(async (source, root) => {
    await fs.writeFile(path.join(source.workflows, 'story.rivet-project'), createBlankProjectFile('story'));
    await fs.mkdir(path.join(source.runtimeLibraries, 'current', 'node_modules', 'example'), { recursive: true });
    await fs.writeFile(path.join(source.runtimeLibraries, 'current', 'package.json'), '{"private":true}');
    await fs.writeFile(
      path.join(source.runtimeLibraries, 'current', 'node_modules', 'example', 'index.js'),
      'module.exports=42;',
    );
    await fs.writeFile(
      path.join(source.runtimeLibraries, 'manifest.json'),
      JSON.stringify({
        packages: { example: { name: 'example', version: '1.0.0' } },
        updatedAt: '',
      }),
    );
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const [project] = await collectSourceWorkflows(source.workflows);
      assert.ok(project);
      const recordings = 32;
      for (let index = 0; index < recordings; index++) {
        const bundle = path.join(source.recordings, project.workflowId, `run-${index}`);
        await fs.mkdir(bundle, { recursive: true });
        const recording = JSON.stringify({ index, padding: 'x'.repeat(2 * 1048576) });
        const compressed = gzipSync(recording);
        const replay = gzipSync(project.contents);
        await fs.writeFile(getRecordingArtifactPath(bundle, 'recording', 'gzip'), compressed);
        await fs.writeFile(getRecordingArtifactPath(bundle, 'replay-project', 'gzip'), replay);
        await fs.writeFile(
          path.join(bundle, 'metadata.json'),
          JSON.stringify({
            version: 2,
            id: `run-${index}`,
            workflowId: project.workflowId,
            sourceProjectMetadataId: project.workflowId,
            sourceProjectName: 'story',
            sourceProjectPath: path.join(source.workflows, 'story.rivet-project'),
            sourceProjectRelativePath: 'story.rivet-project',
            endpointNameAtExecution: 'story',
            createdAt: '2026-01-01T00:00:00.000Z',
            runKind: 'published',
            status: 'succeeded',
            durationMs: 1,
            encoding: 'gzip',
            hasReplayDataset: false,
            recordingCompressedBytes: compressed.length,
            recordingUncompressedBytes: Buffer.byteLength(recording),
            projectCompressedBytes: replay.length,
            projectUncompressedBytes: Buffer.byteLength(project.contents),
            datasetCompressedBytes: 0,
            datasetUncompressedBytes: 0,
          }),
        );
      }
      const target = path.join(root, 'candidate');
      await fs.mkdir(target);
      const candidate = {
        catalogDatabasePath: path.join(target, 'catalog.sqlite'),
        settingsDatabasePath: path.join(target, 'settings.sqlite'),
        artifactRoot: path.join(target, 'objects'),
      };
      const capacity = await inspectLocalCopyCapacity(source, target);
      assert.equal(capacity.fits, true);
      const block = Math.max(4096, (await fs.statfs(target)).bsize);
      let peak = 0;
      const stages: Record<string, number> = {};
      const sample = async () => {
        const seen = new Set<string>();
        const walk = async (entry: string): Promise<number> => {
          const stat = await fs.lstat(entry).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!stat) return 0;
          const inode = `${stat.dev}:${stat.ino}`;
          if (seen.has(inode)) return 0;
          seen.add(inode);
          let bytes = typeof stat.blocks === 'number' ? stat.blocks * 512 : Math.ceil(stat.size / block) * block;
          if (stat.isDirectory()) {
            for (const name of await fs.readdir(entry)) bytes += await walk(path.join(entry, name));
          }
          return bytes;
        };
        const bytes = await walk(target);
        peak = Math.max(peak, bytes);
        return bytes;
      };
      const frozen = async () => {
        await sample();
      };
      const report = await stageLocalMetadataCandidate({
        source,
        candidate,
        settingsEncryptionKey: 'generated-fixture-key',
        assertFrozen: frozen,
        onStage: async (stage) => {
          stages[stage] = await sample();
        },
      });
      assert.equal(report.recordings, recordings);
      const catalog = new LocalWorkflowCatalog({
        databasePath: candidate.catalogDatabasePath,
        artifactRoot: candidate.artifactRoot,
      });
      try {
        catalog.initialize({ verifyOnly: true, requireExisting: true });
        const state = await catalog.readRuntimeLibraryState();
        assert.ok(state);
        await materializeLocalRuntimeLibraries(path.join(target, 'runtime-cache'), state);
      } finally {
        catalog.close();
      }
      stages['runtime-cache'] = await sample();
      const verifiedSize = await sample();
      await stageLocalMetadataCandidate({
        source,
        candidate,
        settingsEncryptionKey: 'generated-fixture-key',
        assertFrozen: frozen,
        verifyOnly: true,
      });
      assert.equal(await sample(), verifiedSize, 'Read-only verification must not duplicate persistent artifacts.');
      assert.ok(peak < capacity.requiredBytes, `Sampled ${peak} bytes exceeds estimate ${capacity.requiredBytes}.`);
      assert.ok(
        peak >= capacity.diskEstimate.recordingArtifactsBytes * 0.9,
        'Measure real expanded artifacts, not only metadata.',
      );
      console.log(
        JSON.stringify({ capacityFixture: { sampledPeakBytes: peak, estimatedBytes: capacity.requiredBytes, stages } }),
      );
    });
  });
});
