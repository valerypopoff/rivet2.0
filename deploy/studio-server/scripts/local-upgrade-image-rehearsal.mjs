import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFreshRehearsalResources,
  assertOwnedRehearsalCompose,
  assertRealPath,
  assertRehearsalEnvironment,
  pinRehearsalImages,
  REHEARSAL_PHASES,
  assertRehearsalPhases,
  readRehearsalPhases,
} from './local-upgrade-rehearsal-safety.mjs';
import { restoredReadinessProbeScript } from './local-upgrade-restored-rehearsal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = '/app/packages/studio-server-api/dist/studio-server-api/src/scripts/';
const prefix = 'rivet-local-upgrade-rehearsal-';
const requiredPhases = REHEARSAL_PHASES;

export async function recordLocalUpgradeRehearsalPhase(file, phase) {
  assert.ok(requiredPhases.includes(phase), 'Unknown rehearsal evidence phase.');
  await loadLocalUpgradeRehearsal(file);
  const evidenceFile = path.join(path.dirname(file), 'phases.json');
  const phases = await readRehearsalPhases(evidenceFile);
  assert.ok(!phases.some((item) => item.name === phase), 'Duplicate evidence phase.');
  phases.push({ name: phase, status: 'passed', checkedAt: new Date().toISOString() });
  await fs.writeFile(evidenceFile, JSON.stringify(phases));
}

export async function run(command, args, env, allowFailure = false, timeoutMs = 20 * 60_000) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 20 * 60_000);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    let forceStop;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceStop = setTimeout(() => {
        child.kill('SIGKILL');
        // A descendant may have inherited these pipes. Timed-out output is
        // never success evidence; do not wait forever for its final drain.
        child.stdout.destroy();
        child.stderr.destroy();
      }, 5_000);
      forceStop.unref();
    }, timeoutMs);
    timeout.unref();
    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(forceStop);
    };
    let output = '';
    const append = (chunk) => {
      output = (output + chunk).slice(-1024 * 1024);
    };
    child.stdout.on('data', (chunk) => {
      append(chunk);
    });
    child.stderr.on('data', (chunk) => {
      append(chunk);
    });
    child.on('error', (error) => {
      clearTimers();
      reject(error);
    });
    // exit can precede the final stdout/stderr data; close certifies that the
    // bounded diagnostic/JSON tail has actually been collected.
    child.on('close', (code) => {
      clearTimers();
      if (timedOut) {
        if (allowFailure) resolve({ code: 1, output });
        else reject(new Error(`Rehearsal command ${command} timed out.`));
      } else if (code === 0 || allowFailure) resolve({ code, output });
      else reject(new Error(`Rehearsal command ${command} failed (${code}). ${output.slice(-6000)}`));
    });
  });
}

export async function loadLocalUpgradeRehearsal(file) {
  const resolved = path.resolve(file);
  const relative = path.relative(path.join(root, 'artifacts', 'local-upgrade'), resolved);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Rehearsal manifest must be inside owned artifacts.',
  );
  await assertRealPath(resolved);
  await assertRealPath(path.dirname(resolved), true);
  let config;
  try {
    config = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch {
    throw new Error('Invalid rehearsal manifest.');
  }
  assertRehearsalEnvironment(config.env);
  assert.equal(config.version, 2);
  assert.match(config.project, /^rivet-local-upgrade-rehearsal-[a-f0-9-]{36}$/);
  assert.equal(config.composeFile, path.join(path.dirname(resolved), 'compose.json'));
  assert.equal(config.baseUrl, `http://127.0.0.1:${config.port}`);
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  assert.equal(config.registryScript, path.join(path.dirname(resolved), 'fixture-registry.mjs'));
  await assertRealPath(config.registryScript);
  for (const name of ['local-upgrade-backup.mjs', 'local-upgrade-snapshot-plan.mjs'])
    await assertRealPath(path.join(path.dirname(resolved), name));
  return config;
}
function rawCompose(config, args, allowFailure = false) {
  return run(
    'docker',
    [
      'compose',
      '-p',
      config.project,
      '-f',
      'deploy/studio-server/compose/docker-compose.yml',
      '-f',
      config.composeFile,
      ...args,
    ],
    { ...process.env, ...config.env },
    allowFailure,
  );
}
async function compose(config, args, allowFailure = false) {
  const rendered = await rawCompose(config, ['config', '--format', 'json']);
  assertOwnedRehearsalCompose(config, JSON.parse(rendered.output));
  return rawCompose(config, args, allowFailure);
}
async function waitReady(config) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await compose(config, ['exec', '-T', 'api', 'node', '-e', restoredReadinessProbeScript()], true);
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Isolated combined backend did not become ready.');
}

/** Controls are local test operations on an explicitly created disposable
 * project. No browser endpoint exposes Docker or these operations. */
export async function controlLocalUpgradeRehearsal(file, action) {
  const config = await loadLocalUpgradeRehearsal(file);
  if (action === 'read-web-app-binding') {
    const result = await compose(config, [
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `
      const {DatabaseSync}=await import('node:sqlite');
      const journal=new DatabaseSync('/data/local-metadata/transition.sqlite',{readOnly:true});
      const state=journal.prepare('SELECT phase,generation_id FROM transition_state WHERE singleton=1').get();journal.close();
      if(state.phase!=='sqlite-live'||!/^[a-zA-Z0-9_-]+$/.test(state.generation_id))throw Error('Not selected fixture');
      const db=new DatabaseSync('/data/local-metadata/generations/'+state.generation_id+'/catalog.sqlite',{readOnly:true});
      try{const app=db.prepare('SELECT metadata_json FROM web_apps').all().map(row=>JSON.parse(row.metadata_json)).find(app=>app.uiGraphId==='release-gate-web-app');
      if(!app)throw Error('Fixture binding absent');console.log(JSON.stringify({appId:app.appId,slug:app.slug,allowedEmails:app.allowedEmails}));}finally{db.close();}
    `,
    ]);
    return result.output
      .trim()
      .split('\n')
      .find((line) => line.startsWith('{'));
  }
  if (action === 'backup-and-restore-selected') {
    await compose(config, ['stop', '-t', '15', 'api']);
    const stopped = await compose(config, ['ps', '--all', '--format', 'json', 'api']);
    const parsed = JSON.parse(stopped.output.trim());
    assert.ok((Array.isArray(parsed) ? parsed : [parsed]).every((container) => container.State === 'exited'));
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      '--input-type=module',
      '-e',
      `
      const {createLocalUpgradeBackup,restoreLocalUpgradeBackup}=await import('/fixture-tools/local-upgrade-backup.mjs');
      const roots={workflows:'/workflows',recordings:'/workflow-recordings',appData:'/data/rivet-app',runtimeLibraries:'/data/runtime-libraries',control:'/data/local-metadata'};
      const result=await createLocalUpgradeBackup({roots,destination:'/restored/sqlite-backup',sqlite:true,assertFrozen:async()=>{}});
      await restoreLocalUpgradeBackup({backup:result.destination,receipt:result.receipt,destination:'/restored/sqlite-restored'});
    `,
    ]);
    const model = JSON.parse(await fs.readFile(config.composeFile, 'utf8'));
    const domains = {
      workflows: '/workflows',
      recordings: '/workflow-recordings',
      appData: '/data/rivet-app',
      runtimeLibraries: '/data/runtime-libraries',
      control: '/data/local-metadata',
    };
    for (const [domain, target] of Object.entries(domains)) {
      const source = 'sqlite_restored_' + domain;
      model.volumes[source] = {};
      model.services.api.volumes = model.services.api.volumes.filter((mount) => mount.target !== target);
      model.services.api.volumes.push({ type: 'volume', source, target, volume: { nocopy: true } });
    }
    model.services.api.volumes.push({
      type: 'volume',
      source: 'sqlite_restored_appData',
      target: '/home/rivet/.local/share/com.valerypopoff.rivet2',
      volume: { nocopy: true },
    });
    const existingVolumes = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], process.env);
    assertFreshRehearsalResources(
      {
        volumes: Object.fromEntries(
          Object.keys(domains).map((domain) => [domain, { name: `${config.project}_sqlite_restored_${domain}` }]),
        ),
      },
      { volumes: existingVolumes.output.trim().split(/\r?\n/), networks: [] },
    );
    await fs.writeFile(config.composeFile, JSON.stringify(model));
    // Restore into five NEW volumes, not over the original selected instance.
    // The original snapshot and old volumes stay untouched until fixture cleanup.
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--user',
      '0',
      '--entrypoint',
      'node',
      'api',
      '--input-type=module',
      '-e',
      `
      const fs=await import('node:fs/promises');
      const {scanBackupRoot,inspectSqliteServingBackup}=await import('/fixture-tools/local-upgrade-backup.mjs');
      const roots=${JSON.stringify(domains)};
      for(const [domain,target] of Object.entries(roots)){
        if((await fs.readdir(target)).length)throw Error('Restore destination is not empty');
        const source='/restored/sqlite-restored/'+domain;
        // A Docker volume mountpoint already exists. Copy only into its
        // verified-empty contents, preserving refusal to overwrite any entry.
        for(const name of await fs.readdir(source))
          await fs.cp(source+'/'+name,target+'/'+name,{recursive:true,force:false,errorOnExist:true,verbatimSymlinks:true});
        // cp may not retain directory modes; restore explicit modes before readback.
        const entries=await scanBackupRoot(source,domain);
        for(const entry of entries)if(entry.type!=='link')await fs.chmod(target+(entry.path?'/'+entry.path:''),entry.mode);
        const actual=await scanBackupRoot(target,domain);
        if(JSON.stringify(entries)!==JSON.stringify(actual))throw Error('Restored volume readback differs');
      }
      await inspectSqliteServingBackup(roots.control, roots.appData);
      const {execFileSync}=await import('node:child_process');
      execFileSync('chown',['-R','10001:10001',...Object.values(roots)]);
    `,
    ]);
    await compose(config, ['up', '-d', '--no-build', '--force-recreate', '--no-deps', 'api']);
    await waitReady(config);
    return;
  }
  if (action === 'assert-rollback-closed') {
    // Offline tools require an exclusive owner lease, even for status. Never
    // bypass the lease merely to run a test against a serving backend.
    await compose(config, ['stop', '-t', '10', 'api']);
    try {
      const result = await compose(config, [
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'node',
        'api',
        cli + 'recover-local-metadata.js',
        '--status',
      ]);
      const state = JSON.parse(
        result.output
          .trim()
          .split('\n')
          .find((line) => line.startsWith('{')),
      );
      assert.equal(state.canReturnToLegacy, false, 'Post-resumption legacy rollback must be refused.');
    } finally {
      await compose(config, ['start', 'api']);
      await waitReady(config);
    }
    return;
  }
  if (action === 'assert-selected-integrity') {
    await compose(config, [
      'exec',
      '-T',
      'api',
      'node',
      '--input-type=module',
      '-e',
      `
      const {DatabaseSync}=await import('node:sqlite');
      const {ImmutableLocalArtifactStore}=await import('/app/packages/studio-server-api/dist/studio-server-api/src/local-metadata/immutable-artifact-store.js');
      const db=new DatabaseSync('/data/local-metadata/transition.sqlite',{readOnly:true});
      const state=db.prepare('SELECT phase,generation_id FROM transition_state WHERE singleton=1').get();db.close();
      if(state.phase!=='sqlite-live'||!/^[a-f0-9-]{36}$/.test(state.generation_id))throw Error('Not selected writable fixture');
      const root='/data/local-metadata/generations/'+state.generation_id;
      for(const file of ['catalog.sqlite','settings.sqlite','operational/evaluation-runs.sqlite','operational/llm-profile-health.sqlite']){
        const current=new DatabaseSync(root+'/'+file,{readOnly:true});
        try{
          if(current.prepare('PRAGMA integrity_check').all().some(row=>row.integrity_check!=='ok')||current.prepare('PRAGMA foreign_key_check').get())throw Error('Selected database integrity failed');
        }finally{current.close();}
      }
      const catalog=new DatabaseSync(root+'/catalog.sqlite',{readOnly:true});
      const objects=new ImmutableLocalArtifactStore(root+'/objects');
      async function check(value){
        if(!value||typeof value!=='object')return;
        if(typeof value.hash==='string'&&typeof value.size==='number'){
          const bytes=await objects.read(value.hash);if(bytes.length!==value.size)throw Error('Artifact size differs');return;
        }
        for(const child of Object.values(value))await check(child);
      }
      try{for(const table of ['projects','published_versions','web_apps','recordings','runtime_library_state'])
        for(const row of catalog.prepare('SELECT metadata_json FROM '+table).iterate())await check(JSON.parse(row.metadata_json));
      }finally{catalog.close();}
    `,
    ]);
    return;
  }
  if (action === 'restart') {
    await compose(config, ['restart', '-t', '10', 'api']);
    await waitReady(config);
    return;
  }
  if (action === 'recreate') {
    // No accepted runs remain here. Bound the disposable fixture's stop, and
    // recreate only the combined backend, not its initialization dependencies.
    await compose(config, ['stop', '-t', '10', 'api']);
    await compose(config, ['up', '-d', '--no-build', '--force-recreate', '--no-deps', 'api']);
    await waitReady(config);
    return;
  }
  if (action === 'drop-runtime-cache') {
    await compose(config, ['stop', '-t', '10', 'api']);
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      '-e',
      `
      const fs=require('node:fs'); const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync('/data/local-metadata/transition.sqlite',{readOnly:true});
      const state=db.prepare('SELECT phase,generation_id FROM transition_state WHERE singleton=1').get();db.close();
      if(state.phase!=='sqlite-live'||!/^[a-f0-9-]{36}$/.test(state.generation_id))throw Error('Not writable selected fixture');
      fs.rmSync('/data/local-metadata/generations/'+state.generation_id+'/runtime-cache',{recursive:true,force:true});
    `,
    ]);
    await compose(config, ['start', 'api']);
    await waitReady(config);
    return;
  }
  if (action === 'assert-isolation') {
    await compose(config, [
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      `
      (async()=>{
        const registry=await fetch('http://fixture-registry:4873/example'); if(!registry.ok)throw Error('Fixture registry unavailable');
        for(const url of ['http://1.1.1.1','https://registry.npmjs.org/example']){
          try { const response=await fetch(url,{signal:AbortSignal.timeout(1500)}); await response.body?.cancel(); throw Error('Unexpected egress'); }
          catch(error){ if(error.message==='Unexpected egress')throw error; }
        }
      })().catch(()=>process.exit(1));
    `,
    ]);
    return;
  }
  if (action === 'restore-backup') {
    await compose(config, [
      'exec',
      '-T',
      'api',
      'node',
      '-e',
      `
      const fs=require('node:fs/promises');
      (async()=>{for(const [name,source] of Object.entries({workflows:'/workflows',recordings:'/workflow-recordings',appData:'/data/rivet-app',runtimeLibraries:'/data/runtime-libraries'})){
        const target='/restored/'+name; await fs.rm(target,{recursive:true,force:true}); await fs.cp(source,target,{recursive:true,verbatimSymlinks:true});
      }})().catch(()=>process.exit(1));
    `,
    ]);
    const result = await compose(config, [
      'exec',
      '-T',
      '-e',
      'RIVET_WORKFLOWS_ROOT=/restored/workflows',
      '-e',
      'RIVET_WORKFLOW_RECORDINGS_ROOT=/restored/recordings',
      '-e',
      'RIVET_APP_DATA_ROOT=/restored/appData',
      '-e',
      'RIVET_RUNTIME_LIBRARIES_ROOT=/restored/runtimeLibraries',
      'api',
      'node',
      cli + 'local-metadata-control.js',
      '--fingerprint',
    ]);
    return JSON.parse(
      result.output
        .trim()
        .split('\n')
        .find((line) => line.startsWith('{')),
    ).sourceFingerprint;
  }
  if (action === 'corrupt-candidate') {
    await compose(config, ['stop', '-t', '10', 'api']);
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      '-e',
      `
      const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync('/data/local-metadata/transition.sqlite',{readOnly:true});
      const state=db.prepare('SELECT phase,generation_id FROM transition_state WHERE singleton=1').get();db.close();
      if(state.phase!=='sqlite-validation'||!state.generation_id)throw Error('Not paused SQLite');
      fs.writeFileSync('/data/local-metadata/generations/'+state.generation_id+'/settings.sqlite','corrupt-test-candidate');
    `,
    ]);
    await compose(config, ['start', 'api']);
    // A failed startup, not merely an HTTP 503, must be observable.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const result = await compose(config, ['ps', '--all', '--format', 'json', 'api']);
      const parsed = JSON.parse(result.output.trim() || '[]');
      const containers = Array.isArray(parsed) ? parsed : [parsed];
      if (
        containers.some(
          (container) =>
            container.Service === 'api' &&
            ['exited', 'restarting'].includes(container.State) &&
            Number(container.ExitCode) > 0,
        )
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Corrupt candidate did not fail selected startup.');
  }
  if (action === 'offline-return') {
    await compose(config, ['stop', '-t', '10', 'api']);
    const status = await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'RIVET_LOCAL_METADATA_ENCRYPTION_KEY=',
      '--entrypoint',
      'node',
      'api',
      cli + 'recover-local-metadata.js',
      '--status',
    ]);
    const state = JSON.parse(
      status.output
        .trim()
        .split('\n')
        .find((line) => line.startsWith('{')),
    );
    assert.ok(state.canReturnToLegacy);
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'RIVET_LOCAL_METADATA_ENCRYPTION_KEY=',
      '--entrypoint',
      'node',
      'api',
      cli + 'recover-local-metadata.js',
      String(state.revision),
      state.generationId,
    ]);
    await compose(config, ['start', 'api']);
    await waitReady(config);
    return;
  }
  if (action === 'assert-source-unchanged') {
    const results = [];
    for (const restored of [false, true]) {
      const overrides = restored
        ? [
            '-e',
            'RIVET_WORKFLOWS_ROOT=/restored/workflows',
            '-e',
            'RIVET_WORKFLOW_RECORDINGS_ROOT=/restored/recordings',
            '-e',
            'RIVET_APP_DATA_ROOT=/restored/appData',
            '-e',
            'RIVET_RUNTIME_LIBRARIES_ROOT=/restored/runtimeLibraries',
          ]
        : [];
      const result = await compose(config, [
        'exec',
        '-T',
        ...overrides,
        'api',
        'node',
        cli + 'local-metadata-control.js',
        '--fingerprint',
      ]);
      results.push(
        JSON.parse(
          result.output
            .trim()
            .split('\n')
            .find((line) => line.startsWith('{')),
        ).sourceFingerprint,
      );
    }
    assert.equal(results[0], results[1]);
    return;
  }
  throw new Error('Unknown isolated rehearsal control.');
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
async function main() {
  const references = Object.fromEntries(
    ['API', 'WEB', 'PROXY'].map((service) => [
      service.toLowerCase(),
      process.env[`RIVET_REHEARSAL_${service}_IMAGE`] ||
        (process.env.IMAGE_NAMESPACE && process.env.SOURCE_TAG
          ? `${process.env.IMAGE_NAMESPACE}/${service.toLowerCase()}:${process.env.SOURCE_TAG}`
          : ''),
    ]),
  );
  assert.ok(
    Object.values(references).every(Boolean),
    'Supply all three exact rehearsal images or IMAGE_NAMESPACE + SOURCE_TAG. No latest defaults.',
  );
  const inspections = {};
  for (const [name, reference] of Object.entries(references)) {
    let inspected = await run('docker', ['image', 'inspect', reference], process.env, true);
    if (inspected.code !== 0) {
      await run('docker', ['pull', reference], process.env);
      inspected = await run('docker', ['image', 'inspect', reference], process.env);
    }
    inspections[name] = JSON.parse(inspected.output)[0];
  }
  const images = pinRehearsalImages(inspections, process.env.GITHUB_SHA);
  const project = prefix + randomUUID();
  const artifactRoot = path.join(root, 'artifacts', 'local-upgrade');
  await fs.mkdir(artifactRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifactRoot, project + '-'));
  const file = path.join(directory, 'manifest.json');
  const port = await availablePort();
  const env = {
    RIVET_API_IMAGE: images.api.id,
    RIVET_WEB_IMAGE: images.web.id,
    RIVET_PROXY_IMAGE: images.proxy.id,
    RIVET_PORT: `127.0.0.1:${port}`,
    RIVET_KEY: randomUUID(),
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_REQUIRE_UI_GATE_KEY: 'true',
    // Dummy OAuth is confined to this owned, isolated loopback-published fixture.
    RIVET_ENABLE_DEVELOPMENT_AUTH: 'true',
    RIVET_DEVELOPMENT_AUTH_CLIENTS: '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1',
    RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '0',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: randomUUID() + randomUUID(),
    RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB: '32',
    RIVET_VM_MIGRATION_ENABLED: '0',
    RIVET_PUBLISHED_WORKFLOWS_BASE_PATH: '/workflows',
    RIVET_LATEST_WORKFLOWS_BASE_PATH: '/workflows-latest',
    RIVET_PUBLISHED_APPS_BASE_PATH: '/apps',
    RIVET_LATEST_APPS_BASE_PATH: '/apps-latest',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    no_proxy: '',
  };
  const volumes = [
    { type: 'volume', source: 'fixture_workflows', target: '/workflows' },
    { type: 'volume', source: 'fixture_recordings', target: '/workflow-recordings' },
    { type: 'volume', source: 'fixture_libraries', target: '/data/runtime-libraries' },
    { type: 'volume', source: 'fixture_backup', target: '/restored' },
    ...['local-upgrade-backup.mjs', 'local-upgrade-snapshot-plan.mjs'].map((name) => ({
      type: 'bind',
      source: path.join(directory, name),
      target: '/fixture-tools/' + name,
      read_only: true,
    })),
  ];
  const config = {
    version: 2,
    project,
    composeFile: path.join(directory, 'compose.json'),
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    images,
    registryScript: path.join(directory, 'fixture-registry.mjs'),
    env,
  };
  await fs.writeFile(
    config.composeFile,
    JSON.stringify({
      services: {
        // Docker Desktop cannot publish host ports from an internal-only
        // network. Only the gateway joins the edge; API/executor stay isolated.
        proxy: { networks: ['default', 'edge'] },
        api: {
          volumes,
          environment: {
            RIVET_EXTRA_ROOTS: '/restored',
            npm_config_registry: 'http://fixture-registry:4873',
            NPM_CONFIG_REGISTRY: 'http://fixture-registry:4873',
          },
          restart: 'no',
        },
        'fixture-registry': {
          image: images.api.id,
          entrypoint: ['node', '/fixture-registry.mjs'],
          read_only: true,
          volumes: [{ type: 'bind', source: config.registryScript, target: '/fixture-registry.mjs', read_only: true }],
          networks: ['default'],
        },
        'filesystem-artifacts-init': {
          volumes: volumes.filter((mount) => mount.type === 'volume'),
          command: [
            'mkdir -p /restored; chown -R 10001:10001 /workflows /workflow-recordings /data/runtime-libraries /data/rivet-app /data/local-metadata /restored',
          ],
        },
      },
      volumes: { fixture_workflows: {}, fixture_recordings: {}, fixture_libraries: {}, fixture_backup: {} },
      networks: { default: { internal: true }, edge: {} },
    }),
  );
  await fs.copyFile(
    path.join(root, 'deploy/studio-server/scripts/local-upgrade-fixture-registry.mjs'),
    config.registryScript,
  );
  for (const name of ['local-upgrade-backup.mjs', 'local-upgrade-snapshot-plan.mjs'])
    await fs.copyFile(path.join(root, 'deploy/studio-server/scripts', name), path.join(directory, name));
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  let cleanupAllowed = false;
  let successfulReport;
  try {
    const existing = await run(
      'docker',
      ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}'],
      process.env,
    );
    assert.equal(existing.output.trim(), '', 'Disposable project already exists.');
    const rendered = JSON.parse((await rawCompose(config, ['config', '--format', 'json'])).output);
    assertOwnedRehearsalCompose(config, rendered);
    const resources = {};
    for (const [kind, command] of [
      ['volumes', 'volume'],
      ['networks', 'network'],
    ]) {
      const listed = await run('docker', [command, 'ls', '--format', '{{.Name}}'], process.env);
      resources[kind] = listed.output.trim().split(/\r?\n/);
    }
    assertFreshRehearsalResources(rendered, resources);
    // No cleanup is permitted until both model and pre-existing-resource checks
    // pass. A rejected model must never trigger down -v in the finally path.
    cleanupAllowed = true;
    await compose(config, ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180']);
    await waitReady(config);
    await controlLocalUpgradeRehearsal(file, 'assert-isolation');
    const login = await fetch(config.baseUrl + '/__rivet_auth', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: env.RIVET_KEY, return_to: '/' }),
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const request = async (route, body, method = 'POST') => {
      const response = await fetch(config.baseUrl + route, {
        signal: AbortSignal.timeout(30_000),
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body ? { method, body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, `${route}: ${response.status}`);
      return response.json();
    };
    const contents = await fs.readFile(
      path.join(root, 'deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project'),
      'utf8',
    );
    await request('/api/workflows/projects/upload', {
      folderRelativePath: '',
      fileName: 'rehearsal.rivet-project',
      contents,
    });
    await request('/api/workflows/folders', { name: 'empty', parentRelativePath: '' });
    await request(
      '/api/app-settings/environment-variables',
      {
        variables: [
          {
            id: 'rehearsal-private-variable',
            name: 'RIVET_RELEASE_GATE_VALUE',
            value: 'image-rehearsal-setting',
            browserAccess: false,
          },
        ],
      },
      'PUT',
    );
    const snapshot = await request('/api/workflows/projects/web-apps?relativePath=rehearsal.rivet-project');
    await request('/api/workflows/projects/publish', {
      relativePath: 'rehearsal.rivet-project',
      settings: { endpointName: 'local-upgrade-rehearsal' },
      preconditions: {
        expectedProjectId: snapshot.projectId,
        expectedDraftRevisionId: snapshot.draftRevisionId,
        expectedPublicationVersion: snapshot.publicationVersion,
      },
    });
    const webSnapshot = await request('/api/workflows/projects/web-apps?relativePath=rehearsal.rivet-project');
    await request('/api/workflows/projects/web-apps/publish', {
      relativePath: 'rehearsal.rivet-project',
      publications: [{ uiGraphId: 'release-gate-web-app', slug: 'local-upgrade-app', allowedEmails: [] }],
      preconditions: {
        expectedProjectId: webSnapshot.projectId,
        expectedDraftRevisionId: webSnapshot.draftRevisionId,
        expectedPublicationVersion: webSnapshot.publicationVersion,
      },
    });
    const execution = await fetch(config.baseUrl + '/workflows/local-upgrade-rehearsal', {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${env.RIVET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify('image-rehearsal-source'),
    });
    assert.ok(execution.ok, 'Seeded published workflow must execute before conversion.');
    const deadline = Date.now() + 30_000;
    let recorded = false;
    while (Date.now() < deadline) {
      const catalog = await request('/api/workflows/recordings/workflows');
      if (
        catalog.workflows?.some(
          (entry) => entry.project?.relativePath === 'rehearsal.rivet-project' && entry.totalRuns > 0,
        )
      ) {
        const workflow = catalog.workflows.find((entry) => entry.project?.relativePath === 'rehearsal.rivet-project');
        const runs = await request(
          `/api/workflows/recordings/workflows/${encodeURIComponent(workflow.workflowId)}/runs?page=1&pageSize=50&status=all`,
        );
        assert.ok(runs.runs?.[0]?.id, 'Source recording needs a stable run identity.');
        config.sourceRecordingId = runs.runs[0].id;
        recorded = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(recorded, 'Source fixture must include a persisted recording.');
    await compose(config, ['stop', '-t', '10', 'api']);
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      '-e',
      `
      const fs=require('node:fs'); const root='/data/runtime-libraries';
      fs.mkdirSync(root+'/current/node_modules/example',{recursive:true});
      fs.writeFileSync(root+'/current/package.json','{"private":true}');
      fs.writeFileSync(root+'/current/node_modules/example/index.js','module.exports=42;');
      fs.writeFileSync(root+'/manifest.json',JSON.stringify({packages:{example:{name:'example',version:'1.0.0'}},updatedAt:'2026-01-01T00:00:00.000Z'}));
    `,
    ]);
    config.env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED = '1';
    config.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = '/data/local-metadata';
    await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      cli + 'local-metadata-control.js',
      '--provision',
    ]);
    const capacity = await compose(config, [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      'api',
      cli + 'local-metadata-control.js',
      '--capacity',
    ]);
    assert.equal(
      JSON.parse(
        capacity.output
          .trim()
          .split('\n')
          .find((line) => line.startsWith('{')),
      ).fits,
      true,
      'Packaged read-only capacity preflight must pass.',
    );
    await compose(config, ['up', '-d', '--no-build', '--force-recreate', 'api']);
    await waitReady(config);
    console.log(
      '[local-upgrade-rehearsal] Isolated production images ready; exercising the real browser/API/restart/recovery path.',
    );
    // The browser fixture imports Core directly. A fresh image-gate checkout
    // has the packaged containers but no host-side workspace build output.
    await run(
      process.execPath,
      ['.yarn/releases/yarn-4.17.1.cjs', 'workspace', '@valerypopoff/rivet2-core', 'run', 'build'],
      process.env,
    );
    await run(
      process.execPath,
      ['.yarn/releases/yarn-4.17.1.cjs', 'studio-server:ui:observe', 'local-storage-upgrade-live.spec.ts'],
      {
        ...process.env,
        // The ordinary observer deliberately prefers .env/.env.dev. A fixture
        // must not inherit a production/dev UI key or an unrelated base URL.
        RIVET_ENV_FILE: path.join(directory, 'rehearsal.env'),
        PLAYWRIGHT_HEADLESS: '1',
        PLAYWRIGHT_SLOW_MO: '0',
        PLAYWRIGHT_BASE_URL: config.baseUrl,
        RIVET_KEY: env.RIVET_KEY,
        RIVET_LOCAL_UPGRADE_REHEARSAL_MANIFEST: file,
      },
    );
    const phases = await readRehearsalPhases(path.join(directory, 'phases.json'));
    assertRehearsalPhases(phases, true);
    successfulReport = {
      passed: true,
      images,
      sourceCommit: images.api.revision,
      phases,
      checkedAt: new Date().toISOString(),
      scope: 'Disposable fixture; not production-data certification.',
    };
  } catch (error) {
    let completed = [];
    try {
      completed = await readRehearsalPhases(path.join(directory, 'phases.json'));
    } catch {
      /* A startup failure may precede the first browser assertion. */
    }
    await fs.writeFile(
      path.join(directory, 'result.json'),
      JSON.stringify({
        passed: false,
        images,
        checkedAt: new Date().toISOString(),
        failure: 'rehearsal-failed',
        phases: requiredPhases.map((name) => ({
          name,
          status: completed.some((phase) => phase.name === name && phase.status === 'passed') ? 'passed' : 'not-run',
        })),
        scope: 'Disposable fixture; not production-data certification.',
      }),
    );
    console.error(
      '[local-upgrade-rehearsal] Failure; inspect artifacts/playwright and the isolated container diagnostics.',
    );
    if (!cleanupAllowed) {
      throw new Error('Fixture safety checks refused startup; no container diagnostics or cleanup were attempted.');
    }
    // Recheck only this generated fixture through the read-only serving owner.
    // Keep the fixed mismatch field, never source data or an exception stack.
    const diagnostic = await compose(
      config,
      [
        'exec',
        '-T',
        'api',
        'node',
        '--input-type=module',
        '-e',
        `
      const base='/app/packages/studio-server-api/dist/studio-server-api/src/';
      const {DatabaseSync}=await import('node:sqlite');
      const db=new DatabaseSync('/data/local-metadata/upgrade.sqlite',{readOnly:true});
      const jobs=db.prepare('SELECT job_json FROM jobs').all().map(row=>JSON.parse(row.job_json));db.close();
      const job=jobs.sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
      if(job?.phase==='failed'&&job.stage==='serving-verification'){
        const {collectSourceWorkflows,collectSourceFolderPaths}=await import(base+'local-metadata/filesystem-workflow-source.js');
        const {collectSourceRecordings}=await import(base+'local-metadata/filesystem-recording-source.js');
        const {verifySqliteWorkflowServing}=await import(base+'local-metadata/verify-serving-candidate.js');
        const projects=await collectSourceWorkflows('/workflows');
        try{
          await verifySqliteWorkflowServing({databasePath:'/data/local-metadata/generations/'+job.id+'/catalog.sqlite',artifactRoot:'/data/local-metadata/generations/'+job.id+'/objects',virtualRoot:'/workflows',projects,folders:await collectSourceFolderPaths('/workflows'),recordings:await collectSourceRecordings('/workflow-recordings',projects),assertFrozen:async()=>{}});
        }catch(error){
          console.log(/^SQLite serving verification failed: [a-z -]+\\.$/.test(error.message)?error.message:'Fixture serving recheck failed without a safe mismatch field.');
        }
      }`,
      ],
      true,
    );
    const logs = await compose(config, ['logs', '--no-color', '--tail', '120'], true);
    await fs.writeFile(path.join(directory, 'container-fixture.log'), logs.output + '\n' + diagnostic.output);
    console.error(diagnostic.output.slice(-1000));
    throw new Error('Isolated local upgrade rehearsal failed. Inspect redacted report and protected test artifacts.');
  } finally {
    try {
      if (cleanupAllowed) {
        const cleanup = await compose(config, ['down', '-v', '--timeout', '10', '--remove-orphans'], true);
        assert.equal(cleanup.code, 0, 'Owned fixture cleanup failed.');
      }
    } catch {
      await fs.writeFile(
        path.join(directory, 'result.json'),
        JSON.stringify({
          passed: false,
          images,
          checkedAt: new Date().toISOString(),
          failure: 'owned-cleanup-failed',
          phases: await readRehearsalPhases(path.join(directory, 'phases.json')).catch(() => []),
          scope: 'Disposable fixture; not production-data certification.',
        }),
      );
      throw new Error('Owned fixture cleanup failed; no successful qualification receipt was published.');
    } finally {
      // Even a failed cleanup/model recheck must not retain generated secrets.
      await fs.rm(file, { force: true });
    }
  }
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(successfulReport));
  console.log(
    '[local-upgrade-rehearsal] PASS: packaged UI, API, coordinated restart, online/offline recovery and live SQLite serving.',
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
