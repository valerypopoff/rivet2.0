import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostedEvaluationCoordinator } from '../dashboard/hostedEvaluationCoordinator.js';

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('hosted Evaluation coordinator scopes state requests and refuses missing retry targets', async () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/hosted-state')) {
      return jsonResponse({
        status: 'interrupted',
        cancelRequested: false,
        jobs: [
          {
            jobId: 'run-1:case-1:0',
            caseId: 'case-1',
            caseName: 'Case 1',
            caseIndex: 0,
            trialIndex: 0,
            status: 'interrupted',
            attempt: 1,
          },
        ],
      });
    }
    return jsonResponse({ error: 'Hosted Evaluation run not found.' }, { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;

  try {
    const coordinator = createHostedEvaluationCoordinator();
    const state = await coordinator.getRunState({ projectId: 'project-1' as never, runId: 'run-1' });
    assert.deepEqual(state, {
      status: 'interrupted',
      cancelRequested: false,
      jobs: [
        {
          jobId: 'run-1:case-1:0',
          caseId: 'case-1',
          caseName: 'Case 1',
          caseIndex: 0,
          trialIndex: 0,
          status: 'interrupted',
          attempt: 1,
        },
      ],
    });
    assert.match(calls[0].url, /\/evaluation-runs\/run-1\/hosted-state\?projectId=project-1$/u);

    assert.equal(
      await coordinator.retryInterrupted({
        projectId: 'project-1' as never,
        runId: 'run-1',
        jobIds: ['run-1:case-1:0'],
      }),
      undefined,
    );
    assert.equal(calls[1].init?.method, 'POST');
    assert.match(calls[1].url, /\/evaluation-runs\/run-1\/retry-interrupted$/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
