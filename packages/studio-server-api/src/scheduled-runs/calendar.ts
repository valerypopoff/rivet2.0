import type { ScheduledRunDraft, RunSchedule } from '../../../studio-server-shared/scheduled-run-types.js';
import { badRequest } from '../utils/httpError.js';

type Wall = { year: number; month: number; day: number; hour: number; minute: number };
const formatter = (zone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
function wall(ms: number, format: Intl.DateTimeFormat): Wall {
  const parts = Object.fromEntries(format.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute! };
}
const utc = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
const same = (a: Wall, b: Wall) =>
  a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;

/** Resolve wall time using both surrounding offsets. Missing DST times have no
 * candidates; repeated times deliberately select only the first occurrence. */
function instants(w: Wall, format: Intl.DateTimeFormat): number[] {
  const approximate = utc(w);
  const candidates = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = approximate + delta * 3_600_000;
    const candidate = approximate - (utc(wall(probe, format)) - probe);
    if (same(wall(candidate, format), w)) candidates.add(candidate);
  }
  return [...candidates].sort((a, b) => a - b);
}
export function nextOccurrence(schedule: RunSchedule, timeZone: string, after: number): number | null {
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchor);
    const period = schedule.minutes * 60_000;
    return anchor > after ? anchor : anchor + (Math.floor((after - anchor) / period) + 1) * period;
  }
  const format = formatter(timeZone);
  if (schedule.kind === 'once') {
    const [year, month, day, hour, minute] = schedule.localTime.split(/\D/).map(Number);
    const choices = instants({ year: year!, month: month!, day: day!, hour: hour!, minute: minute! }, format);
    if (choices.length !== 1)
      throw badRequest('One-time date is nonexistent or ambiguous in this time zone. Choose another time.');
    return choices[0]! > after ? choices[0]! : null;
  }
  const current = wall(after, format);
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let day = 0; day <= 370; day++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + day));
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(date.getUTCDay())) continue;
    if (schedule.kind === 'monthly') {
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      if (date.getUTCDate() !== (schedule.day === 'last' ? last : schedule.day)) continue;
    }
    const choices = instants(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: hour!,
        minute: minute!,
      },
      format,
    );
    if (choices[0] !== undefined && choices[0] > after) return choices[0];
  }
  throw badRequest('Schedule has no occurrence in the next year.');
}
export function validateScheduledRun(value: unknown, now: number): ScheduledRunDraft {
  const v = value as ScheduledRunDraft;
  const fail = (text: string): never => {
    throw badRequest(text);
  };
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Schedule settings are required.');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 120)
    fail('Name must contain 1–120 characters.');
  if (typeof v.description !== 'string' || v.description.length > 2000)
    fail('Description is limited to 2,000 characters.');
  if (typeof v.projectId !== 'string' || !v.projectId.trim() || v.projectId.length > 200)
    fail('Choose a saved project.');
  if (!['latest', 'published'].includes(v.version)) fail('Choose Saved latest or Published.');
  if (typeof v.enabled !== 'boolean' || typeof v.record !== 'boolean')
    fail('Enabled and recording settings must be boolean.');
  if (!Number.isInteger(v.timeoutMinutes) || v.timeoutMinutes < 1 || v.timeoutMinutes > 1440)
    fail('Execution timeout must be 1–1,440 minutes.');
  if (!['skip', 'latest'].includes(v.missed)) fail('Invalid missed-run policy.');
  if (typeof v.timeZone !== 'string' || v.timeZone.length > 100) fail('Choose an IANA time zone.');
  try {
    formatter(v.timeZone).format(now);
  } catch {
    fail('Unknown time zone.');
  }
  if (v.input !== undefined && (!v.input || typeof v.input !== 'object' || Array.isArray(v.input)))
    fail('Input must be a JSON object, or omitted.');
  let serializedInput: string;
  try {
    serializedInput = JSON.stringify(v.input ?? {}, (_key, item) => {
      if (
        (typeof item === 'number' && !Number.isFinite(item)) ||
        ['undefined', 'bigint', 'function', 'symbol'].includes(typeof item)
      )
        throw new Error('Not a JSON value.');
      return item;
    });
  } catch {
    fail('Input must contain only valid JSON values.');
  }
  if (Buffer.byteLength(serializedInput!) > 1024 * 1024) fail('Input is limited to 1 MiB.');
  const s = v.schedule;
  if (!s || !['once', 'interval', 'daily', 'weekly', 'monthly'].includes(s.kind)) fail('Invalid schedule type.');
  if (s.kind === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.localTime)) fail('Choose a one-time date and time.');
    const next = nextOccurrence(s, v.timeZone, now);
    if (v.enabled && next === null) fail('One-time schedule must be in the future.');
  } else if (s.kind === 'interval') {
    if (
      !Number.isInteger(s.minutes) ||
      s.minutes < 1 ||
      s.minutes > 525600 ||
      typeof s.anchor !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s.anchor) ||
      !Number.isFinite(Date.parse(s.anchor))
    )
      fail('Choose an interval of 1–525,600 minutes and an ISO anchor with an explicit UTC offset.');
    // Date.parse normalizes February 30 instead of rejecting it. Compare the
    // literal calendar date independently of the anchor's UTC offset.
    const calendarDate = new Date(`${s.anchor.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== s.anchor.slice(0, 10))
      fail('Interval anchor must contain a real calendar date.');
  } else {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) fail('Use a valid 24-hour time.');
    if (
      s.kind === 'weekly' &&
      (!Array.isArray(s.weekdays) ||
        !s.weekdays.length ||
        s.weekdays.length > 7 ||
        s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    )
      fail('Select weekdays.');
    if (s.kind === 'monthly' && s.day !== 'last' && (!Number.isInteger(s.day) || s.day < 1 || s.day > 31))
      fail('Monthly day must be 1–31 or last.');
  }
  // Construct allowlisted contracts; do not persist caller-owned metadata.
  const schedule: RunSchedule =
    s.kind === 'once'
      ? { kind: s.kind, localTime: s.localTime }
      : s.kind === 'interval'
        ? { kind: s.kind, minutes: s.minutes, anchor: new Date(s.anchor).toISOString() }
        : s.kind === 'weekly'
          ? { kind: s.kind, time: s.time, weekdays: [...new Set(s.weekdays)].sort() }
          : s.kind === 'monthly'
            ? { kind: s.kind, time: s.time, day: s.day }
            : { kind: s.kind, time: s.time };
  return {
    name: v.name.trim(),
    description: v.description,
    projectId: v.projectId,
    version: v.version,
    enabled: v.enabled,
    timeZone: v.timeZone,
    schedule,
    ...(v.input === undefined ? {} : { input: JSON.parse(serializedInput!) }),
    record: v.record,
    timeoutMinutes: v.timeoutMinutes,
    missed: v.missed,
  };
}

/** Find only the latest missed calendar occurrence, with bounded work even after
 * years of downtime. Interval arithmetic never iterates an accumulated backlog. */
export function latestOccurrence(schedule: RunSchedule, zone: string, now: number): number | null {
  if (schedule.kind === 'interval') {
    const anchor = Date.parse(schedule.anchor),
      period = schedule.minutes * 60_000;
    return anchor > now ? null : anchor + Math.floor((now - anchor) / period) * period;
  }
  if (schedule.kind === 'once') return nextOccurrence(schedule, zone, 0);
  const format = formatter(zone),
    current = wall(now, format);
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 370; offset++) {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day - offset));
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(date.getUTCDay())) continue;
    if (schedule.kind === 'monthly') {
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      if (date.getUTCDate() !== (schedule.day === 'last' ? last : schedule.day)) continue;
    }
    const choices = instants(
      {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: hour!,
        minute: minute!,
      },
      format,
    );
    if (choices[0] !== undefined && choices[0] <= now) return choices[0];
  }
  return null;
}
