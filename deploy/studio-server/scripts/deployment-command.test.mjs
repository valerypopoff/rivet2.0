import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { assertNoOperatorRolloutGuards } from './deploy-kubernetes-release.mjs';

// test-style: fixture-read: Read generated Helm fixture values, stand-in state, requests and command result receipts.
import {
  createDeploymentCommandFixture,
  createDeploymentCommandEnvironment,
  createDeploymentCommandTools,
  createFixtureDirectory,
  hash,
} from './deployment-command-fixture.mjs';
import { installedSettingsDigest } from './lib/runtime-qualification-installation.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
test('fresh operator inputs reject stale rollout guards without rewriting bound recovery inputs', () => {
  const stale = 'ha:\n  rolloutResourceVersions:\n    rivet-backend: "old-version"\n';
  assert.throws(() => assertNoOperatorRolloutGuards(stale, new Map()), /private guards from another operation/);
  assert.doesNotThrow(() => assertNoOperatorRolloutGuards('ha:\n  rolloutResourceVersions: {}', new Map()));
  for (const option of ['--env-file', '--plan-only', '--acceptance-only', '--resume-ha', '--resume-cutover'])
    assert.doesNotThrow(() => assertNoOperatorRolloutGuards(stale, new Map([[option, 'explicit']])));
});
let commandTools;
before(async () => {
  commandTools = await createDeploymentCommandTools();
});
after(async () => {
  await commandTools?.close();
});
const fixture = (t, mode, fault, schemaChange = false, recordingCoordination = true) =>
  createDeploymentCommandFixture(t, mode, fault, schemaChange, recordingCoordination, {
    commandTool: commandTools.file,
  });

test('deployment fixtures exclude inherited operator archival and coordination bindings', () => {
  const environment = { KEEP_FIXTURE_VALUE: 'preserved' };
  for (const name of [
    'RIVET_PRODUCTION_EVIDENCE_BUCKET',
    'RIVET_PRODUCTION_EVIDENCE_PREFIX',
    'RIVET_RECORDING_TRANSITION_GUARD',
    'RIVET_RECORDING_TRANSITION_CONFIGURATION',
    'RIVET_RECORDING_TRANSITION_CONFIGURATION_SHA256',
  ]) {
    environment[name] = 'operator-only';
    if (process.platform === 'win32') environment[name.toLowerCase()] = 'case alias';
  }
  const before = { ...environment };
  assert.deepEqual(createDeploymentCommandEnvironment(environment), { KEEP_FIXTURE_VALUE: 'preserved' });
  assert.deepEqual(environment, before);
});

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

const clone = structuredClone;

test('a coordination release without its real wrapper refuses preflight before backup or workload mutation', async (t) => {
  for (const candidateContract of ['required', 'absent']) {
    const f = await createDeploymentCommandFixture(t, 'rolling', null, false, true, {
      commandTool: commandTools.file,
      guard: false,
    });
    if (candidateContract === 'absent') {
      const file = path.join(f.directory, 'artifacts/manifest.json');
      const candidate = JSON.parse(await fs.readFile(file, 'utf8'));
      delete candidate.recordingStorage;
      await fs.writeFile(file, JSON.stringify(candidate));
    }
    const result = await f.invoke(['--preflight-only']);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      candidateContract === 'required' ? /requires the recording storage transition wrapper/ : /cannot read/,
    );
    assert.equal((await f.stages()).length, 0);
    const calls = await f.calls();
    assert.equal(calls.filter((call) => ['upgrade', 'apply', 'delete', 'patch'].includes(call.args?.[0])).length, 0);
  }
});

// Each scenario owns its directory, stand-in state, clock and child processes.
// Bound overlap rather than serialize all real CLI recovery journeys into one
// CI timeout. Operations inside an individual journey remain strictly ordered.
describe('isolated deployment command journeys', { concurrency: 3 }, () => {
  test('the online rollout guard refuses a singleton before backup or workload changes', async (t) => {
    const f = await fixture(t, 'singleton');
    const preview = await f.invoke(['--require-online', '--plan-only']);
    assert.equal(preview.code, 0, preview.stdout + preview.stderr);
    assert.match(preview.stdout, /continuity-required; 0 qualified hop/);
    const plan = JSON.parse(await fs.readFile(path.join(f.directory, 'artifacts/result/upgrade-plan.json'), 'utf8'));
    assert.equal(plan.status, 'continuity-required');
    assert.deepEqual(plan.steps, []);

    const blocked = await f.invoke(['--require-online', '--preflight-only']);
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /qualify online editor adoption on the installed images first/i);
    const transition = await f.invoke(['--require-online', '--ha-control-plane-transition']);
    assert.equal(transition.code, 1, transition.stdout + transition.stderr);
    assert.match(transition.stderr, /--require-online applies to an installed rolling release/);
    await assert.rejects(fs.stat(path.join(f.directory, 'adapters.ndjson')), { code: 'ENOENT' });
    assert.ok(
      (await f.calls()).every((c) => !['upgrade', 'create', 'replace', 'patch', 'scale', 'delete'].includes(c.args[0])),
    );
  });

  test(
    'acceptance-only can finish the original bound observer without another deployment or backup',
    { timeout: 330000 },
    async (t) => {
      // Preserve the original direct-Helm acceptance flow; coordinated releases use a journaled route.
      const f = await fixture(t, 'direct', 'boundObserver', false, false);
      const expected = ['--expected-installed-settings-digest', installedSettingsDigest((await f.state()).installed)];
      const deployed = await f.invoke(expected);
      assert.equal(deployed.code, 1, deployed.stdout + deployed.stderr);
      assert.match(deployed.stderr, /Infrastructure deployment completed, but application acceptance failed/);
      const writes = (await f.calls()).filter((call) =>
        ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(call.args[0]),
      ).length;
      const requests = (await fs.readdir(path.join(f.directory, 'artifacts/result'))).filter((name) =>
        name.startsWith('after-'),
      );
      assert.equal(requests.length, 1);
      const original = path.join('artifacts/result', requests[0], 'request.json');
      const changed = path.join(f.directory, 'artifacts/changed-request.json');
      await fs.writeFile(
        changed,
        JSON.stringify({
          ...JSON.parse(await fs.readFile(path.join(f.directory, original))),
          valuesDigest: hash('other'),
        }),
      );
      const rejected = await f.invoke([...expected, '--acceptance-only', '--acceptance-request', changed]);
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /Original acceptance request must match/);
      assert.equal((await f.stages()).length, 4, 'Mismatched observer context must not reach the adapter');
      const current = await f.state(),
        manifest = current.manifest;
      const documents = parseAllDocuments(manifest);
      documents
        .find((document) => document.get('kind') === 'ConfigMap' && document.get('data'))
        .setIn(['data', 'unexpected-policy'], 'changed');
      current.manifest = documents.map((document) => document.toString()).join('\n---\n');
      await fs.writeFile(path.join(f.directory, 'state.json'), JSON.stringify(current));
      const drifted = await f.invoke([...expected, '--acceptance-only', '--acceptance-request', original]);
      assert.equal(drifted.code, 1, drifted.stdout + drifted.stderr);
      assert.match(drifted.stderr, /verification failed; no release changes were made/i);
      assert.equal((await f.stages()).length, 4, 'Final configuration drift must still block application acceptance');
      const observed = await f.state();
      observed.manifest = manifest;
      await fs.writeFile(path.join(f.directory, 'state.json'), JSON.stringify(observed));
      const verified = await f.invoke([...expected, '--acceptance-only', '--acceptance-request', original]);
      assert.equal(verified.code, 0, verified.stdout + verified.stderr);
      assert.equal(
        (await f.calls()).filter((call) =>
          ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(call.args[0]),
        ).length,
        writes,
      );
      assert.deepEqual(
        (await f.stages()).map((entry) => entry.stage),
        ['preflight', 'before', 'backup', 'after', 'after'],
      );
      assert.equal(
        new Set((await f.stages()).filter((entry) => entry.stage !== 'preflight').map((entry) => entry.operationId))
          .size,
        1,
      );
    },
  );
  test(
    'qualification baseline is checked inside the real deployment command before any write or adapter',
    { timeout: 330000 },
    async (t) => {
      const f = await fixture(t, 'rolling');
      const baseline = installedSettingsDigest((await f.state()).installed);
      const failed = await f.invoke(['--expected-installed-settings-digest', `sha256:${'0'.repeat(64)}`]);
      assert.equal(failed.code, 1, failed.stdout + failed.stderr);
      assert.match(failed.stderr, /settings changed since qualification/);
      assert.ok(
        !(await f.calls()).some((c) =>
          ['upgrade', 'patch', 'scale', 'delete', 'create', 'replace'].includes(c.args[0]),
        ),
      );
      assert.equal((await f.state()).journal, undefined);
      const passed = await f.invoke(['--preflight-only', '--expected-installed-settings-digest', baseline]);
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
    },
  );
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
      assert.equal(before.installed.replicaCount.proxy, 2);
      assert.equal(before.installed.autoscaling.proxy.minReplicas, 2);
      assert.equal(before.installed.availability.topologySpread.minDomains, 2);
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
      assert.equal(
        (await f.state()).injected,
        true,
        'Expected the intended lost template acknowledgement.\n' + lost.stdout + lost.stderr,
      );
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
      const f = await fixture(t, 'direct', null, false, false); // Legacy release without codec coordination.
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

  test('coordinated recording storage refuses an unjournaled non-HA update before mutation', async (t) => {
    const f = await fixture(t, 'direct', null);
    const result = await f.invoke();
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /journaled HA rollout or explicit --maintenance-cutover/);
    assert.ok(
      !(await f.calls()).some((call) =>
        ['upgrade', 'create', 'replace', 'delete', 'patch', 'scale'].includes(call.args[0]),
      ),
    );
    await assert.rejects(fs.stat(path.join(f.directory, 'adapters.ndjson')), { code: 'ENOENT' });
  });

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
          assert.equal(journal.preparation, undefined, 'Normal updates need no scheduler/image warmup Jobs');
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
