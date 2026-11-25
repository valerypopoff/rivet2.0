import { useEffect, useRef, useState } from 'react';
import type {
  RunSchedule,
  ScheduledRun,
  ScheduledRunDraft,
  ScheduledRunList,
} from '../../studio-server-shared/scheduled-run-types';
import type { WorkflowProjectItem } from './types';
import { requestScheduledRuns as request } from './scheduledRunApi';
import { scheduledRunPayload, scheduleForKind } from './scheduledRunForm';

const reconnectWarning =
  'The action was accepted, but the updated list could not be loaded. Wait for the list to reconnect; do not repeat the action.';
const describeError = (error: unknown) =>
  error instanceof Error && error.name === 'TimeoutError'
    ? 'The request timed out. Check the refreshed schedule and history before retrying; the server may have accepted the action.'
    : error instanceof Error
      ? error.message
      : 'Could not update scheduled runs.';

export function useScheduledRunsController({
  projects,
  onOpenRecording,
  onEnabledCountChange,
}: {
  projects: WorkflowProjectItem[];
  onOpenRecording(id: string): Promise<unknown>;
  onEnabledCountChange(count: number): void;
}) {
  const [data, setData] = useState<ScheduledRunList>({ schedules: [], history: [] });
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [draft, setDraft] = useState<ScheduledRunDraft | null>(null),
    [editing, setEditing] = useState<ScheduledRun | null>(null);
  const [input, setInput] = useState(''),
    [times, setTimes] = useState<number[]>([]);
  const initialForm = useRef('');
  const dirty = draft !== null && JSON.stringify({ draft, input }) !== initialForm.current;
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
  const openEditor = (s: ScheduledRun | undefined) => {
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
  const changeKind = (kind: RunSchedule['kind']) => {
    update({ schedule: scheduleForKind(draft?.schedule, kind, kind === 'interval' ? Date.now() : 0) });
  };
  const closeEditor = () => {
    if (working.current) return false;
    setDraft(null);
    setError('');
    return true;
  };
  const updateInput = (value: string) => {
    setInput(value);
    setTimes([]);
  };
  return {
    state: { data, loaded, busy, error, pollError, draft, editing, input, times, dirty },
    actions: {
      openEditor,
      closeEditor,
      updateDraft: update,
      updateInput,
      changeKind,
      save: () =>
        action(async () => {
          await request(editing ? '/' + encodeURIComponent(editing.id) : '', editing ? 'PUT' : 'POST', {
            draft: scheduledRunPayload(draft, input),
            ...(editing ? { revision: editing.revision } : {}),
          });
          if (mounted.current) setDraft(null);
        }),
      preview: () =>
        action(async () => {
          const result = await request<{ times: number[] }>('/preview', 'POST', scheduledRunPayload(draft, input));
          if (mounted.current) setTimes(result.times);
        }, false),
      toggleEnabled: (s: ScheduledRun) =>
        action(() =>
          request('/' + encodeURIComponent(s.id), 'PUT', {
            revision: s.revision,
            draft: { ...s, enabled: !s.enabled },
          }),
        ),
      deleteSchedule: (s: ScheduledRun) =>
        action(() => request('/' + encodeURIComponent(s.id), 'DELETE', { revision: s.revision })),
      runNow: (s: ScheduledRun) =>
        action(() => request('/' + encodeURIComponent(s.id) + '/run', 'POST', { revision: s.revision })),
      cancelRun: (id: string) => action(() => request('/runs/' + encodeURIComponent(id) + '/cancel', 'POST', {})),
      retryRun: (id: string) =>
        action(() => request('/runs/' + encodeURIComponent(id) + '/retry', 'POST', { confirmSideEffects: true })),
      openRecording: (id: string) => action(() => onOpenRecording(id), false),
    },
  };
}
