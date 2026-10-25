import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readDeploymentPolicy,
  runDeploymentStage,
  executeDeploymentWorkflow as runDeploymentWorkflow,
  deploymentRecoveryIdentity,
  assertDeploymentBaseline,
} from './lib/deployment-workflow.mjs';
import { fixtureDeploymentSafety } from './fixtures/deployment-safety.mjs';
const executeDeploymentWorkflow = (options) =>
  runDeploymentWorkflow({
    ...options,
    prepareSafety:
      options.prepareSafety ??
      (() =>
        fixtureDeploymentSafety('direct', {
          release: options.context?.release ?? 'fixture',
          namespace: options.context?.namespace ?? 'fixture',
          manifestDigest: options.context?.candidateManifestDigest ?? 'fixture',
        })),
  });

const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('the final baseline check rejects a recreated or terminating namespace even at the same installed version', () => {
  const expected = { installedManifestDigest: hash('installed'), namespace: 'fixture', namespaceUid: 'original' };
  const installed = { release: { production: { manifestDigest: expected.installedManifestDigest } } };
  const namespace = { metadata: { name: 'fixture', uid: 'original' } };
  assert.doesNotThrow(() => assertDeploymentBaseline(expected, installed, namespace));
  for (const actual of [
    null,
    { metadata: { name: 'fixture', uid: 'replacement' } },
    { metadata: { name: 'other', uid: 'original' } },
    { metadata: { ...namespace.metadata, deletionTimestamp: '2026-10-23T01:00:00Z' } },
  ])
    assert.throws(() => assertDeploymentBaseline(expected, installed, actual), /namespace identity changed/);
  assert.throws(() => assertDeploymentBaseline(expected, {}, namespace), /Installed version changed/);
  assert.doesNotThrow(() =>
    assertDeploymentBaseline({ installedManifestDigest: expected.installedManifestDigest }, installed),
  );
});

test('only an explicit exact token resumes a verified workflow and preserves its original installed baseline', () => {
  const options = { policyDigest: hash('policy'), valuesDigest: hash('values') };
  assert.equal(deploymentRecoveryIdentity(null, options), null);
  assert.equal(deploymentRecoveryIdentity({ phase: 'complete', token: 'old' }, options), null);
  const workflowIdentity = {
    ...options,
    operationId: 'operation',
    beforeVerified: true,
    installedManifestDigest: hash('original-installed'),
  };
  const journal = { phase: 'owners', token: 'exact', workflowIdentity };
  assert.deepEqual(deploymentRecoveryIdentity(journal, { ...options, resumeToken: 'exact' }), workflowIdentity);
  for (const [saved, supplied] of [
    [null, { ...options, resumeToken: 'exact' }],
    [journal, options],
    [journal, { ...options, resumeToken: 'wrong' }],
    [
      { ...journal, phase: 'complete' },
      { ...options, resumeToken: 'exact' },
    ],
    [journal, { ...options, resumeToken: 'exact', valuesDigest: hash('changed') }],
    [
      { ...journal, workflowIdentity: { ...workflowIdentity, installedManifestDigest: undefined } },
      { ...options, resumeToken: 'exact' },
    ],
  ])
    assert.throws(() => deploymentRecoveryIdentity(saved, supplied), /exact unfinished|original deployment/);
});
const adapter = `import fs from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';
const read=process.argv[process.argv.indexOf('--request')+1], out=process.argv[process.argv.indexOf('--receipt')+1];
const r=JSON.parse(await fs.readFile(read,'utf8')), directory=path.dirname(out);
console.log('private adapter log');
let receipt={...r,passed:true};
if(r.stage==='backup'){
 receipt={...receipt,kind:r.consistency==='online'?'rivet-recovery-checkpoint':'rivet-frozen-recovery-checkpoint',capturedAt:new Date().toISOString(),databaseRestoreVerified:true,
 objectReferencesCovered:true,encryptionKeysRecoverable:true,unrelatedDataExcluded:true,artifacts:[]};
 for(const role of ['database','objects','keys','verification']){const text=role+' recovery bytes';await fs.writeFile(path.join(directory,role),text);
 receipt.artifacts.push({role,path:role,sha256:'sha256:'+createHash('sha256').update(text).digest('hex')});}
}else{receipt.kind='rivet-deployment-acceptance';receipt.checks={};for(const name of (r.stage==='backend'?['developerApi','editorSession']:['workflow','webApp','remoteDebugger'])){
 await fs.writeFile(path.join(directory,name),'observed fixture journey');receipt.checks[name]={passed:true,observed:true,evidence:name};}}
await fs.writeFile(out,JSON.stringify(receipt));`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-deployment-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactsDir = path.join(root, 'artifacts');
  await fs.mkdir(artifactsDir);
  await fs.writeFile(path.join(root, 'adapter.mjs'), adapter);
  const policy = {
    formatVersion: 1,
    release: 'rivet',
    namespace: 'fixture',
    context: 'fixture',
    namespaceUid: 'ns-uid',
    backup: { script: 'adapter.mjs', sha256: hash(adapter) },
    acceptance: { script: 'adapter.mjs', sha256: hash(adapter) },
  };
  await fs.writeFile(path.join(root, 'policy.json'), JSON.stringify(policy));
  const context = {
    release: 'rivet',
    namespace: 'fixture',
    context: 'fixture',
    namespaceUid: 'ns-uid',
    operationId: 'operation',
    installedManifestDigest: hash('installed'),
    candidateManifestDigest: hash('candidate'),
    valuesDigest: hash('values'),
  };
  const approval = await readDeploymentPolicy('policy.json', root, context);
  return { root, artifactsDir, policy, context, approval, options: { artifactsDir, timeoutMs: 5000 } };
}

test('real private adapters bind online recovery and before/after application journeys to each attempt', async (t) => {
  const f = await fixture(t);
  for (const stage of ['before', 'backup', 'after']) {
    const report = await runDeploymentStage(f.approval, stage, f.context, f.options);
    assert.equal(report.verified, true);
    assert.equal(JSON.stringify(report).includes('private adapter log'), false);
    assert.match(await fs.readFile(path.join(report.directory, 'adapter-private.log'), 'utf8'), /private adapter log/);
    assert.equal(JSON.parse(await fs.readFile(path.join(report.directory, 'verified.json'), 'utf8')).stage, stage);
  }
});

test('changed scripts or namespace identity fail before an adapter starts', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runDeploymentStage(f.approval, 'before', { ...f.context, namespaceUid: 'other' }, f.options),
    /installation/,
  );
  await fs.writeFile(path.join(f.root, 'adapter.mjs'), '// changed');
  await assert.rejects(runDeploymentStage(f.approval, 'backup', f.context, f.options), /adapter changed/);
  assert.deepEqual(await fs.readdir(f.artifactsDir), []);
});

test('backend acceptance requires both real journeys and the exact pod/process identity', async (t) => {
  const f = await fixture(t);
  const context = { ...f.context, backendCandidate: { uid: 'exact-pod', incarnation: 'exact-process' } };
  assert.equal((await runDeploymentStage(f.approval, 'backend', context, f.options)).verified, true);
  for (const change of [
    (r) => { r.backendCandidate.uid = 'replacement'; },
    (r) => { r.backendCandidate.incarnation = 'replacement'; },
    (r) => { delete r.checks.editorSession; },
    (r) => { r.checks.developerApi.observed = false; },
  ]) await assert.rejects(runDeploymentStage(f.approval, 'backend', context, { ...f.options,
    runAdapter: async (_script, request, receipt, options) => {
      const { executeMaintenanceBackupAdapter } = await import('./lib/maintenance-deployment-plan.mjs');
      await executeMaintenanceBackupAdapter(f.approval.scripts.acceptance, request, receipt, options);
      const result = JSON.parse(await fs.readFile(receipt, 'utf8')); change(result);
      await fs.writeFile(receipt, JSON.stringify(result));
    },
  }), /another backend|acceptance failed/);
  await assert.rejects(runDeploymentStage(f.approval, 'backend', { ...context, backendCandidate: { uid: 'exact-pod' } }, f.options), /another backend/);
});

test('a cutover checkpoint needs a live quiesced lease and verifies frozen recovery bytes', async (t) => {
  const f = await fixture(t);
  const context = {
    ...f.context,
    consistency: 'quiesced',
    phase: 'quiesced',
    journalToken: 'cutover-token',
    leaseExpiresAt: Date.now() + 60_000,
  };
  assert.equal((await runDeploymentStage(f.approval, 'backup', context, f.options)).verified, true);
  for (const patch of [{ phase: 'validating' }, { leaseExpiresAt: 0 }, { journalToken: '' }])
    await assert.rejects(
      runDeploymentStage(f.approval, 'backup', { ...context, ...patch }, f.options),
      /live quiesced/,
    );
});

test('old, partial or falsely successful receipts never authorize completion', async (t) => {
  for (const change of [
    (r) => {
      r.requestId = 'old';
    },
    (r) => {
      r.valuesDigest = hash('other');
    },
    (r) => {
      r.namespaceUid = 'other';
    },
    (r) => {
      r.release = 'other';
    },
    (r) => {
      r.namespace = 'other';
    },
    (r) => {
      r.context = 'other';
    },
    (r) => {
      r.checks.workflow.observed = false;
    },
    (r) => {
      delete r.checks.remoteDebugger;
    },
    (r) => {
      r.checks.webApp.evidence = '../outside';
    },
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      runDeploymentStage(f.approval, 'after', f.context, {
        ...f.options,
        runAdapter: async (_script, request, receipt, options) => {
          const { executeMaintenanceBackupAdapter } = await import('./lib/maintenance-deployment-plan.mjs');
          await executeMaintenanceBackupAdapter(f.approval.scripts.acceptance, request, receipt, options);
          const r = JSON.parse(await fs.readFile(receipt, 'utf8'));
          change(r);
          await fs.writeFile(receipt, JSON.stringify(r));
        },
      }),
      /another attempt|acceptance failed|regular files/,
    );
    for (const entry of await fs.readdir(f.artifactsDir))
      await assert.rejects(fs.stat(path.join(f.artifactsDir, entry, 'verified.json')), { code: 'ENOENT' });
  }
});

test('one workflow invokes actual backup/application adapters before mutation and after infrastructure completion', async (t) => {
  const f = await fixture(t),
    order = [],
    reports = [];
  const result = await executeDeploymentWorkflow({
    ...f.options,
    approval: f.approval,
    context: f.context,
    run: async () => {
      order.push('deploy');
    },
    verifyActivation: async () => order.push('activate'),
    stage: async (...args) => {
      order.push(args[1]);
      return runDeploymentStage(...args);
    },
    artifact: async (_name, value) => reports.push(JSON.parse(value)),
  });
  assert.deepEqual(order, ['before', 'backup', 'deploy', 'activate', 'after']);
  assert.equal(result.state, 'complete');
  assert.equal(reports.at(-1).state, 'complete');
});

test('backup failure prevents deployment and application failure preserves completed infrastructure', async () => {
  for (const failed of ['before', 'backup', 'deploy', 'after']) {
    const order = [],
      reports = [];
    await assert.rejects(
      executeDeploymentWorkflow({
        context: { operationId: 'operation' },
        stage: async (_approval, name) => {
          order.push(name);
          if (name === failed) throw Error('fixture failure');
          return { stage: name };
        },
        run: async () => {
          order.push('deploy');
          if (failed === 'deploy') throw Error('fixture failure');
        },
        artifact: async (_name, value) => reports.push(JSON.parse(value)),
      }),
      failed === 'after' ? /Traffic and scaling remain active/ : /fixture failure/,
    );
    assert.deepEqual(
      order,
      ['before', 'backup', 'deploy', 'after'].slice(0, ['before', 'backup', 'deploy', 'after'].indexOf(failed) + 1),
    );
    assert.equal(
      reports.at(-1).state,
      failed === 'after'
        ? 'infrastructure-complete-application-failed'
        : failed === 'deploy'
          ? 'deployment-incomplete'
          : 'preparation-failed',
    );
  }
});

test('recovery uses its recorded baseline without requiring the unavailable old UI to pass again', async () => {
  const order = [];
  await executeDeploymentWorkflow({
    context: { operationId: 'original', recovering: true },
    stage: async (_approval, name) => {
      order.push(name);
      return { stage: name };
    },
    run: async () => order.push('deploy'),
  });
  assert.deepEqual(order, ['backup', 'deploy', 'after']);
});

test('failed verification-only settlement never reports an unfinished deployment or reruns preparation', async () => {
  const failure = Error('management inventory unavailable'),
    reports = [],
    stages = [];
  await assert.rejects(
    executeDeploymentWorkflow({
      verificationOnly: true,
      context: { operationId: 'verification', recovering: true },
      stage: async (_approval, name) => {
        stages.push(name);
      },
      run: async () => {
        throw failure;
      },
      verifyActivation: async () => assert.fail('activation must not follow failed settlement'),
      artifact: async (_name, value) => reports.push(JSON.parse(value)),
    }),
    (error) => {
      assert.match(error.message, /verification.*failed/i);
      assert.match(error.message, /no release changes/i);
      assert.equal(error.cause, failure);
      return true;
    },
  );
  assert.deepEqual(stages, []);
  assert.equal(reports.at(-1).state, 'verification-incomplete');
  assert.equal(
    reports.some((r) => ['deploying', 'deployment-incomplete'].includes(r.state)),
    false,
  );
});

test('result milestones distinguish applied workloads, autoscaling and application acceptance', async () => {
  for (const failure of [null, 'deploy', 'activate', 'after']) {
    const reports = [];
    const promise = executeDeploymentWorkflow({
      context: { operationId: 'operation' },
      stage: async (_approval, name) => {
        if (name === failure) throw Error('application unavailable');
        return { stage: name };
      },
      run: async () => {
        if (failure === 'deploy') throw Error('uncertain template acknowledgement');
        return { phase: 'complete', token: 'durable-operation' };
      },
      verifyActivation: async () => {
        if (failure === 'activate') throw Error('controller observation unavailable');
      },
      artifact: async (_name, value) => reports.push(JSON.parse(value)),
    });
    if (failure) await assert.rejects(promise);
    else await promise;
    const result = reports.at(-1);
    assert.deepEqual(result.outcome, {
      infrastructure: failure === 'deploy' ? 'unconfirmed' : 'applied',
      autoscaling: failure === 'deploy' ? 'not-verified' : failure === 'activate' ? 'unconfirmed' : 'verified',
      application: !failure ? 'passed' : failure === 'after' ? 'failed' : 'not-verified',
    });
    if (failure !== 'deploy') assert.deepEqual(result.operation, { phase: 'complete', token: 'durable-operation' });
  }
});

test('verification-only outcomes do not claim new workload application or configured autoscaling', async () => {
  const result = await executeDeploymentWorkflow({
    verificationOnly: true,
    context: { operationId: 'verification', recovering: true },
    run: async () => {},
    verifyActivation: async () => ({ skipped: true }),
    stage: async (_approval, name) => {
      assert.equal(name, 'after');
      return { verified: true };
    },
  });
  assert.deepEqual(result.outcome, {
    infrastructure: 'existing-verified',
    autoscaling: 'not-configured',
    application: 'passed',
  });
  assert.equal(result.operation, undefined);
});

test('an acknowledged untouched abort uses the runner receipt rather than claiming an incomplete deployment', async () => {
  const reports = [],
    receipt = { token: 'aborted-operation', phase: 'complete', acknowledgement: 'confirmed', aborted: true };
  await assert.rejects(
    executeDeploymentWorkflow({
      context: { operationId: 'fixture' },
      stage: async () => ({ verified: true }),
      run: async () => {
        throw Object.assign(Error('baseline changed'), { deploymentOperation: receipt });
      },
      artifact: async (_name, value) => reports.push(JSON.parse(value)),
    }),
    /baseline changed/,
  );
  assert.equal(reports.at(-1).state, 'deployment-aborted');
  assert.equal(reports.at(-1).outcome.infrastructure, 'not-changed');
  assert.deepEqual(reports.at(-1).operation, receipt);
});

test('lost infrastructure result acknowledgement cannot be reported as a preparation failure', async () => {
  let deployed = false,
    last;
  await assert.rejects(
    executeDeploymentWorkflow({
      run: async () => {
        deployed = true;
      },
      artifact: async (_name, value) => {
        last = JSON.parse(value);
        if (last.state === 'infrastructure-complete') throw Error('lost receipt write');
      },
    }),
    /Infrastructure deployment completed but saving its result is unconfirmed/,
  );
  assert.equal(deployed, true);
  assert.equal(last.state, 'infrastructure-complete-evidence-unconfirmed');
});

test('activation failure after settlement cannot become a failed application of infrastructure', async () => {
  const order = [],
    reports = [];
  await assert.rejects(
    executeDeploymentWorkflow({
      context: { operationId: 'operation' },
      stage: async (_approval, name) => {
        order.push(name);
        return { stage: name };
      },
      run: async () => order.push('deploy'),
      verifyActivation: async () => {
        order.push('activate');
        throw Error('metrics unavailable');
      },
      artifact: async (_name, value) => reports.push(JSON.parse(value)),
    }),
    /Workloads settled.*--acceptance-only/,
  );
  assert.deepEqual(order, ['before', 'backup', 'deploy', 'activate']);
  assert.equal(reports.at(-1).state, 'infrastructure-complete-activation-unverified');
  assert.equal(
    reports.some((report) => report.state === 'deployment-incomplete'),
    false,
  );
});

test('lost final success acknowledgement keeps infrastructure applied and reports evidence unconfirmed', async () => {
  const order = [];
  let last;
  await assert.rejects(
    executeDeploymentWorkflow({
      context: { operationId: 'operation' },
      stage: async (_approval, name) => {
        order.push(name);
        return { stage: name };
      },
      run: async () => order.push('deploy'),
      verifyActivation: async () => order.push('activate'),
      artifact: async (_name, value) => {
        last = JSON.parse(value);
        if (last.state === 'complete') throw Error('lost final receipt write');
      },
    }),
    /Infrastructure deployment completed but saving its result is unconfirmed/,
  );
  assert.deepEqual(order, ['before', 'backup', 'deploy', 'activate', 'after']);
  assert.equal(last.state, 'infrastructure-complete-evidence-unconfirmed');
});

test('failure to save post-deployment failure receipts preserves the primary verification cause', async () => {
  for (const failed of ['activate', 'after']) {
    const primary = Error(`${failed} fixture failure`),
      disk = Error('disk unavailable');
    await assert.rejects(
      executeDeploymentWorkflow({
        context: { operationId: 'operation' },
        run: async () => {},
        verifyActivation: async () => {
          if (failed === 'activate') throw primary;
        },
        stage: async (_approval, name) => {
          if (name === failed) throw primary;
          return { stage: name };
        },
        artifact: async (_name, value) => {
          if (
            ['infrastructure-complete-activation-unverified', 'infrastructure-complete-application-failed'].includes(
              JSON.parse(value).state,
            )
          )
            throw disk;
        },
      }),
      (error) => {
        assert.match(error.message, failed === 'activate' ? /Workloads settled/ : /Traffic and scaling remain active/);
        assert.deepEqual(error.cause.errors, [primary, disk]);
        return true;
      },
    );
  }
});

test('failure-report IO cannot hide the original preparation or deployment error', async () => {
  for (const phase of ['preparing', 'deploying']) {
    const primary = Error(`${phase} original failure`),
      disk = Error('failure receipt disk unavailable');
    let deployments = 0;
    await assert.rejects(
      executeDeploymentWorkflow({
        context: { operationId: 'operation' },
        stage: async () => {
          if (phase === 'preparing') throw primary;
          return { verified: true };
        },
        run: async () => {
          deployments++;
          throw primary;
        },
        artifact: async (_name, value) => {
          if (['preparation-failed', 'deployment-incomplete'].includes(JSON.parse(value).state)) throw disk;
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, disk]);
        assert.match(error.message, /original failure/);
        assert.match(error.message, /result acknowledgement is unconfirmed/);
        return true;
      },
    );
    assert.equal(deployments, phase === 'deploying' ? 1 : 0);
  }
});
// test-style: fixture-read: Read only test-generated adapter requests, private logs and verification receipts.
