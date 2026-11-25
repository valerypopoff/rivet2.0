import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parse, parseAllDocuments } from 'yaml';
import { resolveHelmBinOrThrow } from './lib/k8s-tools.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';

// test-style: fixture-read: Read generated Helm fixture values, stand-in state, requests and command result receipts.
import { deployQualifiedRelease } from './lib/deploy-qualified-release.mjs';
import { autoscalerPolicy, autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import {
  HA_BROWSER_CONTRACT,
  HA_COOPERATIVE_AUTOSCALING_CHECKS,
  HA_DEVELOPER_OVERLAP_CHECKS,
  HA_ORDINARY_RUNTIME_CHECKS,
  HA_PROVIDER_OVERLAP_CHECKS,
  HA_REQUIRED_CHECKS,
  HA_RUNTIME_CONTROL_CHECKS,
} from './lib/ha-release-evidence.mjs';
import { overlapProfileDigest } from './lib/qualification-overlap-profile.mjs';
import { runRecordingTransitionCommand } from './lib/recording-transition-command.mjs';
import { installedSettingsDigest } from './lib/runtime-qualification-installation.mjs';
import {
  createProductionHelmValues,
  createStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const clone = structuredClone;
export function createDeploymentCommandEnvironment(environment = process.env) {
  const env = { ...environment };
  const operatorBindings = new Set([
    'RIVET_PRODUCTION_EVIDENCE_BUCKET',
    'RIVET_PRODUCTION_EVIDENCE_PREFIX',
    'RIVET_RECORDING_TRANSITION_GUARD',
    'RIVET_RECORDING_TRANSITION_CONFIGURATION',
    'RIVET_RECORDING_TRANSITION_CONFIGURATION_SHA256',
  ]);
  for (const key of Object.keys(env))
    if (operatorBindings.has(process.platform === 'win32' ? key.toUpperCase() : key)) delete env[key];
  return env;
}
export const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
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
if(state.fault==='boundObserver'){
 const keys=['operationId','installedManifestDigest','candidateManifestDigest','valuesDigest','operationPlanDigest','namespaceUid'];
 const file=path.join(fixture,'observer-binding.json');
 if(r.stage==='before')await fs.writeFile(file,JSON.stringify(r),{flag:'wx'});
 if(r.stage==='after'){
  const original=JSON.parse(await fs.readFile(file,'utf8'));
  if(keys.some(key=>r[key]!==original[key]))throw Error('Original observer binding changed');
  if(!state.acceptanceFailed){state.acceptanceFailed=true;await fs.writeFile(path.join(fixture,'state.json'),JSON.stringify(state));throw Error('Synthetic final acceptance failure');}
 }
}
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
 databaseRestoreVerified:true,objectReferencesCovered:true,encryptionKeysRecoverable:true,unrelatedDataExcluded:true,recordingEncodings:r.requiredRecordingEncodings,artifacts:[]};
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
}else{out.kind=r.stage==='preflight'?'rivet-deployment-preflight':'rivet-deployment-acceptance';out.checks={};for(const name of (r.stage==='preflight'?['dependencies','capacity',...(r.requiredRecordingEncodings?['recordingStorage']:[])]:r.stage==='backend'?['developerApi','editorSession']:['workflow','webApp','remoteDebugger'])){
 await fs.writeFile(path.join(directory,name),'synthetic application journey');out.checks[name]={passed:true,observed:true,evidence:name};}}
await fs.writeFile(receipt,JSON.stringify(out));`;

export async function createFixtureDirectory(workspaceRoot) {
  const artifacts = path.join(workspaceRoot, 'artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  return fs.mkdtemp(path.join(artifacts, 'deployment-command-'));
}

export async function createDeploymentCommandTools() {
  const directory = await createFixtureDirectory(root);
  const commandTool = path.join(directory, 'deployment-command-tool.cjs');
  await build({
    entryPoints: [path.join(root, 'deploy/studio-server/scripts/fixtures/deployment-command-tool.mjs')],
    outfile: commandTool,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  });
  return { file: commandTool, close: () => fs.rm(directory, { recursive: true, force: true }) };
}
export async function createDeploymentCommandFixture(
  t,
  mode,
  fault,
  schemaChange = false,
  recordingCoordination = true,
  { commandTool, guard = true } = {},
) {
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
  if (recordingCoordination) {
    const recordingContract = 'packages/studio-server-bootstrap/recording-storage.mjs';
    await fs.mkdir(path.dirname(path.join(directory, recordingContract)), { recursive: true });
    await fs.copyFile(path.join(root, recordingContract), path.join(directory, recordingContract));
  }
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
  if (mode === 'qualified') {
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-compact-edge.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-autoscaling.yaml'));
    base.ha.controlPlane.mode = 'singleton';
    base.ha.namespaceUid = '11111111-1111-4111-8111-111111111111';
    candidate.evidence.runtimeControl = {
      ...candidate.evidence.runtimeControl,
      protocol: 2,
      purpose: 'ordinary-upgrade',
      controlPlaneMode: 'singleton',
      edgeProfiles: ['compact'],
      predecessorManifestDigest: getStudioServerReleaseManifestDigest(previous),
      autoscalerPolicyDigest: autoscalerPolicyDigest(
        autoscalerPolicy({ maxReplicas: base.autoscaling.execution.maxReplicas }),
      ),
      checks: [...HA_ORDINARY_RUNTIME_CHECKS],
    };
    candidate.evidence.runtimeAutoscaling = {
      protocol: 2,
      provider: 'gke',
      candidateSourceSha: sha,
      candidateImages: candidate.images,
      chartDigest: candidate.chart.contentDigest,
      requestSamples: 150,
      failedRequests: 0,
      policyDigest: candidate.evidence.runtimeControl.autoscalerPolicyDigest,
      checks: [...HA_COOPERATIVE_AUTOSCALING_CHECKS],
    };
  }
  if (mode === 'overlap' || mode === 'singleton') {
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'));
    base.ha.controlPlane.mode = mode === 'overlap' ? 'singleton-overlap' : 'singleton';
    base.ha.namespaceUid = '11111111-1111-4111-8111-111111111111';
    base.resources.backendOverlap = clone(base.resources.backend);
    base.resourceLimitAcknowledgements.backendOverlap = clone(base.resourceLimitAcknowledgements.backend);
  }
  if (adoptionStage) {
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-ha.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-compact-edge.yaml'));
    merge(base, await read('deploy/studio-server/helm/overlays/gke-runtime-autoscaling.yaml'));
    // Ownership transfer is a separate two-proxy operation, not the compact
    // ordinary rolling-update profile. Keep this fixture independent of defaults.
    base.replicaCount.proxy = 2;
    base.autoscaling.proxy.minReplicas = 2;
    base.availability.topologySpread.minDomains = 2;
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
    namespaceUid:
      mode === 'overlap' || mode === 'qualified' || adoptionStage ? base.ha.namespaceUid : 'fixture-namespace-uid',
    version: 0,
    resources: [],
    pods: [],
    retirements: {},
    installed: {},
    fault: null,
    simulateAutoscaler: Boolean(adoptionStage) || mode === 'qualified',
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
    '\nempty-kubeconfig\nstate.json\ncalls.ndjson\nadapters.ndjson\nstate.lock\nclock-offset.json\nobserver-binding.json\n',
  );
  const env = {
    ...createDeploymentCommandEnvironment(),
    RIVET_COMMAND_FIXTURE: directory,
    RIVET_FIXTURE_COMMAND_TOOL: commandTool,
    RIVET_FIXTURE_REAL_HELM: realHelm,
    KUBECONFIG: path.join(directory, 'empty-kubeconfig'),
    RIVET_K8S_HELM_BIN: path.join(bin, 'helm.exe'),
    RIVET_K8S_KUBECTL_BIN: path.join(bin, 'kubectl.exe'),
  };
  if (guard) {
    const recordingGuard = new Worker(new URL('./fixtures/recording-transition-guard.mjs', import.meta.url), {
      workerData: { protocol: 1, release: 'rivet', namespace: 'fixture', context: 'fixture-context' },
    });
    env.RIVET_RECORDING_TRANSITION_GUARD = await new Promise((resolve, reject) => {
      recordingGuard.once('message', resolve);
      recordingGuard.once('error', reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) => {
          recordingGuard.once('exit', resolve);
          recordingGuard.once('error', reject);
          recordingGuard.postMessage('close');
        }),
    );
  }
  execFileSync(
    process.execPath,
    [
      commandTool,
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
    { cwd: directory, env: { ...env, NODE_OPTIONS: '' } },
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
  const cli = path.join(directory, 'deploy/studio-server/scripts/deploy-kubernetes-release.mjs');
  const invocation = (extra = []) => ({
    program: process.execPath,
    args: [
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
    options: { cwd: directory, env, capture: true },
  });
  const invoke = async (extra = []) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, invocation(extra).args, {
        cwd: directory,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
    invocation,
    invoke,
    async qualified({ configurationFile, privateStore, preflightOnly = false, run, loadTransition }) {
      const before = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
      const packet = path.join(directory, 'artifacts/qualified-attempt');
      await fs.mkdir(packet, { recursive: true });
      return deployQualifiedRelease({
        root: directory,
        packet,
        manifest: candidate,
        digest: getStudioServerReleaseManifestDigest(candidate, { requirePromoted: true }),
        sourceSha: sha,
        valuesFile: path.join(directory, 'artifacts/values.json'),
        policyFile: path.join(directory, 'artifacts/policy.json'),
        identity: { context: 'fixture-context', namespace: 'fixture', release: 'rivet' },
        operation: {
          operationId: 'rivet-q-123-1',
          predecessorManifestDigest: candidate.lineage.predecessor.manifestDigest,
          candidate: { sourceSha: sha, images: candidate.images, chartDigest: candidate.chart.contentDigest },
          installed: {
            namespaceUid: before.namespaceUid,
            manifestDigest: candidate.lineage.predecessor.manifestDigest,
            valuesDigest: hash(await fs.readFile(path.join(directory, 'artifacts/values.json'))),
            settingsDigest: installedSettingsDigest(before.installed),
          },
        },
        configurationFile,
        environment: env,
        privateStore,
        preflightOnly,
        run: (program, args, options) =>
          run(program, args, {
            ...options,
            env: {
              ...(options?.env ?? env),
              NODE_OPTIONS: env.NODE_OPTIONS,
              RIVET_COMMAND_FIXTURE: env.RIVET_COMMAND_FIXTURE,
              RIVET_FIXTURE_COMMAND_TOOL: env.RIVET_FIXTURE_COMMAND_TOOL,
              RIVET_FIXTURE_REAL_HELM: env.RIVET_FIXTURE_REAL_HELM,
              RIVET_K8S_HELM_BIN: env.RIVET_K8S_HELM_BIN,
              RIVET_K8S_KUBECTL_BIN: env.RIVET_K8S_KUBECTL_BIN,
              KUBECONFIG: env.KUBECONFIG,
            },
          }),
        runGuardedRelease: (input) => runRecordingTransitionCommand({ ...input, load: loadTransition }),
      });
    },
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
      return (
        await fs.readFile(path.join(directory, 'adapters.ndjson'), 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        })
      )
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
