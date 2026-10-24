import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { parse, parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';

// test-style: fixture-read: Read generated Helm fixture values, stand-in state, requests and command result receipts.
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  createProductionHelmValues,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import {
  HA_REQUIRED_CHECKS,
  HA_BROWSER_CONTRACT,
  HA_RUNTIME_CONTROL_CHECKS,
  HA_DEVELOPER_OVERLAP_CHECKS,
} from './lib/ha-release-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const merge = (a, b) => {
  for (const [key, value] of Object.entries(b))
    a[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(a[key] && typeof a[key] === 'object' ? a[key] : {}, value)
        : value;
  return a;
};
const adapter = `import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const request=process.argv[process.argv.indexOf('--request')+1], receipt=process.argv[process.argv.indexOf('--receipt')+1];
const r=JSON.parse(await fs.readFile(request,'utf8')), directory=path.dirname(receipt), fixture=process.env.RIVET_COMMAND_FIXTURE;
await fs.appendFile(path.join(fixture,'adapters.ndjson'),JSON.stringify({stage:r.stage,requestId:r.requestId,operationId:r.operationId})+'\\n');
const state=JSON.parse(await fs.readFile(path.join(fixture,'state.json'),'utf8'));
if(r.stage==='backup'&&state.fault==='backupFail')process.exit(2);
let out={...r,passed:true};
if(state.fault==='wrongInstallation')out.release='another-release';
if(r.stage==='backup'){
 out={...out,kind:r.consistency==='online'?'rivet-recovery-checkpoint':'rivet-frozen-recovery-checkpoint',capturedAt:new Date().toISOString(),
 databaseRestoreVerified:true,objectReferencesCovered:true,encryptionKeysRecoverable:true,unrelatedDataExcluded:true,artifacts:[]};
 for(const role of ['database','objects','keys','verification']){const data='synthetic fixture '+role;await fs.writeFile(path.join(directory,role),data);
 out.artifacts.push({role,path:role,sha256:'sha256:'+createHash('sha256').update(data).digest('hex')});}
}else{out.kind='rivet-deployment-acceptance';out.checks={};for(const name of (r.stage==='backend'?['developerApi','editorSession']:['workflow','webApp','remoteDebugger'])){
 await fs.writeFile(path.join(directory,name),'synthetic application journey');out.checks[name]={passed:true,observed:true,evidence:name};}}
await fs.writeFile(receipt,JSON.stringify(out));`;

async function fixture(t, mode, fault) {
  const directory = await fs.mkdtemp(path.join(root, 'artifacts', 'deployment-command-'));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.cp(path.join(root, 'deploy/studio-server/scripts'), path.join(directory, 'deploy/studio-server/scripts'), {
    recursive: true,
    filter: async (source) => (await fs.stat(source)).isDirectory() || /\.(mjs|json|yaml)$/.test(source),
  });
  await fs.cp(path.join(root, 'deploy/studio-server/helm'), path.join(directory, 'deploy/studio-server/helm'), {
    recursive: true,
  });
  const schema = 'packages/studio-server-api/src/routes/workflows/managed/schema-migrations.ts';
  await fs.mkdir(path.dirname(path.join(directory, schema)), { recursive: true });
  await fs.copyFile(path.join(root, schema), path.join(directory, schema));
  await fs.writeFile(path.join(directory, '.gitignore'), 'artifacts/\n.data/\nbin/\n');
  const git = (args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true });
  git(['init', '--quiet']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Deployment Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Isolated command fixture',
  ]);
  const sha = git(['rev-parse', 'HEAD']).trim();
  const images = (letter) =>
    Object.fromEntries(
      ['proxy', 'web', 'api', 'executor'].map((role) => [
        role,
        { repository: `fixture.invalid/${role}`, digest: `sha256:${letter.repeat(64)}` },
      ]),
    );
  const browserContract = {
    protocol: HA_BROWSER_CONTRACT,
    baseline: { sourceSha: 'a'.repeat(40), image: images('a').web },
  };
  function release(source, image, predecessorRelease) {
    const manifest = createStudioServerReleaseManifest({
      rootDir: directory,
      source: { repository: 'fixture/rivet', ref: 'refs/heads/main', sha: source },
      images: images(image),
      predecessorRelease,
      candidateEvidence: { workflow: 'Fixture only', runId: '1', runAttempt: 1 },
    });
    manifest.evidence.ha = {
      protocol: 3,
      browserContract,
      mode: predecessorRelease ? 'mixed' : 'bootstrap',
      candidateSourceSha: source,
      candidateImages: manifest.images,
      chartDigest: manifest.chart.contentDigest,
      requestSamples: 150,
      failedRequests: 0,
      checks: [...HA_REQUIRED_CHECKS],
      ...(predecessorRelease
        ? { predecessorSourceSha: predecessorRelease.source.sha, predecessorImages: predecessorRelease.images }
        : {}),
    };
    if (predecessorRelease)
      manifest.evidence.runtimeControl = {
        protocol: 1,
        candidateSourceSha: source,
        candidateImages: manifest.images,
        chartDigest: manifest.chart.contentDigest,
        predecessorSourceSha: predecessorRelease.source.sha,
        predecessorImages: predecessorRelease.images,
        requestSamples: 150,
        failedRequests: 0,
        checks: [...HA_RUNTIME_CONTROL_CHECKS],
        ...(mode === 'overlap' ? { developerOverlap: { protocol: 1, checks: [...HA_DEVELOPER_OVERLAP_CHECKS] } } : {}),
      };
    return promoteStudioServerReleaseManifest(manifest, {
      promotionEvidence: { workflow: 'Fixture only', runId: '1', runAttempt: 1 },
    });
  }
  const previous = release('a'.repeat(40), 'a'),
    candidate = release(sha, 'b', previous);
  const selected = mode === 'topology' ? candidate : previous;
  const read = async (file) => parse(await fs.readFile(path.join(directory, file), 'utf8'));
  const base = merge(
    await read('deploy/studio-server/scripts/fixtures/kubernetes-environment.values.yaml'),
    await read('deploy/studio-server/helm/overlays/gke-ha.yaml'),
  );
  Object.assign(base.postgres, { maxConnections: 10000 });
  base.resources = Object.fromEntries(
    ['proxy', 'web', 'backend', 'execution', 'evaluation', 'maintenance', 'autoscaler'].map((role) => [
      role,
      {
        requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '64Mi' },
        limits: { memory: '512Mi', 'ephemeral-storage': '256Mi' },
      },
    ]),
  );
  base.resourceLimitAcknowledgements = Object.fromEntries(
    Object.keys(base.resources).map((role) => [role, { memory: '', ephemeralStorage: '' }]),
  );
  base.autoscaling = {
    proxy: { enabled: false },
    web: { enabled: false },
    backend: { enabled: false },
    execution: { enabled: false },
    executionController: { enabled: false },
  };
  if (mode === 'direct') {
    base.ha.enabled = false;
    base.availability.gkeGateway = false;
    base.replicaCount.backend = 1;
    base.replicaCount.execution = 1;
  }
  if (mode === 'overlap') {
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'));
    base.ha.controlPlane.mode = 'singleton-overlap';
    base.ha.namespaceUid = '11111111-1111-4111-8111-111111111111';
    base.resources.backendOverlap = clone(base.resources.backend);
    base.resourceLimitAcknowledgements.backendOverlap = clone(base.resourceLimitAcknowledgements.backend);
  }
  const operator =
    mode === 'topology'
      ? merge(clone(base), await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'))
      : clone(base);
  operator.autoscaling = clone(base.autoscaling);
  const artifacts = path.join(directory, 'artifacts');
  await fs.mkdir(artifacts);
  const initialFile = path.join(artifacts, 'initial.json');
  await fs.writeFile(initialFile, JSON.stringify(merge(clone(base), createProductionHelmValues(selected))));
  const realHelm = resolveHelmBinOrThrow(root);
  const resources = parseAllDocuments(
    execFileSync(
      realHelm,
      [
        'template',
        'rivet',
        path.join(directory, 'deploy/studio-server/helm'),
        '-n',
        'fixture',
        '-f',
        path.join(directory, 'deploy/studio-server/helm/overlays/prod.yaml'),
        '-f',
        initialFile,
      ],
      { encoding: 'utf8' },
    ),
  )
    .map((d) => d.toJSON())
    .filter(Boolean);
  // The stand-in's initializer uses the very same apply/revision model as its
  // command handler, via a real fixture Helm upgrade subprocess below.
  const state = {
    release: 'rivet',
    namespace: 'fixture',
    namespaceUid: mode === 'overlap' ? base.ha.namespaceUid : 'fixture-namespace-uid',
    version: 0,
    resources: [],
    pods: [],
    retirements: {},
    installed: {},
    fault: null,
  };
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(artifacts, 'values.json'), JSON.stringify(operator));
  await fs.writeFile(path.join(artifacts, 'manifest.json'), JSON.stringify(candidate));
  await fs.writeFile(path.join(artifacts, 'adapter.mjs'), adapter);
  const policy = {
    formatVersion: 1,
    release: 'rivet',
    namespace: 'fixture',
    context: 'fixture-context',
    namespaceUid: state.namespaceUid,
    backup: { script: 'artifacts/adapter.mjs', sha256: hash(adapter) },
    acceptance: { script: 'artifacts/adapter.mjs', sha256: hash(adapter) },
  };
  await fs.writeFile(path.join(artifacts, 'policy.json'), JSON.stringify(policy));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  for (const name of ['helm.exe', 'kubectl.exe']) await fs.writeFile(path.join(bin, name), 'fixture executable marker');
  await fs.writeFile(
    path.join(directory, 'empty-kubeconfig'),
    'apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n',
  );
  // Keep the fixture kubeconfig ignored and source clean just like production.
  await fs.appendFile(
    path.join(directory, '.git/info/exclude'),
    '\nempty-kubeconfig\nstate.json\ncalls.ndjson\nadapters.ndjson\nstate.lock\nclock-offset.json\n',
  );
  const env = {
    ...process.env,
    RIVET_COMMAND_FIXTURE: directory,
    RIVET_FIXTURE_REAL_HELM: realHelm,
    KUBECONFIG: path.join(directory, 'empty-kubeconfig'),
    RIVET_K8S_HELM_BIN: path.join(bin, 'helm.exe'),
    RIVET_K8S_KUBECTL_BIN: path.join(bin, 'kubectl.exe'),
  };
  const tool = path.join(directory, 'deploy/studio-server/scripts/fixtures/deployment-command-tool.mjs');
  execFileSync(
    process.execPath,
    [
      tool,
      'helm',
      'upgrade',
      '--install',
      'rivet',
      path.join(directory, 'deploy/studio-server/helm'),
      '-f',
      path.join(directory, 'deploy/studio-server/helm/overlays/prod.yaml'),
      '--values',
      initialFile,
    ],
    { cwd: directory, env },
  );
  const seeded = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
  seeded.fault = fault;
  if (fault === 'backupFail') seeded.releaseStatus = 'pending-upgrade';
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(seeded));
  await fs.writeFile(path.join(directory, 'calls.ndjson'), '');
  const preload = pathToFileURL(
    path.join(directory, 'deploy/studio-server/scripts/fixtures/deployment-command-preload.mjs'),
  ).href;
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`;
  const invoke = async (extra = []) =>
    new Promise((resolve, reject) => {
      const cli = path.join(directory, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs');
      const child = spawn(
        process.execPath,
        [
          cli,
          '--release',
          'rivet',
          '--namespace',
          'fixture',
          '--context',
          'fixture-context',
          '--values',
          'artifacts/values.json',
          '--manifest',
          'artifacts/manifest.json',
          '--deployment-policy',
          'artifacts/policy.json',
          '--artifacts',
          'artifacts/result',
          '--confirm',
          'rivet',
          '--timeout',
          '2h',
          ...(extra.includes('--acceptance-only')
            ? []
            : mode === 'maintenance'
              ? ['--maintenance-cutover']
              : mode === 'topology'
                ? ['--ha-control-plane-transition']
                : []),
          ...extra,
        ],
        {
          cwd: directory,
          env,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      const timeout = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            if (process.platform === 'win32')
              execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
              });
            else process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Preserve the fixture's diagnostics if shutdown is unconfirmed. */
          }
        }
        reject(Error(`Command fixture timed out: ${stderr.slice(-2000)}`));
      }, 300000);
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout, stderr });
      });
    });
  return {
    directory,
    invoke,
    async state() {
      return JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    },
    async calls() {
      return (await fs.readFile(path.join(directory, 'calls.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    },
    async stages() {
      return (await fs.readFile(path.join(directory, 'adapters.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    },
    async expireLease() {
      const value = await this.state();
      const record = JSON.parse(value.journal.data.record);
      record.leaseExpiresAt = 0;
      value.journal.data.record = JSON.stringify(record);
      value.journal.metadata.resourceVersion = String(++value.version);
      await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(value));
      return record.token;
    },
    digest: getStudioServerReleaseManifestDigest(candidate, { requirePromoted: true }),
    resources,
  };
}
const clone = structuredClone;

test(
  'real deployment command never mistakes a pending release for bootstrap and blocks mutations when backup fails',
  { timeout: 660000 },
  async (t) => {
    const f = await fixture(t, 'rolling', 'backupFail');
    const result = await f.invoke();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /adapter did not complete/);
    assert.deepEqual(
      (await f.stages()).map((r) => r.stage),
      ['before', 'backup'],
    );
    assert.equal(
      (await f.calls()).some(
        (r) =>
          (r.kind === 'kubectl' && ['create', 'replace', 'patch', 'scale', 'delete'].includes(r.args[0])) ||
          (r.kind === 'helm' && r.args[0] === 'upgrade'),
      ),
      false,
    );
  },
);

test(
  'real deployment command rejects application evidence for another release before backup or mutation',
  { timeout: 660000 },
  async (t) => {
    const f = await fixture(t, 'rolling', 'wrongInstallation');
    const result = await f.invoke();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /receipt belongs to another attempt or installation/);
    assert.deepEqual(
      (await f.stages()).map((r) => r.stage),
      ['before'],
    );
    assert.equal(
      (await f.calls()).some(
        (r) =>
          (r.kind === 'kubectl' && ['create', 'replace', 'patch', 'scale', 'delete'].includes(r.args[0])) ||
          (r.kind === 'helm' && r.args[0] === 'upgrade'),
      ),
      false,
    );
  },
);

test(
  'real non-HA deployment uses the shared Helm command without automatic schema rollback',
  { timeout: 660000 },
  async (t) => {
    const f = await fixture(t, 'direct', null);
    const result = await f.invoke();
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const upgrades = (await f.calls()).filter((r) => r.kind === 'helm' && r.args[0] === 'upgrade');
    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].args.includes('--atomic'), false);
    assert.ok(upgrades[0].args.includes('--wait-for-jobs'));
    assert.equal((await f.state()).installed.release.production.manifestDigest, f.digest);
    assert.deepEqual(
      (await f.stages()).map((s) => s.stage),
      ['before', 'backup', 'after'],
    );
  },
);

test(
  'real deployment failure preserves its journal receipt when Helm diagnostic export also fails',
  { timeout: 660000 },
  async (t) => {
    const f = await fixture(t, 'maintenance', 'lostTemplateDiagnostics');
    const result = await f.invoke();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--resume-cutover/);
    assert.match(result.stderr, /diagnostics disk unavailable/);
    const state = await f.state(),
      journal = JSON.parse(state.journal.data.record);
    const report = JSON.parse(
      await fs.readFile(path.join(f.directory, 'artifacts/result/deployment-result.json'), 'utf8'),
    );
    assert.equal(report.state, 'deployment-incomplete');
    assert.equal(report.operation.token, journal.token);
    assert.equal(report.operation.phase, 'validating');
    assert.equal(report.operation.aborted, false);
    assert.equal(report.outcome.infrastructure, 'unconfirmed');
  },
);

for (const action of ['release', 'acquire'])
  test(
    `real overlap command observes a lost housekeeping ${action} acknowledgement without replay`,
    { timeout: 660000 },
    async (t) => {
      const f = await fixture(t, 'overlap', `lostHousekeeping-${action}`);
      const first = await f.invoke();
      assert.equal(first.code, 1, first.stdout + first.stderr);
      assert.match(first.stderr, /lost housekeeping acknowledgement/);
      const journal = JSON.parse((await f.state()).journal.data.record);
      await f.expireLease();
      const recovered = await f.invoke(['--resume-ha', journal.token]);
      assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
      const state = await f.state();
      const backends = state.pods.filter((p) => p.metadata.labels['app.kubernetes.io/component'] === 'backend');
      assert.equal(backends.length, 1);
      assert.equal(state.retirements[backends[0].metadata.name].housekeeping.state, 'owner');
      const commands = (await f.calls()).filter((r) => r.args.includes(`--housekeeping-${action}`));
      assert.equal(commands.length, 2, 'one command per direction, never replay the uncertain first handover');
      assert.ok((await f.stages()).some((stage) => stage.stage === 'backend'));
    },
  );

for (const mode of ['rolling', 'maintenance', 'topology'])
  test(
    `real ${mode} command recovers its exact interrupted operation without dropping safety or replaying an unknown begin`,
    { timeout: 660000 },
    async (t) => {
      const f = await fixture(t, mode, mode === 'maintenance' ? 'lostTemplate' : 'lostBegin');
      const first = await f.invoke();
      assert.equal(first.code, 1, first.stdout + first.stderr);
      assert.match(first.stderr, /lost .*acknowledgement/);
      const interrupted = await f.state(),
        journal = JSON.parse(interrupted.journal.data.record);
      assert.equal(journal.deploymentSafety.scope, 'production');
      assert.equal(
        journal.deploymentSafety.mode,
        mode === 'rolling' ? 'rolling' : mode === 'maintenance' ? 'maintenance' : 'topology',
      );
      assert.ok(journal.workflowIdentity.beforeVerified);
      const begins = (await f.calls()).filter((r) => r.args.includes('--begin-only')).length;
      const token = await f.expireLease();
      const recovered = await f.invoke([mode === 'maintenance' ? '--resume-cutover' : '--resume-ha', token]);
      assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
      const completed = await f.state(),
        final = JSON.parse(completed.journal.data.record);
      assert.equal(final.phase, 'complete');
      assert.deepEqual(final.deploymentSafety, journal.deploymentSafety);
      const resultFile = path.join(f.directory, 'artifacts/result/deployment-result.json');
      const outcome = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      assert.equal(outcome.state, 'complete');
      assert.deepEqual(outcome.operation, { token: final.token, phase: 'complete' });
      assert.deepEqual(outcome.outcome, {
        infrastructure: 'applied',
        autoscaling: 'not-configured',
        application: 'passed',
      });
      assert.equal(completed.installed.release.production.manifestDigest, f.digest);
      const stages = await f.stages();
      assert.equal(stages.filter((s) => s.stage === 'before').length, 1);
      assert.equal(stages.filter((s) => s.stage === 'backup').length, 2);
      assert.equal(stages.at(-1).stage, 'after');
      assert.equal(new Set(stages.map((s) => s.operationId)).size, 1);
      if (mode !== 'maintenance') {
        const originalOwner = journal.owner.name;
        assert.equal(
          (await f.calls()).filter(
            (r) => r.args[0] === 'exec' && r.args[1] === originalOwner && r.args.includes('--begin-only'),
          ).length,
          1,
        );
        assert.ok((await f.calls()).filter((r) => r.args.includes('--begin-only')).length >= begins);
      }
      if (mode === 'topology') {
        const upgrades = (await f.calls()).filter((c) => c.kind === 'helm' && c.args[0] === 'upgrade').length;
        const priorStages = (await f.stages()).length;
        const stateFile = path.join(f.directory, 'state.json');
        await fs.writeFile(stateFile, JSON.stringify({ ...(await f.state()), fault: 'unavailableInventory' }));
        const failedVerification = await f.invoke(['--acceptance-only']);
        assert.equal(failedVerification.code, 1, failedVerification.stdout + failedVerification.stderr);
        assert.match(failedVerification.stderr, /verification failed; no release changes were made/);
        assert.equal(
          JSON.parse(await fs.readFile(path.join(f.directory, 'artifacts/result/deployment-result.json'), 'utf8'))
            .state,
          'verification-incomplete',
        );
        assert.equal((await f.stages()).length, priorStages);
        assert.equal((await f.calls()).filter((c) => c.kind === 'helm' && c.args[0] === 'upgrade').length, upgrades);
        await fs.writeFile(stateFile, JSON.stringify({ ...(await f.state()), fault: null }));
        const verified = await f.invoke(['--acceptance-only']);
        assert.equal(verified.code, 0, verified.stdout + verified.stderr);
        assert.deepEqual(JSON.parse(await fs.readFile(resultFile, 'utf8')).outcome, {
          infrastructure: 'existing-verified',
          autoscaling: 'not-configured',
          application: 'passed',
        });
        assert.equal((await f.calls()).filter((c) => c.kind === 'helm' && c.args[0] === 'upgrade').length, upgrades);
      }
    },
  );
