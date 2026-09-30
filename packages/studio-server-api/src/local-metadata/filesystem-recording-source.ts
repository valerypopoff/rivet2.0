import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

import { getWorkflowRecordingMetadataPath } from '../routes/workflows/fs-helpers.js';
import { getRecordingArtifactPath } from '../routes/workflows/recordings-artifacts.js';
import { normalizeStoredWorkflowRecording } from '../routes/workflows/recordings-metadata.js';
import { decodeMigrationSourceUtf8, readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import type { LocalRecordingCatalogSnapshot, LocalWorkflowCatalogSnapshot } from './workflow-catalog.js';
import { chargeLocalSourceBytes, remainingLocalSourceBytes, withLocalSourceBudget } from './source-budget.js';

async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Source recording artifact is not a regular file: ${filePath}`);
  }
}

function assertMigrationMetadata(raw: unknown, bundle: string): asserts raw is Record<string, unknown> {
  const invalid = () => {
    throw new Error(`Source recording metadata is invalid: ${bundle}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  const fields = raw as Record<string, unknown>;
  if (typeof fields.durationMs !== 'number' || !Number.isFinite(fields.durationMs) || fields.durationMs < 0) invalid();
  if (fields.version === 2 || fields.version === 3) {
    if ((fields.encoding !== 'identity' && fields.encoding !== 'gzip') || typeof fields.hasReplayDataset !== 'boolean')
      invalid();
    for (const field of [
      'recordingCompressedBytes',
      'recordingUncompressedBytes',
      'projectCompressedBytes',
      'projectUncompressedBytes',
      'datasetCompressedBytes',
      'datasetUncompressedBytes',
    ]) {
      const value = fields[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
    }
  }
}

/** Scan authoritative bundles directly; the local SQLite run index is derived. */
export async function collectSourceRecordings(
  recordingsRoot: string,
  projects: LocalWorkflowCatalogSnapshot[],
): Promise<LocalRecordingCatalogSnapshot[]> {
  const recordings: LocalRecordingCatalogSnapshot[] = [];
  for await (const recording of iterateSourceRecordings(recordingsRoot, projects)) recordings.push(recording);
  return recordings.sort((left, right) => left.recordingId.localeCompare(right.recordingId));
}

export async function* iterateSourceRecordings(
  recordingsRoot: string,
  projects: Iterable<Pick<LocalWorkflowCatalogSnapshot, 'workflowId'>>,
): AsyncGenerator<LocalRecordingCatalogSnapshot> {
  const byId = new Set(Array.from(projects, (project) => project.workflowId));
  const ids = new Set<string>();
  const rootStat = await fs.lstat(recordingsRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Source recordings root must be a real directory.');
  }
  for (const projectEntry of await fs.readdir(recordingsRoot, { withFileTypes: true })) {
    if (projectEntry.name.startsWith('.')) continue;
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
      throw new Error(`Unexpected source recording project entry: ${projectEntry.name}`);
    }
    if (!byId.has(projectEntry.name)) throw new Error(`Recording project is missing from source: ${projectEntry.name}`);
    const projectDirectory = path.join(recordingsRoot, projectEntry.name);
    for (const bundleEntry of await fs.readdir(projectDirectory, { withFileTypes: true })) {
      if (bundleEntry.name.startsWith('.')) continue;
      if (!bundleEntry.isDirectory() || bundleEntry.isSymbolicLink()) {
        throw new Error(`Unexpected source recording bundle: ${projectEntry.name}/${bundleEntry.name}`);
      }
      const bundlePath = path.join(projectDirectory, bundleEntry.name);
      yield await withLocalSourceBudget(async () => {
        const metadataPath = getWorkflowRecordingMetadataPath(bundlePath);
        await assertRegularFile(metadataPath);
        const raw: unknown = JSON.parse(await readMigrationSourceUtf8(metadataPath));
        assertMigrationMetadata(raw, `${projectEntry.name}/${bundleEntry.name}`);
        // The legacy normalizer measures artifacts by fully decompressing them.
        // Supply only normalized metadata here; our bounded reader below owns
        // size measurement and validation (including v1 mixed encodings).
        const gzipPath = getRecordingArtifactPath(bundlePath, 'recording', 'gzip');
        const exists = async (file: string) =>
          fs.lstat(file).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false;
              throw error;
            },
          );
        const legacyEncoding = raw.version === 1 && (await exists(gzipPath)) ? 'gzip' : 'identity';
        const legacyHasDataset =
          raw.version === 1 &&
          ((await exists(getRecordingArtifactPath(bundlePath, 'replay-dataset', 'gzip'))) ||
            (await exists(getRecordingArtifactPath(bundlePath, 'replay-dataset', 'identity'))));
        const metadata = await normalizeStoredWorkflowRecording(
          bundlePath,
          raw.version === 1
            ? {
                ...raw,
                version: 2,
                workflowId: raw.sourceProjectMetadataId,
                encoding: legacyEncoding,
                hasReplayDataset: legacyHasDataset,
                recordingCompressedBytes: 0,
                recordingUncompressedBytes: 0,
                projectCompressedBytes: 0,
                projectUncompressedBytes: 0,
                datasetCompressedBytes: 0,
                datasetUncompressedBytes: 0,
              }
            : raw,
        );
        if (
          !metadata ||
          metadata.workflowId !== projectEntry.name ||
          metadata.sourceProjectMetadataId !== projectEntry.name ||
          metadata.run.id !== bundleEntry.name ||
          ids.has(metadata.run.id)
        ) {
          throw new Error(
            `Source recording bundle is incomplete or inconsistent: ${projectEntry.name}/${bundleEntry.name}`,
          );
        }
        ids.add(metadata.run.id);
        const artifact = async (kind: 'recording' | 'replay-project' | 'replay-dataset'): Promise<string> => {
          let encoding = metadata.run.encoding;
          let artifactPath = getRecordingArtifactPath(bundlePath, kind, encoding);
          if (raw.version === 1 && kind !== 'recording') {
            const exists = await fs.lstat(artifactPath).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
              throw error;
            });
            if (!exists) {
              encoding = encoding === 'gzip' ? 'identity' : 'gzip';
              artifactPath = getRecordingArtifactPath(bundlePath, kind, encoding);
            }
          }
          await assertRegularFile(artifactPath);
          // Bound both compressed input and expanded output. Never allocate a
          // full compressed buffer or let a gzip bomb exhaust memory.
          const file = await fs.lstat(artifactPath);
          if (file.size > (remainingLocalSourceBytes() ?? Infinity))
            throw new Error('Local recording exceeds the decoded-memory budget.');
          const input = createReadStream(artifactPath);
          const gunzip = encoding === 'gzip' ? createGunzip() : null;
          const output = gunzip ?? input;
          if (gunzip) {
            input.on('error', (error) => gunzip.destroy(error));
            input.pipe(gunzip);
          }
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for await (const chunk of output) {
              chargeLocalSourceBytes((chunk as Buffer).length);
              size += (chunk as Buffer).length;
              chunks.push(chunk as Buffer);
            }
          } finally {
            input.destroy();
            output.destroy();
          }
          const uncompressed = Buffer.concat(chunks, size);
          if (raw.version === 2 || raw.version === 3) {
            const prefix = kind === 'recording' ? 'recording' : kind === 'replay-project' ? 'project' : 'dataset';
            if (
              file.size !== raw[`${prefix}CompressedBytes`] ||
              uncompressed.length !== raw[`${prefix}UncompressedBytes`]
            ) {
              throw new Error(`Source recording artifact size differs from metadata: ${artifactPath}`);
            }
          }
          return decodeMigrationSourceUtf8(uncompressed, artifactPath);
        };
        return {
          recordingId: metadata.run.id,
          workflowId: metadata.workflowId,
          sourceProjectRelativePath: metadata.sourceProjectRelativePath,
          sourceProjectName: metadata.sourceProjectName,
          createdAt: metadata.run.createdAt,
          runKind: metadata.run.runKind,
          status: metadata.run.status,
          durationMs: metadata.run.durationMs,
          endpointName: metadata.run.endpointNameAtExecution,
          errorMessage: metadata.run.errorMessage ?? null,
          executionIdentity: metadata.run.executionIdentity,
          recordingContents: await artifact('recording'),
          replayProjectContents: await artifact('replay-project'),
          replayDatasetContents: metadata.run.hasReplayDataset ? await artifact('replay-dataset') : null,
        };
      });
    }
  }
}
