import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runRivetResponseReset } from '../lib/rivet-response-reset.mjs';
import { changeDiagnosticService } from '../lib/connection-reset-diagnostic.mjs';
import { KubernetesResponseError } from '../lib/kubernetes-response-error.mjs';

const json = (res, value) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

export async function startRivetResetBackend() {
  const base = '/app/packages/studio-server-api/dist/studio-server-api/src/';
  const load = (name) => import(base + name + '.js');
  Object.assign(process.env, {
    RIVET_WORKFLOWS_ROOT: '/tmp/rivet-reset/workflows',
    RIVET_WORKFLOW_RECORDINGS_ROOT: '/tmp/rivet-reset/recordings',
    RIVET_APP_DATA_ROOT: '/tmp/rivet-reset/app',
    RIVET_RUNTIME_LIBRARIES_ROOT: '/tmp/rivet-reset/libraries',
    RIVET_RECORDINGS_ENABLED: 'true',
  });
  const require = createRequire('/app/packages/studio-server-api/package.json');
  const rivet = await import(require.resolve('@valerypopoff/rivet2-node'));
  const helpers = await load('routes/workflows/fs-helpers');
  const storage = await load('routes/workflows/storage-backend');
  await fs.mkdir(process.env.RIVET_WORKFLOWS_ROOT, { recursive: true });
  await storage.initializeWorkflowStorage();
  await (await load('workflow-endpoint-auth-settings')).writeWorkflowEndpointAuthSettings({ requireBearerAuth: false });
  const project = rivet.loadProjectFromString(helpers.createBlankProjectFile('Response reset diagnostic'));
  const graph = project.graphs[project.metadata.mainGraphId];
  const node = (type, id, data) => ({ type, id, title: id, data, visualData: { x: 0, y: 0 } });
  graph.nodes = [
    node('graphInput', 'input', { id: 'input', dataType: 'string' }),
    node('code', 'admission', {
      inputNames: ['input'],
      outputNames: ['output', 'delay'],
      code: `const body=inputs.input.value,p=JSON.parse(body);
if(!/^[a-f0-9-]{36}$/.test(p.requestId)||![0,1000,295000].includes(p.delayMs))throw Error('Invalid diagnostic input');
require('node:fs').writeFileSync('/tmp/rivet-reset/accepted-'+p.requestId,JSON.stringify({requestId:p.requestId,acceptedAt:new Date().toISOString()}),{flag:'wx'});
return {output:{type:'string',value:body},delay:{type:'number',value:p.delayMs}};`,
    }),
    node('delay', 'delay', { delay: 295000, useDelayInput: true }),
    node('graphOutput', 'output', { id: 'output', dataType: 'string' }),
  ];
  const edge = (outputNodeId, outputId, inputNodeId, inputId) => ({ outputNodeId, outputId, inputNodeId, inputId });
  graph.connections = [
    edge('input', 'data', 'admission', 'input'),
    edge('admission', 'output', 'delay', 'input1'),
    edge('admission', 'delay', 'delay', 'delay'),
    edge('delay', 'output1', 'output', 'value'),
  ];
  const projectPath = process.env.RIVET_WORKFLOWS_ROOT + '/reset.rivet-project';
  await fs.writeFile(projectPath, rivet.serializeProject(project));
  const snapshot = await (
    await load('routes/workflows/workflow-query')
  ).getWorkflowProject(process.env.RIVET_WORKFLOWS_ROOT, projectPath);
  await (
    await load('routes/workflows/workflow-mutations')
  ).publishWorkflowProjectItem(
    'reset.rivet-project',
    { endpointName: 'reset' },
    {
      expectedProjectId: snapshot.projectMetadataId,
      expectedPublicationVersion: snapshot.settings.publicationVersion ?? '0',
      expectedDraftRevisionId: snapshot.revisionId,
    },
  );
  const app = (await load('app')).createApiApp('execution');
  const { getActiveHttpExecutionCount } = await load('active-http-executions');
  const owner = {
    uid: process.env.POD_UID ?? randomUUID(),
    incarnation: randomUUID(),
    node: process.env.NODE_NAME ?? 'local',
    pid: process.pid,
  };
  const records = new Map();
  const trace = (event, data) => console.log(JSON.stringify({ event, at: new Date().toISOString(), owner, ...data }));
  const handle = async (req, res) => {
    if (req.url === '/diagnostic/state' && req.method === 'GET') {
      const requests = [];
      for (const receipt of records.values()) {
        let accepted;
        try {
          accepted = JSON.parse(await fs.readFile('/tmp/rivet-reset/accepted-' + receipt.requestId, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        requests.push({ ...receipt, accepted: !!accepted, acceptedAt: accepted?.acceptedAt });
      }
      return json(res, { owner, requests, activeRuns: getActiveHttpExecutionCount() });
    }
    if (req.url === '/readyz' && req.method === 'GET') return json(res, { ready: true, owner });
    if (req.url !== '/workflows/reset' || req.method !== 'POST') {
      res.statusCode = 404;
      return res.end();
    }
    const requestId = req.headers['x-diagnostic-request'];
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) || records.has(requestId)) {
      res.statusCode = 400;
      return res.end();
    }
    const receipt = {
      requestId,
      socketId: req.socket.diagnosticId,
      upstreamConnection: req.headers.connection,
      finished: false,
      closed: false,
    };
    records.set(requestId, receipt);
    res.setHeader('x-diagnostic-owner', owner.uid);
    const facts = () => ({
      requestId,
      socketId: receipt.socketId,
      requestComplete: req.complete,
      ended: res.writableEnded,
      finished: res.writableFinished,
      bytesWritten: req.socket.bytesWritten,
    });
    res.once('finish', () => {
      receipt.finished = true;
      trace('response-finish', facts());
    });
    res.once('close', () => {
      receipt.closed = true;
      trace('response-close', facts());
    });
    res.once('error', (error) => trace('response-error', { ...facts(), code: error.code }));
    if (process.env.LOCAL_TRUNCATE === '1' && req.headers['x-diagnostic-control'] === '0') {
      const end = res.end.bind(res);
      res.end = function (chunk, ...args) {
        if (String(chunk).includes('\\"delayMs\\":1000')) {
          res.write(Buffer.from(chunk).subarray(0, 11959), () => res.destroy());
          return res;
        }
        return end(chunk, ...args);
      };
    }
    app(req, res);
  };
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      trace('diagnostic-handler-error', { code: error.code });
      if (!res.headersSent) {
        res.statusCode = 500;
        json(res, { error: 'Diagnostic handler failed' });
      } else res.destroy();
    });
  });
  server.on('connection', (socket) => {
    socket.diagnosticId = randomUUID();
    const facts = () => ({
      socketId: socket.diagnosticId,
      local: socket.localAddress,
      remote: socket.remoteAddress,
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
      writableFinished: socket.writableFinished,
      readableEnded: socket.readableEnded,
    });
    socket.once('end', () => trace('socket-end', facts()));
    socket.once('error', (error) => trace('socket-error', { ...facts(), code: error.code }));
    socket.once('close', (hadError) => trace('socket-close', { ...facts(), hadError }));
  });
  (await load('legacy-restore/receive-deadline')).configureRequestReceiveDeadlines(server, false);
  await new Promise((resolve) => server.listen(8080, '0.0.0.0', resolve));
  trace('backend-ready', {});
  return server;
}

async function kubernetesApi(method, path, payload) {
  const root = '/var/run/secrets/kubernetes.io/serviceaccount/';
  const [ca, token] = await Promise.all([fs.readFile(root + 'ca.crt'), fs.readFile(root + 'token', 'utf8')]);
  const https = await import('node:https');
  return new Promise((resolve, reject) => {
    const req = https.request(
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
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 1048576) res.destroy();
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            if (res.statusCode !== 200) throw new KubernetesResponseError(method, res, Buffer.concat(chunks));
            resolve(JSON.parse(Buffer.concat(chunks)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.once('error', reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

if (process.argv[1] && (await fs.realpath(process.argv[1])) === (await fs.realpath(fileURLToPath(import.meta.url)))) {
  const mode = process.argv[2];
  if (mode === 'backend') await startRivetResetBackend();
  else {
    assert.ok(['client-local', 'client-kubernetes'].includes(mode));
    const report = await runRivetResponseReset({
      baseUrl: 'https://proxy:8443',
      backendA: process.env.BACKEND_A,
      backendB: process.env.BACKEND_B,
      durationMs: mode === 'client-local' ? 1000 : 295000,
      evidence: (event) => console.error(JSON.stringify(event)),
      change:
        mode === 'client-local'
          ? async () => {
              const response = await fetch('http://execution:8081/switch', {
                method: 'POST',
                body: JSON.stringify({ expected: 'a', selected: 'b' }),
                signal: AbortSignal.timeout(3000),
              });
              assert.equal(response.status, 200);
              return response.json();
            }
          : () => changeDiagnosticService(kubernetesApi, process.env.POD_NAMESPACE),
    });
    console.log(JSON.stringify(report));
    process.exitCode = report.outcome === 'passed' ? 0 : 1;
  }
}
