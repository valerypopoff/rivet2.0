import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertFreshRehearsalResources,
  assertOwnedRehearsalCompose,
  assertRehearsalEnvironment,
  pinRehearsalImages,
  REHEARSAL_PHASES,
  REHEARSAL_TOOLS,
  assertRehearsalPhases,
  readRehearsalPhases,
} from './local-upgrade-rehearsal-safety.mjs';
import { createFixtureRegistry, fixturePackage } from './local-upgrade-fixture-registry.mjs';
import { gunzipSync } from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  run as runRehearsalCommand,
  stageLocalUpgradeRehearsalTools,
  readOnlyRehearsalSqliteScript,
  webAppBindingProbeScript,
  waitForRehearsalCondition,
  readRehearsalSourceFingerprint,
  assertLegacyRehearsalSource,
  rehearsalComposeInvocation,
  collectRehearsalDiagnostics,
  rehearsalInitializerCommand,
} from './local-upgrade-image-rehearsal.mjs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';

test('rehearsal initializer owns export scratch without losing the legacy source seed', (t) => {
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/sh.exe' : 'sh';
  const probe = spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf8', timeout: 5000 });
  if (probe.error?.code === 'ENOENT') return t.skip('POSIX shell unavailable');
  assert.equal(probe.status, 0, probe.stderr);
  // Observe shell actions without touching absolute fixture or production paths.
  const script =
    'mkdir() { printf "mkdir:%s\\n" "$*"; }; ' +
    'chown() { printf "chown:%s\\n" "$*"; }; ' +
    'chmod() { printf "chmod:%s\\n" "$*"; }; ' +
    rehearsalInitializerCommand();
  const result = spawnSync(shell, ['-ec', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const actions = result.stdout.trim().split(/\r?\n/);
  assert.equal(actions[0], 'mkdir:-p /restored /workflows/empty');
  assert.ok(actions[1].startsWith('chown:-R 10001:10001 '));
  const owned = actions[1].slice('chown:-R 10001:10001 '.length).split(' ');
  for (const directory of [
    '/workflows',
    '/workflow-recordings',
    '/data/runtime-libraries',
    '/data/rivet-app',
    '/data/local-metadata',
    '/data/project-bundles',
    '/restored',
  ])
    assert.ok(owned.includes(directory), `${directory} must belong to the runtime user`);
  assert.equal(actions[2], 'chmod:700 /data/project-bundles');
  assert.equal(actions.length, 3);
});

test('Compose fixture excludes ambient app settings and provider credentials, and never loads repository dotenv', () => {
  const config = { project: 'owned', composeFile: path.resolve('owned/compose.json'), env: { RIVET_KEY: 'fixture' } };
  const ambient = {
    PATH: 'tools',
    DOCKER_CONTEXT: 'desktop-linux',
    RIVET_KEY: 'operator-key',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '/operator/root',
    RIVET_API_TMPFS_SIZE: 'invalid',
    RIVET_SERVER_UI_AUTH_MODE: 'none',
    OPENAI_API_KEY: 'operator-secret',
    PINECONE_API_KEY: 'operator-secret',
  };
  const invocation = rehearsalComposeInvocation(config, ['config', '--format', 'json'], ambient);
  assert.deepEqual(invocation.env, { PATH: 'tools', DOCKER_CONTEXT: 'desktop-linux', RIVET_KEY: 'fixture' });
  assert.equal(invocation.args[invocation.args.indexOf('--env-file') + 1], path.resolve('owned/rehearsal.env'));
  assert.deepEqual(invocation.args.slice(-3), ['config', '--format', 'json']);
  assert.equal(ambient.RIVET_KEY, 'operator-key', 'Caller environment must remain unchanged.');
  assert.throws(() => rehearsalComposeInvocation({ ...config, env: { DOCKER_HOST: 'foreign' } }, []));
});

test('diagnostic probe failure still collects logs and neither fallback exposes exception contents', async () => {
  for (const failProbe of [false, true])
    for (const failLogs of [false, true]) {
      const calls = [];
      const result = await collectRehearsalDiagnostics(
        async () => {
          calls.push('probe');
          if (failProbe) throw new Error('operator-secret');
          return { code: 0, output: 'safe-probe' };
        },
        async () => {
          calls.push('logs');
          if (failLogs) throw new Error('operator-secret');
          return { output: 'container-log' };
        },
      );
      assert.deepEqual(calls, ['probe', 'logs']);
      assert.equal(result.diagnostic.code, failProbe ? 1 : 0);
      assert.ok(result.output.includes(failProbe ? 'recheck unavailable' : 'safe-probe'));
      assert.ok(result.output.includes(failLogs ? 'logs unavailable' : 'container-log'));
      assert.ok(!result.output.includes('operator-secret'));
    }
});

test('migration rehearsal refuses fresh SQLite or a previously copied generation before seeding', () => {
  assertLegacyRehearsalSource({ available: false, runningBackend: 'file', transition: null });
  assertLegacyRehearsalSource({ runningBackend: 'legacy', transition: null });
  assertLegacyRehearsalSource({ runningBackend: 'legacy', transition: { generationId: null } });
  for (const status of [
    undefined,
    {},
    { runningBackend: 'sqlite' },
    { available: false, runningBackend: 'sqlite' },
    { available: true, runningBackend: 'file' },
    { runningBackend: 'legacy', transition: { generationId: 'already-copied' } },
  ])
    assert.throws(() => assertLegacyRehearsalSource(status));
});

// test-style: fixture-read: Compare only test-generated SQLite database bytes before and after the read-only probe; never read production source text.

for (const lockedFile of ['transition.sqlite', 'generations/fixture/catalog.sqlite']) {
  for (const releaseLock of [true, false]) {
    test(`web-app probe ${releaseLock ? 'waits for' : 'refuses a persistent'} lock on ${lockedFile}`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-rehearsal-sqlite-'));
      let writer;
      let reader;
      let releaseTimer;
      let deadline;
      const binding = { appId: 'fixture-app', slug: 'fixture-slug', allowedEmails: ['fixture@example.invalid'] };
      try {
        await fs.mkdir(path.join(root, 'generations/fixture'), { recursive: true });
        const journal = new DatabaseSync(path.join(root, 'transition.sqlite'));
        try {
          journal.exec(
            "CREATE TABLE transition_state(singleton INTEGER,phase TEXT,generation_id TEXT); INSERT INTO transition_state VALUES(1,'sqlite-live','fixture');",
          );
        } finally {
          journal.close();
        }
        const catalog = new DatabaseSync(path.join(root, 'generations/fixture/catalog.sqlite'));
        try {
          catalog.exec('CREATE TABLE web_apps(metadata_json TEXT);');
          catalog
            .prepare('INSERT INTO web_apps VALUES(?)')
            .run(JSON.stringify({ ...binding, uiGraphId: 'release-gate-web-app' }));
        } finally {
          catalog.close();
        }
        writer = new DatabaseSync(path.join(root, lockedFile));
        writer.exec('BEGIN EXCLUSIVE');
        const script = webAppBindingProbeScript(root, releaseLock ? 5000 : 50);
        reader = spawn(
          process.execPath,
          ['--input-type=module', '-e', `await import('node:sqlite');process.send('started');${script}`],
          {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true,
          },
        );
        let output = '';
        let errors = '';
        let started = false;
        reader.stdout.on('data', (chunk) => {
          output += chunk;
        });
        reader.stderr.on('data', (chunk) => {
          errors += chunk;
        });
        reader.on('message', (message) => {
          assert.equal(message, 'started');
          started = true;
          if (releaseLock) releaseTimer = setTimeout(() => writer.exec('COMMIT'), 500);
        });
        const code = await new Promise((resolve, reject) => {
          reader.once('error', reject);
          reader.once('close', resolve);
          deadline = setTimeout(() => {
            reader.kill();
            reject(new Error('Probe did not respect its lock deadline'));
          }, 15_000);
        });
        assert.equal(started, true);
        if (releaseLock) {
          assert.equal(code, 0, errors);
          assert.deepEqual(JSON.parse(output.trim()), binding);
        } else {
          assert.notEqual(code, 0);
          assert.match(errors, /database is locked/);
          assert.equal(output, '', 'A timed-out probe must not publish a binding.');
        }
      } finally {
        clearTimeout(releaseTimer);
        clearTimeout(deadline);
        reader?.kill();
        writer?.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const module of [true, false]) {
  test(`rehearsal SQLite reader stays read-only in ${module ? 'ESM' : 'CommonJS'} scripts`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-rehearsal-readonly-'));
    try {
      const file = path.join(root, 'fixture.sqlite');
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE fixture(value INTEGER); INSERT INTO fixture VALUES(7)');
      db.close();
      const before = await fs.readFile(file);
      const script = readOnlyRehearsalSqliteScript(
        `
        const db=openReadOnly(${JSON.stringify(file)});
        try {
          if(db.prepare('PRAGMA busy_timeout').get().timeout!==5000)throw Error('Wrong timeout');
          console.log(db.prepare('SELECT value FROM fixture').get().value);
          db.exec('UPDATE fixture SET value=8');
        } finally { db.close(); }
      `,
        { module },
      );
      const result = await runRehearsalCommand(
        process.execPath,
        [...(module ? ['--input-type=module'] : []), '-e', script],
        process.env,
        true,
      );
      assert.notEqual(result.code, 0);
      assert.match(result.output, /7\r?\n/);
      assert.match(result.output, /readonly database/);
      assert.deepEqual(await fs.readFile(file), before);
    } finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('rehearsal SQLite lock waits are finite and cannot be configured away', () => {
  for (const busyTimeoutMs of [0, -1, 5001, Infinity, NaN, 0.5, '5000']) {
    assert.throws(() => readOnlyRehearsalSqliteScript('', { busyTimeoutMs }));
  }
});

for (const failure of [
  'wrong-phase',
  'invalid-generation',
  'missing-binding',
  'corrupt-catalog',
  'duplicate-binding',
  'invalid-binding',
  'invalid-policy',
  'malformed-metadata',
]) {
  test(`web-app probe still rejects ${failure} without publishing evidence`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-rehearsal-invalid-'));
    try {
      await fs.mkdir(path.join(root, 'generations/fixture'), { recursive: true });
      const journal = new DatabaseSync(path.join(root, 'transition.sqlite'));
      try {
        journal.exec('CREATE TABLE transition_state(singleton INTEGER,phase TEXT,generation_id TEXT)');
        journal
          .prepare('INSERT INTO transition_state VALUES(1,?,?)')
          .run(
            failure === 'wrong-phase' ? 'legacy' : 'sqlite-live',
            failure === 'invalid-generation' ? '../foreign' : 'fixture',
          );
      } finally {
        journal.close();
      }
      const file = path.join(root, 'generations/fixture/catalog.sqlite');
      if (failure === 'corrupt-catalog') await fs.writeFile(file, 'not a database');
      else {
        const db = new DatabaseSync(file);
        try {
          db.exec('CREATE TABLE web_apps(metadata_json TEXT)');
          const binding = {
            appId: 'fixture-app',
            slug: 'fixture-slug',
            allowedEmails: [],
            uiGraphId: 'release-gate-web-app',
          };
          if (failure === 'duplicate-binding') {
            for (const appId of ['first', 'second'])
              db.prepare('INSERT INTO web_apps VALUES(?)').run(JSON.stringify({ ...binding, appId }));
          } else if (failure === 'invalid-binding' || failure === 'invalid-policy') {
            db.prepare('INSERT INTO web_apps VALUES(?)').run(
              JSON.stringify({
                ...binding,
                ...(failure === 'invalid-binding' ? { appId: null } : { allowedEmails: null }),
              }),
            );
          } else if (failure === 'malformed-metadata') db.prepare('INSERT INTO web_apps VALUES(?)').run('{');
        } finally {
          db.close();
        }
      }
      const result = await runRehearsalCommand(
        process.execPath,
        ['--input-type=module', '-e', webAppBindingProbeScript(root)],
        process.env,
        true,
      );
      assert.notEqual(result.code, 0);
      assert.match(
        result.output,
        failure === 'corrupt-catalog'
          ? /not a database/
          : failure === 'malformed-metadata'
            ? /SyntaxError/
            : failure === 'missing-binding' || failure === 'duplicate-binding'
              ? /Fixture binding absent or ambiguous/
              : failure === 'invalid-binding' || failure === 'invalid-policy'
                ? /Invalid fixture binding/
                : /Not selected fixture/,
      );
      assert.doesNotMatch(result.output, /^\{"appId":/m, 'A failed probe must not emit a binding receipt.');
      assert.deepEqual(await fs.readdir(path.join(root, 'generations')), ['fixture']);
    } finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('fingerprint evidence accepts one valid CLI receipt with ordinary diagnostics', () => {
  const fingerprint = 'ab'.repeat(32);
  assert.equal(
    readRehearsalSourceFingerprint(`ordinary warning\n${JSON.stringify({ sourceFingerprint: fingerprint })}\r\n`),
    fingerprint,
  );
});

test('fingerprint evidence rejects missing, malformed and ambiguous proof instead of equating absent values', () => {
  const receipt = JSON.stringify({ sourceFingerprint: 'ab'.repeat(32) });
  for (const output of [
    '',
    '{}',
    '{',
    '{"error":"failed"}',
    `${receipt}\n${receipt}`,
    ...[null, 0, '', 'ab'.repeat(31), 'AB'.repeat(32), 'x'.repeat(64)].map((sourceFingerprint) =>
      JSON.stringify({ sourceFingerprint }),
    ),
  ]) {
    assert.throws(() => readRehearsalSourceFingerprint(output));
  }
});

test('readiness polling supplies a bounded shared IO budget and accepts timely readiness', async () => {
  await waitForRehearsalCondition(
    async (budget) => {
      assert.ok(budget > 0 && budget <= 15_000);
      return true;
    },
    120_000,
    'not ready',
  );
});

test('readiness polling rejects even successful evidence arriving after its deadline', async () => {
  let calls = 0;
  await assert.rejects(
    waitForRehearsalCondition(
      async (budget) => {
        calls++;
        assert.ok(budget > 0 && budget <= 50);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return true;
      },
      50,
      'not ready in time',
    ),
    /not ready in time/,
  );
  assert.equal(calls, 1);
});

test('readiness polling bounds a stalled child command and never mistakes timeout for readiness', async () => {
  let calls = 0;
  await assert.rejects(
    waitForRehearsalCondition(
      async (budget) => {
        calls++;
        const result = await runRehearsalCommand(
          process.execPath,
          ['-e', 'setInterval(()=>{},1000)'],
          process.env,
          true,
          budget,
        );
        return result.code === 0;
      },
      250,
      'stalled probe',
    ),
    /stalled probe/,
  );
  assert.equal(calls, 1);
});

test('readiness polling validates finite deadlines and propagates safety failures without retry', async () => {
  for (const timeout of [0, -1, 120001, Infinity, NaN, 0.5]) {
    await assert.rejects(waitForRehearsalCondition(async () => true, timeout, 'invalid'));
  }
  let calls = 0;
  await assert.rejects(
    waitForRehearsalCondition(
      async () => {
        calls++;
        throw new Error('ownership refused');
      },
      1000,
      'not ready',
    ),
    /ownership refused/,
  );
  assert.equal(calls, 1);
});

test('staged backup tools import successfully with their real deployment dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-rehearsal-tools-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  try {
    await stageLocalUpgradeRehearsalTools(root);
    const backup = pathToFileURL(path.join(root, 'fixture-tools/scripts/local-upgrade-backup.mjs')).href;
    const result = await runRehearsalCommand(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const tools=await import(${JSON.stringify(backup)});if(typeof tools.createLocalUpgradeBackup!=='function'||typeof tools.restoreLocalUpgradeBackup!=='function')throw new Error('Missing backup entrypoints');`,
      ],
      process.env,
    );
    assert.equal(result.code, 0);
    // Restaging must not silently overwrite evidence from an earlier fixture.
    await assert.rejects(stageLocalUpgradeRehearsalTools(root), { code: 'EEXIST' });
    await fs.unlink(path.join(root, 'fixture-tools/images/api/local-upgrade-ui.mjs'));
    const incomplete = await runRehearsalCommand(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(backup)});`],
      process.env,
      true,
    );
    assert.notEqual(incomplete.code, 0);
    assert.match(incomplete.output, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const linkedParent of ['fixture-tools', 'fixture-tools/images'])
  test(`tool staging refuses ${linkedParent} symlinks before creating foreign directories`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-rehearsal-links-'));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    const owned = path.join(root, 'owned');
    const foreign = path.join(root, 'foreign');
    const link = path.join(owned, linkedParent);
    try {
      await fs.mkdir(foreign);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(stageLocalUpgradeRehearsalTools(owned), /symlink ancestors/);
      assert.deepEqual(await fs.readdir(foreign), [], 'No mkdir or copy may traverse the foreign parent.');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

test('rehearsal command waits for drained pipes and retains only a bounded output tail', async () => {
  const marker = 'generated-final-output-marker';
  const result = await runRehearsalCommand(
    process.execPath,
    ['-e', `process.stdout.write('x'.repeat(2*1048576)+${JSON.stringify(marker)},()=>process.exit(0));`],
    process.env,
  );
  assert.equal(result.code, 0);
  assert.equal(result.output.length, 1048576);
  assert.ok(result.output.endsWith(marker));
});

test('rehearsal command deadlines cannot become successful evidence even if termination exits zero', async () => {
  const args = ['-e', "process.on('SIGTERM',()=>process.exit(0));console.log('READY');setInterval(()=>{},1000);"];
  await assert.rejects(runRehearsalCommand(process.execPath, args, process.env, false, 750), /timed out/);
  const result = await runRehearsalCommand(process.execPath, args, process.env, true, 750);
  assert.equal(result.code, 1);
  assert.ok(result.output.includes('READY'));
});

test(
  'rehearsal command force-stops a foreground process that ignores SIGTERM',
  { skip: process.platform === 'win32' },
  async () => {
    const result = await runRehearsalCommand(
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000);"],
      process.env,
      true,
      750,
    );
    assert.equal(result.code, 1);
    assert.ok(result.output.includes('READY'));
  },
);

test('phase evidence requires actual passed receipts, unique names and valid timestamps', () => {
  const receipts = REHEARSAL_PHASES.map((name) => ({ name, status: 'passed', checkedAt: '2026-09-28T12:00:00.000Z' }));
  assertRehearsalPhases(receipts, true);
  assert.throws(() => assertRehearsalPhases(receipts.slice(1), true));
  assert.throws(() => assertRehearsalPhases([...receipts, receipts[0]]));
  for (const change of [
    { status: 'not-run' },
    { status: 'failed' },
    { checkedAt: 'not-a-date' },
    { name: 'unknown' },
  ]) {
    assert.throws(() => assertRehearsalPhases([{ ...receipts[0], ...change }]));
  }
});

test('phase reader refuses symlinks and malformed evidence without following foreign files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-phase-evidence-'));
  try {
    const file = path.join(root, 'phases.json');
    assert.deepEqual(await readRehearsalPhases(file), []);
    await fs.writeFile(file, '[]');
    assert.deepEqual(await readRehearsalPhases(file), []);
    await fs.writeFile(file, '[{"name":"conversion","status":"not-run"}]');
    await assert.rejects(readRehearsalPhases(file));
    await fs.writeFile(file, '[]');
    const link = path.join(root, 'linked');
    // Windows directory junctions require no symlink privilege.
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readRehearsalPhases(path.join(link, 'phases.json')));
    await assert.rejects(readRehearsalPhases(path.join(link, 'missing.json')));
    await fs.unlink(link);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('manifest configuration cannot redirect Docker or inject host Node options', () => {
  assertRehearsalEnvironment({ RIVET_PORT: '127.0.0.1:23456', HTTP_PROXY: '' });
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'NODE_OPTIONS', 'COMPOSE_FILE', 'PATH'])
    assert.throws(() => assertRehearsalEnvironment({ [key]: 'unsafe' }));
});

function fixture() {
  const project = 'rivet-local-upgrade-rehearsal-12345678-1234-1234-1234-123456789abc';
  const id = 'sha256:' + 'a'.repeat(64);
  const config = {
    project,
    port: 23456,
    registryScript: '/owned/registry.mjs',
    images: { api: { id }, web: { id }, proxy: { id } },
  };
  const model = {
    name: project,
    volumes: { data: { name: project + '_data' } },
    networks: {
      default: { name: project + '_default', internal: true },
      edge: { name: project + '_edge' },
    },
    services: Object.fromEntries(
      ['api', 'web', 'proxy', 'filesystem-artifacts-init', 'fixture-registry'].map((name) => [
        name,
        {
          image: id,
          networks: name === 'proxy' ? { default: {}, edge: {} } : { default: {} },
          volumes:
            name === 'fixture-registry'
              ? [{ type: 'bind', source: config.registryScript, target: '/fixture-registry.mjs', read_only: true }]
              : [{ type: 'volume', source: 'data' }],
          ports: name === 'proxy' ? [{ host_ip: '127.0.0.1', published: '23456', target: 8080 }] : [],
        },
      ]),
    ),
  };
  return { config, model };
}
test('only the project-owned isolated fixture model is accepted', () => {
  const { config, model } = fixture();
  model.networks.default.ipam = {};
  assertOwnedRehearsalCompose(config, model);
});

for (const file of REHEARSAL_TOOLS)
  test(`backup tool ${file} requires its exact read-only fixture binding`, () => {
    const { config, model } = fixture();
    const mount = {
      type: 'bind',
      source: path.join(path.dirname(config.registryScript), 'fixture-tools', file),
      target: '/fixture-tools/' + file,
      read_only: true,
    };
    model.services.api.volumes.push(mount);
    assertOwnedRehearsalCompose(config, model);
    for (const change of [
      { read_only: false },
      { source: '/prod/local-upgrade-backup.mjs' },
      { target: '/fixture-tools/unreviewed.mjs' },
      { target: '/tools/local-upgrade-backup.mjs' },
    ]) {
      const changed = structuredClone(model);
      Object.assign(changed.services.api.volumes.at(-1), change);
      assert.throws(() => assertOwnedRehearsalCompose(config, changed));
    }
    const changed = structuredClone(model);
    changed.services.web.volumes.push(mount);
    assert.throws(() => assertOwnedRehearsalCompose(config, changed));
  });

test('existing prefixed volumes or networks are not reusable disposable resources', () => {
  const { model } = fixture();
  assertFreshRehearsalResources(model, { volumes: [], networks: [] });
  assert.throws(() => assertFreshRehearsalResources(model, { volumes: [model.volumes.data.name], networks: [] }));
  assert.throws(() => assertFreshRehearsalResources(model, { volumes: [], networks: [model.networks.default.name] }));
});
for (const [name, change] of [
  [
    'fixed-name volume',
    (m) => {
      m.volumes.data.name = 'ops_data';
    },
  ],
  [
    'external volume',
    (m) => {
      m.volumes.data.external = true;
    },
  ],
  [
    'host-backed volume',
    (m) => {
      m.volumes.data.driver_opts = { device: '/prod' };
    },
  ],
  [
    'foreign bind',
    (m) => {
      m.services.api.volumes = [{ type: 'bind', source: '/prod', target: '/workflows' }];
    },
  ],
  [
    'host-backed secret',
    (m) => {
      m.secrets = { host: { file: '/prod.env' } };
    },
  ],
  [
    'host-backed config',
    (m) => {
      m.configs = { host: { file: '/prod.conf' } };
    },
  ],
  [
    'implicit Docker API socket',
    (m) => {
      m.services.api.use_api_socket = true;
    },
  ],
  [
    'lifecycle hook',
    (m) => {
      m.services.proxy.post_start = [{ command: 'unsafe' }];
    },
  ],
  [
    'foreign volume',
    (m) => {
      m.services.api.volumes = [{ type: 'volume', source: 'ops_data' }];
    },
  ],
  [
    'mutable image',
    (m) => {
      m.services.api.image = 'api:latest';
    },
  ],
  [
    'public port',
    (m) => {
      m.services.proxy.ports[0].host_ip = '0.0.0.0';
    },
  ],
  [
    'backend edge network',
    (m) => {
      m.services.api.networks.edge = {};
    },
  ],
  [
    'external network',
    (m) => {
      m.networks.default.external = true;
    },
  ],
  [
    'host namespace',
    (m) => {
      m.services.api.network_mode = 'host';
    },
  ],
])
  test(`fixture creation and cleanup reject ${name}`, () => {
    const { config, model } = fixture();
    change(model);
    assert.throws(() => assertOwnedRehearsalCompose(config, model));
  });
test('image tags resolve to immutable IDs and mismatched revisions are refused', () => {
  const image = {
    Id: 'sha256:' + 'b'.repeat(64),
    RepoDigests: ['repo@sha256:' + 'c'.repeat(64)],
    Config: { Labels: { 'org.opencontainers.image.revision': 'd'.repeat(40) } },
  };
  const images = { api: image, web: image, proxy: image };
  assert.equal(pinRehearsalImages(images).api.id, image.Id);
  assert.throws(() =>
    pinRehearsalImages({
      ...images,
      web: { ...image, Config: { Labels: { 'org.opencontainers.image.revision': 'e'.repeat(40) } } },
    }),
  );
  assert.throws(() => pinRehearsalImages({ ...images, web: { ...image, Config: {} } }));
  assert.doesNotThrow(() => pinRehearsalImages(images, 'd'.repeat(40)));
  assert.throws(() => pinRehearsalImages(images, 'e'.repeat(40)));
});
test('offline registry serves deterministic real package archives and refuses other packages', async () => {
  const server = createFixtureRegistry();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const manifest = await (await fetch(base + '/example')).json();
    assert.deepEqual(Object.keys(manifest.versions), ['1.0.0', '2.0.0']);
    assert.equal((await fetch(base + '/other')).status, 404);
    for (const version of ['1.0.0', '2.0.0']) {
      const bytes = Buffer.from(await (await fetch(base + `/example/-/example-${version}.tgz`)).arrayBuffer());
      assert.deepEqual(bytes, fixturePackage(version));
      assert.ok(gunzipSync(bytes).includes(Buffer.from(`module.exports=${version === '1.0.0' ? 42 : 84};`)));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
