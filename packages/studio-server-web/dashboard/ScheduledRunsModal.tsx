import { useEffect, useRef, useState, type FC, type ReactNode, type MouseEvent } from 'react';
import Button from '@atlaskit/button';
import Checkbox from '@atlaskit/checkbox';
import Select from '@atlaskit/select';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import DeleteBinIcon from 'majesticons/line/delete-bin-line.svg?react';
import type {
  ScheduledRun,
  ScheduledRunDraft,
  ScheduledRunList,
  RunSchedule,
} from '../../studio-server-shared/scheduled-run-types';
import type { WorkflowProjectItem } from './types';
import { requestScheduledRuns as request } from './scheduledRunApi';
import { ScheduledProjectSelect } from './ScheduledProjectSelect';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import './ScheduledRunsModal.css';

function ScheduleButton({
  disabled,
  primary,
  children,
  type = 'button',
  onClick,
}: {
  disabled?: boolean;
  primary?: boolean;
  children: ReactNode;
  type?: 'button' | 'submit';
  onClick?(event: MouseEvent<HTMLElement>): void;
}) {
  return (
    <Button
      onClick={onClick}
      type={type}
      isDisabled={disabled}
      appearance={primary ? 'primary' : 'subtle'}
      className={`scheduled-run-action button-size-l${primary ? ' scheduled-run-primary' : ''}`}
    >
      {children}
    </Button>
  );
}

function ScheduleSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
  onMenuChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled: boolean;
  onChange(value: string): void;
  onMenuChange(id: string, open: boolean): void;
}) {
  return (
    <div className="scheduled-run-field">
      <label htmlFor={id}>{label}</label>
      <Select
        inputId={id}
        onMenuOpen={() => onMenuChange(id, true)}
        onMenuClose={() => onMenuChange(id, false)}
        options={options}
        value={options.find((option) => option.value === value)}
        isDisabled={disabled}
        isSearchable={false}
        menuPlacement="auto"
        classNamePrefix="scheduled-select"
        onChange={(option) => {
          if (option) onChange(option.value);
        }}
      />
    </div>
  );
}

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
  onEnabledCountChange(count: number): void;
}> = ({ projects, onClose, onOpenRecording, onEnabledCountChange }) => {
  const [data, setData] = useState<ScheduledRunList>({ schedules: [], history: [] });
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [historyPage, setHistoryPage] = useState(1);
  const historyPages = Math.max(1, Math.ceil(data.history.length / historyPageSize));
  const currentHistoryPage = Math.min(historyPage, historyPages);
  useEffect(() => {
    setHistoryPage((current) => Math.min(current, historyPages));
  }, [historyPages]);
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [listForeground, setListForeground] = useState(true);
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const trackSelect = (id: string, open: boolean) =>
    setOpenSelect((current) => (open ? id : current === id ? null : current));
  const [draft, setDraft] = useState<ScheduledRunDraft | null>(null),
    [editing, setEditing] = useState<ScheduledRun | null>(null);
  const [input, setInput] = useState(''),
    [times, setTimes] = useState<number[]>([]);
  const initialForm = useRef('');
  const dirty = draft !== null && JSON.stringify({ draft, input }) !== initialForm.current;
  const mounted = useRef(true),
    epoch = useRef(0),
    working = useRef(false);
  const editorOpener = useRef<HTMLElement | null>(null);
  const listClose = useRef<HTMLButtonElement>(null);
  const editorContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) editorContent.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  useEffect(() => {
    if (draft || busy || !listForeground || !editorOpener.current) return;
    // The list's focus lock reactivates when the editor leaves the modal stack.
    // Restore its originating control after that reactivation, not before it.
    const frame = requestAnimationFrame(() => {
      const target = editorOpener.current;
      (target?.isConnected ? target : listClose.current)?.focus();
      editorOpener.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [draft, busy, listForeground]);
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
            onEnabledCountChange(result.schedules.filter((schedule) => schedule.enabled).length);
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
  }, [onEnabledCountChange]);
  const action = async (operation: () => Promise<unknown>, refresh = true) => {
    if (working.current) return;
    working.current = true;
    epoch.current++;
    setBusy(true);
    setError('');
    let acknowledged = false;
    try {
      await operation();
      if (!refresh) return;
      acknowledged = true;
      const result = await request<ScheduledRunList>();
      if (mounted.current) {
        setData(result);
        onEnabledCountChange(result.schedules.filter((schedule) => schedule.enabled).length);
        setLoaded(true);
        setPollError('');
      }
    } catch (failure) {
      if (mounted.current) setError(acknowledged ? reconnectWarning : describeError(failure));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const edit = (s: ScheduledRun | undefined, opener: HTMLElement) => {
    editorOpener.current = opener;
    setOpenSelect(null);
    setEditing(s ?? null);
    setTimes([]);
    setError('');
    const initialInput = s?.input === undefined ? '' : JSON.stringify(s.input, null, 2);
    const initialDraft: ScheduledRunDraft = s
      ? structuredClone(s)
      : {
          name: '',
          description: '',
          projectId: projects.find((project) => project.projectMetadataId)?.projectMetadataId ?? '',
          version: 'latest',
          enabled: true,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          schedule: { kind: 'daily', time: '10:00' },
          record: true,
          timeoutMinutes: 60,
          missed: 'skip',
        };
    initialForm.current = JSON.stringify({ draft: initialDraft, input: initialInput });
    setInput(initialInput);
    setDraft(initialDraft);
  };
  const update = (changes: Partial<ScheduledRunDraft>) => {
    setDraft((d) => (d ? { ...d, ...changes } : d));
    setTimes([]);
  };
  const payload = () => {
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
  const closeEditor = () => {
    if (working.current) return;
    setDraft(null);
    setOpenSelect(null);
    setError('');
  };
  return (
    <ModalTransition>
      <ModalDialog
        label="Scheduled runs"
        onClose={onClose}
        onStackChange={(index) => setListForeground(index === 0)}
        shouldCloseOnEscapePress={!draft}
        testId="scheduled-runs-modal"
      >
        <ModalBody>
          <div className="scheduled-runs" aria-busy={busy}>
            <div className="scheduled-runs-heading project-settings-modal-header-row">
              <h2>Scheduled runs</h2>
              <button
                ref={listClose}
                type="button"
                className="project-settings-close-button"
                aria-label="Close"
                onClick={onClose}
              >
                ×
              </button>
            </div>
            <div className="scheduled-runs-content">
              <p className="scheduled-runs-help">
                Runs use the saved project’s main graph. The server must be running; this browser can be closed. Unsaved
                editor changes are not used.
              </p>
              {!draft && (error || pollError) ? <div role="alert">{error || pollError}</div> : null}
              <ScheduleButton primary disabled={busy} onClick={(event) => edit(undefined, event.currentTarget)}>
                + Add scheduled run
              </ScheduleButton>
              {!loaded ? <p>Loading scheduled runs…</p> : !data.schedules.length ? <p>No scheduled runs yet.</p> : null}
              {data.schedules.map((s) => (
                <section key={s.id} className={`scheduled-run-card${s.enabled ? '' : ' scheduled-run-card--paused'}`}>
                  <div className="scheduled-run-header">
                    <h3>
                      {s.name}{' '}
                      {!s.enabled ? (
                        <small>
                          {s.schedule.kind === 'once' && s.nextAt === null ? 'Paused or completed' : 'Paused'}
                        </small>
                      ) : null}
                    </h3>
                    <button
                      type="button"
                      className="scheduled-run-delete"
                      aria-label={`Delete schedule ${s.name}`}
                      title="Delete schedule"
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
                      <DeleteBinIcon aria-hidden="true" />
                    </button>
                  </div>
                  {s.description ? <p>{s.description}</p> : null}
                  <p>
                    {projects.find((p) => p.projectMetadataId === s.projectId)?.name ??
                      `Unavailable project (${s.projectId})`}{' '}
                    · {s.version === 'latest' ? 'Saved latest' : 'Published'}
                  </p>
                  <p>
                    {description(s)} · {s.timeZone} · Next: {date(s.nextAt, s.timeZone)}
                  </p>
                  <p>Recordings: {s.record ? 'On (requires server recording setting)' : 'Off'}</p>
                  <div className="scheduled-run-buttons">
                    <ScheduleButton disabled={busy} onClick={(event) => edit(s, event.currentTarget)}>
                      Edit
                    </ScheduleButton>
                    <ScheduleButton
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
                      {s.enabled ? 'Pause' : 'Unpause'}
                    </ScheduleButton>
                    <ScheduleButton
                      disabled={busy}
                      onClick={() =>
                        void action(() => request(`/${encodeURIComponent(s.id)}/run`, 'POST', { revision: s.revision }))
                      }
                    >
                      Run now
                    </ScheduleButton>
                  </div>
                </section>
              ))}
              <details className="scheduled-run-history">
                <summary>Recent runs ({data.history.length})</summary>
                <p>
                  History is separate from recordings. Failed or interrupted runs are not automatically retried because
                  external side effects may already have happened.
                </p>
                {data.history.length > 0 ? (
                  <div className="scheduled-run-history-controls">
                    <span className="scheduled-run-history-label">Per page</span>
                    <SegmentedControl label="Recent runs per page">
                      {[10, 20, 50, 100].map((size) => (
                        <SegmentedControlButton
                          key={size}
                          selected={historyPageSize === size}
                          onClick={() => {
                            if (historyPageSize === size) return;
                            setHistoryPageSize(size);
                            setHistoryPage(1);
                          }}
                        >
                          {size}
                        </SegmentedControlButton>
                      ))}
                    </SegmentedControl>
                  </div>
                ) : null}
                {loaded && !data.history.length ? <p>No recent runs yet.</p> : null}
                {data.history
                  .slice((currentHistoryPage - 1) * historyPageSize, currentHistoryPage * historyPageSize)
                  .map((run) => (
                    <section className="scheduled-run-card" key={run.id}>
                      <strong>{run.name}</strong> · {run.status} · {date(run.scheduledAt)}
                      {run.reason ? <p>{run.reason}</p> : null}
                      {run.recordingStatus === 'unavailable' ? (
                        <p>Recording unavailable. The execution result is unchanged.</p>
                      ) : null}
                      <div className="scheduled-run-buttons">
                        {run.recordingId ? (
                          <a
                            href="#"
                            className="scheduled-run-recording-link"
                            aria-disabled={busy}
                            tabIndex={busy ? -1 : undefined}
                            onClick={(event) => {
                              event.preventDefault();
                              if (!busy) void action(() => onOpenRecording(run.recordingId!), false);
                            }}
                          >
                            Open recording
                          </a>
                        ) : null}
                        {['queued', 'claimed', 'running'].includes(run.status) ? (
                          <ScheduleButton
                            disabled={busy || run.cancelRequested}
                            onClick={() =>
                              void action(() => request(`/runs/${encodeURIComponent(run.id)}/cancel`, 'POST', {}))
                            }
                          >
                            {run.cancelRequested ? 'Cancelling…' : 'Cancel run'}
                          </ScheduleButton>
                        ) : null}
                        {['failed', 'interrupted'].includes(run.status) &&
                        data.schedules.some((s) => s.id === run.scheduleId) ? (
                          <ScheduleButton
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  'Retry may repeat external side effects. Check what happened before retrying. Continue?',
                                )
                              )
                                void action(() =>
                                  request(`/runs/${encodeURIComponent(run.id)}/retry`, 'POST', {
                                    confirmSideEffects: true,
                                  }),
                                );
                            }}
                          >
                            Retry run
                          </ScheduleButton>
                        ) : null}
                      </div>
                    </section>
                  ))}
                {historyPages > 1 ? (
                  <nav className="scheduled-run-history-pagination" aria-label="Recent runs pages">
                    <button
                      type="button"
                      onClick={() => setHistoryPage(currentHistoryPage - 1)}
                      disabled={currentHistoryPage === 1}
                    >
                      Previous
                    </button>
                    <span role="status" aria-live="polite" aria-atomic="true">
                      Page {currentHistoryPage} of {historyPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setHistoryPage(currentHistoryPage + 1)}
                      disabled={currentHistoryPage === historyPages}
                    >
                      Next
                    </button>
                  </nav>
                ) : null}
              </details>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
      {draft && (
        <ModalDialog
          label={editing ? 'Edit scheduled run' : 'Add scheduled run'}
          testId="scheduled-run-editor-modal"
          onClose={closeEditor}
          shouldReturnFocus={false}
          shouldCloseOnEscapePress={!busy && openSelect === null}
          shouldCloseOnOverlayClick={!busy}
        >
          <ModalBody>
            <div
              className="scheduled-runs"
              aria-busy={busy}
              onKeyDown={(event) => {
                // Dismissing a select must not also dismiss its parent dialog.
                if (event.key === 'Escape' && openSelect !== null) event.stopPropagation();
              }}
            >
              <div className="scheduled-runs-heading project-settings-modal-header-row">
                <h2>{editing ? 'Edit scheduled run' : 'Add scheduled run'}</h2>
                <button
                  type="button"
                  className="project-settings-close-button"
                  aria-label="Close"
                  disabled={busy}
                  onClick={closeEditor}
                >
                  ×
                </button>
              </div>
              <form
                className="scheduled-run-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!dirty) return;
                  void action(async () => {
                    await request(editing ? `/${encodeURIComponent(editing.id)}` : '', editing ? 'PUT' : 'POST', {
                      draft: payload(),
                      ...(editing ? { revision: editing.revision } : {}),
                    });
                    if (mounted.current) setDraft(null);
                  });
                }}
              >
                <div className="scheduled-runs-content" ref={editorContent}>
                  {error ? <div role="alert">{error}</div> : null}
                  <fieldset
                    className="scheduled-run-fields"
                    disabled={busy}
                    aria-labelledby="scheduled-run-details-heading"
                  >
                    <h4 id="scheduled-run-details-heading" className="scheduled-run-section-title">
                      Project and details
                    </h4>
                    <label>
                      Name
                      <input
                        required
                        maxLength={120}
                        value={draft.name}
                        onChange={(e) => update({ name: e.target.value })}
                      />
                    </label>
                    <div className="scheduled-run-field">
                      <label htmlFor="scheduled-run-project">Project</label>
                      <ScheduledProjectSelect
                        projects={projects}
                        onMenuChange={trackSelect}
                        value={draft.projectId}
                        disabled={busy}
                        onChange={(projectId) => update({ projectId })}
                      />
                    </div>
                    <label>
                      Description (optional)
                      <textarea
                        maxLength={2000}
                        value={draft.description}
                        onChange={(e) => update({ description: e.target.value })}
                      />
                    </label>
                    <ScheduleSelect
                      id="scheduled-run-version"
                      onMenuChange={trackSelect}
                      label="Version"
                      disabled={busy}
                      value={draft.version}
                      onChange={(version) => update({ version: version as ScheduledRunDraft['version'] })}
                      options={[
                        { value: 'latest', label: 'Saved latest' },
                        { value: 'published', label: 'Published' },
                      ]}
                    />
                  </fieldset>
                  <fieldset
                    className="scheduled-run-fields"
                    disabled={busy}
                    aria-labelledby="scheduled-run-timing-heading"
                  >
                    <h4 id="scheduled-run-timing-heading" className="scheduled-run-section-title">
                      When to run
                    </h4>
                    <ScheduleSelect
                      id="scheduled-run-kind"
                      onMenuChange={trackSelect}
                      label="Schedule"
                      disabled={busy}
                      value={draft.schedule.kind}
                      onChange={(kind) => changeKind(kind as RunSchedule['kind'])}
                      options={['once', 'interval', 'daily', 'weekly', 'monthly'].map((kind) => ({
                        value: kind,
                        label: kind[0]!.toUpperCase() + kind.slice(1),
                      }))}
                    />
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
                      <fieldset className="scheduled-run-weekdays scheduled-run-wide">
                        <legend>Weekdays</legend>
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((name, day) => (
                          <Checkbox
                            key={day}
                            label={name}
                            isDisabled={busy}
                            isChecked={draft.schedule.kind === 'weekly' && draft.schedule.weekdays.includes(day)}
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
                        ))}
                      </fieldset>
                    ) : null}
                    {draft.schedule.kind === 'monthly' ? (
                      <ScheduleSelect
                        id="scheduled-run-month-day"
                        onMenuChange={trackSelect}
                        label="Day of month"
                        disabled={busy}
                        value={String(draft.schedule.day)}
                        onChange={(value) => {
                          if (draft.schedule.kind === 'monthly')
                            update({
                              schedule: {
                                ...draft.schedule,
                                day: value === 'last' ? 'last' : Number(value),
                              },
                            });
                        }}
                        options={[
                          ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
                          { value: 'last', label: 'Last day' },
                        ]}
                      />
                    ) : null}
                    {['daily', 'weekly', 'monthly'].includes(draft.schedule.kind) ? (
                      <p className="scheduled-runs-help scheduled-run-wide scheduled-run-timing-notes">
                        Missing daylight-saving times are skipped; repeated times run once.
                        {draft.schedule.kind === 'monthly' &&
                        draft.schedule.day !== 'last' &&
                        draft.schedule.day > 28 ? (
                          <> Months without the selected day are skipped.</>
                        ) : null}
                      </p>
                    ) : null}
                  </fieldset>
                  <fieldset
                    className="scheduled-run-fields"
                    disabled={busy}
                    aria-labelledby="scheduled-run-execution-heading"
                  >
                    <h4 id="scheduled-run-execution-heading" className="scheduled-run-section-title">
                      Execution
                    </h4>
                    <ScheduleSelect
                      id="scheduled-run-missed"
                      onMenuChange={trackSelect}
                      label="Missed runs"
                      disabled={busy}
                      value={draft.missed}
                      onChange={(missed) => update({ missed: missed as ScheduledRunDraft['missed'] })}
                      options={[
                        { value: 'skip', label: 'Skip missed runs' },
                        { value: 'latest', label: 'Catch up latest only' },
                      ]}
                    />
                    <label>
                      Maximum run duration (minutes)
                      <input
                        title="Includes preparation. When this limit is reached, the server cancels the run."
                        type="number"
                        min={1}
                        max={1440}
                        required
                        value={draft.timeoutMinutes}
                        onChange={(e) => update({ timeoutMinutes: Number(e.target.value) })}
                      />
                    </label>
                    <label className="scheduled-run-wide">
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
                    <div className="scheduled-run-toggles scheduled-run-wide">
                      <Checkbox
                        label="Record these runs (requires server recording setting)"
                        isDisabled={busy}
                        isChecked={draft.record}
                        onChange={(e) => update({ record: e.target.checked })}
                      />
                    </div>
                    <p className="scheduled-runs-help scheduled-run-wide scheduled-run-overlap-note">
                      A run is skipped if a previous run from this schedule is still pending or running.
                    </p>
                  </fieldset>
                  {times.length ? (
                    <ul aria-label="Next runs">
                      {times.map((t) => (
                        <li key={t}>{date(t, draft.timeZone)}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="scheduled-run-footer">
                  <ScheduleButton
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const result = await request<{ times: number[] }>('/preview', 'POST', payload());
                        if (mounted.current) setTimes(result.times);
                      }, false)
                    }
                  >
                    Preview next runs
                  </ScheduleButton>
                  <ScheduleButton primary type="submit" disabled={busy || !dirty}>
                    Save
                  </ScheduleButton>
                </div>
              </form>
            </div>
          </ModalBody>
        </ModalDialog>
      )}
    </ModalTransition>
  );
};
