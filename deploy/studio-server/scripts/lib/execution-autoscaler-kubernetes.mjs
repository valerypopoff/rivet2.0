import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { releaseOperationJournalName } from './release-operation-journal.mjs';
import { classifyStartupFence, assertFenceIntent } from './execution-autoscaler-fence.mjs';

const enc = encodeURIComponent;
const fenceAnnotation = 'rivet.dev/execution-retirement-fence';
function parseRetirement(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Execution retirement response is invalid.');
  }
}
export const executionSampleCommand = (port) => [
  'node',
  '--input-type=module',
  '-e',
  `const r=await fetch('http://127.0.0.1:${port}/metrics',{signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);process.stdout.write(await r.text());`,
];
export class PendingExecutionCpuSample extends Error {}

export function cpuQuantity(value) {
  const match = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(String(value));
  if (!match) throw new Error('Unrecognized execution CPU quantity.');
  return Number(match[1]) * ({ n: 1e-9, u: 1e-6, m: 1e-3 }[match[2]] ?? 1);
}
function gauge(text, name, labels) {
  const matches = text.split('\n').filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));
  if (matches.length !== 1 || (labels && !matches[0].includes(labels)))
    throw new Error('Execution admission metrics unavailable.');
  const value = Number(matches[0].trim().split(/\s+/).at(-1));
  if (!Number.isFinite(value) || value < 0) throw new Error('Execution admission metric is invalid.');
  return value;
}

class KubernetesResponseError extends Error {
  constructor(method, response) {
    super(`Kubernetes ${method} failed (${response.statusCode}); write acknowledgement may be unknown.`);
    this.status = response.statusCode;
    this.retryAfter = response.headers['retry-after'];
  }
}
function readRetryDelay(value, attempt) {
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** attempt;
}

/** Strict TLS in-cluster; loopback HTTP is injectable only by the local tests.
 * Only explicit GET throttling is retried, within one deadline. No write
 * retries, redirects or response bodies in error logs. */
export function createKubernetesTransport({
  origin,
  token = () => readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim(),
  ca = () => readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
  timeoutMs = 10000,
  allowLoopbackHttp = false,
  WebSocketClass,
}) {
  const base = new URL(origin);
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' && !(allowLoopbackHttp && base.protocol === 'http:' && base.hostname === '127.0.0.1'))
  )
    throw new Error('Kubernetes transport requires a trusted HTTPS origin.');
  const credentials = () => ({
    headers: { authorization: `Bearer ${token()}` },
    ...(base.protocol === 'https:' ? { ca: ca(), rejectUnauthorized: true } : {}),
  });
  return {
    async json(method, path, body, contentType = 'application/json') {
      const deadline = performance.now() + timeoutMs;
      const requestOnce = () =>
        new Promise((resolve, reject) => {
          const auth = credentials();
          const payload = body === undefined ? undefined : JSON.stringify(body);
          const request = (base.protocol === 'https:' ? https : http).request(
            new URL(path, base),
            {
              ...auth,
              method,
              headers: {
                ...auth.headers,
                accept: 'application/json',
                'content-type': contentType,
                ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
              },
            },
            (response) => {
              const chunks = [];
              let bytes = 0;
              response.on('data', (chunk) => {
                if ((bytes += chunk.length) > 4 * 1024 * 1024)
                  response.destroy(new Error('Kubernetes response exceeds the bounded inventory size.'));
                else chunks.push(chunk);
              });
              response.once('error', reject);
              response.once('end', () => {
                if (response.statusCode === 404 && method === 'GET') return resolve(null);
                if (response.statusCode < 200 || response.statusCode >= 300)
                  return reject(new KubernetesResponseError(method, response));
                try {
                  resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                  reject(new Error('Kubernetes returned a non-JSON response.'));
                }
              });
            },
          );
          const timer = setTimeout(
            () => request.destroy(new Error('Kubernetes request deadline exceeded; observe before retrying writes.')),
            Math.max(1, deadline - performance.now()),
          );
          request.once('close', () => clearTimeout(timer));
          request.once('error', reject);
          request.end(payload);
        });
      for (let attempt = 0; ; attempt++) {
        try {
          if (performance.now() >= deadline) throw new Error('Kubernetes request deadline exceeded.');
          return await requestOnce();
        } catch (error) {
          if (method !== 'GET' || !(error instanceof KubernetesResponseError) || error.status !== 429 || attempt >= 2)
            throw error;
          const delay = readRetryDelay(error.retryAfter, attempt);
          if (!Number.isFinite(delay) || delay >= deadline - performance.now()) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
    exec(
      path,
      command,
      { container = 'api', stdin, maxOutputBytes = 1024 * 1024, onStderr, keepAliveMs = 30000, signal } = {},
    ) {
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new Error('Kubernetes exec abort signal is invalid.');
      if (signal?.aborted) return Promise.reject(new Error('Kubernetes exec aborted before dispatch.'));
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(container)) throw new Error('Kubernetes exec container is invalid.');
      if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 32 * 1024 * 1024)
        throw new Error('Kubernetes exec output bound is invalid.');
      if (stdin !== undefined && (!Buffer.isBuffer(stdin) || stdin.length > 32 * 1024 * 1024))
        throw new Error('Kubernetes exec input is invalid.');
      if (onStderr !== undefined && typeof onStderr !== 'function')
        throw new Error('Kubernetes diagnostic sink is invalid.');
      if (!Number.isSafeInteger(keepAliveMs) || keepAliveMs < 1)
        throw new Error('Kubernetes exec keepalive interval is invalid.');
      return new Promise((resolve, reject) => {
        const url = new URL(path, base);
        url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        for (const item of command) url.searchParams.append('command', item);
        url.searchParams.set('container', container);
        url.searchParams.set('stdout', 'true');
        url.searchParams.set('stderr', 'true');
        if (stdin !== undefined) url.searchParams.set('stdin', 'true');
        const WebSocket = WebSocketClass ?? createRequire(import.meta.url)('ws');
        const socket = new WebSocket(
          url,
          stdin === undefined ? ['v5.channel.k8s.io', 'v4.channel.k8s.io'] : ['v5.channel.k8s.io'],
          {
            ...credentials(),
            handshakeTimeout: timeoutMs,
            maxPayload: 1024 * 1024,
          },
        );
        let output = '',
          bytes = 0,
          status,
          stderr = false,
          settled = false,
          heartbeat;
        const decoder = new StringDecoder('utf8');
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          signal?.removeEventListener('abort', abort);
          socket.removeAllListeners();
          socket.on('error', () => {});
          socket.terminate();
          error ? reject(error) : resolve(result);
        };
        const abort = () => finish(new Error('Kubernetes exec aborted; command outcome is unknown.'));
        const timer = setTimeout(
          () => finish(new Error('Kubernetes exec deadline exceeded; command outcome is unknown.')),
          timeoutMs,
        );
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        socket.once('open', () => {
          // Keep silent long-running setup commands alive through idle proxies.
          // This does not extend their absolute deadline or retry the command.
          heartbeat = setInterval(() => {
            try {
              socket.ping();
            } catch {
              finish(new Error('Kubernetes exec keepalive failed; command outcome is unknown.'));
            }
          }, keepAliveMs);
          heartbeat.unref();
          if (stdin === undefined) return;
          // v5 supports explicit stdin EOF without closing stdout/status. A
          // connection loss remains uncertain and is never retried here.
          for (let offset = 0; offset < stdin.length; offset += 65536)
            socket.send(Buffer.concat([Buffer.from([0]), stdin.subarray(offset, offset + 65536)]));
          socket.send(Buffer.from([255, 0]));
        });
        socket.on('message', (data) => {
          bytes += data.length;
          if (bytes > maxOutputBytes) return finish(new Error('Kubernetes exec output exceeded its limit.'));
          if (data[0] === 1) output += decoder.write(data.subarray(1));
          if (data[0] === 2 && data.length > 1) {
            stderr = true;
            try {
              onStderr?.(data.subarray(1));
            } catch (error) {
              return finish(error);
            }
          }
          if (data[0] === 3) {
            try {
              status = JSON.parse(data.subarray(1).toString('utf8'));
            } catch {
              finish(new Error('Kubernetes exec status is invalid.'));
            }
          }
        });
        socket.once('error', () => finish(new Error('Kubernetes exec connection failed; command outcome is unknown.')));
        socket.once('close', (code) =>
          status?.status === 'Success' && (!stderr || onStderr)
            ? finish(null, output + decoder.end())
            : finish(
                new Error(
                  `Kubernetes exec did not confirm a successful exit (close code ${code}); command outcome is unknown.`,
                ),
              ),
        );
      });
    },
  };
}

export function createExecutionAutoscalerIO({
  transport: api,
  release,
  namespace,
  workload,
  service,
  image,
  expectedUid,
  policy,
  port = 8080,
  now = Date.now,
}) {
  if (
    ![release, namespace, workload].every((x) => /^[a-z0-9][a-z0-9.-]*$/.test(x)) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Autoscaler Kubernetes identity is invalid.');
  const ns = `/api/v1/namespaces/${enc(namespace)}`;
  const sts = `/apis/apps/v1/namespaces/${enc(namespace)}/statefulsets/${enc(workload)}`;
  const cm = `${ns}/configmaps/${enc(releaseOperationJournalName(release))}`;
  const selector = `app.kubernetes.io/instance=${release},app.kubernetes.io/component=execution`;
  const owned = async (target) => {
    if (!target.name.startsWith(`${workload}-`) || !/^\d+$/.test(target.name.slice(workload.length + 1)))
      throw new Error('Foreign pod name rejected.');
    const pod = await api.json('GET', `${ns}/pods/${enc(target.name)}`);
    if (
      !pod ||
      pod.metadata.uid !== target.uid ||
      pod.metadata.deletionTimestamp ||
      !pod.metadata.ownerReferences?.some(
        (o) => o.controller && o.kind === 'StatefulSet' && o.uid === target.workloadUid && o.name === workload,
      )
    )
      throw new Error('Execution pod UID or controller changed.');
    return pod;
  };
  const retirement = async (name) =>
    parseRetirement(await api.exec(`${ns}/pods/${enc(name)}/exec`, ['node', '/opt/rivet/retire-backend.mjs']));
  const ownerFor = async (target) => {
    const owner = await api.json('GET', sts);
    if (
      owner?.metadata.uid !== target.workloadUid ||
      owner.metadata.deletionTimestamp ||
      owner.spec.updateStrategy?.type !== 'OnDelete' ||
      owner.metadata.labels?.['app.kubernetes.io/instance'] !== release ||
      owner.spec.template.spec.containers.find((c) => c.name === 'api')?.image !== image
    )
      throw new Error('Execution workload UID, image or ownership changed.');
    return owner;
  };
  const confirmDrained = async (target) => {
    await owned(target);
    const status = await retirement(target.name);
    if (
      status.state !== 'drained' ||
      status.operationId !== target.operationId ||
      status.incarnation !== target.incarnation
    )
      throw new Error('Execution owner is not confirmed drained.');
  };
  const editFence = async (target, remove, expected, authorize) => {
    const owner = await ownerFor(target);
    const value = owner.spec.template.metadata?.annotations?.[fenceAnnotation];
    if (expected !== undefined && (value ?? null) !== expected)
      throw Error('Startup fence template precondition changed.');
    if (remove && value === undefined) return;
    if (value !== undefined && value !== target.name) throw new Error('Another startup fence owns this workload.');
    const annotations = { ...owner.spec.template.metadata?.annotations };
    if (remove) delete annotations[fenceAnnotation];
    else annotations[fenceAnnotation] = target.name;
    await authorize?.();
    await api.json(
      'PATCH',
      sts,
      [
        { op: 'test', path: '/metadata/uid', value: target.workloadUid },
        { op: 'test', path: '/metadata/resourceVersion', value: owner.metadata.resourceVersion },
        { op: 'add', path: '/spec/template/metadata/annotations', value: annotations },
      ],
      'application/json-patch+json',
    );
  };
  const fencePod = async (target, expected, authorize) => {
    const pod = await owned(target);
    if (expected !== undefined) {
      const status = await retirement(target.name);
      if (
        status.protocol !== 1 ||
        status.incarnation !== target.incarnation ||
        status.state !== 'serving' ||
        status.operationId
      )
        throw Error('Startup fence process changed before metadata write.');
      if ((await owned(target)).metadata.resourceVersion !== pod.metadata.resourceVersion)
        throw Error('Startup fence pod changed during process inspection.');
    }
    const value = pod.metadata.annotations?.[fenceAnnotation];
    if (expected !== undefined && (value ?? null) !== expected) throw Error('Startup fence pod precondition changed.');
    classifyStartupFence(value, target.name, workload);
    if (!pod.metadata.resourceVersion) throw new Error('Pod startup fence resourceVersion is unconfirmed.');
    await authorize?.();
    await api.json(
      'PATCH',
      `${ns}/pods/${enc(target.name)}`,
      [
        { op: 'test', path: '/metadata/uid', value: target.uid },
        { op: 'test', path: '/metadata/resourceVersion', value: pod.metadata.resourceVersion },
        {
          op: 'add',
          path: '/metadata/annotations',
          value: { ...pod.metadata.annotations, [fenceAnnotation]: target.name },
        },
      ],
      'application/json-patch+json',
    );
  };
  const inspectFence = async (target) => {
    const owner = await ownerFor(target);
    const pod = await owned(target);
    const status = await retirement(target.name);
    if (
      status.protocol !== 1 ||
      status.incarnation !== target.incarnation ||
      status.state !== 'serving' ||
      status.operationId
    )
      throw Error('Startup fence process is not the original serving incarnation.');
    // Re-read identity after the process query. A replacement must not inherit authority.
    await owned(target);
    const template = owner.spec.template.metadata?.annotations?.[fenceAnnotation];
    if (template !== undefined && template !== target.name) throw Error('Another startup fence owns this workload.');
    const value = pod.metadata.annotations?.[fenceAnnotation];
    return {
      template: template ?? null,
      pod: value ?? null,
      podKind: classifyStartupFence(value, target.name, workload),
    };
  };
  const prepareFence = async (target) => {
    const observed = await inspectFence(target);
    return {
      protocol: 1,
      name: target.name,
      uid: target.uid,
      workloadUid: target.workloadUid,
      incarnation: target.incarnation,
      operationId: target.operationId,
      steps: {
        template: { before: observed.template, confirmed: false },
        pod: { before: observed.pod, confirmed: false },
      },
    };
  };
  const convergeFence = async (target, intent, { authorize, confirm }) => {
    assertFenceIntent(intent, target);
    for (const resource of ['template', 'pod']) {
      const observed = await inspectFence(target);
      const step = intent.steps[resource];
      if (observed[resource] !== target.name) {
        if (step.confirmed || observed[resource] !== step.before)
          throw Error('Startup fence metadata diverged from its recorded intent.');
        // Only metadata may converge. The caller renews the exact journal lease
        // before each conditional write; no exec/scale/delete command is retried.
        if (resource === 'template') await editFence(target, false, step.before, authorize);
        else await fencePod(target, step.before, authorize);
        if ((await inspectFence(target))[resource] !== target.name) throw Error('Startup fence write is unconfirmed.');
      }
      if (!step.confirmed) await confirm(resource);
    }
  };
  return {
    inspectFence,
    prepareFence,
    convergeFence,
    // Template annotation covers a new pod UID; the live pod annotation covers
    // a container restart with the SAME UID. Never clear the latter on a busy
    // or retired pod: it disappears only with that exact pod's removal.
    fence: async (target) => {
      await editFence(target, false);
      await fencePod(target);
    },
    clearFence: (target) => editFence(target, true),
    isFenced: async (target) =>
      (await ownerFor(target)).spec.template.metadata?.annotations?.[fenceAnnotation] === target.name,
    fenceObserved: async (target) => {
      const owner = await ownerFor(target);
      const pod = await owned(target);
      if (pod.metadata.annotations?.[fenceAnnotation] !== target.name)
        throw new Error('Pod startup fence intent is unconfirmed.');
      return (
        owner.spec.template.metadata?.annotations?.[fenceAnnotation] === target.name &&
        Number.isSafeInteger(owner.status?.observedGeneration) &&
        owner.status.observedGeneration >= owner.metadata.generation
      );
    },
    confirmDrained,
    async confirmPeers(target, peers) {
      let confirmed = 0;
      for (const peer of peers.filter((p) => p.uid !== target.uid && p.ready && p.state === 'serving')) {
        const before = await owned({ ...peer, workloadUid: target.workloadUid });
        if (!before.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) continue;
        const status = await retirement(peer.name);
        const after = await owned({ ...peer, workloadUid: target.workloadUid });
        if (
          status.incarnation === peer.incarnation &&
          status.state === 'serving' &&
          !status.operationId &&
          after.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
        )
          confirmed++;
        if (confirmed === 2) return;
      }
      throw new Error('Two serving execution peers are not confirmed.');
    },
    async readJournal() {
      const value = await api.json('GET', cm);
      return value ? { ...JSON.parse(value.data.record), resourceVersion: value.metadata.resourceVersion } : null;
    },
    async writeJournal(record, resourceVersion) {
      const { resourceVersion: ignored, ...data } = record;
      const value = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: releaseOperationJournalName(release),
          namespace,
          ...(resourceVersion ? { resourceVersion } : {}),
          labels: { 'app.kubernetes.io/instance': release },
        },
        data: { record: JSON.stringify(data) },
      };
      const result = await api.json(resourceVersion ? 'PUT' : 'POST', resourceVersion ? cm : `${ns}/configmaps`, value);
      return { ...data, resourceVersion: result.metadata.resourceVersion };
    },
    async snapshot({ demand = true, replacement = null } = {}) {
      const owner = await api.json('GET', sts);
      if (
        !owner ||
        (expectedUid && owner.metadata.uid !== expectedUid) ||
        owner.metadata.labels?.['app.kubernetes.io/instance'] !== release ||
        owner.spec.updateStrategy?.type !== 'OnDelete' ||
        owner.spec.template.spec.containers.find((c) => c.name === 'api')?.image !== image
      )
        throw new Error('Execution workload identity, image or retirement strategy changed.');
      const [pods, metrics, hpas] = await Promise.all([
        api.json('GET', `${ns}/pods?labelSelector=${enc(selector)}`),
        demand
          ? api.json(
              'GET',
              `/apis/metrics.k8s.io/v1beta1/namespaces/${enc(namespace)}/pods?labelSelector=${enc(selector)}`,
            )
          : Promise.resolve(null),
        api.json('GET', `/apis/autoscaling/v2/namespaces/${enc(namespace)}/horizontalpodautoscalers`),
      ]);
      if (
        !pods?.items ||
        (demand && !metrics?.items) ||
        !hpas?.items ||
        hpas.items.some((h) => h.spec?.scaleTargetRef?.name === workload)
      )
        throw new Error('Execution inventory/metrics unavailable or a competing HPA exists.');
      const result = [];
      // Sequential bounded exec avoids a burst of management requests at scale.
      for (const pod of pods.items) {
        const suffix = pod.metadata.name.slice(workload.length + 1);
        if (
          !pod.metadata.name.startsWith(`${workload}-`) ||
          !/^\d+$/.test(suffix) ||
          !pod.metadata.ownerReferences?.some(
            (o) => o.controller && o.kind === 'StatefulSet' && o.uid === owner.metadata.uid && o.name === workload,
          )
        )
          throw new Error('Execution pod has a foreign controller.');
        const ready = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true;
        const entry = {
          name: pod.metadata.name,
          uid: pod.metadata.uid,
          ordinal: Number(suffix),
          ready,
          terminating: !!pod.metadata.deletionTimestamp,
        };
        if (
          pod.status?.phase !== 'Running' ||
          entry.terminating ||
          (!demand && (!ready || entry.name !== replacement))
        ) {
          result.push(entry);
          continue;
        }
        const status = await retirement(entry.name);
        if (!demand) {
          await owned({ ...entry, workloadUid: owner.metadata.uid });
          result.push({ ...entry, ...status });
          continue;
        }
        const text = await api.exec(`${ns}/pods/${enc(entry.name)}/exec`, executionSampleCommand(port));
        const sample = metrics.items.find((m) => m.metadata.name === entry.name);
        if (!sample) throw new PendingExecutionCpuSample('Execution CPU sample is not available yet.');
        const cpu = sample?.containers?.find((c) => c.name === 'api')?.usage?.cpu;
        const request = pod.spec.containers.find((c) => c.name === 'api')?.resources?.requests?.cpu;
        const requestCpu = cpuQuantity(request);
        const age = now() - Date.parse(sample?.timestamp);
        result.push({
          ...entry,
          ...status,
          active: gauge(text, 'rivet_published_execution_active_runs'),
          limit: gauge(text, 'rivet_published_execution_admission_limit', 'mode="enforce"'),
          cpuRatio: cpuQuantity(cpu) / requestCpu,
          sampleFresh:
            status.protocol === 1 &&
            status.withdrawalProtocol === 1 &&
            Number.isFinite(age) &&
            age >= -5000 &&
            age <= policy.metricsMaxAgeSeconds * 1000 &&
            requestCpu > 0,
          cpuSampleAt: Date.parse(sample?.timestamp),
        });
        // A metrics request must not hide pod replacement during exec.
        const after = await owned({ ...entry, workloadUid: owner.metadata.uid });
        result.at(-1).ready = after.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') === true;
      }
      return {
        uid: owner.metadata.uid,
        resourceVersion: owner.metadata.resourceVersion,
        replicas: owner.spec.replicas,
        pods: result.map((pod) => ({
          ...pod,
          sampleFresh: pod.sampleFresh && now() - pod.cpuSampleAt <= policy.metricsMaxAgeSeconds * 1000,
        })),
        startupFence: owner.spec.template.metadata?.annotations?.[fenceAnnotation],
      };
    },
    async scale(uid, from, to, expectedResourceVersion) {
      const scale = await api.json('GET', `${sts}/scale`);
      if (
        scale?.metadata.uid !== uid ||
        scale.spec.replicas !== from ||
        (expectedResourceVersion !== undefined && scale.metadata.resourceVersion !== expectedResourceVersion)
      )
        throw new Error('Scale precondition changed.');
      await api.json(
        'PATCH',
        `${sts}/scale`,
        [
          { op: 'test', path: '/metadata/uid', value: uid },
          { op: 'test', path: '/metadata/resourceVersion', value: scale.metadata.resourceVersion },
          { op: 'test', path: '/spec/replicas', value: from },
          { op: 'replace', path: '/spec/replicas', value: to },
        ],
        'application/json-patch+json',
      );
    },
    async retire(target, action) {
      await owned(target);
      const before = await retirement(target.name);
      if (
        before.incarnation !== target.incarnation ||
        (before.operationId && before.operationId !== target.operationId)
      )
        throw new Error('Execution process incarnation changed.');
      const result = parseRetirement(
        await api.exec(`${ns}/pods/${enc(target.name)}/exec`, [
          'node',
          '/opt/rivet/retire-backend.mjs',
          target.operationId,
          target.incarnation,
          action === 'withdraw' ? '--withdraw-only' : '--begin-only',
        ]),
      );
      if (result.incarnation !== target.incarnation || result.operationId !== target.operationId)
        throw new Error('Execution retirement acknowledgement changed.');
    },
    async routed(target) {
      const slices = await api.json(
        'GET',
        `/apis/discovery.k8s.io/v1/namespaces/${enc(namespace)}/endpointslices?labelSelector=${enc(`kubernetes.io/service-name=${service}`)}`,
      );
      if (!slices?.items) throw new Error('Execution route withdrawal is unconfirmed.');
      if (slices.items.some((s) => s.endpoints?.some((e) => e.conditions?.ready !== false && !e.targetRef?.uid)))
        throw new Error('Execution route endpoint identity is unconfirmed.');
      return slices.items.some((s) =>
        s.endpoints?.some((e) => e.targetRef?.uid === target.uid && e.conditions?.ready !== false),
      );
    },
    async remove(target) {
      await confirmDrained(target);
      await api.json('DELETE', `${ns}/pods/${enc(target.name)}`, {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid: target.uid },
      });
    },
  };
}
