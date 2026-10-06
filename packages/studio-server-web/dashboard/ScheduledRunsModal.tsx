import { useEffect, useRef, useState, type FC } from 'react';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import type {
  ScheduledRun,
  ScheduledRunDraft,
  ScheduledRunList,
  RunSchedule,
} from '../../studio-server-shared/scheduled-run-types';
import type { WorkflowProjectItem } from './types';
import { requestScheduledRuns as request } from './scheduledRunApi';
import './ScheduledRunsModal.css';

const reconnectWarning =
  'The action was accepted, but the updated list could not be loaded. Wait for the list to reconnect; do not repeat the action.';
const describeError = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'The request timed out. Check the refreshed schedule and history before retrying; the server may have accepted the action.'
    : error instanceof Error
      ? error.message
      : 'Could not update scheduled runs.';
const date = (time: number | null | undefined, zone?: string) =>
  time == null
    ? '—'
    : new Date(time).toLocaleString(undefined, zone ? { timeZone: zone, timeZoneName: 'short' } : undefined);
const description = (s: ScheduledRun) => {
  const r = s.schedule;
  if (r.kind === 'once') return `Once: ${r.localTime.replace('T', ' ')}`;
  if (r.kind === 'interval') return `Every ${r.minutes} minutes`;
  if (r.kind === 'daily') return `Daily at ${r.time}`;
  if (r.kind === 'weekly')
    return `${r.weekdays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} at ${r.time}`;
  return `Monthly, ${r.day === 'last' ? 'last day' : `day ${r.day}`} at ${r.time}`;
};

export const ScheduledRunsModal: FC<{
  projects: WorkflowProjectItem[];
  onClose(): void;
  onOpenRecording(id: string): Promise<unknown>;
}> = ({ projects, onClose, onOpenRecording }) => {
  const [data, setData] = useState<ScheduledRunList>({ schedules: [], history: [] });
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [draft, setDraft] = useState<ScheduledRunDraft | null>(null),
    [editing, setEditing] = useState<ScheduledRun | null>(null);
  const [input, setInput] = useState(''),
    [times, setTimes] = useState<number[]>([]);
  const mounted = useRef(true),
    epoch = useRef(0),
    working = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = epoch.current;
      try {
        if (!working.current) {
          const result = await request<ScheduledRunList>('', 'GET', undefined, controller.signal);
          if (!controller.signal.aborted && current === epoch.current) {
            setPollError('');
            setError((current) => (current === reconnectWarning ? '' : current));
            setData(result);
            setLoaded(true);
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted && current === epoch.current) setPollError(describeError(failure));
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  const action = async (operation: () => Promise<unknown>) => {
    if (working.current) return;
    working.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    let acknowledged = false;
    try {
      await operation();
      acknowledged = true;
      const result = await request<ScheduledRunList>();
      if (mounted.current) {
        setData(result);
        setLoaded(true);
      }
    } catch (failure) {
      if (mounted.current) setError(acknowledged ? reconnectWarning : describeError(failure));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const edit = (s?: ScheduledRun) => {
    setEditing(s ?? null);
    setTimes([]);
    setError('');
    setInput(s?.input === undefined ? '' : JSON.stringify(s.input, null, 2));
    setDraft(
      s
        ? structuredClone(s)
        : {
            name: '',
            description: '',
            projectId: projects[0]?.id ?? '',
            version: 'latest',
            enabled: true,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            schedule: { kind: 'daily', time: '10:00' },
            record: true,
            timeoutMinutes: 60,
            missed: 'skip',
          },
    );
  };
  const update = (changes: Partial<ScheduledRunDraft>) => {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    setTimes([]);
  };
  const payload = () => {
    if (!draft) throw new Error('No schedule selected.');
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
  };
  const changeKind = (kind: RunSchedule['kind']) => {
    const time =
      draft?.schedule.kind === 'daily' || draft?.schedule.kind === 'weekly' || draft?.schedule.kind === 'monthly'
        ? draft.schedule.time
        : '10:00';
    const schedule: RunSchedule =
      kind === 'interval'
        ? { kind, minutes: 60, anchor: new Date(Date.now() + 3600000).toISOString() }
        : kind === 'once'
          ? { kind, localTime: '' }
          : kind === 'weekly'
            ? { kind, time, weekdays: [1] }
            : kind === 'monthly'
              ? { kind, time, day: 1 }
              : { kind: 'daily', time };
    update({ schedule });
  };
  return (
    <ModalTransition>
      <ModalDialog width="x-large" onClose={onClose} testId="scheduled-runs-modal">
        <ModalBody>
          <div className="scheduled-runs">
            <div className="scheduled-runs-heading">
              <h2>Scheduled runs</h2>
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
            <p>
              Runs use the saved project’s main graph. The server must be running; this browser can be closed. Unsaved
              editor changes are not used.
            </p>
            {error || pollError ? <div role="alert">{error || pollError}</div> : null}
            {!draft ? (
              <>
                <button type="button" disabled={busy} onClick={() => edit()}>
                  Add scheduled run
                </button>
                {!loaded ? (
                  <p>Loading scheduled runs…</p>
                ) : !data.schedules.length ? (
                  <p>No scheduled runs yet.</p>
                ) : null}
                {data.schedules.map((s) => (
                  <section key={s.id} className="scheduled-run-card">
                    <h3>
                      {s.name}{' '}
                      <small>
                        {s.enabled
                          ? 'Enabled'
                          : s.schedule.kind === 'once' && s.nextAt === null
                            ? 'Paused or completed'
                            : 'Paused'}
                      </small>
                    </h3>
                    {s.description ? <p>{s.description}</p> : null}
                    <p>
                      {projects.find((p) => p.id === s.projectId)?.name ?? `Unavailable project (${s.projectId})`} ·{' '}
                      {s.version === 'latest' ? 'Saved latest' : 'Published'}
                    </p>
                    <p>
                      {description(s)} · {s.timeZone} · Next: {date(s.nextAt, s.timeZone)}
                    </p>
                    <p>Recordings: {s.record ? 'On (requires server recording setting)' : 'Off'}</p>
                    <div className="scheduled-run-buttons">
                      <button disabled={busy} onClick={() => edit(s)}>
                        Edit
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            request(`/${encodeURIComponent(s.id)}`, 'PUT', {
                              revision: s.revision,
                              draft: { ...s, enabled: !s.enabled },
                            }),
                          )
                        }
                      >
                        {s.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            request(`/${encodeURIComponent(s.id)}/run`, 'POST', { revision: s.revision }),
                          )
                        }
                      >
                        Run now
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              'Delete this schedule? Pending work is cancelled; an already-running graph continues.',
                            )
                          )
                            void action(() =>
                              request(`/${encodeURIComponent(s.id)}`, 'DELETE', { revision: s.revision }),
                            );
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </section>
                ))}
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void action(async () => {
                    await request(editing ? `/${encodeURIComponent(editing.id)}` : '', editing ? 'PUT' : 'POST', {
                      draft: payload(),
                      ...(editing ? { revision: editing.revision } : {}),
                    });
                    if (mounted.current) setDraft(null);
                  });
                }}
              >
                <h3>{editing ? 'Edit scheduled run' : 'Add scheduled run'}</h3>
                <fieldset className="scheduled-run-fields" disabled={busy}>
                  <label>
                    Name
                    <input
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    Description (optional)
                    <textarea
                      maxLength={2000}
                      value={draft.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  </label>
                  <label>
                    Project
                    <select required value={draft.projectId} onChange={(e) => update({ projectId: e.target.value })}>
                      <option value="">Choose a project</option>
                      {!projects.some((p) => p.id === draft.projectId) && draft.projectId ? (
                        <option value={draft.projectId}>Unavailable project</option>
                      ) : null}
                      {projects.map((p) => (
                        <option key={p.relativePath} value={p.id}>
                          {p.name} ({p.relativePath})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Version
                    <select
                      value={draft.version}
                      onChange={(e) => update({ version: e.target.value as ScheduledRunDraft['version'] })}
                    >
                      <option value="latest">Saved latest</option>
                      <option value="published">Published</option>
                    </select>
                  </label>
                  <label>
                    Schedule
                    <select
                      value={draft.schedule.kind}
                      onChange={(e) => changeKind(e.target.value as RunSchedule['kind'])}
                    >
                      <option value="once">Once</option>
                      <option value="interval">Interval</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                  </label>
                  <label>
                    Time zone
                    <input
                      required
                      value={draft.timeZone}
                      placeholder="Europe/London"
                      onChange={(e) => update({ timeZone: e.target.value })}
                    />
                  </label>
                  {draft.schedule.kind === 'once' ? (
                    <label>
                      Date and time
                      <input
                        type="datetime-local"
                        required
                        value={draft.schedule.localTime}
                        onChange={(e) => update({ schedule: { kind: 'once', localTime: e.target.value } })}
                      />
                    </label>
                  ) : null}
                  {draft.schedule.kind === 'interval' ? (
                    <>
                      <label>
                        Every (minutes)
                        <input
                          type="number"
                          min={1}
                          max={525600}
                          required
                          value={draft.schedule.minutes}
                          onChange={(e) =>
                            update({
                              schedule: {
                                kind: 'interval',
                                minutes: Number(e.target.value),
                                anchor: draft.schedule.kind === 'interval' ? draft.schedule.anchor : '',
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Anchor (UTC ISO date)
                        <input
                          required
                          value={draft.schedule.anchor}
                          onChange={(e) =>
                            update({
                              schedule: {
                                kind: 'interval',
                                minutes: draft.schedule.kind === 'interval' ? draft.schedule.minutes : 60,
                                anchor: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {'time' in draft.schedule ? (
                    <label>
                      Time
                      <input
                        type="time"
                        required
                        value={draft.schedule.time}
                        onChange={(e) => {
                          if ('time' in draft.schedule)
                            update({ schedule: { ...draft.schedule, time: e.target.value } });
                        }}
                      />
                    </label>
                  ) : null}
                  {draft.schedule.kind === 'weekly' ? (
                    <fieldset>
                      <legend>Weekdays</legend>
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, day) => (
                        <label className="scheduled-run-checkbox" key={day}>
                          <input
                            type="checkbox"
                            checked={draft.schedule.kind === 'weekly' && draft.schedule.weekdays.includes(day)}
                            onChange={(e) => {
                              if (draft.schedule.kind === 'weekly')
                                update({
                                  schedule: {
                                    ...draft.schedule,
                                    weekdays: e.target.checked
                                      ? [...draft.schedule.weekdays, day].sort()
                                      : draft.schedule.weekdays.filter((d) => d !== day),
                                  },
                                });
                            }}
                          />
                          {name}
                        </label>
                      ))}
                    </fieldset>
                  ) : null}
                  {draft.schedule.kind === 'monthly' ? (
                    <label>
                      Day of month
                      <select
                        value={draft.schedule.day}
                        onChange={(e) => {
                          if (draft.schedule.kind === 'monthly')
                            update({
                              schedule: {
                                ...draft.schedule,
                                day: e.target.value === 'last' ? 'last' : Number(e.target.value),
                              },
                            });
                        }}
                      >
                        {Array.from({ length: 31 }, (_, i) => (
                          <option key={i + 1}>{i + 1}</option>
                        ))}
                        <option value="last">Last day</option>
                      </select>
                    </label>
                  ) : null}
                  <label>
                    Missed runs
                    <select
                      value={draft.missed}
                      onChange={(e) => update({ missed: e.target.value as ScheduledRunDraft['missed'] })}
                    >
                      <option value="skip">Skip missed runs</option>
                      <option value="latest">Catch up latest only</option>
                    </select>
                  </label>
                  <label>
                    Timeout (minutes)
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      required
                      value={draft.timeoutMinutes}
                      onChange={(e) => update({ timeoutMinutes: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Input JSON object (optional)
                    <textarea
                      rows={5}
                      value={input}
                      placeholder="Leave blank to use Graph Input defaults; {} sends an empty object."
                      onChange={(e) => {
                        setInput(e.target.value);
                        setTimes([]);
                      }}
                    />
                  </label>
                  <label className="scheduled-run-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => update({ enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  <label className="scheduled-run-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.record}
                      onChange={(e) => update({ record: e.target.checked })}
                    />
                    Record these runs (requires server recording setting)
                  </label>
                </fieldset>
                <p>
                  Recurring missing DST times are skipped; repeated times run once. Days absent from a month are
                  skipped. Previous pending/running occurrences never overlap.
                </p>
                <div className="scheduled-run-buttons">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = await request<{ times: number[] }>('/preview', 'POST', payload());
                        if (mounted.current) setTimes(result.times);
                      })
                    }
                  >
                    Preview next runs
                  </button>
                  <button type="submit" disabled={busy}>
                    {busy ? 'Saving…' : 'Save schedule'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setDraft(null)}>
                    Cancel editing
                  </button>
                </div>
                {times.length ? (
                  <ul aria-label="Next runs">
                    {times.map((t) => (
                      <li key={t}>{date(t, draft.timeZone)}</li>
                    ))}
                  </ul>
                ) : null}
              </form>
            )}
            <h3>Recent runs</h3>
            <p>
              History is separate from recordings. Failed or interrupted runs are not automatically retried because
              external side effects may already have happened.
            </p>
            {data.history.slice(0, 100).map((run) => (
              <section className="scheduled-run-card" key={run.id}>
                <strong>{run.name}</strong> · {run.status} · {date(run.scheduledAt)}
                {run.reason ? <p>{run.reason}</p> : null}
                {run.recordingStatus === 'unavailable' ? (
                  <p>Recording unavailable. The execution result is unchanged.</p>
                ) : null}
                <div className="scheduled-run-buttons">
                  {run.recordingId ? (
                    <button disabled={busy} onClick={() => void action(() => onOpenRecording(run.recordingId!))}>
                      Open recording
                    </button>
                  ) : null}
                  {['queued', 'claimed', 'running'].includes(run.status) ? (
                    <button
                      disabled={busy || run.cancelRequested}
                      onClick={() =>
                        void action(() => request(`/runs/${encodeURIComponent(run.id)}/cancel`, 'POST', {}))
                      }
                    >
                      {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
                    </button>
                  ) : null}
                  {['failed', 'interrupted'].includes(run.status) &&
                  data.schedules.some((s) => s.id === run.scheduleId) ? (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Retry may repeat external side effects. Check what happened before retrying. Continue?',
                          )
                        )
                          void action(() =>
                            request(`/runs/${encodeURIComponent(run.id)}/retry`, 'POST', { confirmSideEffects: true }),
                          );
                      }}
                    >
                      Retry run
                    </button>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
