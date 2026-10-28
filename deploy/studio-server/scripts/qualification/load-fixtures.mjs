import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { root, ready, role, until } from './provider-gate.mjs';
import { pathToFileURL } from 'node:url';
const { rootStructuralMutation } = await import(
  pathToFileURL(path.join(root, 'deploy/studio-server/scripts/lib/structural-fixture-admission.mjs'))
);
const { parse, stringify } = createRequire(path.join(root, 'package.json'))('yaml');
export function backgroundNodes(kind, milliseconds) {
  assert.ok(['slots', 'cpu'].includes(kind));
  assert.ok(Number.isInteger(milliseconds) && milliseconds >= 1000 && milliseconds <= 1200000);
  const nodes = {
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
  };
  if (kind === 'slots')
    nodes['[tail]:delay "Tail"'] = {
      data: { delay: milliseconds, useDelayInput: false },
      visualData: '400/0/300/null//',
    };
  else
    nodes['[tail]:code "Tail"'] = {
      data: {
        inputNames: ['input1'],
        outputNames: ['output'],
        // Yield before load and between bounded CPU slices: early HTTP responses,
        // heartbeats and debugger messages must remain flushable. No network/I/O.
        code: `const wait=require('node:timers/promises').setTimeout;await wait(1000);const end=Date.now()+${milliseconds};let value=1;while(Date.now()<end){const slice=Math.min(end,Date.now()+20);while(Date.now()<slice)value=Math.sin(value+1);await wait(5)}return {output:{type:'number',value}};`,
      },
      visualData: '400/0/300/null//',
    };
  return nodes;
}
export async function publishBackground(gate, kind, milliseconds, label) {
  assert.match(label, /^[a-z0-9-]{1,50}$/);
  const project = parse(
    await fs.readFile(
      path.join(root, 'deploy/studio-server/scripts/fixtures/managed-release-gate.rivet-project'),
      'utf8',
    ),
  );
  project.data.metadata.id = randomUUID();
  project.data.metadata.title = `Isolated qualification ${label}`;
  delete project.data.uiGraphs;
  project.data.graphs[project.data.metadata.mainGraphId].nodes = backgroundNodes(kind, milliseconds);
  const uploaded = await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/projects/upload', {
    method: 'POST',
    headers: { 'X-Rivet-Namespace-Intent': '1' },
    body: JSON.stringify({
      folderRelativePath: '',
      fileName: `${label}-${project.data.metadata.id}.rivet-project`,
      contents: stringify(project),
      mutation: rootStructuralMutation(),
    }),
  });
  const snapshot = await gate.requestWorkflow(
    gate.config.baseUrl,
    '/api/workflows/projects/web-apps?relativePath=' + encodeURIComponent(uploaded.project.relativePath),
  );
  assert.equal(snapshot.projectId, project.data.metadata.id);
  const endpoint = `qualification-${label}-${project.data.metadata.id}`;
  await gate.requestWorkflow(gate.config.baseUrl, '/api/workflows/projects/publish', {
    method: 'POST',
    body: JSON.stringify({
      relativePath: uploaded.project.relativePath,
      settings: { endpointName: endpoint },
      preconditions: {
        expectedProjectId: snapshot.projectId,
        expectedDraftRevisionId: snapshot.draftRevisionId,
        expectedPublicationVersion: snapshot.publicationVersion,
      },
    }),
  });
  return { endpoint, workflowId: snapshot.projectId, kind, milliseconds };
}
export async function startOwnedBackground(gate, pod, project, count, accepted) {
  assert.ok(ready(pod) && role(pod) === 'execution');
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 3);
  const observed = (await gate.pods()).find((p) => p.metadata.uid === pod.metadata.uid);
  assert.ok(ready(observed));
  assert.equal(observed.metadata.name, pod.metadata.name);
  const marker = randomUUID(),
    request = {
      pod: pod.metadata.name,
      uid: pod.metadata.uid,
      marker,
      workflowId: project.workflowId,
      endpoint: project.endpoint,
      count,
      maximumWorkMs: project.milliseconds + 1000,
      dispatchedAt: new Date().toISOString(),
    };
  accepted.push(request); // Retain uncertain admissions; never retry their POSTs.
  await gate.artifact(`accepted-${marker}-intent.json`, JSON.stringify(request));
  const program = `const results=await Promise.all(Array.from({length:${count}},async(_,i)=>{const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/workflows/'+${JSON.stringify(project.endpoint)},{method:'POST',headers:{authorization:'Bearer '+process.env.RIVET_KEY,'content-type':'application/json'},body:JSON.stringify({input:${JSON.stringify(marker)}+'-'+i}),signal:AbortSignal.timeout(15000)});await r.arrayBuffer();return{status:r.status,correlationId:r.headers.get('x-rivet-correlation-id')}}));console.log(JSON.stringify(results));`;
  const result = await gate.kube([
    'exec',
    pod.metadata.name,
    '-c',
    'api',
    '--',
    'node',
    '--input-type=module',
    '-e',
    program,
  ]);
  request.responses = JSON.parse(result.stdout.trim());
  request.acknowledgedAt = new Date().toISOString();
  await gate.artifact(`accepted-${marker}-ack.json`, JSON.stringify(request));
  assert.equal(request.responses.length, count);
  assert.ok(request.responses.every((r) => r.status === 200 && r.correlationId));
  return request;
}
export async function settleOwnedBackground(gate, accepted, timeoutMs = 1800000) {
  return until(
    'every accepted fixture run durably recorded',
    async () => {
      let pending = false;
      for (const workflowId of new Set(accepted.map((r) => r.workflowId))) {
        const page = await gate.requestWorkflow(
          gate.config.baseUrl,
          `/api/workflows/recordings/workflows/${workflowId}/runs?page=1&pageSize=100&status=all`,
        );
        assert.equal(page.hasMore, false, 'bounded fixture must fit a complete recording page');
        for (const request of accepted.filter((r) => r.workflowId === workflowId)) {
          assert.ok(
            request.responses,
            'uncertain POST admission requires independent reconciliation, not automatic replay',
          );
          for (const response of request.responses) {
            const matches = page.runs.filter((r) => r.executionIdentity?.correlationId === response.correlationId);
            assert.ok(matches.length <= 1, 'duplicate correlation recording');
            if (!matches.length) {
              pending = true;
              continue;
            }
            assert.equal(matches[0].status, 'succeeded');
            request.recordings ??= {};
            request.recordings[response.correlationId] = matches[0].id;
          }
        }
      }
      return !pending;
    },
    timeoutMs,
  );
}
