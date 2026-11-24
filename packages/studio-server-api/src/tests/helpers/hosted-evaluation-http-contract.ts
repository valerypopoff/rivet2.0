import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import {
  loadProjectFromString,
  serializeProject,
  graphInputNode,
  graphOutputNode,
  httpCallNode,
  type PortId,
} from '@valerypopoff/rivet2-node';
import { createHostedEvaluationFixture } from './hosted-evaluation-fixture.js';
import { listenTestServer } from './http-server-harness.js';
import { startAsyncWorkflowProcess } from './workflow-async-process.js';

/** Real mounted handlers and production coordinator, using only the integration fixture's storage. */
export async function verifyHostedEvaluationHttpContract(pool: Pool, storage: Record<string, unknown>) {
  const api = await startAsyncWorkflowProcess({
    storage,
    apiProfile: 'control',
    hostedEvaluations: true,
    projectPayloadBytes: 0,
    projectName: 'Hosted HTTP fixture',
    endpointName: 'hosted-http-fixture',
  });
  const fixtures: Awaited<ReturnType<typeof createHostedEvaluationFixture>>[] = [];
  let entered = false;
  const pending = new Set<http.ServerResponse>();
  let target: Awaited<ReturnType<typeof listenTestServer>> | undefined;
  const headers = {
    'content-type': 'application/json',
    'x-rivet-proxy-auth': createHash('sha256').update('async-fixture-key:proxy-auth').digest('hex'),
  };
  async function call(route: string, body?: unknown) {
    const response = await fetch(`${api.baseUrl}/api/workflows/evaluation-runs${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function until(check: () => boolean | Promise<boolean>, label: string) {
    const end = Date.now() + 15000;
    while (!(await check())) {
      if (Date.now() >= end) throw new Error(label);
      await delay(10);
    }
  }
  try {
    const first = await createHostedEvaluationFixture(pool, 1);
    fixtures.push(first);
    const second = await createHostedEvaluationFixture(pool, 1);
    fixtures.push(second);
    target = await listenTestServer(
      http.createServer((_request, response) => {
        entered = true;
        pending.add(response);
        response.on('close', () => pending.delete(response));
      }),
    );
    const capability = await call('/hosted/capability');
    assert.equal(capability.status, 200);
    assert.equal(capability.body.enabled, true);
    assert.equal(capability.body.workerEnabled, true);
    const project = loadProjectFromString(first.submission.projectContents);
    const graph = project.graphs[project.metadata.mainGraphId!]!;
    const input = graphInputNode.impl.create();
    input.data = { id: 'input', dataType: 'string' };
    const request = httpCallNode.impl.create();
    request.data.useUrlInput = false;
    request.data.url = target.baseUrl;
    const output = graphOutputNode.impl.create();
    output.data = { id: 'output', dataType: 'any' };
    graph.nodes = [input, request, output];
    graph.connections = [
      { outputNodeId: request.id, outputId: 'res_body' as PortId, inputNodeId: output.id, inputId: 'value' as PortId },
    ];
    first.submission.projectContents = serializeProject(project) as string;
    assert.equal((await call('/hosted', first.submission)).status, 202);
    await until(() => entered, 'Hosted HTTP target never executed');
    const state = await call(
      `/${encodeURIComponent(first.identity.runId)}/hosted-state?projectId=${first.identity.projectId}`,
    );
    assert.equal(state.status, 200);
    assert.equal((state.body.jobs as { status: string }[])[0]!.status, 'accepted');
    assert.equal(
      (await call(`/${encodeURIComponent(first.identity.runId)}/cancel-hosted`, first.identity)).status,
      200,
    );
    await until(
      async () => (await first.store.get(first.identity))?.executionStatus === 'canceled',
      'HTTP cancellation did not settle',
    );
    assert.equal((await call('/hosted', first.submission)).status, 409);
    assert.equal((await call('/hosted', second.submission)).status, 202);
    await until(
      async () => Boolean((await second.store.get(second.identity))?.completedAt),
      'HTTP submission did not finish',
    );
    await pool.query("UPDATE evaluation_hosted_trial_jobs SET status='interrupted' WHERE project_id=$1", [
      second.identity.projectId,
    ]);
    await pool.query("UPDATE evaluation_hosted_runs SET status='interrupted' WHERE project_id=$1", [
      second.identity.projectId,
    ]);
    const jobs = (
      await pool.query<{ job_id: string }>('SELECT job_id FROM evaluation_hosted_trial_jobs WHERE project_id=$1', [
        second.identity.projectId,
      ])
    ).rows;
    const retried = await call(`/${encodeURIComponent(second.identity.runId)}/retry-interrupted`, {
      ...second.identity,
      jobIds: jobs.map((job) => job.job_id),
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.executionStatus, 'running');
    await until(
      async () =>
        (
          await pool.query(
            "SELECT 1 FROM evaluation_hosted_trial_jobs WHERE project_id=$1 AND attempt=2 AND status='settled'",
            [second.identity.projectId],
          )
        ).rowCount === 1,
      'HTTP retry did not execute exactly once',
    );
    console.log(
      'Hosted PostgreSQL HTTP: admission, state, cancellation, duplicate conflict and explicit retry passed.',
    );
  } finally {
    for (const response of pending) response.end();
    await target?.close();
    await api.close();
    for (const fixture of fixtures) await fixture.dispose();
  }
}
