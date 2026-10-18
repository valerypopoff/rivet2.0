import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import {
  createHostedEvaluationSubmission,
  createHostedEvaluationFixtureContents,
} from '../kubernetes-hosted-evaluation-gate.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function haProofTimeoutMs({ deploymentTimeoutSeconds = 600 }) {
  assert.ok(Number.isSafeInteger(deploymentTimeoutSeconds) && deploymentTimeoutSeconds > 0 &&
    Number.isSafeInteger(deploymentTimeoutSeconds * 1000), 'HA proof requires a positive whole-second deployment timeout');
  return deploymentTimeoutSeconds * 1000;
}
async function until(description, check, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw Error(`HA proof timed out: ${description}`);
}

/** Disposable fixture observations, not production retirement policy. Every
 * receipt is tied to an actual accepted operation and the retiring pod UID. */
export class HaReleaseProbes {
  constructor(gate, baseUrl, rootDir) {
    this.gate = gate;
    this.baseUrl = baseUrl;
    this.rootDir = rootDir;
    this.editors = [];
    this.notifications = [];
    this.evaluations = [];
    this.background = [];
    this.withdrawn = [];
  }
  request(route, options) {
    return this.gate.requestWorkflow(this.baseUrl, route, options);
  }
  kube(args, extra = {}) {
    return this.gate.kubectl(['-n', this.gate.config.namespace, ...args], { capture: true, ...extra });
  }
  async sql(query) {
    if (this.gate.readProofSql) return this.gate.readProofSql(query);
    const result = await this.kube([
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
    ]);
    return JSON.parse(result.stdout.trim());
  }
  async prepare() {
    const state = JSON.parse(
      await fs.readFile(path.join(this.gate.config.artifactsDir, 'ha-persisted-state.json'), 'utf8'),
    );
    const template = await this.request('/api/workflows/projects/download', {
      method: 'POST',
      body: JSON.stringify({ relativePath: state.relativePath, version: 'live' }),
    });
    this.template = template;
    this.projectPath = state.relativePath;
    this.projectId = parse(template).data.metadata.id;
    const project = parse(template);
    project.data.metadata.id = randomUUID();
    this.backgroundEndpoint = `ha-background-${project.data.metadata.id}`;
    delete project.data.uiGraphs;
    const graph = project.data.graphs[project.data.metadata.mainGraphId];
    graph.nodes = {
      '[input]:graphInput "Input"': {
        data: { id: 'input', dataType: 'string' },
        outgoingConnections: ['data->"Output" output/value', 'data->"Background" background/input1'],
        visualData: '0/0/300/null//',
      },
      '[output]:graphOutput "Output"': { data: { id: 'output', dataType: 'string' }, visualData: '700/0/300/null//' },
      '[background]:startBackgroundBranch "Background"': {
        data: {},
        outgoingConnections: ['output1->"Tail" tail/input1'],
        visualData: '200/0/300/null//',
      },
      '[tail]:delay "Tail"': { data: { delay: 45_000, useDelayInput: false }, visualData: '400/0/300/null//' },
    };
    const upload = await this.request('/api/workflows/projects/upload', {
      method: 'POST',
      body: JSON.stringify({
        folderRelativePath: '',
        fileName: 'ha-background.rivet-project',
        contents: stringify(project),
      }),
    });
    const relativePath = upload.project.relativePath;
    const snapshot = await this.request(
      `/api/workflows/projects/web-apps?relativePath=${encodeURIComponent(relativePath)}`,
    );
    await this.request('/api/workflows/projects/publish', {
      method: 'POST',
      body: JSON.stringify({
        relativePath,
        settings: { endpointName: this.backgroundEndpoint },
        preconditions: {
          expectedProjectId: snapshot.projectId,
          expectedDraftRevisionId: snapshot.draftRevisionId,
          expectedPublicationVersion: snapshot.publicationVersion,
        },
      }),
    });
    const bundle = await this.request('/api/workflows/project-bundles', {
      method: 'POST',
      body: JSON.stringify({ relativePath: state.relativePath, version: 'published', requestId: randomUUID() }),
    });
    this.bundle = await until('immutable shared export', async () => {
      const status = await this.request(`/api/workflows/project-bundles/${bundle.id}`);
      if (status.phase === 'failed') throw Error(`Bundle preparation failed: ${status.message}`);
      return status.phase === 'ready' ? status : null;
    });
    const pods = JSON.parse(
      (await this.kube(['get', 'pods', '-l', `app.kubernetes.io/instance=${this.gate.config.release}`, '-o', 'json']))
        .stdout,
    ).items;
    const restoreOwners = pods.filter((p) => p.spec.volumes?.some((v) => v.persistentVolumeClaim));
    assert.equal(restoreOwners.length, 1, 'only the maintenance owner may mount restore data');
    assert.match(restoreOwners[0].metadata.name, /-maintenance-backend-0$/);
  }
  async beforeRetirement(pod) {
    const match = /-ha-backend-([01])$/.exec(pod.name);
    if (match) {
      const neighbor = pod.name.slice(0, -1) + (match[1] === '0' ? '1' : '0');
      const source = await fs.readFile(
        path.join(this.rootDir, 'deploy/studio-server/scripts/fixtures/ha-notification-probe.mjs'),
        'utf8',
      );
      const result = await this.kube(
        ['exec', '-i', pod.name, '-c', pod.container, '--', 'node', '--input-type=module', '-', neighbor],
        { input: source },
      );
      this.notifications.push({ pod: pod.name, uid: pod.uid, receipt: JSON.parse(result.stdout.trim()) });
      await this.startEditor(pod, pod.name.slice(0, -1) + (match[1] === '0' ? '1' : '0'));
      const runId = `ha-${randomUUID()}`;
      const submission = createHostedEvaluationSubmission({ runId, label: runId });
      submission.projectContents = createHostedEvaluationFixtureContents(this.template, { trialDelayMs: 45_000 });
      submission.projectPath = this.projectPath;
      submission.dataset.projectId = this.projectId;
      submission.dataset.cases = Array.from({ length: 6 }, (_, index) => ({
        id: `case-${index}`,
        name: `Case ${index}`,
        values: { input: 'ha-preserved' },
      }));
      await this.request('/api/workflows/evaluation-runs/hosted', { method: 'POST', body: JSON.stringify(submission) });
      const jobs = await until('Evaluation accepted on retiring owner', async () => {
        const rows = await this.sql(
          `SELECT COALESCE(json_agg(json_build_object('jobId',job_id,'attempt',attempt,'worker',worker_id)), '[]') FROM evaluation_hosted_trial_jobs WHERE run_id='${runId}' AND status='accepted' AND worker_id LIKE 'evaluation-worker:${pod.name}:%'`,
        );
        return rows.length ? rows : null;
      });
      this.evaluations.push({ pod: pod.name, uid: pod.uid, runId, jobs });
    }
    if (/-ha-execution-[01]$/.test(pod.name)) {
      const source = `const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/workflows/${this.backgroundEndpoint}',{method:'POST',headers:{authorization:'Bearer '+process.env.RIVET_KEY,'content-type':'application/json'},body:JSON.stringify({input:'preserved'}),signal:AbortSignal.timeout(10000)});console.log(JSON.stringify({status:r.status,correlationId:r.headers.get('x-rivet-correlation-id'),body:await r.json()}));`;
      const response = JSON.parse(
        (await this.kube(['exec', pod.name, '-c', pod.container, '--', 'node', '--input-type=module', '-e', source]))
          .stdout,
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.output.value, JSON.stringify({ input: 'preserved' }));
      assert.ok(response.correlationId);
      this.background.push({ pod: pod.name, uid: pod.uid, correlationId: response.correlationId });
    }
  }
  async startEditor(pod, neighbor, holdMs = 25_000) {
    const marker = `/tmp/rivet-ha-probe-${randomUUID()}.json`;
    const source = await fs.readFile(
      path.join(this.rootDir, 'deploy/studio-server/scripts/fixtures/ha-editor-retirement-probe.mjs'),
      'utf8',
    );
    const probe = { pod: pod.name, uid: pod.uid, receipt: null, error: null };
    this.editors.push(probe);
    probe.completed = this.kube(
      [
        'exec',
        '-i',
        pod.name,
        '-c',
        pod.container,
        '--',
        'node',
        '--input-type=module',
        '-',
        marker,
        neighbor,
        String(holdMs),
      ],
      { input: source },
    ).then(
      (result) => {
        probe.receipt = JSON.parse(result.stdout.trim().split('\n').at(-1));
      },
      (error) => {
        probe.error = error;
      },
    );
    await until(
      'accepted paused editor run',
      async () => {
        if (probe.error) throw probe.error;
        const result = await this.kube([
          'exec',
          pod.name,
          '-c',
          pod.container,
          '--',
          'node',
          '-e',
          'process.stdout.write(require("node:fs").existsSync(process.argv[1])?require("node:fs").readFileSync(process.argv[1],"utf8"):"null")',
          marker,
        ]);
        return JSON.parse(result.stdout)?.phase === 'paused';
      },
      90_000,
    );
  }
  async afterWithdrawal(pod) {
    this.withdrawn.push({ pod: pod.name, uid: pod.uid });
    const evaluation = this.evaluations.find((p) => p.uid === pod.uid);
    if (evaluation) {
      const jobs = await this.sql(
        `SELECT json_agg(json_build_object('jobId',job_id,'attempt',attempt,'worker',worker_id,'status',status,'executionStatus',trial_json->>'executionStatus')) FROM evaluation_hosted_trial_jobs WHERE run_id='${evaluation.runId}'`,
      );
      for (const accepted of evaluation.jobs) {
        const completed = jobs.find((j) => j.jobId === accepted.jobId);
        assert.equal(completed.status, 'settled');
        assert.equal(completed.executionStatus, 'completed');
        assert.equal(completed.attempt, 1);
        assert.equal(completed.worker, accepted.worker);
      }
      evaluation.preserved = true;
    }
    const background = this.background.find((p) => p.uid === pod.uid);
    if (background) {
      const page = await this.request('/api/workflows/recordings/runs?page=1&pageSize=100&status=all');
      const recordings = page.runs.filter((r) => r.executionIdentity?.correlationId === background.correlationId);
      assert.equal(recordings.length, 1, 'one full-run recording must be durable before removing its owner');
      assert.equal(recordings[0].status, 'succeeded');
      background.recordingId = recordings[0].id;
    }
    if (/-maintenance-backend-0$/.test(pod.name)) {
      const response = await fetch(`${this.baseUrl}/api/workflows/project-bundles/${this.bundle.id}/download`, {
        headers: this.gate.probeHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(response.status, 200);
      const digest = createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex');
      assert.equal(digest, this.bundle.archiveHash);
      this.bundleVerified = true;
    }
  }
  async finish() {
    await Promise.all(this.editors.map((p) => p.completed));
    for (const p of this.editors) if (p.error) throw p.error;
    assert.equal(this.editors.length, 2);
    assert.equal(this.notifications.length, 2);
    assert.ok(this.editors.every((p) => p.receipt?.phase === 'passed'));
    assert.equal(this.evaluations.length, 2);
    assert.ok(this.evaluations.every((p) => p.preserved));
    assert.equal(this.background.length, 2);
    assert.ok(this.background.every((p) => p.recordingId));
    assert.equal(this.bundleVerified, true);
    const source = await fs.readFile(
      path.join(this.rootDir, 'deploy/studio-server/scripts/fixtures/ha-notification-probe.mjs'),
      'utf8',
    );
    const left = `${this.gate.config.release}-ha-backend-0`,
      right = `${this.gate.config.release}-ha-backend-1`;
    const result = await this.kube(
      ['exec', '-i', left, '-c', 'backend', '--', 'node', '--input-type=module', '-', right, 'folders'],
      { input: source },
    );
    this.folderNotifications = JSON.parse(result.stdout.trim());
    const report = this.snapshot();
    await this.gate.artifact('ha-workload-probes.json', JSON.stringify(report, null, 2));
    return report;
  }
  snapshot() {
    return {
      editors: this.editors.map(({ completed, error, ...p }) => ({ ...p, ...(error ? { error: String(error) } : {}) })),
      evaluations: this.evaluations,
      notifications: this.notifications,
      folderNotifications: this.folderNotifications,
      background: this.background,
      bundle: this.bundle,
      withdrawn: this.withdrawn,
      bundleVerified: this.bundleVerified === true,
    };
  }
}
