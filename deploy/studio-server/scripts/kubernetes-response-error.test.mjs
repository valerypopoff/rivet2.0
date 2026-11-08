import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createKubernetesTransport } from './lib/execution-autoscaler-kubernetes.mjs';
import { KubernetesResponseError } from './lib/kubernetes-response-error.mjs';
import { changeDiagnosticService, diagnosticLabel } from './lib/connection-reset-diagnostic.mjs';

for (const [status, reason] of [
  [422, 'Invalid'],
  [409, 'Conflict'],
  [403, 'Forbidden'],
  [502, undefined],
]) {
  test(`Kubernetes write failure preserves safe status evidence without replay: ${status}`, async (t) => {
    let calls = 0;
    const auditId = 'b11e69e4-e1b2-447a-a70f-4f4a34efac10';
    const secret = 'fixture-sensitive-request-value';
    const server = http.createServer((req, res) => {
      calls++;
      req.resume();
      res.writeHead(status, { 'audit-id': auditId });
      res.end(
        reason
          ? JSON.stringify({
              kind: 'Status',
              reason,
              message: secret,
              details: {
                causes: [{ reason: 'FieldValueInvalid', field: 'spec.containers[0].image', message: secret }],
              },
            })
          : 'upstream error ' + secret,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const api = createKubernetesTransport({
      origin: `http://127.0.0.1:${server.address().port}`,
      allowLoopbackHttp: true,
      token: () => secret,
      ca: () => undefined,
    });
    await assert.rejects(api.json('POST', '/api/v1/namespaces/fixture/configmaps', { data: { secret } }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.auditId, auditId);
      if (reason) {
        assert.equal(error.kubernetesStatus.reason, reason);
        assert.deepEqual(error.kubernetesStatus.causes, [
          { reason: 'FieldValueInvalid', field: 'spec.containers[0].image' },
        ]);
        assert.match(error.message, new RegExp(reason));
      }
      assert.match(error.message, new RegExp(auditId));
      assert.ok(!error.message.includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('a failed write keeps its original status if the read-back also fails', async () => {
  const namespace = 'rivet-reset-123456abcdef';
  const writeError = new KubernetesResponseError(
    'PATCH',
    { statusCode: 422, headers: { 'audit-id': 'b11e69e4-e1b2-447a-a70f-4f4a34efac10' } },
    Buffer.from(JSON.stringify({ kind: 'Status', reason: 'Invalid' })),
  );
  let reads = 0,
    writes = 0;
  await assert.rejects(
    changeDiagnosticService(async (method) => {
      if (method === 'PATCH') {
        writes++;
        throw writeError;
      }
      if (reads++) throw Error('secondary read-back failure');
      return {
        metadata: {
          name: 'execution',
          namespace,
          labels: { [diagnosticLabel]: namespace },
          uid: 'service-1',
          resourceVersion: '1',
        },
        spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', selector: { [diagnosticLabel]: namespace, pool: 'a' } },
      };
    }, namespace),
    (error) => error === writeError,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});
