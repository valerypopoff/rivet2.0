import assert from 'node:assert/strict';
import test from 'node:test';
import { createScheduledRunRequester } from '../dashboard/scheduledRunApi.js';

const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const accepted = () => json({ id: 'schedule', revision: 1 });
function recordRequests(reply: (attempt: number) => Response | Promise<Response>, now?: () => number) {
  const ids: string[] = [];
  let next = 0;
  const request = createScheduledRunRequester({
    now,
    createId: () => `request-${++next}`,
    fetch: async (_input, init) => {
      ids.push(JSON.parse(String(init?.body)).requestId);
      return reply(ids.length);
    },
  });
  return { request, ids };
}

void test('Create, Run now and Retry require validated acknowledgements before retiring identities', async () => {
  const occurrence = { id: 'run', scheduleId: 'schedule', status: 'queued' };
  const invalidOccurrences = [
    { ...occurrence, scheduleId: '' },
    { ...occurrence, scheduleId: 3 },
    { ...occurrence, status: 'unknown' },
  ];
  for (const example of [
    {
      path: '',
      body: { draft: {} },
      valid: { id: 'schedule', revision: 1 },
      invalid: [
        null,
        {},
        { id: '', revision: 1 },
        { id: 3, revision: 1 },
        { id: 'schedule', revision: 0 },
        { id: 'schedule', revision: 1.5 },
      ],
    },
    { path: '/s/run', body: { revision: 1 }, valid: occurrence, invalid: invalidOccurrences },
    { path: '/runs/r/retry', body: { confirmSideEffects: true }, valid: occurrence, invalid: invalidOccurrences },
  ]) {
    const status = example.path ? 202 : 201;
    const invalid = example.invalid.map((value) => json(value, status));
    if (!example.path) invalid.push(new Response(null, { status: 204 }));
    const replies = [...invalid, json(example.valid, status), json(example.valid, status)];
    const { request, ids } = recordRequests(() => replies.shift()!);
    for (const _reply of invalid)
      await assert.rejects(
        request(example.path, 'POST', example.body),
        /invalid acknowledgement/,
        example.path || 'Create',
      );
    assert.deepEqual(await request(example.path, 'POST', example.body), example.valid);
    await request(example.path, 'POST', example.body);
    assert.deepEqual(ids, [...Array(invalid.length + 1).fill('request-1'), 'request-2'], example.path || 'Create');
  }
});

void test(
  'a retired response cannot delete a newer uncertain action with the same intent',
  { timeout: 10_000 },
  async () => {
    let complete!: (value: unknown) => void;
    let entered!: () => void;
    const bodyEntered = new Promise<void>((resolve) => (entered = resolve));
    const retired = accepted();
    retired.json = () => {
      entered();
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    const { request, ids } = recordRequests((attempt) => {
      if (attempt === 1) return retired;
      if (attempt === 3) throw new Error('Lost response');
      return accepted();
    });
    const first = request('', 'POST', { draft: {} });
    await bodyEntered;
    await request('', 'POST', { draft: {} });
    await assert.rejects(request('', 'POST', { draft: {} }), /Lost response/);
    complete({ id: 'schedule', revision: 1 });
    await first;
    await request('', 'POST', { draft: {} });
    assert.deepEqual(ids, ['request-1', 'request-1', 'request-2', 'request-2']);
  },
);

void test('first-attempt HTTP failures distinguish definitive rejection from uncertain outcomes', async () => {
  for (const [status, retained] of [
    [400, false],
    [403, false],
    [408, true],
    [409, true],
    [503, true],
  ] as const) {
    const { request, ids } = recordRequests((attempt) =>
      attempt === 1 ? json({ error: 'Rejected' }, status) : accepted(),
    );
    await assert.rejects(request('', 'POST', { draft: {} }), /Rejected/);
    await request('', 'POST', { draft: {} });
    assert.deepEqual(ids, ['request-1', retained ? 'request-1' : 'request-2'], `HTTP ${status}`);
  }
});

void test(
  'a late rejected attempt cannot retire an identity reused by an uncertain retry',
  { timeout: 10_000 },
  async () => {
    let completeFirst!: (response: Response) => void;
    const { request, ids } = recordRequests((attempt) => {
      if (attempt === 1) return new Promise<Response>((resolve) => (completeFirst = resolve));
      if (attempt === 2) throw new Error('Lost retry acknowledgement');
      return accepted();
    });
    const first = assert.rejects(request('', 'POST', { draft: {} }), /Forbidden/);
    await assert.rejects(request('', 'POST', { draft: {} }), /Lost retry acknowledgement/);
    completeFirst(json({ error: 'Forbidden' }, 403));
    await first;
    await request('', 'POST', { draft: {} });
    assert.deepEqual(ids, ['request-1', 'request-1', 'request-1']);
  },
);

void test('uncertain action age and count limits prohibit unsafe replay without another network request', async () => {
  let now = 0;
  const { request, ids } = recordRequests(
    () => {
      throw new Error('Offline');
    },
    () => now,
  );
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /Offline/);
  now = 86400_000 - 1;
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /Offline/);
  now = 86400_000;
  await assert.rejects(request('/s/run', 'POST', { revision: 1 }), /too old/);
  assert.equal(ids.length, 2);
  for (let i = 1; i < 100; i++) await assert.rejects(request(`/s${i}/run`, 'POST', { revision: 1 }), /Offline/);
  await assert.rejects(request('/another/run', 'POST', { revision: 1 }), /Too many unresolved/);
  assert.equal(ids.length, 101);
});
