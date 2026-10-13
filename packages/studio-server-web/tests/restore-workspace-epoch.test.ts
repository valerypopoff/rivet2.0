import assert from 'node:assert/strict';
import test from 'node:test';
import { bindRestoreWorkspaceEpoch } from '../restore-workspace-epoch';

test('document epoch preserves request headers and bodies without leaking to other origins', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const browser = {
    location: new URL('https://rivet.test/?editor'),
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response();
    },
  };
  bindRestoreWorkspaceEpoch('restore-a', browser as never);
  await browser.fetch('/api/projects/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get('X-Rivet-Workspace-Epoch'), 'restore-a');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(requests[0]?.init?.body, '{}');
  await browser.fetch(new Request('https://rivet.test/api/projects/save', { headers: { 'X-Original': 'yes' } }), {
    headers: { 'X-Override': 'yes' },
  });
  const combined = new Headers(requests[1]?.init?.headers);
  assert.equal(
    combined.get('X-Original'),
    null,
    'RequestInit headers must replace Request headers, as in native fetch',
  );
  assert.equal(combined.get('X-Override'), 'yes');
  await browser.fetch('https://provider.test/api/chat', { headers: { Authorization: 'secret' } });
  assert.equal(new Headers(requests[2]?.init?.headers).has('X-Rivet-Workspace-Epoch'), false);
});
