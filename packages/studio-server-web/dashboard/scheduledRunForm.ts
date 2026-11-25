import type { RunSchedule, ScheduledRunDraft } from '../../studio-server-shared/scheduled-run-types';

export function scheduledRunPayload(draft: ScheduledRunDraft | null, input: string) {
  if (!draft) throw new Error('No schedule selected.');
  if (!draft.projectId) throw new Error('Choose a project.');
  const { input: previous, ...rest } = draft;
  if (!input.trim()) return rest;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('Input must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Input must be a JSON object.');
  return { ...rest, input: value };
}

export function scheduleForKind(
  previous: RunSchedule | undefined,
  kind: RunSchedule['kind'],
  now: number,
): RunSchedule {
  const time =
    previous?.kind === 'daily' || previous?.kind === 'weekly' || previous?.kind === 'monthly' ? previous.time : '10:00';
  return kind === 'interval'
    ? { kind, minutes: 60, anchor: new Date(now + 3600000).toISOString() }
    : kind === 'once'
      ? { kind, localTime: '' }
      : kind === 'weekly'
        ? { kind, time, weekdays: [1] }
        : kind === 'monthly'
          ? { kind, time, day: 1 }
          : { kind: 'daily', time };
}
