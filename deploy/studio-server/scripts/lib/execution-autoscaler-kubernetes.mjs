import https from 'node:https';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { releaseOperationJournalName } from './release-operation-journal.mjs';

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

/** Strict TLS in-cluster; loopback HTTP is injectable only by the local tests.
 * No automatic retries, redirects or response bodies in error logs. */
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
    json(method, path, body, contentType = 'application/json') {
      return new Promise((resolve, reject) => {
        const auth = credentials();
        const request = (base.protocol === 'https:' ? https : http).request(
          new URL(path, base),
          {
            ...auth,
            method,
            headers: { ...auth.headers, accept: 'application/json', 'content-type': contentType },
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
                return reject(
                  new Error(
                    `Kubernetes ${method} failed (${response.statusCode}); write acknowledgement may be unknown.`,
                  ),
                );
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
          timeoutMs,
        );
        request.once('close', () => clearTimeout(timer));
        request.once('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });
    },
    exec(path, command) {
      return new Promise((resolve, reject) => {
        const url = new URL(path, base);
        url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
        for (const item of command) url.searchParams.append('command', item);
        url.searchParams.set('container', 'api');
        url.searchParams.set('stdout', 'true');
        url.searchParams.set('stderr', 'true');
        const WebSocket = WebSocketClass ?? createRequire(import.meta.url)('ws');
        const socket = new WebSocket(url, ['v5.channel.k8s.io', 'v4.channel.k8s.io'], {
          ...credentials(),
          handshakeTimeout: timeoutMs,
          maxPayload: 1024 * 1024,
        });
        let output = '',
          bytes = 0,
          status,
          stderr = false;
        const finish = (error, result) => {
          clearTimeout(timer);
          socket.removeAllListeners();
          socket.on('error', () => {});
          socket.terminate();
          error ? reject(error) : resolve(result);
        };
        const timer = setTimeout(
          () => finish(new Error('Kubernetes exec deadline exceeded; command outcome is unknown.')),
          timeoutMs,
        );
        socket.on('message', (data) => {
          bytes += data.length;
          if (bytes > 1024 * 1024) return finish(new Error('Kubernetes exec output exceeded its limit.'));
          if (data[0] === 1) output += data.subarray(1).toString('utf8');
          if (data[0] === 2 && data.length > 1) stderr = true;
          if (data[0] === 3) {
            try {
              status = JSON.parse(data.subarray(1).toString('utf8'));
            } catch {
              finish(new Error('Kubernetes exec status is invalid.'));
            }
          }
        });
        socket.once('error', () => finish(new Error('Kubernetes exec connection failed; command outcome is unknown.')));
        socket.once('close', () =>
          status?.status === 'Success' && !stderr
            ? finish(null, output)
            : finish(new Error('Kubernetes exec did not confirm a successful exit.')),
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
    if (owner?.metadata.uid !== target.workloadUid) throw new Error('Execution workload UID changed.');
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
  const editFence = async (target, remove) => {
    const owner = await ownerFor(target);
    const value = owner.spec.template.metadata?.annotations?.[fenceAnnotation];
    if (remove && value === undefined) return;
    if (value !== undefined && value !== target.name) throw new Error('Another startup fence owns this workload.');
    const annotations = { ...owner.spec.template.metadata?.annotations };
    if (remove) delete annotations[fenceAnnotation];
    else annotations[fenceAnnotation] = target.name;
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
  const fencePod = async (target) => {
    const pod = await owned(target);
    const value = pod.metadata.annotations?.[fenceAnnotation];
    if (value !== undefined && value !== target.name) throw new Error('Another startup fence owns this pod.');
    if (!pod.metadata.resourceVersion) throw new Error('Pod startup fence resourceVersion is unconfirmed.');
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
  return {
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
      if (scale?.metadata.uid !== uid || scale.spec.replicas !== from
        || (expectedResourceVersion !== undefined && scale.metadata.resourceVersion !== expectedResourceVersion))
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
