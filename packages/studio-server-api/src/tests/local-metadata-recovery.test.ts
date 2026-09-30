import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { inspectLocalMetadataTransition, recoverLocalMetadataToLegacy } from '../local-metadata/recover-legacy.js';
import { localMetadataSourceIdentity } from '../local-metadata/source-identity.js';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';

async function fixture(
  run: (
    options: Parameters<typeof recoverLocalMetadataToLegacy>[0],
    journal: LocalMetadataTransitionJournal,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-recover-local-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const controlRoot = path.join(root, 'control');
  const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
  try {
    for (const directory of [controlRoot, ...Object.values(source)]) await fs.mkdir(directory);
    await fs.mkdir(path.join(source.appData, 'settings'));
    await fs.writeFile(path.join(source.appData, 'settings', 'original.json'), '{"secret":"unchanged"}');
    await journal.initialize({ create: true });
    const proof = {
      id: 'generation-1',
      sourceIdentity: localMetadataSourceIdentity(source),
      candidateIdentity: 'b'.repeat(64),
      sourceFingerprint: await fingerprintVmMigrationSource(source),
      candidateFingerprint: 'c'.repeat(64),
      reportHash: 'd'.repeat(64),
    };
    const verified = journal.recordVerifiedCandidate(1, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    await run(
      {
        controlRoot,
        source,
        expectedRevision: selected.revision,
        expectedGenerationId: proof.id,
        withExclusiveOwner: async (operation) => operation(),
      },
      journal,
    );
  } finally {
    journal.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('offline recovery selects retained legacy paused without a candidate database or settings encryption key', async () => {
  await fixture(async (options, journal) => {
    const before = await fingerprintVmMigrationSource(options.source);
    const recovered = await recoverLocalMetadataToLegacy(options);
    assert.equal(recovered.phase, 'legacy-validation');
    assert.equal(recovered.paused, true);
    assert.equal(recovered.backend, 'legacy');
    assert.equal(recovered.validationEvidenceHash, null);
    assert.equal(await fingerprintVmMigrationSource(options.source), before);
    assert.equal(journal.read().phase, 'legacy-validation');
    await fs.stat(path.join(options.source.appData, 'vm-migration-maintenance.json'));
  });
});

test('offline transition inspection requires ownership and does not mutate the journal or source', async () => {
  await fixture(async (options, journal) => {
    const before = journal.read();
    const source = await fingerprintVmMigrationSource(options.source);
    const result = await inspectLocalMetadataTransition(options);
    assert.deepEqual(result, before);
    assert.deepEqual(journal.read(), before);
    assert.equal(await fingerprintVmMigrationSource(options.source), source);
    await assert.rejects(
      inspectLocalMetadataTransition({
        ...options,
        withExclusiveOwner: async () => {
          throw new Error('running owner');
        },
      }),
      /running owner/,
    );
    await assert.rejects(inspectLocalMetadataTransition({ ...options, controlRoot: 'relative' }), /absolute/);
  });
});

test('offline CLI reports redacted state and returns legacy paused with the real owner lease', async () => {
  await fixture(async (options, journal) => {
    const ownerModule = (await import(
      new URL('../../../../deploy/studio-server/images/api/local-metadata-owner-lease.mjs', import.meta.url).href
    )) as {
      acquireLocalMetadataOwnerLease(root: string): { release(): void };
    };
    ownerModule.acquireLocalMetadataOwnerLease(options.controlRoot).release();
    const cli = fileURLToPath(new URL('../scripts/recover-local-metadata.ts', import.meta.url));
    const env = {
      ...process.env,
      RIVET_LOCAL_METADATA_CONTROL_ROOT: options.controlRoot,
      RIVET_WORKFLOWS_ROOT: options.source.workflows,
      RIVET_WORKFLOW_RECORDINGS_ROOT: options.source.recordings,
      RIVET_APP_DATA_ROOT: options.source.appData,
      RIVET_RUNTIME_LIBRARIES_ROOT: options.source.runtimeLibraries,
    };
    const invoke = (args: string[]) =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', cli, ...args], { env });
    const held = ownerModule.acquireLocalMetadataOwnerLease(options.controlRoot);
    try {
      await assert.rejects(invoke(['--status']));
    } finally {
      held.release();
    }
    const status = await invoke(['--status']);
    assert.deepEqual(JSON.parse(status.stdout), {
      phase: 'sqlite-validation',
      backend: 'sqlite',
      paused: true,
      canReturnToLegacy: true,
      revision: options.expectedRevision,
      generationId: options.expectedGenerationId,
    });
    assert.ok(!status.stdout.includes('sourceFingerprint'));
    assert.ok(!status.stdout.includes('unchanged'));
    const result = await invoke([String(options.expectedRevision), options.expectedGenerationId]);
    assert.equal(JSON.parse(result.stdout).phase, 'legacy-validation');
    assert.equal(JSON.parse(result.stdout).paused, true);
    assert.equal(journal.read().phase, 'legacy-validation');
    await assert.rejects(invoke([String(options.expectedRevision), options.expectedGenerationId]), /Command failed/);
  });
});

test('offline recovery rejects stale operators, source drift, a running owner and post-resume rollback', async () => {
  await fixture(async (options, journal) => {
    await assert.rejects(recoverLocalMetadataToLegacy({ ...options, expectedRevision: 1 }), /Stale/);
    await assert.rejects(recoverLocalMetadataToLegacy({ ...options, expectedGenerationId: 'wrong' }), /Stale/);
    await assert.rejects(
      recoverLocalMetadataToLegacy({
        ...options,
        withExclusiveOwner: async () => {
          throw new Error('running owner');
        },
      }),
      /running owner/,
    );
    const original = path.join(options.source.appData, 'settings', 'original.json');
    await fs.writeFile(original, 'changed');
    await assert.rejects(recoverLocalMetadataToLegacy(options), /differs/);
    await fs.writeFile(original, '{"secret":"unchanged"}');
    const validated = journal.recordRuntimeValidation(
      options.expectedRevision,
      'sqlite',
      options.expectedGenerationId,
      'e'.repeat(64),
    );
    const live = journal.resumeWrites(validated.revision, validated.generation!);
    await assert.rejects(recoverLocalMetadataToLegacy({ ...options, expectedRevision: live.revision }), /unavailable/);
    assert.equal(journal.read().phase, 'sqlite-live');
  });
});

test('offline recovery cannot reset missing control state or place its journal inside the retained source', async () => {
  await fixture(async (options, journal) => {
    await assert.rejects(recoverLocalMetadataToLegacy({ ...options, controlRoot: options.source.appData }), /outside/);
    journal.close();
    await fs.rm(path.join(options.controlRoot, 'transition.sqlite'));
    await assert.rejects(recoverLocalMetadataToLegacy(options), /missing/);
    await assert.rejects(fs.stat(path.join(options.controlRoot, 'transition.sqlite')), { code: 'ENOENT' });
  });
});
