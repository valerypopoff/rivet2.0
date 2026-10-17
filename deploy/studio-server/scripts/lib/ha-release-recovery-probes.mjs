import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAllDocuments } from 'yaml';
import { runHaKubernetesRollout } from './ha-kubernetes-rollout.mjs';
import { releaseOperationJournalName } from './release-operation-journal.mjs';
import { runManagedGateCommand as run } from '../kubernetes-managed-release-gate.mjs';
import { HaReleaseProbes } from './ha-release-probes.mjs';

/** Faults are injected at the transport acknowledgement/CAS boundary of the
 * real disposable Kubernetes API. The production rollout implementation is not
 * replaced, and accepted application work is never force-terminated. */
export async function verifyHaReleaseRecovery(gate, baseUrl, rootDir) {
  await gate.assertProofContext();
  const kube = (args, extra = {}) =>
    gate.kubectl(['-n', gate.config.namespace, '--request-timeout=30s', ...args], { capture: true, ...extra });
  const journalName = releaseOperationJournalName(gate.config.release);
  const journal = async () => JSON.parse((await kube(['get', 'configmap', journalName, '-o', 'json'])).stdout);
  const report = { lostAcknowledgement: null, leaseLoss: null, samples: 0, failures: [] };
  let running = true;
  const traffic = (async () => {
    while (running) {
      try {
        await gate.requestWorkflow(baseUrl, '/workflows/managed-release-workflow', {
          method: 'POST',
          body: '{}',
          timeoutMs: 15_000,
        });
        report.samples++;
      } catch (error) {
        report.failures.push(String(error));
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  try {
    for (const fault of ['lostAcknowledgement', 'leaseLoss']) {
      const values = {
        ...gate.values(),
        podAnnotations: {
          backend: { 'rivet.dev/ha-proof-generation': fault },
          execution: { 'rivet.dev/ha-proof-generation': fault },
        },
      };
      const file = path.join(gate.config.artifactsDir, `ha-recovery-${fault}-values.json`);
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
      const resources = parseAllDocuments((await run(gate.helmBin, args, { capture: true })).stdout)
        .map((d) => {
          if (d.errors.length) throw d.errors[0];
          return d.toJSON();
        })
        .filter(Boolean);
      let injected = false,
        original,
        conflictObserved = false,
        begins = 0;
      const accepted = new HaReleaseProbes(gate, baseUrl, rootDir);
      const send = async (args, extra) => {
        if (args[0] === 'exec' && args.includes('--begin-only')) {
          if (!original) original = args[1];
          if (args[1] === original) begins++;
          const value = await kube(args, extra);
          if (!injected) {
            injected = true;
            if (fault === 'lostAcknowledgement') throw Error('Injected lost begin acknowledgement');
            const cm = await journal(),
              record = JSON.parse(cm.data.record);
            cm.data.record = JSON.stringify({ ...record, runner: randomUUID(), leaseExpiresAt: Date.now() - 1 });
            await kube(['replace', '-f', '-', '-o', 'json'], { input: JSON.stringify(cm) });
          }
          return value;
        }
        try {
          return await kube(args, extra);
        } catch (error) {
          if (
            injected &&
            fault === 'leaseLoss' &&
            args[0] === 'replace' &&
            /Conflict|modified|resourceVersion/i.test(String(error))
          )
            conflictObserved = true;
          throw error;
        }
      };
      const options = {
        kube: send,
        release: gate.config.release,
        namespace: gate.config.namespace,
        manifestDigest: gate.config.images.api.digest,
        resources,
        timeoutMs: 180_000,
        artifact: (name, value) => gate.artifact(`recovery-${fault}/${name}`, value),
        applyTemplates: (_workloads, guardedValues) =>
          gate.apply(
            {
              ...values,
              ...guardedValues,
              ha: { ...values.ha, ...guardedValues.ha },
            },
            `ha-recovery-${fault}-apply.json`,
          ),
        restoreAutoscalers: (_workloads, guardedValues) =>
          gate.apply(
            {
              ...values,
              ...guardedValues,
              ha: { ...values.ha, ...guardedValues.ha },
              workflowSchema: { ...values.workflowSchema, migrationJob: { enabled: false } },
            },
            `ha-recovery-${fault}-complete.json`,
          ),
        beforeRetirement: async (pod) => {
          if (fault !== 'leaseLoss' || original || !/-ha-backend-0$/.test(pod.name)) return;
          // Reuse the real accepted/paused editor probe, held beyond the
          // 30-second journal heartbeat. Status is never fabricated.
          await accepted.startEditor(pod, pod.name.slice(0, -1) + '1', 45_000);
        },
      };
      let error;
      try {
        await runHaKubernetesRollout(options);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, `${fault} must stop the original runner`);
      assert.equal(injected, true);
      if (fault === 'leaseLoss')
        assert.equal(conflictObserved, true, 'real API-server CAS conflict must fence the runner');
      const cm = await journal(),
        record = JSON.parse(cm.data.record);
      assert.equal(record.owner.name, original);
      assert.equal(record.owner.beginIssued, true);
      const pod = JSON.parse((await kube(['get', 'pod', original, '-o', 'json'])).stdout);
      assert.equal(pod.metadata.uid, record.owner.uid, 'unconfirmed runner must not delete the accepted owner');
      await runHaKubernetesRollout({ ...options, beforeRetirement: undefined, resumeToken: record.token });
      await Promise.all(accepted.editors.map((p) => p.completed));
      for (const p of accepted.editors) {
        if (p.error) throw p.error;
        assert.equal(p.receipt?.phase, 'passed');
        assert.ok(p.receipt.heldMs >= 45_000);
      }
      assert.equal(begins, 1, 'exact-token recovery must observe, not replay, the original begin');
      report[fault] = {
        passed: true,
        originalPod: original,
        originalUid: record.owner.uid,
        beginCommands: begins,
        ...(fault === 'leaseLoss' ? { conflictObserved } : {}),
      };
    }
    assert.equal(report.failures.length, 0, report.failures[0]);
    return report;
  } finally {
    running = false;
    await traffic;
    await gate.artifact('ha-recovery-probes.json', JSON.stringify(report, null, 2));
  }
}
