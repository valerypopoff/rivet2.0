import { useAtomValue } from 'jotai';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';

export function ManagedLatestRunControls() {
  const runtime = useExecutorSessionRuntime();
  useAtomValue(executorSessionRevisionState);
  const state = runtime.getLatestDebuggerState();
  if (!state) return null;
  const selected = state.runs.find((run) => run.key === state.selected);
  const connection = runtime.getRuntimeState().connection;
  if (connection.kind !== 'managed-latest') return null;
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12 }}
      aria-label="Remote Debugger run selection"
    >
      <span>Channel: {connection.channel ?? 'default'}</span>
      <select
        aria-label="Debugger run"
        value={state.selected ?? ''}
        onChange={(event) => runtime.selectLatestDebuggerRun(event.target.value)}
      >
        {!state.selected && <option value="">Waiting for a run</option>}
        {state.runs.map((run) => (
          <option key={run.key} value={run.key}>
            {run.title} · {new Date(run.startedAt).toLocaleTimeString()} · {run.scope.rootRunId.slice(-8)} ·{' '}
            {run.status}
          </option>
        ))}
      </select>
      <button type="button" disabled={state.following} onClick={() => runtime.selectLatestDebuggerRun()}>
        {state.following ? 'Following newest' : 'Follow newest'}
      </button>
      {selected?.incomplete && <span role="status">Retained history is incomplete.</span>}
    </div>
  );
}
