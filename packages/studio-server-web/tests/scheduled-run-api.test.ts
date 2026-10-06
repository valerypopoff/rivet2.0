import assert from 'node:assert/strict';
import test from 'node:test';
import { createScheduledRunRequester } from '../dashboard/scheduledRunApi.js';

const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const accepted = () => json({ id: 'schedule', revision: 1 });
const body = (init?: RequestInit) => JSON.parse(String(init?.body));

test('uncertain or malformed acknowledgements retain the request identity until validated success', async () => {
  const replies = [json({}), json(null), new Response(null, { status: 204 }), accepted(), accepted()];
  const ids: string[] = [];
  let next = 0;
  const request = createScheduledRunRequester({
    createId: () => `request-${++next}`,
    fetch: async (_input, init) => {
      ids.push(body(init).requestId);
      return replies.shift()!;
    },
  });
  for (let i = 0; i < 3; i++) await assert.rejects(request('', 'POST', { draft: {} }), /invalid acknowledgement/);
  await request('', 'POST', { draft: {} });
  await request('', 'POST', { draft: {} });
  assert.deepEqual(ids, ['request-1', 'request-1', 'request-1', 'request-1', 'request-2']);
});

test('a retired response cannot delete a newer uncertain action with the same intent', async () => {
  let complete!: (value: unknown) => void;
  const retired = accepted();
  retired.json = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const ids: string[] = [];
  let next = 0;
  const request = createScheduledRunRequester({
    createId: () => `request-${++next}`,
    fetch: async (_input, init) => {
      ids.push(body(init).requestId);
      if (ids.length === 1) return retired;
      if (ids.length === 3) throw new Error('Lost response');
      return accepted();
    },
  });
  const first = request('', 'POST', { draft: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await request('', 'POST', { draft: {} });
  await assert.rejects(request('', 'POST', { draft: {} }), /Lost response/);
  complete({ id: 'schedule', revision: 1 });
  await first;
  await request('', 'POST', { draft: {} });
  assert.deepEqual(ids, ['request-1', 'request-1', 'request-2', 'request-2']);
});

test('Run now and Retry validate occurrence acknowledgements; definite rejection releases only its own key', async () => {
  const replies = [
    json({ id: 'run' }, 202),
    json({ error: 'Conflict' }, 409),
    json({ error: 'Bad request' }, 400),
    json({ id: 'run', scheduleId: 'schedule', status: 'queued' }, 202),
    json({ id: 'retry', scheduleId: 'schedule', status: 'queued' }, 202),
  ];
  const ids: string[] = [];
  let next = 0;
  const request = createScheduledRunRequester({
    createId: () => `request-${++next}`,
    fetch: async (_input, init) => {
      ids.push(body(init).requestId);
      return replies.shift()!;
    },
  });
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /invalid acknowledgement/);
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /Conflict/);
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /Bad request/);
  await request('/s/run', 'POST', { revision: 1 });
  await request('/runs/r/retry', 'POST', { confirmSideEffects: true });
  assert.deepEqual(ids, ['request-1', 'request-1', 'request-1', 'request-2', 'request-3']);
});

test('uncertain action age and count limits prohibit unsafe replay without another network request', async () => {
  let now = 0,
    sends = 0;
  const request = createScheduledRunRequester({
    now: () => now,
    createId: () => String(sends),
    fetch: async () => {
      sends++;
      throw new Error('Offline');
    },
  });
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /Offline/);
  now = 86400_000;
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /too old/);
  assert.equal(sends, 1);
  for (let i = 1; i < 100; i++) await assert.rejects(request(`/s${i}/run`, 'POST', { revision: 1 }), /Offline/);
  await assert.rejects(request('/another/run', 'POST', { revision: 1 }), /Too many unresolved/);
  assert.equal(sends, 100);
});
