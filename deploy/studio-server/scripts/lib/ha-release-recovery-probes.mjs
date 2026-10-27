import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { runHaKubernetesRollout } from './ha-kubernetes-rollout.mjs';
import { createDeploymentSafety } from './deployment-safety.mjs';
import { releaseOperationJournalName } from './release-operation-journal.mjs';
import { runManagedGateCommand as run } from '../kubernetes-managed-release-gate.mjs';
import { HaReleaseProbes, haProofTimeoutMs } from './ha-release-probes.mjs';
import { startHaWorkflowTraffic } from './ha-workflow-traffic.mjs';
import { measureHaPhase } from './ha-proof-timing.mjs';
import { assertHaRecoveryScenario, assertHaRecoveryOwners } from './ha-scenario-evidence.mjs';

async function recoveryOwners(kube, release) {
  const pods = JSON.parse(
    (await kube(['get', 'pods', '-l', `app.kubernetes.io/instance=${release}`, '-o', 'json'])).stdout,
  ).items;
  return pods
    .filter((p) => ['backend', 'execution', 'maintenance'].includes(p.metadata.labels?.['app.kubernetes.io/component']))
    .map((p) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      workload: p.metadata.name.replace(/-\d+$/, ''),
      role: p.metadata.labels['app.kubernetes.io/component'],
      ready:
        !p.metadata.deletionTimestamp && p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'),
      image: p.spec.containers.find((c) => ['backend', 'api'].includes(c.name))?.image,
    }));
}

/** Inject between a serialized runner write and the actual API call. Writing
 * immediately after begin instead can race that runner's concurrent heartbeat:
 * the injector, rather than the runner, loses the CAS and tests the wrong fault. */
export function createHaRecoveryFaultTransport(fault, kube, journal, journalName) {
  assert.ok(['lostAcknowledgement', 'leaseLoss'].includes(fault));
  const state = { injected: false, original: null, beginAccepted: false, conflictObserved: false, begins: 0 };
  const send = async (args, extra) => {
    if (args[0] === 'exec' && args.includes('--begin-only')) {
      state.original ??= args[1];
      if (args[1] === state.original) state.begins++;
      const value = await kube(args, extra);
      if (args[1] === state.original) state.beginAccepted = true;
      if (!state.injected && fault === 'lostAcknowledgement') {
        state.injected = true;
        throw Error('Injected lost begin acknowledgement');
      }
      return value;
    }
    const journalWrite =
      args[0] === 'replace' && extra?.input && JSON.parse(extra.input).metadata?.name === journalName;
    if (fault === 'leaseLoss' && state.beginAccepted && !state.injected && journalWrite) {
      const pending = JSON.parse(extra.input),
        cm = await journal();
      const record = JSON.parse(cm.data.record),
        proposed = JSON.parse(pending.data.record);
      assert.equal(
        cm.metadata.resourceVersion,
        pending.metadata.resourceVersion,
        'unexpected concurrent journal writer',
      );
      assert.equal(record.token, proposed.token);
      assert.equal(record.runner, proposed.runner);
      assert.equal(record.owner?.name, state.original);
      assert.equal(record.owner?.uid, proposed.owner?.uid);
      assert.equal(record.owner?.beginIssued, true);
      cm.data.record = JSON.stringify({ ...record, runner: randomUUID(), leaseExpiresAt: Date.now() - 1 });
      await kube(['replace', '-f', '-', '-o', 'json'], { input: JSON.stringify(cm) });
      state.injected = true;
    }
    try {
      return await kube(args, extra);
    } catch (error) {
      if (
        state.injected &&
        fault === 'leaseLoss' &&
        journalWrite &&
        /Error from server \(Conflict\)/.test(String(error))
      )
        state.conflictObserved = true;
      throw error;
    }
  };
  return { send, state };
}

async function recoveryResources(gate, rootDir, values, tag) {
  const file = path.join(gate.config.artifactsDir, `ha-recovery-${tag}-values.json`);
  await fs.writeFile(file, JSON.stringify(values));
  const args = [
    '--kube-context',
    gate.config.context,
    'template',
    gate.config.release,
    path.join(rootDir, 'deploy/studio-server/helm'),
    '-n',
    gate.config.namespace,
    ...(
      gate.config.proofValuesFiles ?? [
        path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'),
      ]
    ).flatMap((file) => ['-f', file]),
    '-f',
    file,
  ];
  return parseAllDocuments((await run(gate.helmBin, args, { capture: true })).stdout)
    .map((d) => {
      if (d.errors.length) throw d.errors[0];
      return d.toJSON();
    })
    .filter(Boolean);
}

function recoveryOptions(gate, kube, values, resources, tag) {
  const apply = (guarded, complete) =>
    gate.apply(
      {
        ...values,
        ...guarded,
        ha: { ...values.ha, ...guarded.ha },
        ...(complete ? { workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } } } : {}),
      },
      `ha-recovery-${tag}-${complete ? 'complete' : 'apply'}.json`,
    );
  return {
    safety: createDeploymentSafety({
      mode: 'rolling',
      scope: 'rehearsal',
      checkBaseline: () => gate.assertProofContext(),
      localIdentity: {
        release: gate.config.release,
        namespace: gate.config.namespace,
        context: gate.config.context,
        candidateManifestDigest: gate.config.images.api.digest,
      },
    }),
    kube,
    release: gate.config.release,
    namespace: gate.config.namespace,
    manifestDigest: gate.config.images.api.digest,
    resources,
    timeoutMs: haProofTimeoutMs(gate.config),
    artifact: (name, value) => {
      if (name === 'ha-rollout.json') {
        const record = JSON.parse(value);
        gate.proofTiming?.status(`${tag}:${record.phase}:${record.owner?.name ?? 'none'}`);
      }
      return gate.artifact(`recovery-${tag}/${name}`, value);
    },
    applyTemplates: (_workloads, guarded) => apply(guarded, false),
    restoreAutoscalers: (_workloads, guarded) => apply(guarded, true),
  };
}

/** A fresh lane must exercise reuse of a real completed journal, as the former
 * serial proof did. Never fabricate a completion or mutate unfinished work. */
export async function establishHaRecoveryBaseline({ readJournal, inspectOwners, completeNoChange }) {
  const before = await inspectOwners();
  let baselineJournal = await readJournal();
  if (!baselineJournal) {
    await completeNoChange();
    assert.deepEqual(await inspectOwners(), before, 'No-change baseline replaced an owner');
    baselineJournal = await readJournal();
  }
  assert.equal(baselineJournal?.phase, 'complete', 'Recovery fixture has unfinished work');
  assert.ok(baselineJournal.token, 'Recovery baseline lacks its acknowledged operation token');
  return { before, baselineJournal };
}

/** Faults are injected at the transport acknowledgement/CAS boundary of the
 * real disposable Kubernetes API. The production rollout implementation is not
 * replaced, and accepted application work is never force-terminated. */
export async function verifyHaReleaseRecovery(
  gate,
  baseUrl,
  rootDir,
  { faults = ['lostAcknowledgement', 'leaseLoss'] } = {},
) {
  assert.ok(
    faults.length > 0 &&
      new Set(faults).size === faults.length &&
      faults.every((f) => ['lostAcknowledgement', 'leaseLoss'].includes(f)),
    'Unknown or duplicate HA recovery fault',
  );
  await gate.assertProofContext();
  const kube = (args, extra = {}) =>
    gate.kubectl(['-n', gate.config.namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
  const journalName = releaseOperationJournalName(gate.config.release);
  const journal = async () => JSON.parse((await kube(['get', 'configmap', journalName, '-o', 'json'])).stdout);
  let phase = 'starting';
  const traffic = startHaWorkflowTraffic(gate, baseUrl, () => phase);
  const report = { lostAcknowledgement: null, leaseLoss: null, ...traffic.report };
  try {
    for (const fault of faults) {
      await measureHaPhase(gate, `recovery:${fault}`, async () => {
        phase = `${fault}:preparing`;
        const { before, baselineJournal } = await establishHaRecoveryBaseline({
          inspectOwners: async () => {
            const owners = await recoveryOwners(kube, gate.config.release);
            assertHaRecoveryOwners(owners, `${gate.config.images.api.repository}@${gate.config.images.api.digest}`);
            return owners;
          },
          readJournal: async () => {
            const raw = (await kube(['get', 'configmap', journalName, '--ignore-not-found', '-o', 'json'])).stdout;
            return raw.trim() ? JSON.parse(JSON.parse(raw).data.record) : null;
          },
          completeNoChange: async () => {
            const values = gate.values();
            const resources = await recoveryResources(gate, rootDir, values, 'baseline');
            await measureHaPhase(gate, 'completed-journal-baseline', () =>
              runHaKubernetesRollout({
                ...recoveryOptions(gate, kube, values, resources, 'baseline'),
                beforeRetirement: async () => {
                  throw Error('No-change recovery baseline must not retire an ordinary owner');
                },
              }),
            );
          },
        });
        const values = {
          ...gate.values(),
          podAnnotations: {
            backend: { 'rivet.dev/ha-proof-generation': fault },
            execution: { 'rivet.dev/ha-proof-generation': fault },
          },
        };
        const resources = await recoveryResources(gate, rootDir, values, fault);
        const accepted = new HaReleaseProbes(gate, baseUrl, rootDir);
        const { send, state } = createHaRecoveryFaultTransport(fault, kube, journal, journalName);
        const options = {
          ...recoveryOptions(gate, send, values, resources, fault),
          beforeRetirement: async (pod) => {
            if (fault !== 'leaseLoss' || state.original || !/-ha-backend-0$/.test(pod.name)) return;
            // Reuse the real accepted/paused editor probe, held beyond the
            // 30-second journal heartbeat. Status is never fabricated.
            await accepted.startEditor(pod, pod.name.slice(0, -1) + '1', 45_000);
          },
        };
        let error;
        phase = `${fault}:injecting`;
        try {
          await runHaKubernetesRollout(options);
        } catch (caught) {
          error = caught;
        }
        assert.ok(error, `${fault} must stop the original runner`);
        if (!state.injected) throw new Error('recovery fault was not injected', { cause: error });
        if (fault === 'leaseLoss' && !state.conflictObserved)
          throw new Error('real API-server CAS conflict must fence the runner', { cause: error });
        const cm = await journal(),
          record = JSON.parse(cm.data.record);
        assert.equal(record.owner.name, state.original);
        assert.equal(record.owner.beginIssued, true);
        const pod = JSON.parse((await kube(['get', 'pod', state.original, '-o', 'json'])).stdout);
        assert.equal(pod.metadata.uid, record.owner.uid, 'unconfirmed runner must not delete the accepted owner');
        phase = `${fault}:resuming`;
        const rollout = await runHaKubernetesRollout({
          ...options,
          beforeRetirement: undefined,
          resumeToken: record.token,
        });
        phase = `${fault}:settling`;
        await Promise.all(accepted.editors.map((p) => p.completed));
        await gate.artifact(
          `recovery-${fault}/editor-receipts.json`,
          JSON.stringify(
            accepted.editors.map((p) => ({ pod: p.pod, uid: p.uid, receipt: p.receipt, error: p.error?.name ?? null })),
            null,
            2,
          ),
        );
        for (const p of accepted.editors) {
          if (p.error) throw p.error;
          assert.equal(p.receipt?.phase, 'passed');
          assert.ok(
            p.receipt.heldMs >= 45_000,
            `accepted editor hold was ${p.receipt.heldMs}ms; at least 45000ms is required`,
          );
        }
        assert.equal(state.begins, 1, 'exact-token recovery must observe, not replay, the original begin');
        report[fault] = {
          passed: true,
          faultInjected: state.injected,
          beginAccepted: state.beginAccepted,
          originalPod: state.original,
          originalUid: record.owner.uid,
          protectedOwner: { name: pod.metadata.name, uid: pod.metadata.uid },
          resumeToken: record.token,
          baselineJournal: { token: baselineJournal.token, phase: baselineJournal.phase },
          rollout: { phase: rollout.phase, owner: rollout.owner, token: rollout.token, completed: rollout.completed },
          before,
          after: await recoveryOwners(kube, gate.config.release),
          editors: accepted.editors.map((p) => ({ pod: p.pod, uid: p.uid, receipt: p.receipt })),
          beginCommands: state.begins,
          ...(fault === 'leaseLoss' ? { conflictObserved: state.conflictObserved } : {}),
        };
      });
    }
  } finally {
    Object.assign(report, await traffic.stop());
    await gate.artifact('ha-recovery-probes.json', JSON.stringify(report, null, 2));
  }
  assert.equal(report.failures.length, 0, report.failures[0]);
  for (const fault of faults) assertHaRecoveryScenario(report, fault, gate.config.images);
  return report;
}
