// Private staging transport only. No application code or production TLS override.
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';

const maxBytes = 4 * 1024 * 1024;
export function classifyRequest(method, raw, { namespace, release, journalName }) {
  assert.ok(typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\'));
  const url = new URL(raw, 'https://fixture.invalid');
  assert.equal(url.origin, 'https://fixture.invalid');
  const p = url.pathname;
  assert.equal(decodeURIComponent(p), p, 'encoded path segments are not fixture routes');
  const ns = `/api/v1/namespaces/${namespace}`;
  const workload = `/apis/apps/v1/namespaces/${namespace}/statefulsets/${release}-ha-execution`;
  if (method === 'GET' && p === `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`) return 'metrics';
  if (method === 'PATCH' && p === workload + '/scale') return 'scale';
  if (['GET', 'PATCH'].includes(method) && [workload, workload + '/scale'].includes(p)) return 'json';
  if (['GET', 'PUT'].includes(method) && p === ns + `/configmaps/${journalName}`) return 'json';
  if (method === 'POST' && p === ns + '/configmaps') return 'journal-create';
  if (
    method === 'GET' &&
    [
      ns + '/pods',
      `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`,
      `/apis/discovery.k8s.io/v1/namespaces/${namespace}/endpointslices`,
    ].includes(p)
  )
    return 'json';
  const pod = new RegExp(`^${ns}/pods/${release}-ha-execution-[0-9]+(/exec)?$`);
  if (pod.test(p) && ['GET', 'PATCH', 'DELETE'].includes(method)) return p.endsWith('/exec') ? 'exec' : 'json';
  throw Error('Unreviewed staging Kubernetes route');
}
async function bytes(stream) {
  const chunks = [];
  let count = 0;
  for await (const chunk of stream) {
    count += chunk.length;
    if (count > maxBytes) throw Error('Fixture message exceeds bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function headers(incoming) {
  assert.match(incoming.authorization ?? '', /^Bearer [^\r\n]+$/);
  return Object.fromEntries(
    [
      'authorization',
      'accept',
      'content-type',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'connection',
      'upgrade',
    ]
      .filter((name) => incoming[name] !== undefined)
      .map((name) => [name, incoming[name]]),
  );
}
export function createFaultTransport({
  tls,
  upstream,
  upstreamCa,
  readControl,
  replaceControl,
  timeoutMs = 15000,
  namespace,
  release,
  journalName,
  maxReplicas,
}) {
  const base = new URL(upstream);
  assert.equal(base.protocol, 'https:');
  assert.equal(base.pathname, '/');
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  assert.ok(upstreamCa && tls.cert && tls.key);
  const request = (req, body) =>
    new Promise((resolve, reject) => {
      const out = https.request(
        new URL(req.url, base),
        { method: req.method, ca: upstreamCa, rejectUnauthorized: true, headers: headers(req.headers), agent: false },
        async (response) => {
          try {
            resolve({ status: response.statusCode, body: await bytes(response), headers: response.headers });
          } catch (error) {
            reject(error);
          }
        },
      );
      out.setTimeout(timeoutMs, () => out.destroy(Error('Fixture upstream deadline')));
      out.once('error', reject);
      out.end(body);
    });
  const sockets = new Set();
  const server = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, async (req, res) => {
    let lostAck;
    try {
      const kind = classifyRequest(req.method, req.url, { namespace, release, journalName });
      if (kind === 'exec') throw Error('Exec requires WebSocket upgrade');
      headers(req.headers);
      const body = await bytes(req),
        control = await readControl();
      assert.ok(['pass', 'metrics-missing', 'metrics-stale', 'lose-scale-ack-once'].includes(control.mode));
      if (kind === 'journal-create') {
        const object = JSON.parse(body);
        assert.equal(object.metadata?.name, journalName);
        assert.equal(object.metadata?.namespace, namespace);
      }
      if (kind === 'metrics' && control.mode === 'metrics-missing') {
        await replaceControl(control, { ...control, missingResponses: (control.missingResponses ?? 0) + 1 });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"kind":"Status","reason":"ServiceUnavailable","code":503}');
        return;
      }
      if (kind === 'scale') {
        const patch = JSON.parse(body);
        assert.ok(Array.isArray(patch));
        const uid = patch.find((p) => p.op === 'test' && p.path === '/metadata/uid')?.value;
        const from = patch.find((p) => p.op === 'test' && p.path === '/spec/replicas')?.value;
        const to = patch.find((p) => p.op === 'replace' && p.path === '/spec/replicas')?.value;
        assert.ok(typeof uid === 'string' && Number.isInteger(from) && Number.isInteger(to));
        assert.ok(from >= 2 && from <= maxReplicas && to >= 2 && to <= maxReplicas);
        assert.ok((control.scaleWrites?.length ?? 0) < 64);
        const suppress = control.mode === 'lose-scale-ack-once' && !control.scaleAttempt;
        // Claim and record every scale transition before dispatch. No recovery
        // path in this transport ever forwards a recorded write again itself.
        const claimed = await replaceControl(control, {
          ...control,
          scaleWrites: [...(control.scaleWrites ?? []), { uid, from, to, at: new Date().toISOString() }],
          ...(suppress
            ? { scaleAttempt: { id: randomUUID(), state: 'dispatched', at: new Date().toISOString() } }
            : {}),
        });
        if (suppress) lostAck = claimed;
      }
      const result = await request(req, body);
      if (lostAck) {
        let identity;
        if (result.status >= 200 && result.status < 300) {
          const scale = JSON.parse(result.body);
          assert.ok(scale.metadata?.uid && scale.metadata.resourceVersion && Number.isInteger(scale.spec?.replicas));
          identity = {
            uid: scale.metadata.uid,
            resourceVersion: scale.metadata.resourceVersion,
            replicas: scale.spec.replicas,
          };
        }
        await replaceControl(lostAck, {
          ...lostAck,
          scaleAttempt: {
            ...lostAck.scaleAttempt,
            state: identity ? 'accepted-response-suppressed' : 'rejected-response-suppressed',
            status: result.status,
            identity,
          },
        });
        res.destroy();
        return;
      }
      if (kind === 'metrics' && control.mode === 'metrics-stale' && result.status === 200) {
        const metrics = JSON.parse(result.body);
        assert.ok(Array.isArray(metrics.items));
        for (const item of metrics.items) item.timestamp = new Date(Date.now() - 600000).toISOString();
        result.body = Buffer.from(JSON.stringify(metrics));
        await replaceControl(control, { ...control, staleResponses: (control.staleResponses ?? 0) + 1 });
      }
      res.writeHead(result.status, { 'content-type': result.headers['content-type'] ?? 'application/json' });
      res.end(result.body);
    } catch {
      // Never expose bearer headers, upstream bodies or a false write acknowledgement.
      if (lostAck) res.destroy();
      else if (!res.headersSent) {
        res.writeHead(502);
        res.end('{"kind":"Status","reason":"FixtureBlocked"}');
      } else res.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    let out;
    try {
      assert.equal(classifyRequest(req.method, req.url, { namespace, release, journalName }), 'exec');
      out = https.request(new URL(req.url, base), {
        method: 'GET',
        headers: headers(req.headers),
        ca: upstreamCa,
        rejectUnauthorized: true,
        agent: false,
      });
      const deadline = setTimeout(() => {
        out.destroy();
        socket.destroy();
      }, timeoutMs);
      deadline.unref();
      socket.on('close', () => {
        clearTimeout(deadline);
        out.destroy();
      });
      out.on('error', () => socket.destroy());
      out.once('response', (response) => {
        response.resume();
        socket.destroy();
      });
      out.once('upgrade', (response, remote, remoteHead) => {
        if (response.statusCode !== 101) {
          remote.destroy();
          socket.destroy();
          return;
        }
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
            Object.entries(response.headers)
              .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
              .join('\r\n') +
            '\r\n\r\n',
        );
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.on('error', () => socket.destroy());
        socket.on('error', () => remote.destroy());
        remote.on('close', () => socket.destroy());
        socket.pipe(remote);
        remote.pipe(socket);
      });
      out.end();
    } catch {
      out?.destroy();
      socket.destroy();
    }
  });
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
