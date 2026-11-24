// test-style: fixture-read: reads only the owned CLI receipts, child readiness and temporary credential configuration.
import { acquireRecordingStorageLock } from '@valerypopoff/rivet-studio-server-bootstrap/recording-storage.mjs';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import {
  createDeploymentCommandFixture,
  createDeploymentCommandTools,
} from '../../../../deploy/studio-server/scripts/deployment-command-fixture.mjs';
import { runManagedGateCommand } from '../../../../deploy/studio-server/scripts/lib/managed-gate-command.mjs';
import type {
  RecordingTransitionConfiguration,
  runRecordingTransitionCommand,
} from '../../../../deploy/studio-server/scripts/lib/recording-transition-command.mjs';
import { PostgresAppSettingsBackend } from '../../src/app-settings/managed-settings-store.js';
import { deploymentStorageSettingsRepository } from '../../src/deployment-storage-settings.js';
import { getManagedDbPoolConfig } from '../../src/routes/workflows/managed/db.js';
import type { ManagedWorkflowStorageConfig } from '../../src/routes/workflows/storage-config.js';
import {
  recordingStorageIdentity,
  recordingStorageRequiredEncodings,
  withRecordingOperatorLease,
} from '../recording-storage-operator.js';
import { withRecordingStorageTransition } from '../recording-storage-transition.js';

async function waitFor(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(label);
    await delay(20);
  }
}
function contains(error: unknown, pattern: RegExp): boolean {
  return (
    error instanceof Error &&
    (pattern.test(error.message) ||
      (error instanceof AggregateError && error.errors.some((item) => contains(item, pattern))))
  );
}

/** Runs inside the recording-durability lane's database; no new fixture services. */
export async function verifyRecordingStorageTransition(pool: Pool, storage: ManagedWorkflowStorageConfig) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-recording-transition-')));
  const identity = {
    context: 'fixture-context',
    namespace: 'fixture',
    release: 'rivet',
    namespaceUid: 'fixture-namespace-uid',
  };
  const secret = 'recording-transition-owned-fixture-key';
  const key = deploymentStorageSettingsRepository.descriptor.key;
  const settings = new PostgresAppSettingsBackend({
    poolConfig: getManagedDbPoolConfig(storage),
    encryptionSecret: secret,
  });
  const disposers: Array<() => unknown> = [];
  const failures: unknown[] = [];
  let inserted = false;
  const configuration: RecordingTransitionConfiguration = {
    protocol: 1,
    identity,
    storageIdentity: recordingStorageIdentity(storage),
    settings: {
      databaseUrl: { value: `${storage.databaseUrl}\n` },
      encryptionKey: { value: `${secret}\r\n` },
      sslMode: storage.databaseSslMode,
    },
  };
  const file = path.join(directory, 'connection.json');
  const save = async (value = configuration) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const input = { identity, configuration, interrupts: new EventEmitter() };
  try {
    await settings.initialize();
    assert.equal((await pool.query('SELECT 1 FROM app_settings WHERE setting_key=$1', [key])).rowCount, 0);
    const storedSettings = {
      version: 1,
      storageMode: 'managed',
      databaseMode: 'managed',
      databaseSslMode: storage.databaseSslMode,
      databaseConnectionString: storage.databaseUrl,
      objectStorageBucket: storage.objectStorageBucket,
      objectStorageEndpoint: storage.objectStorageEndpoint,
      objectStorageRegion: storage.objectStorageRegion,
      objectStoragePrefix: storage.objectStoragePrefix,
      objectStorageForcePathStyle: storage.objectStorageForcePathStyle,
      storageAccessKeyId: storage.objectStorageAccessKeyId,
      storageAccessKey: storage.objectStorageSecretAccessKey,
    };
    const initial = await settings.write({ key, expectedRevision: null, schemaVersion: 1, value: storedSettings });
    assert.ok(initial);
    inserted = true;
    const overridden = new URL(storage.databaseUrl);
    overridden.searchParams.set('host', overridden.hostname);
    const changed = await settings.write({
      key,
      expectedRevision: initial.revision,
      schemaVersion: 1,
      value: { ...storedSettings, databaseConnectionString: overridden.toString() },
    });
    assert.ok(changed);
    await assert.rejects(
      withRecordingStorageTransition(input, async () =>
        assert.fail('Ambiguous stored database address must prevent deployment'),
      ),
      /URL host and port/,
    );
    assert.ok(
      await settings.write({ key, expectedRevision: changed.revision, schemaVersion: 1, value: storedSettings }),
    );
    await settings.dispose();
    await save();
    const before = (await pool.query('SELECT * FROM app_settings WHERE setting_key=$1', [key])).rows[0];
    const optionsSchema = `transition_options_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA ${optionsSchema}`);
    disposers.push(() => pool.query(`DROP SCHEMA ${optionsSchema} CASCADE`));
    await pool.query(`CREATE VIEW ${optionsSchema}.app_settings AS SELECT * FROM public.app_settings
      WHERE current_setting('default_transaction_read_only')='on' AND current_setting('statement_timeout')='15s'`);
    const startupOverride = new URL(storage.databaseUrl);
    startupOverride.searchParams.set('options', '-c search_path=pg_catalog');
    startupOverride.searchParams.append(
      'options',
      `-c search_path=${optionsSchema},public -c default_transaction_read_only=off -c statement_timeout=0`,
    );
    startupOverride.searchParams.set('statement_timeout', '0');
    assert.equal(
      await withRecordingStorageTransition(
        {
          ...input,
          configuration: {
            ...configuration,
            settings: { ...configuration.settings, databaseUrl: { value: startupOverride.toString() } },
          },
        },
        async () => true,
      ),
      true,
      'Settings reads must enforce read-only/timeout startup options while preserving the configured search path',
    );
    await withRecordingOperatorLease(
      storage,
      'converter',
      async (_pool, _signal, _check, client) => {
        const { rows } = await client.query<{ timeout: string; read_only: string; search_path: string }>(
          `SELECT current_setting('statement_timeout') AS timeout,
            current_setting('default_transaction_read_only') AS read_only,
            current_setting('search_path') AS search_path`,
        );
        assert.deepEqual(rows[0], { timeout: '15s', read_only: 'off', search_path: `${optionsSchema},public` });
      },
      { databaseUrl: startupOverride.toString(), databaseSslMode: storage.databaseSslMode },
    );
    const rotated = { ...configuration.settings, encryptionKey: { value: 'replacement-fixture-key' } };
    await assert.rejects(
      withRecordingStorageTransition({ ...input, configuration: { ...configuration, settings: rotated } }, async () =>
        assert.fail('Unavailable settings key must prevent deployment'),
      ),
      /encrypted with unavailable key/,
    );
    await withRecordingStorageTransition(
      {
        ...input,
        configuration: { ...configuration, settings: { ...rotated, previousEncryptionKey: { value: secret } } },
      },
      async () => {},
    );
    const inventory = await pool.connect();
    try {
      await inventory.query('BEGIN');
      await inventory.query(
        'CREATE TEMP TABLE workflow_recordings(recording_blob_key text); CREATE TEMP TABLE workflow_run_evidence(manifest_json jsonb)',
      );
      assert.deepEqual(await recordingStorageRequiredEncodings(inventory), []);
      const encoded = (codec: string) => `trace.artifact-v1.${'a'.repeat(64)}.10.20.${codec}`;
      await inventory.query('INSERT INTO workflow_recordings VALUES ($1),($2)', ['legacy-trace', encoded('gzip')]);
      await inventory.query('INSERT INTO workflow_run_evidence VALUES ($1::jsonb)', [
        JSON.stringify({ row: { recordingBlobKey: encoded('br') } }),
      ]);
      assert.deepEqual(await recordingStorageRequiredEncodings(inventory), ['br', 'gzip', 'identity']);
      await inventory.query('INSERT INTO workflow_run_evidence VALUES ($1::jsonb)', [
        JSON.stringify({ row: { recordingBlobKey: encoded('unknown') } }),
      ]);
      await assert.rejects(recordingStorageRequiredEncodings(inventory), /unknown stored recording encoding/);
    } finally {
      await inventory.query('ROLLBACK');
      inventory.release();
    }
    const observer = await pool.connect();
    try {
      const release = await acquireRecordingStorageLock(observer, 'exclusive');
      try {
        await assert.rejects(
          withRecordingStorageTransition(input, async () => assert.fail('Converter must exclude transition')),
          /storage operation/,
        );
      } finally {
        await release();
      }
      await withRecordingStorageTransition(input, async ({ guardUrl, signal, requiredEncodings }) => {
        assert.ok(requiredEncodings.includes('br'));
        const conflicting = await observer.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [8072, 24006]);
        assert.equal(conflicting.rows[0].acquired, false);
        await withRecordingStorageTransition(input, async () => {}); // shared nested transition, not a new exclusive lock
        const response = await fetch(guardUrl, { method: 'POST', signal });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).namespace, identity.namespace);
      });
      const released = await acquireRecordingStorageLock(observer, 'exclusive');
      await released();
    } finally {
      observer.release();
    }
    await assert.rejects(
      withRecordingStorageTransition(
        { ...input, configuration: { ...configuration, storageIdentity: '0'.repeat(64) } },
        async () => assert.fail('Mismatched storage must never start the CLI'),
      ),
      /differs from the reviewed/,
    );
    const installed = (
      await pool.query('SELECT deployment FROM rivet_restore_control.installation WHERE singleton=TRUE')
    ).rows[0].deployment;
    await pool.query("UPDATE rivet_restore_control.installation SET deployment='foreign/rivet' WHERE singleton=TRUE");
    try {
      await assert.rejects(
        withRecordingStorageTransition(input, async () => assert.fail('Foreign database')),
        /another deployment/,
      );
    } finally {
      await pool.query('UPDATE rivet_restore_control.installation SET deployment=$1 WHERE singleton=TRUE', [installed]);
    }

    // Exercise the real controller -> qualified TS loader -> PostgreSQL guard.
    // The native CLI itself is exercised below; this seam intercepts only its run.
    const root = await fs.realpath(fileURLToPath(new URL('../../../../', import.meta.url)));
    const controller = path.join(directory, 'controller-bridge.mjs');
    await fs.copyFile(path.join(root, 'deploy/studio-server/scripts/lib/recording-transition-command.mjs'), controller);
    const bridge = (await import(pathToFileURL(controller).href)) as {
      runRecordingTransitionCommand: typeof runRecordingTransitionCommand;
    };
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const loaderArtifacts = await fs.mkdtemp(path.join(root, 'artifacts/transition-loader-'));
    disposers.push(() => fs.rm(loaderArtifacts, { recursive: true, force: true }));
    for (const cancelled of [true, false]) {
      const artifacts = path.join(loaderArtifacts, cancelled ? 'cancelled' : 'active');
      const reason = new Error('cancelled before qualified acquisition');
      let calls = 0;
      const command = bridge.runRecordingTransitionCommand({
        root,
        program: process.execPath,
        args: [
          path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
          '--context',
          identity.context,
          '--namespace',
          identity.namespace,
          '--release',
          identity.release,
          '--artifacts',
          artifacts,
          '--preflight-only',
        ],
        identity,
        required: true,
        configurationFile: file,
        options: { env: {}, ...(cancelled ? { signal: AbortSignal.abort(reason) } : {}) },
        run: async (program, args, options) => {
          calls++;
          assert.equal(program, process.execPath);
          assert.equal(args[0], path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'));
          assert.equal(options?.cwd, root);
          const url = options?.env?.RIVET_RECORDING_TRANSITION_GUARD;
          assert.ok(url);
          const response = await fetch(url, { method: 'POST', signal: options?.signal });
          assert.equal(response.status, 200);
          const proof = (await response.json()) as typeof identity & { requiredEncodings: string[] };
          assert.equal(proof.context, identity.context);
          assert.equal(proof.namespaceUid, identity.namespaceUid);
          assert.ok(proof.requiredEncodings.includes('br'));
          const observer = await pool.connect();
          try {
            assert.equal(
              (await observer.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [8072, 24006])).rows[0].acquired,
              false,
            );
          } finally {
            observer.release(true);
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      if (cancelled) await assert.rejects(command, (error) => error === reason);
      else assert.equal((await command).exitCode, 0);
      assert.equal(calls, cancelled ? 0 : 1);
      const receipt = JSON.parse(await fs.readFile(path.join(artifacts, 'recording-transition.json'), 'utf8')) as {
        guardPrepared: boolean;
        commandInvoked: boolean;
        completed: boolean;
      };
      assert.deepEqual(
        [receipt.guardPrepared, receipt.commandInvoked, receipt.completed],
        [!cancelled, !cancelled, !cancelled],
      );
    }
    const tools = await createDeploymentCommandTools();
    disposers.push(tools.close);
    const lifecycle = {
      after(action: () => unknown) {
        disposers.push(action);
      },
    };
    for (const guarded of [false, true]) {
      const fixture = await createDeploymentCommandFixture(
        lifecycle,
        guarded ? 'qualified' : 'rolling',
        null,
        false,
        true,
        { commandTool: tools.file, guard: false },
      );
      const command = fixture.invocation(['--preflight-only']);
      command.args.splice(command.args.indexOf('--confirm'), 2);
      const originalState = await fixture.state();
      if (!guarded) {
        const result = await runManagedGateCommand(command.program, command.args, {
          ...command.options,
          allowFailure: true,
        });
        assert.equal(result.exitCode, 1);
        assert.match(result.stderr, /requires the recording storage transition wrapper/);
        assert.equal((await fixture.stages()).length, 0);
      } else {
        await save({ ...configuration, identity: { ...identity, namespaceUid: originalState.namespaceUid } });
        const result = await fixture.qualified({
          configurationFile: file,
          preflightOnly: true,
          run: runManagedGateCommand,
          loadTransition: async () => ({ withRecordingStorageTransition }),
        });
        assert.equal(result.status, 'preflight-passed');
        const receipt = JSON.parse(
          await fs.readFile(
            path.join(fixture.directory, 'artifacts/qualified-attempt/private-preflight/deployment-preflight.json'),
            'utf8',
          ),
        );
        assert.equal(receipt.workloadMutations, false);
        assert.equal(receipt.applicationJourneysRun, false);
        assert.deepEqual(
          (await fixture.stages()).map((item) => item.stage),
          ['preflight'],
        );
        const state = await fixture.state();
        assert.deepEqual(state.installed, originalState.installed);
        assert.deepEqual(state.journal, originalState.journal);
      }
    }
    const apply = await createDeploymentCommandFixture(lifecycle, 'qualified', null, false, true, {
      commandTool: tools.file,
      guard: false,
    });
    apply.invocation().options.env.RIVET_FIXTURE_RECORDING_SETTINGS_KEY = secret;
    await save({
      ...configuration,
      identity: { ...identity, namespaceUid: (await apply.state()).namespaceUid },
      settings: { ...configuration.settings, encryptionKey: { environment: 'RIVET_FIXTURE_RECORDING_SETTINGS_KEY' } },
    });
    let guardedCommands = 0;
    const applied = await apply.qualified({
      configurationFile: file,
      privateStore: path.join(directory, 'inventory'),
      run: (program, args, options) => {
        guardedCommands++;
        assert.equal(options?.env?.RIVET_FIXTURE_RECORDING_SETTINGS_KEY, undefined);
        return runManagedGateCommand(program, args, options);
      },
      loadTransition: async () => ({ withRecordingStorageTransition }),
    });
    assert.equal(applied.status, 'deployed');
    assert.equal(guardedCommands, 1);
    assert.equal(
      JSON.parse(
        await fs.readFile(
          path.join(apply.directory, 'artifacts/qualified-attempt/private-deployment/deployment-result.json'),
          'utf8',
        ),
      ).state,
      'complete',
    );
    assert.deepEqual(
      (await pool.query('SELECT * FROM app_settings WHERE setting_key=$1', [key])).rows[0],
      before,
      'Settings reads must not initialize, rotate, timestamp or rewrite the stored settings',
    );

    // The native fixture forwards actual PostgreSQL bytes. Only its executable
    // selection is redirected; SQL, locks, proxy lifetime and guard remain real.
    const proxyFile = path.join(directory, 'proxy.mjs');
    const target = new URL(storage.databaseUrl);
    await fs.writeFile(
      proxyFile,
      `import net from 'node:net';import fs from 'node:fs';
const port=Number(process.argv.find(x=>x.startsWith('--port=')).slice(7));
const server=net.createServer(socket=>{const remote=net.connect(${Number(target.port || 5432)},${JSON.stringify(target.hostname)});socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());});
server.listen(port,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(path.join(directory, 'proxy.pid'))},String(process.pid));console.log('The proxy has started successfully and is ready for new connections!');});`,
    );
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    const proxy = {
      executable: proxyFile,
      sha256: `sha256:${createHash('sha256')
        .update(await fs.readFile(proxyFile))
        .digest('hex')}`,
      instance: 'fixture:region:database',
      port,
      databaseHost: target.hostname,
      databasePort: Number(target.port || 5432),
      sslMode: 'disable' as const,
    };
    const nativeSpawn = childProcess.spawn;
    await assert.rejects(
      withRecordingStorageTransition(
        { ...input, configuration: { ...configuration, proxy: { ...proxy, databaseHost: 'foreign.example.test' } } },
        async () => assert.fail('Proxy mapping must match before starting a process'),
      ),
      /proxy does not belong/,
    );
    // A pinned regular file which cannot be executed must settle its failed
    // spawn, rather than report an unconfirmed live proxy or invoke the action.
    await assert.rejects(
      withRecordingStorageTransition({ ...input, configuration: { ...configuration, proxy } }, async () =>
        assert.fail('Unstarted proxy must prevent deployment'),
      ),
      (error) =>
        error instanceof Error &&
        (/proxy did not become ready/.test(error.message) || (error as NodeJS.ErrnoException).code === 'EFTYPE'),
    );
    let interruptOnProxyExit = false;
    childProcess.spawn = ((program, args, options) => {
      if (program !== proxyFile) return nativeSpawn(program, args as string[], options as childProcess.SpawnOptions);
      const child = nativeSpawn(
        process.execPath,
        [proxyFile, ...(args as string[])],
        options as childProcess.SpawnOptions,
      );
      child.once('exit', () => {
        if (interruptOnProxyExit) input.interrupts.emit('SIGTERM');
      });
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    try {
      await withRecordingStorageTransition(
        { ...input, configuration: { ...configuration, proxy } },
        async ({ guardUrl }) => {
          assert.equal((await fetch(guardUrl, { method: 'POST' })).status, 200);
        },
      );
      interruptOnProxyExit = true;
      try {
        await assert.rejects(
          withRecordingStorageTransition({ ...input, configuration: { ...configuration, proxy } }, async () => {}),
          /interrupted/,
        );
      } finally {
        interruptOnProxyExit = false;
      }
      for (const fault of ['database-owner', 'proxy'] as const) {
        const marker = path.join(directory, `command-${fault}`);
        await assert.rejects(
          withRecordingStorageTransition(
            { ...input, configuration: { ...configuration, ...(fault === 'proxy' ? { proxy } : {}) } },
            async ({ signal }) => {
              const running = runManagedGateCommand(
                process.execPath,
                [
                  '-e',
                  `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`,
                ],
                { signal, settleTree: true, capture: true },
              );
              const rejected = assert.rejects(running);
              await waitFor(
                async () =>
                  fs.access(marker).then(
                    () => true,
                    () => false,
                  ),
                'Owned command must start before injecting loss',
              );
              if (fault === 'proxy')
                process.kill(Number(await fs.readFile(path.join(directory, 'proxy.pid'), 'utf8')), 'SIGTERM');
              else {
                const rows = await pool.query(
                  "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=8072 AND objid=24006 AND mode='ShareLock' AND granted",
                );
                assert.equal(rows.rows.length, 1);
                await pool.query('SELECT pg_terminate_backend($1)', [rows.rows[0].pid]);
              }
              await rejected;
              signal.throwIfAborted();
            },
          ),
          (error) => contains(error, /coordination|proxy|aborted/i),
        );
      }
    } finally {
      childProcess.spawn = nativeSpawn;
      syncBuiltinESMExports();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const dispose of [
      ...disposers.reverse(),
      () => settings.dispose(),
      async () => {
        if (inserted) await pool.query('DELETE FROM app_settings WHERE setting_key=$1', [key]);
      },
      () => fs.rm(directory, { recursive: true, force: true }),
    ]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Recording transition contract and fixture cleanup failed.');
  console.log(
    'Hosted recording transition: real PostgreSQL locks, settings, guard, CLI preflight/apply, proxy transport and ownership-loss settlement passed.',
  );
}
