// Disposable diagnostic runtime only. No Rivet data, credentials or API images.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  changeDiagnosticService,
  diagnosticResponseBytes,
  runConnectionResetDiagnostic,
} from '../lib/connection-reset-diagnostic.mjs';

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    assert.ok(bytes <= 20480, 'Diagnostic input exceeded bound');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const json = (res, value) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

export function diagnosticBackend({ uid, fault = false, holdMs = 300000 }) {
  assert.ok([100, 300000].includes(holdMs));
  const owner = {
      uid,
      incarnation: randomUUID(),
      node: process.env.NODE_NAME ?? 'local',
      podIp: process.env.POD_IP ?? 'local',
      nodeVersion: process.versions.node,
    },
    records = new Map();
  let faultAssigned = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && ['/readyz', '/owner'].includes(req.url)) return json(res, owner);
      if (req.method === 'GET' && req.url === '/state')
        return json(res, { owner, requests: [...records.values()].map((r) => r.receipt) });
      if (req.method === 'POST' && req.url === '/release') {
        const { requestIds } = await body(req);
        assert.ok(Array.isArray(requestIds) && requestIds.length > 0 && requestIds.length <= 4);
        assert.equal(new Set(requestIds).size, requestIds.length);
        const selected = requestIds.map((id) => records.get(id));
        assert.ok(selected.every((r) => r?.receipt.held && !r.receipt.released));
        for (const record of selected) record.release(false);
        return json(res, { released: requestIds });
      }
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/workflows/fixture');
      const input = await body(req);
      assert.match(input.requestId ?? '', /^[a-f0-9-]{36}$/);
      assert.equal(typeof input.hold, 'boolean');
      assert.equal(input.input, 'x'.repeat(16384));
      const control = req.headers['x-diagnostic-control'] === '1';
      assert.ok(records.size < 7 && !records.has(input.requestId), 'Duplicate or excess request');
      const payload = { output: { type: 'string', value: JSON.stringify(input) }, padding: '' };
      payload.padding = 'p'.repeat(diagnosticResponseBytes - Buffer.byteLength(JSON.stringify(payload)));
      const bytes = Buffer.from(JSON.stringify(payload));
      assert.equal(bytes.length, diagnosticResponseBytes);
      const receipt = {
        requestId: input.requestId,
        ownerUid: uid,
        acceptedAt: new Date().toISOString(),
        held: input.hold,
        control,
        prefixBytes: input.hold ? 0 : bytes.length,
        socket: {
          localAddress: req.socket.localAddress,
          localPort: req.socket.localPort,
          remoteAddress: req.socket.remoteAddress,
          remotePort: req.socket.remotePort,
        },
        released: false,
        finished: false,
        closed: false,
        autoReleased: false,
      };
      let timer;
      const truncate = input.hold && !control && fault && !faultAssigned;
      if (truncate) faultAssigned = true;
      const release = (automatic) => {
        if (receipt.released) return;
        clearTimeout(timer);
        receipt.held = false;
        receipt.released = true;
        receipt.autoReleased = automatic;
        if (truncate) res.write(bytes.subarray(0, 11959), () => res.destroy());
        else res.end(bytes);
      };
      records.set(input.requestId, { receipt, release });
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', bytes.length);
      res.setHeader('x-diagnostic-owner', uid);
      res.once('finish', () => {
        receipt.finished = true;
        clearTimeout(timer);
      });
      res.once('close', () => {
        receipt.closed = true;
        receipt.held = false;
        clearTimeout(timer);
      });
      if (input.hold) {
        // The failed production-shaped probe was silent until execution ended.
        // Sending an earlier prefix did not exercise a silent connection.
        timer = setTimeout(() => release(true), holdMs + 30000);
      } else {
        receipt.released = true;
        res.end(bytes);
      }
    } catch {
      if (!res.headersSent) {
        res.statusCode = 400;
        json(res, { error: 'Invalid diagnostic request' });
      } else res.destroy();
    }
  });
  return server;
}

// Local approximation of a ClusterIP: choose the backend when a connection is
// accepted, retain that connection across a selector change. This does not
// emulate Cilium/conntrack; only a real provider test can exercise that layer.
export function diagnosticRouter({ a = 'a', b = 'b' } = {}) {
  let selected = 'a',
    changes = 0;
  const uid = randomUUID();
  const tcp = net.createServer((client) => {
    const upstream = net.connect(8080, selected === 'a' ? a : b);
    client.pipe(upstream).pipe(client);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => {
      if (!upstream.readableEnded) client.destroy();
    });
  });
  const control = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/route') return json(res, { uid, selected, changes });
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/switch');
      assert.deepEqual(await body(req), { expected: 'a', selected: 'b' });
      assert.equal(selected, 'a');
      assert.equal(changes, 0);
      selected = 'b';
      changes++;
      json(res, { uid, selected, changes });
    } catch {
      res.statusCode = 409;
      json(res, { error: 'Diagnostic route conflict' });
    }
  });
  return { tcp, control };
}

async function kubernetesApi(method, path, payload) {
  const root = '/var/run/secrets/kubernetes.io/serviceaccount/';
  const [ca, token] = await Promise.all([readFile(root + 'ca.crt'), readFile(root + 'token', 'utf8')]);
  return new Promise((resolve, reject) => {
    const request = https.request(
      'https://kubernetes.default.svc' + path,
      {
        method,
        ca,
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: 'Bearer ' + token.trim(),
          ...(payload ? { 'content-type': 'application/json-patch+json' } : {}),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1048576) response.destroy();
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            if (response.statusCode !== 200)
              throw Object.assign(Error('Diagnostic Kubernetes request failed'), {
                code: 'DIAGNOSTIC_KUBERNETES_HTTP',
                status: response.statusCode,
              });
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(payload ? JSON.stringify(payload) : undefined);
  });
}

// ConfigMap projection and local directory links give argv a symlink path,
// while Node resolves import.meta.url to the underlying file.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const mode = process.argv[2];
  if (mode === 'backend')
    diagnosticBackend({
      uid: process.env.POD_UID,
      fault: process.env.LOCAL_TRUNCATE === '1',
      holdMs: Number(process.env.DIAGNOSTIC_HOLD_MS ?? 300000),
    }).listen(8080, '0.0.0.0');
  else if (mode === 'router') {
    const r = diagnosticRouter();
    r.tcp.listen(8080, '0.0.0.0');
    r.control.listen(8081, '0.0.0.0');
  } else {
    assert.ok(['client-local', 'client-kubernetes'].includes(mode));
    assert.equal(process.versions.node, '24.22.1');
    // Read-only startup readiness has a short bound and starts no work.
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        for (const url of ['http://a:8080/readyz', 'http://b:8080/readyz', 'https://proxy:8443/readyz']) {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
        }
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
    const change =
      mode === 'client-kubernetes'
        ? () => changeDiagnosticService(kubernetesApi, process.env.POD_NAMESPACE)
        : async () => {
            const before = await (await fetch('http://execution:8081/route')).json();
            assert.equal(before.selected, 'a');
            assert.equal(before.changes, 0);
            const response = await fetch('http://execution:8081/switch', {
              method: 'POST',
              body: JSON.stringify({ expected: 'a', selected: 'b' }),
              signal: AbortSignal.timeout(3000),
            });
            assert.equal(response.status, 200);
            const after = await response.json();
            assert.equal(after.uid, before.uid);
            assert.equal(after.changes, 1);
            return { before, after };
          };
    const report = await runConnectionResetDiagnostic({
      baseUrl: 'https://proxy:8443',
      backendA: 'http://a:8080',
      backendB: 'http://b:8080',
      change,
      holdMs: mode === 'client-local' ? 100 : 300000,
      evidence: (event) => console.error(JSON.stringify(event)),
    });
    await writeFile('/tmp/connection-reset-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  }
}
