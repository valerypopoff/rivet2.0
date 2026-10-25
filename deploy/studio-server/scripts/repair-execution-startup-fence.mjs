import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createExecutionAutoscalerIO } from './lib/execution-autoscaler-kubernetes.mjs';
import { autoscalerPolicyDigest } from './lib/execution-autoscaler.mjs';
import { releaseOperationJournalName } from './lib/release-operation-journal.mjs';
import {
  prepareExecutionFenceRepair,
  applyExecutionFenceRepair,
  fenceRepairDigest,
  fenceRecoveryError,
} from './lib/execution-fence-recovery.mjs';

export function createFenceRecoveryIO({ binding, kube }) {
  const journal = releaseOperationJournalName(binding.release);
  const ns = `/api/v1/namespaces/${encodeURIComponent(binding.namespace)}`;
  const sts = `/apis/apps/v1/namespaces/${encodeURIComponent(binding.namespace)}/statefulsets/${encodeURIComponent(binding.workload)}`;
  const podName = (url) => {
    const name = decodeURIComponent(url.slice(`${ns}/pods/`.length));
    if (!name.startsWith(`${binding.workload}-`) || !/^(0|[1-9]\d*)$/.test(name.slice(binding.workload.length + 1)))
      throw Error('Recovery pod path is outside the bound workload.');
    return name;
  };
  const transport = {
    async json(method, url, body) {
      if (url === `${ns}/configmaps/${journal}`) {
        if (method === 'GET') return kube(['get', 'configmap', journal, '-o', 'json']);
        if (method === 'PUT' && body.metadata.name === journal && body.metadata.namespace === binding.namespace)
          return kube(['replace', '-f', '-', '-o', 'json'], body);
      }
      if (url === sts && method === 'GET') return kube(['get', 'statefulset', binding.workload, '-o', 'json']);
      if (url.startsWith(`${ns}/pods/`) && !url.includes('?')) {
        const name = podName(url);
        if (method === 'GET') return kube(['get', 'pod', name, '-o', 'json']);
        if (method === 'PATCH' && body.length === 3 && body[2].op === 'add' && body[2].path === '/metadata/annotations')
          return kube(['patch', 'pod', name, '--type=json', '-p', JSON.stringify(body), '-o', 'json']);
      }
      throw Error('Recovery transport refuses this mutation or resource.');
    },
    async exec(url, command) {
      if (
        !url.endsWith('/exec') ||
        JSON.stringify(command) !== JSON.stringify(['node', '/opt/rivet/retire-backend.mjs'])
      )
        throw Error('Recovery permits status-only executor inspection.');
      return kube(['exec', podName(url.slice(0, -5)), '-c', 'api', '--', ...command], undefined, true);
    },
  };
  const io = createExecutionAutoscalerIO({ ...binding, transport });
  return {
    ...io,
    async verifyRepairBinding(expected, target) {
      if (JSON.stringify(expected) !== JSON.stringify(binding)) throw Error('Recovery binding changed.');
      const namespace = kube(['get', 'namespace', binding.namespace, '-o', 'json']);
      if (namespace.metadata.uid !== binding.namespaceUid || namespace.metadata.deletionTimestamp)
        throw Error('Recovery namespace identity changed.');
      const controller = kube(['get', 'deployment', binding.controller, '-o', 'json']);
      const container = controller.spec.template.spec.containers.find((c) => c.name === 'autoscaler');
      const config = JSON.parse(container?.env?.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG')?.value ?? 'null');
      if (
        controller.metadata.uid !== binding.controllerUid ||
        controller.metadata.deletionTimestamp ||
        controller.metadata.labels?.['app.kubernetes.io/instance'] !== binding.release ||
        container.image !== binding.image ||
        config?.release !== binding.release ||
        config.namespace !== binding.namespace ||
        config.workload !== binding.workload ||
        config.manifestDigest !== binding.manifestDigest ||
        autoscalerPolicyDigest(config.policy) !== binding.policyDigest
      )
        throw Error('Original autoscaler image, policy or installation changed.');
      if (target) {
        const pods = kube([
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/instance=${binding.release},app.kubernetes.io/component=execution`,
          '-o',
          'json',
        ]).items;
        let peers = 0;
        for (const pod of pods) {
          const name = pod.metadata.name;
          if (name === target.name) continue; // inspectFence separately verifies the target incarnation.
          if (
            !name.startsWith(`${binding.workload}-`) ||
            !/^(0|[1-9]\d*)$/.test(name.slice(binding.workload.length + 1)) ||
            pod.metadata.deletionTimestamp ||
            !pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ||
            !pod.metadata.ownerReferences?.some(
              (o) =>
                o.controller && o.kind === 'StatefulSet' && o.uid === target.workloadUid && o.name === binding.workload,
            )
          )
            throw Error('Recovery peer ownership or readiness is unconfirmed.');
          const status = JSON.parse(
            kube(['exec', name, '-c', 'api', '--', 'node', '/opt/rivet/retire-backend.mjs'], undefined, true),
          );
          const after = kube(['get', 'pod', name, '-o', 'json']);
          if (
            status.protocol !== 1 ||
            !status.incarnation ||
            status.state !== 'serving' ||
            status.operationId ||
            after.metadata.uid !== pod.metadata.uid ||
            after.metadata.deletionTimestamp ||
            !after.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
          )
            throw Error('A conflicting retirement or changed recovery peer blocks repair.');
          peers++;
        }
        if (peers < 2) throw Error('Two serving peers are required before recovery.');
      }
    },
  };
}

async function main() {
  const { values: v } = parseArgs({
    options: {
      help: { type: 'boolean' },
      ...Object.fromEntries(
        [
          'context',
          'kubeconfig',
          'namespace',
          'namespace-uid',
          'release',
          'controller',
          'output',
          'apply',
          'confirm',
        ].map((k) => [k, { type: 'string' }]),
      ),
    },
  });
  if (v.help) {
    console.log(
      'Dry-run: --context NAME --namespace NAME --namespace-uid UID --release NAME --controller NAME --output PRIVATE-PLAN.json\nApply (separate approval): --context NAME --apply PRIVATE-PLAN.json --confirm sha256:PLAN-DIGEST --output FRESH-RECEIPT.json\nOptional --kubeconfig PATH. No scale, deletion, journal reset or modifying exec is supported.',
    );
    return;
  }
  if (!v.context || !v.output) throw Error('Explicit --context and fresh private --output receipt path are required.');
  if (v.confirm && !v.apply) throw fenceRecoveryError('--confirm requires --apply.');
  if (v.apply && ['namespace', 'namespace-uid', 'release', 'controller'].some((key) => v[key]))
    throw fenceRecoveryError('Apply uses installation identity from its plan; identity overrides are not allowed.');
  if (v.apply && !v.confirm) throw fenceRecoveryError('Apply requires an explicit --confirm digest.');
  let plan = v.apply ? JSON.parse(await fs.readFile(v.apply, 'utf8')) : null;
  if (plan && plan.binding.context !== v.context) throw Error('Recovery context differs from the plan.');
  const namespace = plan?.binding.namespace ?? v.namespace;
  if (!namespace) throw Error('Explicit --namespace is required.');
  const kube = (args, input, text = false) => {
    const out = execFileSync(
      'kubectl',
      [
        '--context',
        v.context,
        ...(v.kubeconfig ? ['--kubeconfig', v.kubeconfig] : []),
        '--namespace',
        namespace,
        '--request-timeout=25s',
        ...args,
      ],
      {
        input: input ? JSON.stringify(input) : undefined,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return text ? out : JSON.parse(out);
  };
  let binding = plan?.binding;
  if (!binding) {
    if (!v.release || !v.controller || !v['namespace-uid'])
      throw Error('Dry-run requires --release, --controller and --namespace-uid.');
    const c = kube(['get', 'deployment', v.controller, '-o', 'json']);
    const container = c.spec.template.spec.containers.find((c) => c.name === 'autoscaler');
    const config = JSON.parse(container.env.find((e) => e.name === 'RIVET_AUTOSCALER_CONFIG').value);
    binding = {
      context: v.context,
      namespace,
      namespaceUid: v['namespace-uid'],
      release: v.release,
      controller: v.controller,
      controllerUid: c.metadata.uid,
      workload: config.workload,
      image: container.image,
      manifestDigest: config.manifestDigest,
      policyDigest: autoscalerPolicyDigest(config.policy),
    };
  }
  const io = createFenceRecoveryIO({ binding, kube });
  // Reserve the evidence path BEFORE any cluster write. Never overwrite an older receipt.
  const receipt = await fs.open(v.output, 'wx', 0o600);
  try {
    if (!plan) plan = await prepareExecutionFenceRepair({ io, binding });
    const result = v.apply ? await applyExecutionFenceRepair({ io, plan, confirmation: v.confirm }) : plan;
    await receipt.writeFile(JSON.stringify(result, null, 2) + '\n');
    console.log(
      JSON.stringify({
        outcome: v.apply ? result.outcome : 'dry-run-only',
        planDigest: fenceRepairDigest(plan),
        output: path.resolve(v.output),
      }),
    );
  } finally {
    await receipt.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    if (error.code === 'rivet_fence_recovery') console.error(error.message);
    console.error(
      'Fence recovery failed closed. Preserve the plan and inspect the original journal; do not clear fences or retry other commands.',
    );
    process.exitCode = 1;
  });
