// test-style: fixture-read: reads only the private configuration, receipts and child output created by these tests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  validateRecordingTransitionConfiguration,
  readRecordingTransitionConfiguration,
  resolveRecordingTransitionBootstrap,
  runRecordingTransitionCommand,
} from './lib/recording-transition-command.mjs';
import { runManagedGateCommand } from './lib/managed-gate-command.mjs';

const identity = { context: 'production', namespace: 'rivet', release: 'rivet', namespaceUid: 'owned-namespace' };
const envSpelling = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
const configuration = () => ({
  protocol: 1,
  identity,
  storageIdentity: 'a'.repeat(64),
  settings: {
    databaseUrl: { value: 'postgres://test@127.0.0.1/rivet' },
    encryptionKey: { environment: 'RIVET_TEST_TRANSITION_KEY' },
    sslMode: 'disable',
  },
});
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-transition-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'connection.json');
  await fs.writeFile(file, JSON.stringify(configuration()), { mode: 0o600 });
  const args = [
    path.join(root, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs'),
    '--context',
    identity.context,
    '--namespace',
    identity.namespace,
    '--release',
    identity.release,
    '--artifacts',
    'artifacts/result',
    '--preflight-only',
  ];
  return { root, file, args };
}

async function assertStopped(pid) {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') alive = false;
    else throw error;
  }
  if (alive && process.platform === 'linux') {
    const state = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    alive = state !== '' && !/\) [ZX] /.test(state);
  }
  assert.equal(alive, false, 'Strict release owner must settle its descendants');
}

test('transition configuration rejects unknown executable/environment hooks and mismatched installation without exposing values', () => {
  const sentinel = 'SENSITIVE-CONFIGURATION-SENTINEL';
  for (const change of [
    (x) => (x.environment = { NODE_OPTIONS: sentinel }),
    (x) => (x.settings.databaseUrl = { value: sentinel, command: 'shell' }),
    (x) => (x.identity.namespaceUid = 'foreign'),
    (x) => (x.settings.sslMode = sentinel),
    (x) => (x.proxy = { executable: sentinel }),
    (x) => (x.protocol = 2),
    (x) => (x.storageIdentity = [x.storageIdentity]),
    (x) => (x.settings.encryptionKey = { kubernetesSecret: { name: null, key: 123 } }),
    (x) => (x.settings.previousEncryptionKey = null),
  ]) {
    const value = structuredClone(configuration());
    change(value);
    assert.throws(
      () => validateRecordingTransitionConfiguration(value, identity),
      (error) =>
        error.message === 'Recording transition configuration is invalid.' && !String(error).includes(sentinel),
    );
  }
  assert.deepEqual(validateRecordingTransitionConfiguration(configuration(), identity), configuration());
});

test('private bootstrap reads a bounded pinned regular file and resolves only explicit secret references', async (t) => {
  const f = await fixture(t),
    bytes = await fs.readFile(f.file);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const config = await readRecordingTransitionConfiguration(f.file, identity, digest);
  await assert.rejects(
    readRecordingTransitionConfiguration(f.file, identity, 'sha256:' + 'b'.repeat(64)),
    /configuration is invalid/,
  );
  await assert.rejects(readRecordingTransitionConfiguration(f.root, identity), /configuration is invalid/);
  const before = JSON.stringify(process.env);
  config.settings.databaseUrl = { kubernetesSecret: { name: 'storage', key: 'url' } };
  config.settings.encryptionKey = { kubernetesSecret: { name: 'storage', key: 'key' } };
  let reads = 0;
  const result = await resolveRecordingTransitionBootstrap(config, {
    environment: {},
    run: async (program, args, options) => {
      reads++;
      assert.equal(program, 'kubectl');
      assert.deepEqual(args.slice(0, 4), ['--context', 'production', '--namespace', 'rivet']);
      assert.equal(options.capture, true);
      return {
        stdout: JSON.stringify({
          data: {
            url: Buffer.from('postgres://fixture/db\n').toString('base64'),
            key: Buffer.from('private-key\r\n').toString('base64'),
          },
        }),
      };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.environment.RIVET_APP_SETTINGS_DATABASE_URL, 'postgres://fixture:5432/db');
  assert.equal(result.environment.RIVET_APP_SETTINGS_ENCRYPTION_KEY, 'private-key');
  assert.equal(JSON.stringify(process.env), before);
  const literal = {
    ...configuration(),
    settings: {
      databaseUrl: { value: '  postgres://fixture@127.0.0.1/db?application_name=transition\n' },
      encryptionKey: { value: ' fixture\nkey\r\n' },
      sslMode: 'disable',
    },
  };
  const literalResult = await resolveRecordingTransitionBootstrap(literal);
  assert.equal(
    literalResult.environment.RIVET_APP_SETTINGS_DATABASE_URL,
    'postgres://fixture@127.0.0.1:5432/db?application_name=transition',
  );
  assert.equal(literalResult.environment.RIVET_APP_SETTINGS_ENCRYPTION_KEY, 'fixture\nkey');
  for (const environment of [
    { [envSpelling('RIVET_TEST_TRANSITION_KEY')]: ' fixture-key\r\n' },
    { rivet_test_transition_key: 'shadow-key', RIVET_TEST_TRANSITION_KEY: 'fixture-key' },
  ]) {
    const environmentResult = await resolveRecordingTransitionBootstrap(
      { ...literal, settings: { ...literal.settings, encryptionKey: { environment: 'RIVET_TEST_TRANSITION_KEY' } } },
      { environment },
    );
    assert.equal(environmentResult.environment.RIVET_APP_SETTINGS_ENCRYPTION_KEY, 'fixture-key');
  }
  await assert.rejects(
    resolveRecordingTransitionBootstrap({
      ...literal,
      settings: { ...literal.settings, databaseUrl: { value: 'postgres://fixture@127.0.0.1' } },
    }),
    /name its database/,
  );
  for (const address of [
    'postgres://fixture@127.0.0.1/db?host=foreign.example.test',
    'postgres://fixture@127.0.0.1/db?port=5444',
    'postgres:///db',
  ]) {
    await assert.rejects(
      resolveRecordingTransitionBootstrap({
        ...configuration(),
        settings: {
          databaseUrl: { value: address },
          encryptionKey: { value: 'fixture' },
          sslMode: 'disable',
        },
      }),
      /URL host and port/,
    );
  }
});

test('bridge is inert for legacy commands and guarded execution preserves arguments, signals, source and secret isolation', async (t) => {
  const f = await fixture(t);
  let calls = 0,
    loads = 0;
  const keyName = envSpelling('RIVET_TEST_TRANSITION_KEY');
  const env = { [keyName]: 'not-for-cli', [envSpelling('RIVET_RECORDING_TRANSITION_GUARD')]: 'stale' };
  if (process.platform === 'win32') env.RIVET_TEST_TRANSITION_KEY = 'not-for-cli';
  const input = {
    root: f.root,
    program: process.execPath,
    args: f.args,
    identity,
    configurationFile: undefined,
    options: { env },
    run: async (_program, args, options) => {
      calls++;
      assert.equal(args, f.args);
      assert.equal(options.cwd, f.root);
      assert.equal(options.env.RIVET_RECORDING_TRANSITION_GUARD, undefined);
      assert.ok(!Object.keys(options.env).some((key) => key.toUpperCase() === 'RIVET_RECORDING_TRANSITION_GUARD'));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    load: async () => {
      loads++;
      throw Error('Legacy must not import storage');
    },
  };
  await runRecordingTransitionCommand(input);
  assert.equal(loads, 0);
  await assert.rejects(runRecordingTransitionCommand({ ...input, required: true }), /requires protected/);
  assert.equal(calls, 1);
  env[envSpelling('RIVET_RECORDING_TRANSITION_CONFIGURATION')] = f.file;
  const digestName = envSpelling('RIVET_RECORDING_TRANSITION_CONFIGURATION_SHA256');
  env[digestName] = 'sha256:' + 'b'.repeat(64);
  await assert.rejects(runRecordingTransitionCommand({ ...input, required: true }), /configuration is invalid/);
  env[digestName] = `sha256:${createHash('sha256')
    .update(await fs.readFile(f.file))
    .digest('hex')}`;
  const signal = new AbortController().signal;
  await runRecordingTransitionCommand({
    ...input,
    required: true,
    load: async (root) => {
      assert.equal(root, f.root);
      return {
        withRecordingStorageTransition: async (guardInput, action) => {
          assert.equal(guardInput.configuration.storageIdentity, 'a'.repeat(64));
          return action({ guardUrl: 'http://127.0.0.1/private-capability', signal, requiredEncodings: ['br'] });
        },
      };
    },
    run: async (_program, args, options) => {
      calls++;
      assert.equal(args, f.args);
      assert.equal(options.signal, signal);
      assert.equal(options.settleTree, true);
      assert.equal(options.env.RIVET_TEST_TRANSITION_KEY, undefined);
      assert.ok(!Object.keys(options.env).some((key) => key.toUpperCase() === 'RIVET_TEST_TRANSITION_KEY'));
      assert.ok(
        !Object.keys(options.env).some((key) => key.toUpperCase() === 'RIVET_RECORDING_TRANSITION_CONFIGURATION'),
      );
      assert.equal(options.env.RIVET_RECORDING_TRANSITION_GUARD, 'http://127.0.0.1/private-capability');
      assert.equal(
        Object.keys(options.env).filter((key) => key.toUpperCase() === 'RIVET_RECORDING_TRANSITION_GUARD').length,
        1,
      );
      const intent = JSON.parse(
        await fs.readFile(path.join(f.root, 'artifacts/result/recording-transition-intent.json'), 'utf8'),
      );
      assert.equal(intent.guardPrepared, true);
      assert.equal(intent.commandInvoked, false);
      assert.equal(intent.completed, false);
      assert.equal(intent.configurationBinding.length, 64);
      assert.deepEqual(intent.requiredEncodings, ['br']);
      assert.ok(!JSON.stringify(intent).includes('private-capability'));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(env[keyName], 'not-for-cli');
  const audit = await fs.readFile(path.join(f.root, 'artifacts/result/recording-transition.json'), 'utf8');
  assert.equal(JSON.parse(audit).completed, true);
  assert.ok(!audit.includes('private-capability') && !audit.includes('not-for-cli'));
  const intentFile = path.join(f.root, 'artifacts/result/recording-transition-intent.json');
  const intent = await fs.readFile(intentFile, 'utf8');
  assert.equal(JSON.parse(intent).commandInvoked, false, 'The intent stays immutable after command completion');
  assert.ok(!intent.includes('private-capability') && !intent.includes('not-for-cli'));
  const failed = await fixture(t);
  const blockedArtifacts = path.join(failed.root, 'artifacts/result');
  await fs.mkdir(blockedArtifacts, { recursive: true });
  await fs.writeFile(path.join(blockedArtifacts, 'recording-transition-intent.json'), intent);
  await assert.rejects(
    runRecordingTransitionCommand({
      ...input,
      ...failed,
      configurationFile: failed.file,
      load: async () => ({
        withRecordingStorageTransition: (_input, action) =>
          action({ guardUrl: 'http://127.0.0.1/private-capability', signal, requiredEncodings: ['br'] }),
      }),
      run: async () => assert.fail('Unpersisted transition intent must prevent CLI invocation'),
    }),
    { code: 'EEXIST' },
  );
  const failure = JSON.parse(await fs.readFile(path.join(blockedArtifacts, 'recording-transition.json'), 'utf8'));
  assert.equal(failure.commandInvoked, false);
  assert.equal(failure.completed, false);
  assert.equal(await fs.readFile(path.join(blockedArtifacts, 'recording-transition-intent.json'), 'utf8'), intent);
  await assert.rejects(
    runRecordingTransitionCommand({ ...input, args: [...f.args, '--context', 'foreign'] }),
    /does not match/,
  );
  await assert.rejects(runRecordingTransitionCommand({ ...input, program: 'bash' }), /exact qualified/);
  for (const args of [f.args.filter((arg, index) => index !== 7 && index !== 8), [...f.args, '--artifacts', 'other']])
    await assert.rejects(
      runRecordingTransitionCommand({ ...input, configurationFile: f.file, args }),
      /one evidence directory/,
    );
  await assert.rejects(
    runRecordingTransitionCommand({ ...input, configurationFile: f.file, load: async () => ({}) }),
    /predates hosted/,
  );
});

test(
  'strict native owner preserves argument bytes and removes descendants which outlive their parent',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const values = ['space value', 'quote"value', 'tail\\', '$literal`value'];
    const commandEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
    );
    commandEnvironment[process.platform === 'win32' ? 'Path' : 'PATH'] =
      `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
    const result = await runManagedGateCommand(
      path.basename(process.execPath),
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values],
      { settleTree: true, capture: true, env: commandEnvironment },
    );
    assert.deepEqual(JSON.parse(result.stdout), values);
    for (const stdio of ['ignore', 'inherit']) {
      const marker = path.join(f.root, `child-ready-${stdio}`);
      const child = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
      await runManagedGateCommand(
        process.execPath,
        [
          '-e',
          `const fs=require('node:fs');const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:${JSON.stringify(stdio)},detached:${process.platform === 'win32'},windowsHide:true}).unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(t)}},10)`,
        ],
        { settleTree: true, capture: true, signal: t.signal },
      );
      // The process belongs to this test's creation chain, never a discovered name.
      await assertStopped(Number(await fs.readFile(marker, 'utf8')));
    }
  },
);

for (const cooperative of [true, false])
  test(
    `strict command interruption rejects ${cooperative ? 'cooperative zero exit' : 'ignored termination'} and settles native descendants`,
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        marker = path.join(f.root, 'command-ready');
      const cancel = new AbortController();
      const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`;
      const rejected = assert.rejects(
        runManagedGateCommand(
          process.execPath,
          [
            '-e',
            `process.on('SIGTERM',()=>{${cooperative ? 'process.exit(0)' : ''}});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore',detached:${process.platform === 'win32'},windowsHide:true}).unref();setInterval(()=>{},1000)`,
          ],
          { settleTree: true, capture: true, signal: AbortSignal.any([cancel.signal, t.signal]) },
        ),
        /owned cancellation/,
      );
      const deadline = Date.now() + 10000;
      try {
        while (
          !(await fs.access(marker).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() >= deadline) throw Error('Owned command did not become ready for cancellation');
          t.signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        cancel.abort(Error('owned cancellation'));
      }
      await rejected;
      await assertStopped(Number(await fs.readFile(marker, 'utf8')));
    },
  );

test(
  'ordinary journaled failure retains its original receipt-managed observer for acceptance-only recovery',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      marker = path.join(f.root, 'observer-ready'),
      token = randomUUID();
    const observer = `const fs=require('node:fs');const http=require('node:http');const server=http.createServer((req,res)=>{res.end('owned');if(req.method==='POST'&&req.url==='/${token}')server.close(()=>process.exit(0));});server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({port:server.address().port}));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});});`;
    const parent = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(observer)}],{stdio:'ignore',detached:true,windowsHide:true}).unref();setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(17)},10)`;
    let url;
    let stopping;
    const stopObserver = () =>
      (stopping ??= (async () => {
        if (url) await (await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000) })).text();
      })());
    t.after(stopObserver);
    try {
      const rejected = assert.rejects(
        runManagedGateCommand(process.execPath, ['-e', parent], {
          capture: true,
          settleTree: true,
          retainOnFailure: true,
          signal: t.signal,
        }),
        /exit code 17/,
      );
      const deadline = Date.now() + 10000;
      while (
        !(await fs.access(marker).then(
          () => true,
          () => false,
        ))
      ) {
        if (Date.now() >= deadline) throw Error('Receipt-managed observer did not publish readiness');
        t.signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      url = `http://127.0.0.1:${JSON.parse(await fs.readFile(marker, 'utf8')).port}/${token}`;
      await rejected;
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      await response.text();
    } finally {
      await stopObserver();
    }
  },
);
