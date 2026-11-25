import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunSchedule, ScheduledRunDraft } from '../../studio-server-shared/scheduled-run-types';
import { scheduledRunPayload, scheduleForKind } from '../dashboard/scheduledRunForm';

const draft: ScheduledRunDraft = {
  name: 'Work',
  description: '',
  projectId: 'project',
  version: 'latest',
  enabled: false,
  timeZone: 'UTC',
  schedule: { kind: 'daily', time: '09:30' },
  record: true,
  timeoutMinutes: 60,
  missed: 'skip',
};

void test('input text distinguishes omission from an explicit object without changing the draft', () => {
  const saved = { ...draft, input: { old: true } };
  const before = structuredClone(saved);
  for (const input of ['', ' \n\t ']) assert.deepEqual(scheduledRunPayload(saved, input), draft);
  assert.deepEqual(scheduledRunPayload(saved, '{}'), { ...draft, input: {} });
  assert.deepEqual(scheduledRunPayload(saved, '{"nested":{"score":0},"enabled":false}'), {
    ...draft,
    input: { nested: { score: 0 }, enabled: false },
  });
  assert.deepEqual(saved, before);
});

void test('payload validation retains diagnostic order and rejects malformed and non-object JSON', () => {
  assert.throws(() => scheduledRunPayload(null, '['), { message: 'No schedule selected.' });
  assert.throws(() => scheduledRunPayload({ ...draft, projectId: '' }, '['), { message: 'Choose a project.' });
  assert.throws(() => scheduledRunPayload(draft, '['), { message: 'Input must be valid JSON.' });
  for (const input of ['null', '[]', '0', 'true', '"text"'])
    assert.throws(() => scheduledRunPayload(draft, input), { message: 'Input must be a JSON object.' });
});

void test('editing preserves returned fields and wire order while replacing only the old input', () => {
  const saved = { id: 'schedule', input: { old: true }, revision: 7, ...draft, nextAt: null };
  const before = structuredClone(saved);
  assert.equal(
    JSON.stringify(scheduledRunPayload(saved, '{"new":1}')),
    JSON.stringify({
      id: 'schedule',
      revision: 7,
      ...draft,
      nextAt: null,
      input: { new: 1 },
    }),
  );
  assert.deepEqual(saved, before);
});

void test('kind changes retain only calendar time and use an event-time interval anchor', () => {
  const now = Date.UTC(2026, 10, 25);
  const previous: Array<RunSchedule | undefined> = [
    undefined,
    { kind: 'once', localTime: '2026-11-26T12:00' },
    { kind: 'interval', minutes: 5, anchor: 'old' },
    { kind: 'daily', time: '09:30' },
    { kind: 'weekly', time: '09:30', weekdays: [0, 3] },
    { kind: 'monthly', time: '09:30', day: 'last' },
  ];
  const before = structuredClone(previous);
  for (const schedule of previous) {
    const time = schedule && 'time' in schedule ? '09:30' : '10:00';
    assert.deepEqual(scheduleForKind(schedule, 'once', now), { kind: 'once', localTime: '' });
    assert.deepEqual(scheduleForKind(schedule, 'interval', now), {
      kind: 'interval',
      minutes: 60,
      anchor: '2026-11-25T01:00:00.000Z',
    });
    assert.deepEqual(scheduleForKind(schedule, 'daily', now), { kind: 'daily', time });
    assert.deepEqual(scheduleForKind(schedule, 'weekly', now), { kind: 'weekly', time, weekdays: [1] });
    assert.deepEqual(scheduleForKind(schedule, 'monthly', now), { kind: 'monthly', time, day: 1 });
  }
  assert.deepEqual(previous, before);
});
