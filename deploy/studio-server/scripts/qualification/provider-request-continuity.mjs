import assert from 'node:assert/strict';
import https from 'node:https';
import http2 from 'node:http2';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parse, stringify } from 'yaml';
import { rootStructuralMutation } from '../lib/structural-fixture-admission.mjs';
import { extractWebAppRevisionKey, openWebSocketAction } from '../kubernetes-managed-release-gate.mjs';
import {
  requestContinuityProfile,
  assertProtectedProxyTemplate,
  CONTINUITY_DURATION_STAGES,
  continuityStages,
  continuityTimeoutMs,
  assertContinuityAcceptance,
} from '../lib/request-continuity.mjs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const bounded = async (promise, ms = 330000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Continuity probe deadline exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
async function waitForProxyRoll(label, check, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (await check()) return;
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Exercise the native RollingUpdate controller on the isolated candidate,
 * retaining images, replicas and HPA policy. Never manually remove a proxy. */
export async function qualifyProtectedProxyRoll(gate, probes, { waitFor = waitForProxyRoll } = {}) {
  await gate.assertProofContext();
  const name = gate.config.release + '-proxy';
  const deployment = JSON.parse((await gate.kube(['get', 'deployment', name, '-o', 'json'])).stdout);
  assert.equal(deployment.metadata.labels['app.kubernetes.io/instance'], gate.config.release);
  assert.equal(deployment.spec.strategy.type, 'RollingUpdate');
  assert.equal(deployment.spec.strategy.rollingUpdate.maxUnavailable, 0);
  assert.equal(deployment.spec.replicas, 2);
  assertProtectedProxyTemplate(deployment.spec.template, gate.operation.requestContinuityProfile);
  const proxies = async () =>
    (await gate.pods()).filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'proxy');
  const before = await proxies();
  assert.equal(before.length, 2);
  assert.ok(
    before.every(
      (p) =>
        !p.metadata.deletionTimestamp && p.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
    ),
  );
  for (const stage of gate.operation.qualification?.tier === 'focused' ? [] : Object.keys(CONTINUITY_DURATION_STAGES)) {
    await probes.startCohort(stage);
    await probes.settleCohort(stage);
  }
  await probes.startCohort('protected-roll');
  const replacement = { before: before.map((p) => p.metadata.uid), dispatchedAt: new Date().toISOString() };
  const annotations = {
    ...deployment.spec.template.metadata.annotations,
    'rivet.dev/runtime-control-cold': gate.coldProxyMarker ?? gate.operation.operationId,
  };
  const patch = [
    { op: 'test', path: '/metadata/uid', value: deployment.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: deployment.metadata.resourceVersion },
    { op: 'add', path: '/spec/template/metadata/annotations', value: annotations },
  ];
  await gate.artifact(
    'continuity-proxy-roll-intent.json',
    JSON.stringify({ uid: deployment.metadata.uid, resourceVersion: deployment.metadata.resourceVersion, patch }),
  );
  // Persist intent first; a failed acknowledgement stops qualification and is
  // never permission to replay this template mutation.
  await gate.kube(['patch', 'deployment', name, '--type=json', '-p', JSON.stringify(patch)]);
  await waitFor(
    'protected proxy replacement and predecessor exit',
    async () => {
      const current = await proxies();
      const departing = current.filter(
        (p) => replacement.before.includes(p.metadata.uid) && p.metadata.deletionTimestamp,
      );
      if (departing.length && !replacement.observedAt) replacement.observedAt = new Date().toISOString();
      if (current.some((p) => replacement.before.includes(p.metadata.uid))) return false;
      if (
        current.length !== 2 ||
        current.some(
          (p) =>
            p.metadata.deletionTimestamp || !p.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'),
        )
      )
        return false;
      replacement.after = current.map((p) => p.metadata.uid);
      return true;
    },
    continuityTimeoutMs(gate.operation.requestContinuityProfile),
  );
  assert.ok(replacement.observedAt, 'Native proxy termination was not observed');
  await probes.settleCohort('protected-roll');
  assertContinuityAcceptance(await gate.verifyProtectedProxyAvailability(), gate.operation.requestContinuityProfile);
  probes.replacement = replacement;
}
/** Consume the complete body. Neither a response header nor a successfully
 * opened stream counts as a completed protected request. No POST is retried. */
export function collectContinuityResponse(stream, status, headers) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0,
      ended = false;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 131072) stream.destroy(Error('Probe body exceeded bounds'));
      else chunks.push(chunk);
    });
    stream.once('error', reject);
    stream.once('aborted', () => reject(Error('Probe body interrupted')));
    stream.once('close', () => {
      if (!ended) reject(Error('Probe stream closed before its complete body'));
    });
    stream.once('end', () => {
      ended = true;
      resolve({ status, headers, body: Buffer.concat(chunks), bytes });
    });
  });
}
function requestHttp1(url, { agent, body, headers = {}, timeoutMs = body ? 330000 : 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        agent,
        method: body ? 'POST' : 'GET',
        headers: {
          ...headers,
          ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        collectContinuityResponse(response, response.statusCode, response.headers).then(
          (value) => resolve({ ...value, reusedConnection: req.reusedSocket }),
          reject,
        );
      },
    );
    req.once('error', reject);
    req.end(body);
  });
}
export function requestHttp2(session, path, { body, headers = {}, timeoutMs = body ? 330000 : 15000 } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const stream = session.request({
    ':path': path,
    ':method': body ? 'POST' : 'GET',
    ...headers,
    ...(body ? { 'content-type': 'application/json' } : {}),
  });
  // An inactivity timer resets on each chunk and cannot bound a trickling body.
  const timer = setTimeout(() => stream.destroy(Error('HTTP/2 probe deadline exceeded')), timeoutMs);
  const completion = new Promise((resolve, reject) => {
    let headersReceived = false;
    stream.once('error', reject);
    stream.once('close', () => {
      if (!headersReceived) reject(Error('HTTP/2 probe closed before response headers'));
    });
    stream.once('response', (headers) => {
      headersReceived = true;
      collectContinuityResponse(stream, headers[':status'], headers).then(resolve, reject);
    });
  });
  stream.end(body);
  return completion.finally(() => clearTimeout(timer));
}

export class ProviderRequestContinuity {
  constructor(gate, { hpaOnly = false } = {}) {
    this.hpaOnly = hpaOnly;
    this.gate = gate;
    this.cohorts = new Map();
    this.requests = [];
    this.failures = [];
    this.sessions = new Set();
    this.bootstrap = requestContinuityProfile(gate.operation.installed.qualificationValues)
      ? 'already-protected'
      : 'passed';
  }
  async prepare(template) {
    const gate = this.gate,
      base = gate.config.baseUrl;
    // Only this operation's isolated installation is changed. Production must
    // pass the same running-Nginx check before an adoption is admitted.
    await gate.assertProofContext();
    const limits = await fetch(`${base}/api/app-settings/runtime-limits`, {
      headers: gate.probeHeaders,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(limits.status, 200);
    const etag = limits.headers.get('etag');
    assert.ok(etag);
    await limits.body.cancel();
    await gate.requestWorkflow(base, '/api/app-settings/runtime-limits', {
      method: 'PATCH',
      headers: { 'If-Match': etag },
      body: JSON.stringify({ proxyReadTimeoutSeconds: 3600 }),
    });
    const deadline = performance.now() + 120000;
    while (true) {
      const proxies = (await gate.pods()).filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'proxy');
      const includes = await Promise.all(
        proxies.map(
          async (p) =>
            (
              await gate.kube([
                'exec',
                p.metadata.name,
                '-c',
                'proxy',
                '--',
                'cat',
                '/tmp/nginx/rivet-proxy-timeout.inc',
              ])
            ).stdout,
        ),
      );
      if (includes.length >= 2 && includes.every((v) => /proxy_read_timeout\s+3600s;/.test(v))) break;
      assert.ok(performance.now() < deadline, 'Runtime proxy settings did not reach all original proxies');
      await new Promise((r) => setTimeout(r, 1000));
    }
    const project = parse(template);
    project.data.metadata.id = randomUUID();
    delete project.data.uiGraphs;
    project.data.graphs[project.data.metadata.mainGraphId].nodes = {
      '[input]:graphInput "Input"': {
        data: { id: 'input', dataType: 'string' },
        outgoingConnections: ['data->"Admission" admission/input'],
        visualData: '0/0/300/null//',
      },
      '[admission]:code "Admission"': {
        data: {
          inputNames: ['input'],
          outputNames: ['output', 'delay'],
          code: `const body=inputs.input.value,p=JSON.parse(body);
if(!/^[a-f0-9-]{36}$/.test(p.requestId)||![60000,180000,295000,300000].includes(p.delayMs))throw Error('Invalid continuity fixture input');
require('node:fs').writeFileSync('/tmp/rivet-continuity-'+p.requestId+'.json',JSON.stringify({requestId:p.requestId,acceptedAt:new Date().toISOString(),podName:process.env.HOSTNAME}),{flag:'wx'});
return {output:{type:'string',value:body},delay:{type:'number',value:p.delayMs}};`,
        },
        outgoingConnections: ['output->"Delay" delay/input1', 'delay->"Delay" delay/delay'],
        visualData: '175/100/300/null//',
      },
      '[delay]:delay "Delay"': {
        data: { delay: 300000, useDelayInput: true },
        outgoingConnections: ['output1->"Output" output/value'],
        visualData: '350/0/300/null//',
      },
      '[output]:graphOutput "Output"': { data: { id: 'output', dataType: 'string' }, visualData: '700/0/300/null//' },
    };
    this.endpoint = `continuity-${project.data.metadata.id}`;
    const uploaded = await gate.requestWorkflow(base, '/api/workflows/projects/upload', {
      method: 'POST',
      headers: { 'X-Rivet-Namespace-Intent': '1' },
      body: JSON.stringify({
        folderRelativePath: '',
        mutation: rootStructuralMutation(),
        fileName: `${this.endpoint}.rivet-project`,
        contents: stringify(project),
      }),
    });
    this.workflowId = uploaded.project.id;
    const relativePath = uploaded.project.relativePath;
    const snapshot = await gate.requestWorkflow(
      base,
      `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`,
    );
    await gate.requestWorkflow(base, '/api/workflows/projects/publish', {
      method: 'POST',
      body: JSON.stringify({
        relativePath,
        settings: { endpointName: this.endpoint },
        preconditions: {
          expectedProjectId: snapshot.projectId,
          expectedDraftRevisionId: snapshot.draftRevisionId,
          expectedPublicationVersion: snapshot.publicationVersion,
        },
      }),
    });
    if (this.hpaOnly) {
      this.prepared = true;
      return;
    }
    const html = await gate.requestWorkflow(base, '/apps/release-gate-web-app');
    this.revisionKey = extractWebAppRevisionKey(html);
    this.idleAction = openWebSocketAction(base, {
      startOnReady: false,
      componentId: 'release-gate-long-run-button',
      revisionKey: this.revisionKey,
      headers: { cookie: [gate.uiCookie, gate.publicAppCookie].join('; ') },
    });
    // A readiness timeout cannot leave unhandled deferred rejections behind.
    this.idleAction.accepted.catch(() => {});
    this.idleAction.terminal.catch(() => {});
    await bounded(this.idleAction.ready, 30000);
    this.idleOpenedAt = new Date().toISOString();
    this.prepared = true;
  }
  async startCohort(stage) {
    assert.equal(this.prepared, true, 'The owned continuity fixture must be prepared first');
    if (this.cohorts.has(stage)) return;
    // Keep fixture demand bounded independently of how closely deployment
    // checkpoints occur. A new boundary cohort must not overload two workers
    // by overlapping the previous three requests and accepted drain probes.
    await Promise.all([...this.cohorts.values()].map((c) => c.completion));
    const cohort = { stage, startedAt: new Date().toISOString(), requests: [], outcome: 'running' };
    this.cohorts.set(stage, cohort);
    const base = this.gate.config.baseUrl,
      agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    const session = http2.connect(base);
    session.on('error', () => {});
    this.sessions.add(session);
    try {
      assert.equal((await requestHttp1(`${base}/readyz`, { agent })).status, 200);
      assert.equal((await requestHttp2(session, '/readyz')).status, 200);
      assert.equal(session.socket.alpnProtocol, 'h2', 'The provider must actually negotiate HTTP/2');
      await new Promise(setImmediate); // Let the completed HTTP/1 warm-up socket enter its agent's free pool.
      const tasks = ['fresh-http1', 'pooled-http1', 'http2'].map((transport) => {
        const requestId = randomUUID(),
          delayMs = CONTINUITY_DURATION_STAGES[stage] ?? 300000,
          body = JSON.stringify({ requestId, delayMs, input: 'x'.repeat(16384) }),
          start = performance.now();
        const receipt = { stage, transport, requestId, durationMs: delayMs, startedAt: new Date().toISOString() };
        cohort.requests.push(receipt);
        this.requests.push(receipt);
        const headers = { ...this.gate.probeHeaders, 'x-rivet-ha-probe-id': requestId };
        // Register every completion even if a transport throws synchronously
        // (for example an HTTP/2 session that closed after warm-up).
        const response = Promise.resolve().then(() =>
          transport === 'http2'
            ? requestHttp2(session, `/workflows/${this.endpoint}`, { body, headers, timeoutMs: delayMs + 30000 })
            : requestHttp1(`${base}/workflows/${this.endpoint}`, {
                agent: transport === 'pooled-http1' ? agent : false,
                body,
                headers,
                timeoutMs: delayMs + 30000,
              }),
        );
        return response
          .then((result) => {
            assert.equal(result.status, 200);
            assert.equal(JSON.parse(result.body).output.value, body, 'Complete synthetic response changed');
            const correlationId = result.headers['x-rivet-correlation-id'];
            assert.ok(typeof correlationId === 'string' && correlationId);
            if (transport === 'pooled-http1')
              assert.equal(result.reusedConnection, true, 'Pooled test silently opened a fresh connection');
            Object.assign(receipt, {
              correlationId,
              elapsedMs: Math.round(performance.now() - start),
              finishedAt: new Date().toISOString(),
              fullBody: true,
              bodyBytes: result.bytes,
              bodySha256: sha(result.body),
              outcome: 'passed',
            });
            assert.ok(receipt.elapsedMs >= delayMs, 'The provider must execute the full fixture duration');
          })
          .catch((error) => {
            receipt.outcome = 'failed';
            this.failures.push({ stage, requestId, name: error.name });
            throw error;
          });
      });
      cohort.completion = Promise.allSettled(tasks)
        .then((results) => {
          assert.ok(
            results.every((r) => r.status === 'fulfilled'),
            'A protected request failed',
          );
          cohort.outcome = 'passed';
        })
        .finally(() => {
          agent.destroy();
          session.destroy();
          this.sessions.delete(session);
        });
      cohort.completion.catch(() => {});
      await this.waitForAcceptance(stage);
    } catch (error) {
      agent.destroy();
      session.destroy();
      this.sessions.delete(session);
      cohort.outcome = 'failed';
      this.failures.push({ stage, name: error.name });
      throw error;
    }
  }
  async settleCohort(stage) {
    const cohort = this.cohorts.get(stage);
    assert.ok(cohort, `Missing continuity stage ${stage}`);
    await cohort.completion;
  }
  async waitForAcceptance(stage) {
    const receipts = this.cohorts.get(stage).requests,
      deadline = performance.now() + 30000;
    while (true) {
      const pods = (await this.gate.pods()).filter(
        (p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'execution' && !p.metadata.deletionTimestamp,
      );
      const found = new Map();
      for (const pod of pods)
        for (const container of pod.spec.containers.filter((c) => ['backend', 'api', 'executor'].includes(c.name))) {
          const source = `const f=require('node:fs');console.log(JSON.stringify(JSON.parse(process.argv[1]).flatMap(id=>{const p='/tmp/rivet-continuity-'+id+'.json';return f.existsSync(p)?[JSON.parse(f.readFileSync(p,'utf8'))]:[]})));`;
          const result = await this.gate.kube([
            'exec',
            pod.metadata.name,
            '-c',
            container.name,
            '--',
            'node',
            '-e',
            source,
            JSON.stringify(receipts.map((r) => r.requestId)),
          ]);
          for (const marker of JSON.parse(result.stdout)) {
            const key = pod.metadata.uid + ':' + marker.requestId,
              value = { ...marker, executionPodUid: pod.metadata.uid };
            if (found.has(key)) assert.deepEqual(found.get(key), value, 'Shared-container admission markers differ');
            found.set(key, value);
          }
        }
      for (const receipt of receipts) {
        const markers = [...found.values()].filter((m) => m.requestId === receipt.requestId);
        assert.ok(markers.length <= 1, 'Duplicate synchronous workflow admission');
        if (markers.length && !receipt.acceptedAt)
          // Boundary times share the observer's clock. Existence of the marker
          // proves admission already happened, without relying on node clock skew.
          Object.assign(receipt, { acceptedAt: new Date().toISOString(), executionPodUid: markers[0].executionPodUid });
      }
      if (receipts.every((r) => r.acceptedAt)) return;
      assert.ok(performance.now() < deadline, 'Continuity requests were not accepted before disruption');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  async observeJournal(record) {
    if (!this.prepared) return;
    const state = record.proxyContinuity;
    if (!state) return;
    if (state.mutations?.policy && !this.cohorts.has('policy-adoption')) await this.startCohort('policy-adoption');
    if (state.mutations?.bridge && !this.cohorts.has('bootstrap')) await this.startCohort('bootstrap');
    if (state.mutations?.normal && !this.cohorts.has('return-handoff')) {
      await this.startCohort('return-handoff');
      this.returnHandoff = { dispatchedAt: new Date().toISOString() };
    }
    if (state.phase === 'normal-serving' && !this.returnHandoff?.observedAt)
      this.returnHandoff.observedAt = new Date().toISOString();
    if (
      (state.phase === 'bridge-serving' || (state.phase === 'complete' && record.phase === 'templates')) &&
      !this.cohorts.has('late-admission')
    ) {
      await this.startCohort('late-admission');
      this.actionCompletion = this.resumeAcceptedAction();
      this.actionCompletion.catch(() => {});
    }
    if (state.phase === 'complete')
      this.bridgeCleaned = state.routeRestored && state.entries.every((e) => e.absent || !e.intent);
  }
  async resumeAcceptedAction() {
    const action = this.idleAction;
    action.start();
    const accepted = await bounded(action.accepted, 30000);
    const acceptedAt = new Date().toISOString();
    assert.ok(accepted.runId && accepted.requestId);
    action.socket.terminate();
    const resumed = openWebSocketAction(this.gate.config.baseUrl, {
      revisionKey: this.revisionKey,
      headers: { cookie: [this.gate.uiCookie, this.gate.publicAppCookie].join('; ') },
      resume: { runId: accepted.runId, lastSequence: accepted.sequence },
    });
    resumed.accepted.catch(() => {});
    try {
      const terminal = await bounded(resumed.terminal);
      assert.equal(terminal.type, 'action.completed');
      assert.equal(terminal.runId, accepted.runId);
      assert.ok(terminal.sequence > accepted.sequence);
      assert.equal(resumed.messages.filter((m) => m.type === 'action.completed').length, 1);
      assert.match(accepted.runId, /^[a-f0-9-]{36}$/);
      assert.match(accepted.requestId, /^release-gate-[a-f0-9-]{36}$/);
      const query = `SELECT row_to_json(t) FROM (SELECT (SELECT count(*)::int FROM web_app_action_runs WHERE request_id='${accepted.requestId}') AS runs, count(*) FILTER (WHERE event->>'type'='action.accepted')::int AS starts, count(*) FILTER (WHERE event->>'type'='action.completed')::int AS completions FROM web_app_action_run_events WHERE run_id='${accepted.runId}') t`;
      const persisted = JSON.parse(
        (
          await this.gate.kube([
            'exec',
            'deployment/release-gate-postgres',
            '--',
            'psql',
            '-U',
            'rivet',
            '-d',
            'rivet',
            '-At',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            query,
          ])
        ).stdout.trim(),
      );
      assert.deepEqual(persisted, { runs: 1, starts: 1, completions: 1 });
      this.action = {
        idleOpenedAt: this.idleOpenedAt,
        acceptedAt,
        finishedAt: new Date().toISOString(),
        runId: accepted.runId,
        requestId: accepted.requestId,
        persisted,
        resumed: true,
        starts: 1,
        completions: 1,
        terminalSequence: terminal.sequence,
      };
    } finally {
      resumed.close();
    }
  }
  async finish() {
    for (const stage of continuityStages(
      this.bootstrap === 'already-protected',
      this.hpaOnly ? 'autoscaling' : 'upgrade',
      this.gate.operation.qualification?.tier ?? 'full',
    ))
      await this.settleCohort(stage);
    if (!this.hpaOnly) {
      assert.ok(this.actionCompletion, 'No late WebSocket action was exercised');
      await this.actionCompletion;
      assert.equal(this.browserResume, true, 'The published browser must automatically resume its accepted action');
      this.action.browserResume = true;
      assert.ok(this.bridgeCleaned, 'Temporary bridge settlement was not observed');
    }
    const page = await this.gate.requestWorkflow(
      this.gate.config.baseUrl,
      `/api/workflows/recordings/workflows/${encodeURIComponent(this.workflowId)}/runs?page=1&pageSize=100&status=all`,
    );
    assert.equal(page.hasMore, false);
    assert.equal(page.totalRuns, this.requests.length, 'Duplicate or unaccounted fixture invocations');
    for (const receipt of this.requests) {
      const matches = page.runs.filter(
        (r) => r.workflowId === this.workflowId && r.executionIdentity?.correlationId === receipt.correlationId,
      );
      assert.equal(matches.length, 1);
      assert.equal(matches[0].status, 'succeeded');
      receipt.recordingId = matches[0].id;
    }
    assert.equal(this.failures.length, 0);
    return {
      protocol: this.gate.operation.qualification?.tier === 'focused' ? 3 : 2,
      profile: this.gate.operation.requestContinuityProfile,
      bootstrap: this.bootstrap,
      bridgeCleaned: true,
      requests: this.requests,
      ...(this.action ? { action: this.action } : {}),
      ...(this.removal ? { removal: this.removal } : {}),
      ...(this.replacement ? { replacement: this.replacement } : {}),
      ...(this.returnHandoff ? { returnHandoff: this.returnHandoff } : {}),
      failures: this.failures,
    };
  }
  async close() {
    this.idleAction?.close();
    // Settle already accepted requests before provider cleanup, even on failure.
    await Promise.allSettled([...this.cohorts.values()].map((c) => c.completion));
    await this.actionCompletion?.catch(() => {});
    for (const session of this.sessions) session.destroy();
  }
}
