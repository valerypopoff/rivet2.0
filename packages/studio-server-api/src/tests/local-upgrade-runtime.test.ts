import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { provisionLocalMetadataControl } from '../local-metadata/runtime-control.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { recoverLocalMetadataToLegacy } from '../local-metadata/recover-legacy.js';
import { FilesystemRivetEvaluationStore } from '../evaluation-runs/filesystem-store.js';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';

// test-style: fixture-read: reads only generated legacy and candidate fixtures to verify conversion and recovery.
async function fixture(
  run: (
    source: { workflows: string; recordings: string; appData: string; runtimeLibraries: string },
    control: string,
    command: (name: string, extra?: NodeJS.ProcessEnv) => Promise<void>,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-runtime-'));
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'libraries'),
  };
  const control = path.join(root, 'control');
  try {
    for (const directory of [control, ...Object.values(source)]) await fs.mkdir(directory);
    await fs.mkdir(path.join(source.workflows, 'empty'));
    await fs.writeFile(path.join(source.workflows, 'story.rivet-project'), createBlankProjectFile('Story'));
    await fs.mkdir(path.join(source.appData, 'settings'));
    await fs.writeFile(
      path.join(source.appData, 'settings', 'environment-variables.json'),
      JSON.stringify({
        version: 1,
        variables: [
          { id: 'variable01', name: 'PRIVATE_FIXTURE', value: 'never-return-this-secret', browserAccess: false },
        ],
      }),
    );
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
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    // Exercise native snapshots as well as the previously file-backed domains.
    const evaluations = new FilesystemRivetEvaluationStore(path.join(source.appData, 'evaluation-runs.sqlite'));
    const health = new FilesystemRivetLLMProfileHealthStore(path.join(source.appData, 'llm-profile-health.sqlite'));
    try {
      await evaluations.getLibrarySnapshot();
      await health.list();
    } finally {
      await evaluations.dispose();
      await health.dispose();
    }
    await provisionLocalMetadataControl(control, source);
    const command = async (name: string, extra: NodeJS.ProcessEnv = {}) => {
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('./helpers/local-upgrade-runtime.ts', import.meta.url)), name],
        {
          // The UI rehearsal performs several real API/executor boots. Each
          // phase has its own bounded status deadline; the outer process must
          // allow their cumulative duration rather than kill a healthy restart.
          timeout: name === 'ui-workflow' ? 300_000 : 90_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            RIVET_KEY: 'rehearsal-shared-key',
            RIVET_SERVER_UI_AUTH_MODE: 'key',
            RIVET_EXTRA_ROOTS: root,
            RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1',
            RIVET_LOCAL_METADATA_SUPERVISED: '1',
            RIVET_LOCAL_METADATA_CONTROL_ROOT: control,
            RIVET_LOCAL_METADATA_ENCRYPTION_KEY: 'isolated-test-settings-key-32-characters',
            // Direct fixture processes have no UI supervisor. Never inherit
            // capabilities or its private endpoint from a serving container.
            RIVET_LOCAL_METADATA_UI_ROOT: '',
            RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE: '0',
            RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE: '0',
            RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN: '',
            RIVET_BACKEND_HEALTH_PORT: '',
            RIVET_VM_MIGRATION_EDITOR_CONTROL: '1',
            RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
            RIVET_WORKFLOW_STORAGE_BACKEND: 'filesystem',
            RIVET_WORKFLOWS_ROOT: source.workflows,
            RIVET_WORKFLOW_RECORDINGS_ROOT: source.recordings,
            RIVET_APP_DATA_ROOT: source.appData,
            RIVET_RUNTIME_LIBRARIES_ROOT: source.runtimeLibraries,
            ...extra,
          },
        },
      );
      assert.match(result.stdout, new RegExp(`rehearsal:${name}:ok`));
    };
    // Match a VM that was already serving before the freeze; startup creates
    // its transaction/control and disposable library staging directories.
    await command('legacy');
    await run(source, control, command);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Each case owns all four roots, its control journal, child environment and
// ephemeral HTTP ports. Keep restart/fault phases serial within a case, while
// bounding independent cases to four workers; other API files remain serial.
describe('isolated local upgrade runtime scenarios', { concurrency: 4 }, () => {
  test('authenticated browser backup and project export work while paused and certify an actual restored archive', async () => {
    await fixture(async (_source, _control, command) => {
      await command('browser-backup');
    });
  });

  test('UI prepares, backs up, copies, restarts, validates and resumes a real supervised backend without console intervention', async () => {
    await fixture(async (_source, _control, command) => {
      await command('ui-workflow');
    });
  });

  test('operator copy, restart, validation, resume and ordinary serving select SQLite without changing retained files', async () => {
    await fixture(async (source, control, command) => {
      const fingerprint = await fingerprintVmMigrationSource(source);
      await command('copy');
      const selection = new LocalMetadataTransitionJournal(path.join(control, 'transition.sqlite'));
      let runtimeCache: string;
      try {
        await selection.initialize({ readOnly: true });
        runtimeCache = path.join(control, 'generations', selection.read().generation!.id, 'runtime-cache');
      } finally {
        selection.close();
      }
      // The archive is durable business data; an extracted package cache is not.
      // Actual supervised startup on Linux must rebuild it, not fail closed as
      // though an authoritative database or artifact had disappeared.
      await fs.rm(runtimeCache, { recursive: true });
      await fs.symlink(source.runtimeLibraries, runtimeCache, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(command('validate'), /Selected runtime-library cache must be a real directory/);
      await fs.unlink(runtimeCache);
      if (process.platform !== 'win32') await command('supervised');
      await command('validate');
      assert.ok((await fs.stat(path.join(runtimeCache, 'current', 'node_modules', 'example', 'index.js'))).isFile());
      await command('resume');
      await command('live');
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      const journal = new LocalMetadataTransitionJournal(path.join(control, 'transition.sqlite'));
      try {
        await journal.initialize({ readOnly: true });
        assert.equal(journal.read().phase, 'sqlite-live');
        assert.equal(journal.read().canReturnToLegacy, false);
      } finally {
        journal.close();
      }
    });
  });

  test('operator setup status is available before opt-in without exposing configuration to unsigned sessions', async () => {
    await fixture(async (_source, _control, command) => {
      await command('setup-status');
    });
  });

  test('operator inspection refuses oversized sources before parsing project or publication content', async () => {
    await fixture(async (source, _control, command) => {
      // Deliberately invalid project bytes: entering the inventory parser would
      // throw, rather than returning the explicit capacity refusal below.
      await fs.writeFile(path.join(source.workflows, 'story.rivet-project'), Buffer.alloc(17 * 1024 * 1024, 'x'));
      await command('inspect-capacity', { RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB: '16' });
    });
  });

  test('background copy capacity refusal is durable and cannot create a candidate or modify the frozen source', async () => {
    await fixture(async (_source, _control, command) => {
      await command('copy-capacity-refusal');
    });
  });

  test('background source fingerprint mismatch is durable and never creates a candidate', async () => {
    await fixture(async (_source, _control, command) => {
      await command('copy-fingerprint-mismatch');
    });
  });

  test('failed workflow diagnostics survive polling and same-generation retry and resolve a project read-only', async () => {
    await fixture(async (source, _control, command) => {
      await fs.writeFile(path.join(source.workflows, 'invalid.rivet-project'), 'password=private-malformed-fixture');
      await command('copy-source-diagnostic');
    });
  });

  test('operator activity remains visible across HTTP clients and competing actions fail with a safe conflict', async () => {
    await fixture(async (_source, _control, command) => {
      await command('copy-operation-status');
    });
  });

  test('status cannot report an interrupted copy when its worker finishes during optional backup IO', async () => {
    await fixture(async (_source, _control, command) => {
      await command('copy-status-race');
    });
  });

  test('status rereads backup evidence when its worker finishes during a held metadata read', async () => {
    await fixture(async (_source, _control, command) => {
      await command('backup-status-race');
    });
  });

  test('copy verifies plaintext settings without an encryption key, enable flag or key attestation', async () => {
    await fixture(async (_source, _control, command) => {
      await command('copy-without-key');
    });
  });

  test('operator inspection errors redact private source contents from HTTP responses and API logs', async () => {
    await fixture(async (source, _control, command) => {
      const bundle = path.join(source.recordings, 'fixture-project', 'fixture-run');
      await fs.mkdir(bundle, { recursive: true });
      await fs.writeFile(path.join(bundle, 'metadata.json'), 'LEAKME42');
      await command('inspect-error-redacted');
    });
  });

  test('failed selected startup can return to legacy without the candidate encryption key or an intact candidate', async () => {
    await fixture(async (source, control, command) => {
      const fingerprint = await fingerprintVmMigrationSource(source);
      await command('copy');
      const journal = new LocalMetadataTransitionJournal(path.join(control, 'transition.sqlite'));
      let state;
      try {
        await journal.initialize({ readOnly: true });
        state = journal.read();
      } finally {
        journal.close();
      }
      await fs.writeFile(
        path.join(control, 'generations', state.generation!.id, 'settings.sqlite'),
        'broken candidate',
      );
      await assert.rejects(command('validate'));
      const recovered = await recoverLocalMetadataToLegacy({
        controlRoot: control,
        source,
        expectedRevision: state.revision,
        expectedGenerationId: state.generation!.id,
        withExclusiveOwner: async (operation) => operation(),
      });
      assert.equal(recovered.backend, 'legacy');
      await command('validate', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      await command('resume', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      await command('legacy', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
    });
  });

  test('legacy recovery refuses replacement source mounts and drift before initializing file-backed authorities', async () => {
    await fixture(async (source, control, command) => {
      const fingerprint = await fingerprintVmMigrationSource(source);
      await command('copy');
      await command('return');
      for (const [role, variable] of [
        ['workflows', 'RIVET_WORKFLOWS_ROOT'],
        ['recordings', 'RIVET_WORKFLOW_RECORDINGS_ROOT'],
        ['appData', 'RIVET_APP_DATA_ROOT'],
        ['runtimeLibraries', 'RIVET_RUNTIME_LIBRARIES_ROOT'],
      ] as const) {
        const replacement = path.join(path.dirname(control), `replacement-${role}`);
        await fs.mkdir(replacement);
        await assert.rejects(command('legacy', { [variable]: replacement }), /source mount identity/);
        assert.deepEqual(await fs.readdir(replacement), [], 'Rejected startup must not create new legacy defaults.');
      }
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      const projectPath = path.join(source.workflows, 'story.rivet-project');
      const original = await fs.readFile(projectPath);
      await fs.writeFile(projectPath, createBlankProjectFile('Changed during paused recovery'));
      await assert.rejects(command('legacy'), /Retained legacy source differs/);
      await fs.writeFile(projectPath, original);
      await command('validate', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      await command('resume', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      // Legitimate legacy writes after resumption are allowed; its old content
      // proof is not a permanent read-only lock, but mount identity still is.
      await fs.writeFile(projectPath, createBlankProjectFile('New live legacy save'));
      await command('legacy', { RIVET_LOCAL_METADATA_ENCRYPTION_KEY: '' });
      await assert.rejects(
        command('legacy', { RIVET_WORKFLOWS_ROOT: path.join(path.dirname(control), 'replacement-workflows') }),
        /source mount identity/,
      );
    });
  });

  test('restored-clone legacy resumption can be refenced before restart and a second conversion', async () => {
    await fixture(async (source, _control, command) => {
      const fingerprint = await fingerprintVmMigrationSource(source);
      await command('copy');
      await command('return');
      await command('validate');
      await command('resume-refence');
      await command('legacy-fenced');
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      await command('copy');
      await command('validate');
      assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
    });
  });

  for (const [point, mode] of [
    ['copy:settings', 'ENOSPC'],
    ['copy:runtime-cache', 'EACCES'],
  ] as const) {
    test(`durable copy failure ${mode} at ${point} is redacted and retries the same generation exactly`, async () => {
      await fixture(async (source, _control, command) => {
        const fingerprint = await fingerprintVmMigrationSource(source);
        await command('copy-fault', { REHEARSAL_FAULT_POINT: point, REHEARSAL_FAULT_MODE: mode });
        await command('copy-retry');
        await command('return');
        await command('validate');
        await command('resume');
        await command('legacy');
        assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
        // The journal retains the returned generation. A later failure must
        // report the new job, never that older successful certificate.
        await command('copy-fault', { REHEARSAL_FAULT_POINT: point, REHEARSAL_FAULT_MODE: mode });
      });
    });
  }

  for (const point of [
    'copy:source-fingerprint',
    'copy:recordings',
    'copy:certificate-committed',
    'copy:selection-certified',
  ]) {
    test(`forced termination at ${point} leaves durable evidence, paused legacy and usable recovery`, async () => {
      await fixture(async (source, _control, command) => {
        const fingerprint = await fingerprintVmMigrationSource(source);
        await assert.rejects(command('copy-fault', { REHEARSAL_FAULT_POINT: point, REHEARSAL_FAULT_MODE: 'kill' }));
        await command('assert-interrupted');
        if (point !== 'copy:selection-certified') await command('copy-retry');
        await command('return');
        await command('validate');
        await command('resume');
        assert.equal(await fingerprintVmMigrationSource(source), fingerprint);
      });
    });
  }

  test('forced termination after activation commit remains reversible and does not admit writes', async () => {
    await fixture(async (source, control, command) => {
      await command('copy-fault', { REHEARSAL_FAULT_POINT: 'copy:settings', REHEARSAL_FAULT_MODE: 'ENOSPC' });
      await command('copy-retry');
      await assert.rejects(
        command('activate-fault', { REHEARSAL_FAULT_POINT: 'activate:committed', REHEARSAL_FAULT_MODE: 'kill' }),
      );
      const journal = new LocalMetadataTransitionJournal(path.join(control, 'transition.sqlite'));
      try {
        await journal.initialize({ readOnly: true });
        const state = journal.read();
        assert.equal(state.phase, 'sqlite-validation');
        assert.equal(state.paused, true);
        assert.equal(state.canReturnToLegacy, true);
        await recoverLocalMetadataToLegacy({
          controlRoot: control,
          source,
          expectedRevision: state.revision,
          expectedGenerationId: state.generation!.id,
          withExclusiveOwner: async (op) => op(),
        });
      } finally {
        journal.close();
      }
      await command('validate');
      await command('resume');
      await command('legacy');
    });
  });

  for (const point of ['resume:committed', 'resume:maintenance-removed']) {
    test(`forced termination at ${point} cannot reopen rollback and can complete resumption`, async () => {
      await fixture(async (_source, control, command) => {
        await command('copy');
        await command('validate');
        await assert.rejects(command('resume-fault', { REHEARSAL_FAULT_POINT: point, REHEARSAL_FAULT_MODE: 'kill' }));
        const journal = new LocalMetadataTransitionJournal(path.join(control, 'transition.sqlite'));
        try {
          await journal.initialize({ readOnly: true });
          assert.equal(journal.read().phase, 'sqlite-live');
          assert.equal(journal.read().canReturnToLegacy, false);
        } finally {
          journal.close();
        }
        if (point === 'resume:committed') await command('resume');
        await command('live');
      });
    });
  }
});
