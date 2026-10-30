import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse, parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
import { assertNoOperatorRolloutGuards } from './deploy-kubernetes-release.mjs';

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
  HA_PROVIDER_OVERLAP_CHECKS,
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_COOPERATIVE_AUTOSCALING_CHECKS,
} from './lib/ha-release-evidence.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { overlapProfileDigest } from './lib/qualification-overlap-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('fresh operator inputs reject stale rollout guards without rewriting bound recovery inputs', () => {
  const stale = 'ha:\n  rolloutResourceVersions:\n    rivet-backend: "old-version"\n';
  assert.throws(() => assertNoOperatorRolloutGuards(stale, new Map()), /private guards from another operation/);
  assert.doesNotThrow(() => assertNoOperatorRolloutGuards('ha:\n  rolloutResourceVersions: {}', new Map()));
  for (const option of ['--env-file', '--plan-only', '--acceptance-only', '--resume-ha', '--resume-cutover'])
    assert.doesNotThrow(() => assertNoOperatorRolloutGuards(stale, new Map([[option, 'explicit']])));
});
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
if(r.stage==='before'&&['completedAutoscalerAdvance','samplingAutoscalerAdvance','busyAutoscalerAdvance','inventoryAutoscalerAdvance'].includes(state.fault)){
 const record=JSON.parse(state.journal.data.record);
 if(state.fault==='busyAutoscalerAdvance'){record.phase='scaling';record.leaseExpiresAt=Date.now()+120000;}
 if(state.fault==='samplingAutoscalerAdvance')record.leaseExpiresAt=Date.now()+15000;
 state.journal.data.record=JSON.stringify(record);state.journal.metadata.resourceVersion=String(++state.version);
 state.autoscalerAdvancedDuringBaseline=true;await fs.writeFile(path.join(fixture,'state.json'),JSON.stringify(state));
}
if((r.stage==='backup'&&state.fault==='backupFail')||(r.stage==='preflight'&&state.fault==='preflightFail'))process.exit(2);
let out={...r,passed:true};
if(state.fault==='wrongInstallation')out.release='another-release';
if(r.stage==='backup'){
 out={...out,kind:r.consistency==='online'?'rivet-recovery-checkpoint':'rivet-frozen-recovery-checkpoint',capturedAt:new Date().toISOString(),
 databaseRestoreVerified:true,objectReferencesCovered:true,encryptionKeysRecoverable:true,unrelatedDataExcluded:true,artifacts:[]};
 for(const role of ['database','objects','keys','verification']){const data='synthetic fixture '+role;await fs.writeFile(path.join(directory,role),data);
 out.artifacts.push({role,path:role,sha256:'sha256:'+createHash('sha256').update(data).digest('hex')});}
}else if(r.stage==='migration-validation'||r.stage==='migration-preflight'){
 if(r.stage==='migration-validation'&&state.pods.length)throw Error('Old readers still exist during restored-copy migration validation');
 if(state.fault==='migrationValidationFail'&&r.stage==='migration-validation')throw Error('Restored-copy migration failed');
 if(state.fault==='migrationPreflightFail')throw Error('Migration prerequisites unavailable');
 const data='synthetic restored-copy migration evidence';await fs.writeFile(path.join(directory,'migration.json'),data);
 out={...out,kind:'rivet-maintenance-'+r.stage,passed:true,supportsSchemaMigration:true,candidateImageVerified:true,restoreEnvironmentReady:true,
 isolatedRestore:true,migrationApplied:true,targetSchemaVerified:true,
 preservedDataVerified:true,oldDatabaseReadersStopped:true,unrelatedDataExcluded:true,verifiedAt:new Date().toISOString(),
 artifacts:[{role:'verification',path:'migration.json',sha256:'sha256:'+createHash('sha256').update(data).digest('hex')}]};
 if(state.fault==='checkpointMetadataChanged'&&r.stage==='migration-validation'){
  const file=path.join(r.checkpointDirectory,'receipt.json'), changed=JSON.parse(await fs.readFile(file,'utf8'));
  changed.formatVersion=999;await fs.writeFile(file,JSON.stringify(changed));
 }
}else{out.kind=r.stage==='preflight'?'rivet-deployment-preflight':'rivet-deployment-acceptance';out.checks={};for(const name of (r.stage==='preflight'?['dependencies','capacity']:r.stage==='backend'?['developerApi','editorSession']:['workflow','webApp','remoteDebugger'])){
 await fs.writeFile(path.join(directory,name),'synthetic application journey');out.checks[name]={passed:true,observed:true,evidence:name};}}
await fs.writeFile(receipt,JSON.stringify(out));`;

async function createFixtureDirectory(workspaceRoot) {
  const artifacts = path.join(workspaceRoot, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  return fs.mkdtemp(path.join(artifacts, 'deployment-command-'));
}

test('deployment fixtures initialize an absent artifacts directory and remain isolated', async (t) => {
  const checkout = await fs.mkdtemp(path.join(tmpdir(), 'rivet-command-checkout-'));
  t.after(() => fs.rm(checkout, { recursive: true, force: true }));
  await assert.rejects(fs.stat(path.join(checkout, 'artifacts')), { code: 'ENOENT' });
  const directories = await Promise.all([createFixtureDirectory(checkout), createFixtureDirectory(checkout)]);
  assert.notEqual(directories[0], directories[1]);
  for (const directory of directories) {
    assert.equal(path.dirname(directory), path.join(checkout, 'artifacts'));
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  }
});

async function fixture(t, mode, fault, schemaChange = false) {
  const adoptionStage = mode.startsWith('adoption-') ? mode.slice('adoption-'.length) : null;
  const directory = await createFixtureDirectory(root);
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
  const previous = release('a'.repeat(40), 'a');
  if (schemaChange)
    previous.database.managedWorkflowSchema = {
      version: previous.database.managedWorkflowSchema.version - 1,
      minimumRollbackCompatibleVersion: previous.database.managedWorkflowSchema.version - 1,
    };
  const candidate = release(sha, 'b', previous);
  if (schemaChange) {
    delete candidate.evidence.ha;
    delete candidate.evidence.runtimeControl;
  }
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
  if (fault === 'gkeHpa' || schemaChange) base.autoscaling.proxy = { enabled: true, minReplicas: 6, maxReplicas: 8 };
  if (fault === 'controllerRecreation') {
    base.autoscaling.executionController.enabled = true;
    base.metrics = { enabled: true };
    base.publishedExecutionAdmission = { mode: 'enforce', maxActiveRunsPerPod: 4 };
  }
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
  if (adoptionStage) {
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-compact-edge.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-autoscaling.yaml'));
    base.autoscaling.execution.maxReplicas = 7;
    base.postgres = {
      ...base.postgres,
      maxConnections: 200,
      reservedConnections: 30,
      poolMaxPerApiPod: adoptionStage === 'sizing' ? 10 : 9,
    };
    const profile = {
      protocol: 1,
      maxConnections: 200,
      reservedConnections: 30,
      poolMaxPerApiPod: 9,
      backendResources: {
        requests: { cpu: '750m', memory: '1536Mi', 'ephemeral-storage': '256Mi' },
        limits: { memory: '3Gi', 'ephemeral-storage': '2Gi' },
      },
    };
    base.resources.backendOverlap = clone(profile.backendResources);
    base.ha.namespaceUid = '11111111-1111-4111-8111-111111111111';
    const common = {
      candidateSourceSha: sha,
      candidateImages: candidate.images,
      chartDigest: candidate.chart.contentDigest,
      requestSamples: 150,
      failedRequests: 0,
    };
    const policyDigest = autoscalerPolicyDigest(autoscalerPolicy({ maxReplicas: 7 }));
    candidate.evidence.runtimeControl = {
      ...common,
      protocol: 3,
      purpose: 'ordinary-upgrade',
      controlPlaneMode: 'singleton-overlap',
      predecessorSourceSha: previous.source.sha,
      predecessorImages: previous.images,
      predecessorManifestDigest: getStudioServerReleaseManifestDigest(previous),
      autoscalerPolicyDigest: policyDigest,
      edgeProfiles: ['compact'],
      checks: [...HA_ORDINARY_RUNTIME_CHECKS],
      developerOverlap: {
        protocol: 2,
        sourceMode: 'singleton',
        sourcePool: 10,
        profile,
        profileDigest: overlapProfileDigest(profile),
        checks: [...HA_PROVIDER_OVERLAP_CHECKS],
      },
    };
    candidate.evidence.runtimeAutoscaling = {
      ...common,
      protocol: 2,
      provider: 'gke',
      policyDigest,
      checks: [...HA_COOPERATIVE_AUTOSCALING_CHECKS],
    };
  }
  const operator =
    mode === 'topology'
      ? merge(clone(base), await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'))
      : clone(base);
  operator.autoscaling = clone(base.autoscaling);
  if (adoptionStage) {
    operator.postgres.poolMaxPerApiPod = 9;
    operator.ha.controlPlane.mode = adoptionStage === 'sizing' ? 'singleton' : 'singleton-overlap';
  }
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
    namespaceUid: mode === 'overlap' || adoptionStage ? base.ha.namespaceUid : 'fixture-namespace-uid',
    version: 0,
    resources: [],
    pods: [],
    retirements: {},
    installed: {},
    fault: null,
    simulateAutoscaler: Boolean(adoptionStage),
  };
  await fs.writeFile(path.join(directory, 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(artifacts, 'values.json'), JSON.stringify(operator));
  await fs.writeFile(path.join(artifacts, 'manifest.json'), JSON.stringify(adoptionStage ? previous : candidate));
  if (adoptionStage) await fs.writeFile(path.join(artifacts, 'adoption-certificate.json'), JSON.stringify(candidate));
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
  if (schemaChange) {
    await fs.writeFile(path.join(artifacts, 'baseline.json'), JSON.stringify(previous));
    await fs.writeFile(
      path.join(artifacts, 'maintenance-plan.json'),
      JSON.stringify({
        formatVersion: 1,
        kind: 'rivet-maintenance-deployment',
        release: 'rivet',
        namespace: 'fixture',
        context: 'fixture-context',
        namespaceUid: state.namespaceUid,
        installedManifestDigest: getStudioServerReleaseManifestDigest(previous),
        installedManifestPath: 'artifacts/baseline.json',
        candidateManifestDigest: getStudioServerReleaseManifestDigest(candidate),
        valuesDigest: hash(await fs.readFile(path.join(artifacts, 'values.json'))),
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        reason: 'Explicit test-only schema-changing maintenance',
        accepts: { interruption: true, qualificationWaived: true, dataLoss: false },
        backup: policy.backup,
        schemaMigration: {
          fromVersion: previous.database.managedWorkflowSchema.version,
          toVersion: candidate.database.managedWorkflowSchema.version,
          ...policy.backup,
        },
      }),
    );
  }
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
  if (
    [
      'completedAutoscalerAdvance',
      'samplingAutoscalerAdvance',
      'busyAutoscalerAdvance',
      'inventoryAutoscalerAdvance',
      'claimConflict',
      'lostClaimAcknowledgement',
    ].includes(fault)
  ) {
    seeded.journal = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: releaseOperationJournalName('rivet'),
        namespace: 'fixture',
        uid: randomUUID(),
        resourceVersion: String(++seeded.version),
      },
      data: {
        record: JSON.stringify({
          autoscalingProtocol: 1,
          release: 'rivet',
          namespace: 'fixture',
          phase: 'complete',
          token: randomUUID(),
          runner: randomUUID(),
          leaseExpiresAt: 0,
          manifestDigest: seeded.installed.release.production.manifestDigest,
        }),
      },
    };
  }
  if (fault === 'pendingRelease') seeded.releaseStatus = 'pending-upgrade';
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
          ...(adoptionStage
            ? [
                '--overlap-adoption-certificate',
                'artifacts/adoption-certificate.json',
                '--overlap-adoption-stage',
                adoptionStage,
                ...(adoptionStage === 'ownership' ? ['--ha-control-plane-transition'] : []),
              ]
            : []),
          ...(schemaChange && !extra.includes('--acceptance-only')
            ? ['--maintenance-plan', 'artifacts/maintenance-plan.json']
            : []),
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

// Each scenario owns its directory, stand-in state, clock and child processes.
// Bound overlap rather than serialize all real CLI recovery journeys into one
// CI timeout. Operations inside an individual journey remain strictly ordered.
describe('isolated deployment command journeys', { concurrency: 3 }, () => {
  test(
    'maintenance uses private file-backed management documents without piped write acknowledgements',
    { timeout: 330000 },
    async (t) => {
      const f = await fixture(t, 'maintenance', 'rejectPipedInput');
      const result = await f.invoke();
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const writes = (await f.calls()).filter(
        (c) => c.kind === 'kubectl' && ['create', 'replace', 'delete'].includes(c.args[0]) && c.args.includes('-f'),
      );
      assert.ok(writes.length > 2);
      for (const call of writes) {
        const file = call.args[call.args.indexOf('-f') + 1];
        assert.notEqual(file, '-');
        await assert.rejects(
          fs.stat(file),
          { code: 'ENOENT' },
          'private management input is removed after physical command completion',
        );
      }
      assert.equal(JSON.parse((await f.state()).journal.data.record).phase, 'complete');
    },
  );
  // Preflight, lost application and recovery each retain their own 300s child
  // deadline. Give the complete three-command journey those budgets plus 30s.
  for (const stage of ['sizing', 'ownership'])
    test(`certified same-image overlap adoption ${stage} runs the actual command`, { timeout: 930000 }, async (t) => {
      const f = await fixture(t, `adoption-${stage}`, 'lostTemplate');
      const before = await f.state();
      const preflight = await f.invoke(['--preflight-only']);
      assert.equal(preflight.code, 0, preflight.stdout + preflight.stderr);
      assert.equal(
        (await f.calls()).filter((c) =>
          ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(c.args[0]),
        ).length,
        0,
      );
      const lost = await f.invoke();
      assert.equal(lost.code, 1, lost.stdout + lost.stderr);
      const token = await f.expireLease();
      const helmWrites = () =>
        f.calls().then((calls) => calls.filter((c) => c.kind === 'helm' && c.args[0] === 'upgrade').length);
      const beforeRecoveryWrites = await helmWrites();
      const result = await f.invoke(['--resume-ha', token]);
      const diagnostics = await fs.readdir(path.join(f.directory, 'artifacts/result'));
      const headroom = await Promise.all(
        diagnostics
          .filter((n) => n.startsWith('ha-headroom'))
          .map((n) => fs.readFile(path.join(f.directory, 'artifacts/result', n), 'utf8')),
      );
      assert.equal(result.code, 0, result.stdout + result.stderr + headroom.join('\n'));
      const after = await f.state();
      assert.equal(
        after.installed.release.production.manifestDigest,
        before.installed.release.production.manifestDigest,
      );
      assert.deepEqual(after.installed.images, before.installed.images);
      assert.equal(after.installed.postgres.poolMaxPerApiPod, 9);
      assert.equal(after.installed.ha.controlPlane.mode, stage === 'sizing' ? 'singleton' : 'singleton-overlap');
      const record = after.completedCutover ?? JSON.parse(after.journal.data.record);
      assert.equal(record.phase, 'complete');
      assert.equal(record.workflowIdentity.adoptionStage, stage);
      assert.equal(record.token, token);
      assert.equal(
        await helmWrites(),
        beforeRecoveryWrites + (stage === 'sizing' ? 1 : 0),
        'Template acknowledgement loss must not replay Helm',
      );
      if (stage === 'ownership') {
        const runtime = (state) =>
          state.pods
            .filter((p) => p.metadata.labels['app.kubernetes.io/component'] === 'execution')
            .map((p) => p.metadata.uid)
            .sort();
        assert.deepEqual(runtime(after), runtime(before));
      }
    });
  test(
    'schema-changing waiver is rejected before downtime without its explicit migration-validation approval',
    { timeout: 330000 },
    async (t) => {
      const f = await fixture(t, 'maintenance', null, true);
      const planFile = path.join(f.directory, 'artifacts/maintenance-plan.json');
      const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
      delete plan.schemaMigration;
      await fs.writeFile(planFile, JSON.stringify(plan));
      const result = await f.invoke(['--preflight-only']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /explicit schemaMigration approval/);
      assert.equal((await f.state()).journal, undefined);
      assert.equal(
        (await f.calls()).filter((c) =>
          ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(c.args[0]),
        ).length,
        0,
      );
    },
  );

  test(
    'migration adapter prerequisites are checked before maintenance ownership and workload changes',
    { timeout: 330000 },
    async (t) => {
      const f = await fixture(t, 'maintenance', 'migrationPreflightFail', true);
      const result = await f.invoke(['--preflight-only']);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal((await f.state()).journal, undefined);
      assert.equal(
        (await f.calls()).filter((c) =>
          ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(c.args[0]),
        ).length,
        0,
      );
    },
  );

  test(
    'permanent schema-changing maintenance accepts intentional autoscaler-controller recreation and fresh activation',
    { timeout: 330000 },
    async (t) => {
      const f = await fixture(t, 'maintenance', 'controllerRecreation', true);
      const controller = (state) =>
        state.resources.find((r) => r.metadata.labels?.['app.kubernetes.io/component'] === 'autoscaler');
      const oldUid = controller(await f.state()).metadata.uid;
      const result = await f.invoke();
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const state = await f.state();
      assert.notEqual(controller(state).metadata.uid, oldUid);
      const activation = JSON.parse(
        await fs.readFile(path.join(f.directory, 'artifacts/result/execution-autoscaler-activation.json'), 'utf8'),
      );
      assert.equal(activation.activated, true);
      assert.equal(state.completedCutover.phase, 'complete');
    },
  );

  for (const fault of ['lostFinalInventory', 'lostFinalApply'])
    test(
      `schema-changing maintenance ${fault} recovers by observation, never reapplying Helm`,
      { timeout: 660000 },
      async (t) => {
        const f = await fixture(t, 'maintenance', fault, true);
        const originalHpa = (await f.state()).resources.find((r) => r.kind === 'HorizontalPodAutoscaler').metadata.uid;
        const deployment = await f.invoke();
        assert.equal(deployment.code, 1, deployment.stdout + deployment.stderr);
        assert.match(deployment.stderr, /--verify-only/);
        const state = await f.state(),
          record = JSON.parse(state.journal.data.record);
        assert.equal(record.phase, 'resuming');
        assert.equal(record.finalApply.acknowledged, fault !== 'lostFinalApply');
        assert.equal(record.finalApply.inventory, undefined);
        assert.notEqual(
          state.resources.find((r) => r.kind === 'HorizontalPodAutoscaler').metadata.uid,
          originalHpa,
          'the final HPA is intentionally recreated after fenced validation',
        );
        assert.deepEqual(
          (await f.stages()).map((s) => s.stage),
          ['preflight', 'migration-preflight', 'before', 'backup', 'migration-validation'],
        );
        const count = (await f.calls()).filter(
          (c) =>
            (c.kind === 'helm' && c.args[0] === 'upgrade') ||
            (c.kind === 'kubectl' && ['patch', 'delete', 'scale', 'exec'].includes(c.args[0])),
        ).length;
        const verified = await f.invoke(['--resume-cutover', record.token, '--verify-only']);
        assert.equal(verified.code, 0, verified.stdout + verified.stderr);
        assert.equal(
          (await f.calls()).filter(
            (c) =>
              (c.kind === 'helm' && c.args[0] === 'upgrade') ||
              (c.kind === 'kubectl' && ['patch', 'delete', 'scale', 'exec'].includes(c.args[0])),
          ).length,
          count,
        );
        const completed = JSON.parse((await f.state()).journal.data.record);
        assert.equal(completed.phase, 'complete');
        assert.equal(
          completed.finalApply.acknowledged,
          fault !== 'lostFinalApply',
          'observation cannot invent a Helm reply',
        );
        assert.equal(completed.finalApply.verifiedByObservation, true);
        assert.equal((await f.stages()).filter((s) => s.stage === 'migration-validation').length, 1);
        const acceptance = await f.invoke(['--acceptance-only']);
        assert.equal(acceptance.code, 0, acceptance.stdout + acceptance.stderr);
        assert.equal(
          (await f.calls()).filter(
            (c) =>
              (c.kind === 'helm' && c.args[0] === 'upgrade') ||
              (c.kind === 'kubectl' && ['patch', 'delete', 'scale', 'exec'].includes(c.args[0])),
          ).length,
          count,
          'acceptance of the exact installed waived release cannot reapply workloads',
        );
        if (fault === 'lostFinalInventory') {
          const settled = await f.state(),
            stages = (await f.stages()).length;
          const stateFile = path.join(f.directory, 'state.json');
          for (const drift of [
            'helm-status',
            'helm-settings',
            'live-settings',
            'startup-fence',
            'afterSettlementNotReady',
            'afterSettlementPodReplaced',
          ]) {
            const changed = structuredClone(settled);
            if (drift === 'helm-status') changed.releaseStatus = 'failed';
            else if (drift === 'helm-settings') {
              const resources = parseAllDocuments(changed.manifest)
                .map((doc) => doc.toJSON())
                .filter(Boolean);
              resources
                .find((r) => r.kind === 'StatefulSet')
                .spec.template.spec.containers[0].env.push({ name: 'UNAPPROVED', value: 'changed' });
              changed.manifest = resources.map((r) => JSON.stringify(r)).join('\n---\n');
            } else if (drift.startsWith('afterSettlement')) changed.fault = drift;
            else {
              const owner = changed.resources.find((r) => r.kind === 'StatefulSet');
              if (drift === 'live-settings')
                owner.spec.template.spec.containers[0].env.push({ name: 'UNAPPROVED', value: 'changed' });
              else {
                owner.spec.template.metadata.annotations ??= {};
                owner.spec.template.metadata.annotations['rivet.dev/execution-retirement-fence'] = 'stale';
              }
            }
            await fs.writeFile(stateFile, JSON.stringify(changed));
            const refused = await f.invoke(['--acceptance-only']);
            assert.equal(refused.code, 1, `${drift}: ${refused.stdout}${refused.stderr}`);
            assert.match(refused.stderr, /verification failed; no release changes were made/);
            assert.equal((await f.stages()).length, stages, `${drift} cannot run application acceptance`);
            assert.equal(
              (await f.calls()).filter(
                (c) =>
                  (c.kind === 'helm' && c.args[0] === 'upgrade') ||
                  (c.kind === 'kubectl' && ['patch', 'delete', 'scale', 'exec'].includes(c.args[0])),
              ).length,
              count,
            );
          }
          const historicalCapacity = structuredClone(settled);
          const saved = parseAllDocuments(historicalCapacity.manifest)
            .map((doc) => doc.toJSON())
            .filter(Boolean);
          saved.find(
            (r) => r.kind === 'Deployment' && r.metadata.labels?.['app.kubernetes.io/component'] === 'proxy',
          ).spec.replicas = 7;
          historicalCapacity.manifest = saved.map((r) => JSON.stringify(r)).join('\n---\n');
          await fs.writeFile(stateFile, JSON.stringify(historicalCapacity));
          const grown = await f.invoke(['--acceptance-only']);
          assert.equal(grown.code, 0, grown.stdout + grown.stderr);
          assert.equal(
            (await f.stages()).length,
            stages + 1,
            'valid historical autoscaled capacity still permits acceptance',
          );
          assert.equal(
            (await f.calls()).filter(
              (c) =>
                (c.kind === 'helm' && c.args[0] === 'upgrade') ||
                (c.kind === 'kubectl' && ['patch', 'delete', 'scale', 'exec'].includes(c.args[0])),
            ).length,
            count,
          );
        }
      },
    );
  test(
    'failed restored-copy migration or altered checkpoint blocks live candidate templates and keeps the exact operation recoverable',
    { timeout: 330000 },
    async (t) => {
      for (const fault of ['migrationValidationFail', 'checkpointMetadataChanged']) {
        const f = await fixture(t, 'maintenance', fault, true);
        const result = await f.invoke();
        assert.equal(result.code, 1, result.stdout + result.stderr);
        const record = JSON.parse((await f.state()).journal.data.record);
        assert.equal(record.phase, 'quiesced', fault);
        assert.equal((await f.calls()).filter((c) => c.kind === 'helm' && c.args[0] === 'upgrade').length, 0, fault);
        assert.equal((await f.state()).pods.length, 0, fault);
      }
    },
  );

  test(
    'real readiness preflight rejects a pending Helm release or unavailable local prerequisites without maintenance',
    { timeout: 660000 },
    async (t) => {
      for (const fault of ['pendingRelease', 'preflightFail']) {
        const f = await fixture(t, 'maintenance', fault);
        const result = await f.invoke(['--preflight-only']);
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, fault === 'pendingRelease' ? /not deployed/ : /adapter did not complete/);
        assert.equal(
          (await f.calls()).some(
            (c) =>
              (c.kind === 'helm' && c.args[0] === 'upgrade') ||
              (c.kind === 'kubectl' && ['create', 'replace', 'scale', 'patch', 'delete', 'exec'].includes(c.args[0])),
          ),
          false,
        );
        assert.equal((await f.state()).journal, undefined);
      }
    },
  );

  test(
    'real GKE-shaped HPA preflight and final-apply connection recovery never replay workloads or backup',
    { timeout: 660000 },
    async (t) => {
      const f = await fixture(t, 'maintenance', 'gkeHpa');
      const preflight = await f.invoke(['--preflight-only']);
      assert.equal(preflight.code, 0, preflight.stdout + preflight.stderr);
      assert.deepEqual(
        (await f.stages()).map((s) => s.stage),
        ['preflight'],
      );
      assert.equal((await f.state()).journal, undefined);
      const stateFile = path.join(f.directory, 'state.json');
      await fs.writeFile(stateFile, JSON.stringify({ ...(await f.state()), fault: 'settlementDisconnect' }));
      const deployment = await f.invoke();
      assert.equal(deployment.code, 1, deployment.stdout + deployment.stderr);
      assert.match(deployment.stderr, /--verify-only/);
      const record = JSON.parse((await f.state()).journal.data.record);
      assert.equal(record.phase, 'resuming');
      assert.equal(record.finalApply.protocol, 2);
      assert.ok((await f.state()).pods.length > 0);
      const mutations = (calls) =>
        calls.filter(
          (c) =>
            (c.kind === 'helm' && c.args[0] === 'upgrade') ||
            (c.kind === 'kubectl' && ['scale', 'patch', 'delete', 'exec'].includes(c.args[0])),
        ).length;
      const before = mutations(await f.calls());
      const stages = (await f.stages()).length;
      const checkpoint = record.recoveryCheckpoint.directory;
      const receipt = JSON.parse(await fs.readFile(path.join(checkpoint, 'receipt.json'), 'utf8'));
      const artifact = path.join(checkpoint, receipt.artifacts[0].path);
      const bytes = await fs.readFile(artifact);
      await fs.writeFile(artifact, 'corrupted retained backup');
      const rejected = await f.invoke(['--resume-cutover', record.token, '--verify-only']);
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /checksum has changed/);
      assert.equal(mutations(await f.calls()), before);
      assert.equal((await f.stages()).length, stages);
      assert.equal(JSON.parse((await f.state()).journal.data.record).phase, 'resuming');
      await fs.writeFile(artifact, bytes);
      const verified = await f.invoke(['--resume-cutover', record.token, '--verify-only']);
      assert.equal(verified.code, 0, verified.stdout + verified.stderr);
      assert.equal(mutations(await f.calls()), before);
      assert.deepEqual(
        (await f.stages()).slice(stages).map((s) => s.stage),
        ['after'],
      );
      const completed = JSON.parse((await f.state()).journal.data.record);
      assert.equal(completed.phase, 'complete');
      assert.equal(completed.verificationOnlyRecovery, true);
      const report = JSON.parse(
        await fs.readFile(path.join(f.directory, 'artifacts/result/deployment-result.json'), 'utf8'),
      );
      assert.equal(report.outcome.infrastructure, 'existing-verified');
      assert.equal(report.outcome.application, 'passed');
    },
  );

  for (const fault of [
    'completedAutoscalerAdvance',
    'samplingAutoscalerAdvance',
    'busyAutoscalerAdvance',
    'inventoryAutoscalerAdvance',
  ])
    test(
      `real maintenance command handles ${fault} autoscaler journal after baseline`,
      { timeout: 660000 },
      async (t) => {
        const busy = fault === 'busyAutoscalerAdvance';
        const f = await fixture(t, 'maintenance', fault);
        const result = await f.invoke();
        assert.equal((await f.state()).autoscalerAdvancedDuringBaseline, true);
        assert.equal(result.code, busy ? 1 : 0, result.stdout + result.stderr);
        if (busy) {
          assert.match(result.stderr, /autoscaling operation owns this release/);
          assert.equal(
            (await f.calls()).some(
              (r) =>
                (r.kind === 'kubectl' && ['create', 'replace', 'patch', 'scale', 'delete'].includes(r.args[0])) ||
                (r.kind === 'helm' && r.args[0] === 'upgrade'),
            ),
            false,
          );
          assert.equal(JSON.parse((await f.state()).journal.data.record).autoscalingProtocol, 1);
        } else {
          const record = JSON.parse((await f.state()).journal.data.record);
          if (fault === 'inventoryAutoscalerAdvance') {
            const state = await f.state();
            assert.equal(state.inventoryAutoscalerAdvanced, true);
            assert.equal(state.claimVersion, state.inventorySampleVersion);
          }
          if (fault === 'samplingAutoscalerAdvance')
            assert.ok(
              (await f.state()).samplingLeaseReads > 0,
              'The command must observe the held sampling lease before waiting',
            );
          assert.equal(record.formatVersion, 1);
          assert.equal(record.phase, 'complete');
          assert.equal((await f.state()).installed.release.production.manifestDigest, f.digest);
        }
      },
    );

  test(
    'real maintenance claim is never retried after a CAS conflict or lost acknowledgement',
    { timeout: 660000 },
    async (t) => {
      for (const fault of ['claimConflict', 'lostClaimAcknowledgement']) {
        const f = await fixture(t, 'maintenance', fault);
        const result = await f.invoke();
        assert.equal(result.code, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /ownership write is unconfirmed/);
        const writes = (await f.calls()).filter(
          (r) =>
            (r.kind === 'kubectl' && ['create', 'replace', 'patch', 'scale', 'delete'].includes(r.args[0])) ||
            (r.kind === 'helm' && r.args[0] === 'upgrade'),
        );
        assert.equal(writes.length, 1, 'Only the initial journal CAS may be dispatched');
        assert.equal(writes[0].args[0], 'replace');
        const record = JSON.parse((await f.state()).journal.data.record);
        if (fault === 'lostClaimAcknowledgement') {
          assert.equal(record.phase, 'quiescing');
          assert.ok(result.stderr.includes(record.token), 'An uncertain accepted claim retains its recovery token');
        } else assert.equal(record.autoscalingProtocol, 1);
      }
    },
  );

  test(
    'real deployment command blocks mutations when backup fails after successful prerequisites',
    { timeout: 660000 },
    async (t) => {
      const f = await fixture(t, 'rolling', 'backupFail');
      const result = await f.invoke();
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /adapter did not complete/);
      assert.deepEqual(
        (await f.stages()).map((r) => r.stage),
        ['preflight', 'before', 'backup'],
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
        ['preflight'],
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
        ['preflight', 'before', 'backup', 'after'],
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
      const reports = await fs.readdir(path.join(f.directory, 'artifacts/result'));
      const privateReport = reports.filter((file) => /^deployment-failure-[a-f0-9-]+\.private\.json$/.test(file));
      assert.equal(privateReport.length, 1);
      const failure = JSON.parse(
        await fs.readFile(path.join(f.directory, 'artifacts/result', privateReport[0]), 'utf8'),
      );
      const details = JSON.stringify(failure);
      assert.match(details, /diagnostics disk unavailable/);
      assert.match(details, /lost|failed|unconfirmed/i);
      assert.ok(failure.error.cause, 'the public wrapper must not hide the original failure');
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
        if (mode === 'rolling') {
          assert.equal(journal.preparation.state, 'complete');
          assert.ok(
            journal.preparation.jobs.length && journal.preparation.jobs.every((j) => j.warmed && j.absent && j.nodeUid),
          );
          const calls = await f.calls();
          const firstHelm = calls.findIndex((c) => c.kind === 'helm' && c.args[0] === 'upgrade');
          const cleanup = calls
            .map((c, i) => (c.args[0] === 'delete' && c.args[2]?.includes('/jobs/') ? i : -1))
            .filter((i) => i >= 0);
          assert.equal(cleanup.length, journal.preparation.jobs.length);
          assert.ok(
            cleanup.every((i) => i < firstHelm),
            'Preparation must finish before templates can retire any frontend',
          );
        }
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
});
