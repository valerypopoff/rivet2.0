import { useAtomValue } from 'jotai';
import Select from '@atlaskit/select';
import Portal from '@atlaskit/portal';
import { css } from '@emotion/react';
import { useState } from 'react';
import { useExecutorSessionRuntime } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';
import { isLatestRunSettled } from '../hooks/latestDebuggerRuns.js';

export function ManagedLatestRunControls() {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const runtime = useExecutorSessionRuntime();
  useAtomValue(executorSessionRevisionState);
  const state = runtime.getLatestDebuggerState();
  if (!state) return null;
  const selected = state.runs.find((run) => run.key === state.selected);
  const connection = runtime.getRuntimeState().connection;
  if (connection.kind !== 'managed-latest') return null;
  const options = state.runs.map((run) => ({
    value: run.key,
    label: `${run.title} · ${new Date(run.startedAt).toLocaleTimeString()} · ${run.scope.rootRunId.slice(-8)} · ${run.status}${isLatestRunSettled(run) ? ' · History' : ''}`,
  }));
  return (
    <div
      css={css`
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 16px;

        .run-picker {
          min-width: 0;
          max-width: 100%;
        }
      `}
      aria-label="Remote Debugger run selection"
    >
      <span>Channel: {connection.channel ?? 'default'}</span>
      <div
        className="run-picker"
        onKeyDown={(event) => {
          // A dropdown-handled Escape closes its menu, not the containing modal.
          if (event.key === 'Escape' && event.defaultPrevented) event.stopPropagation();
        }}
      >
        <Select
          instanceId="managed-debugger-run"
          aria-label="Debugger run"
          options={options}
          value={options.find((option) => option.value === state.selected) ?? null}
          placeholder="Waiting for a new run"
          isSearchable={false}
          menuPlacement="auto"
          menuPosition="fixed"
          menuPortalTarget={menuPortalTarget ?? undefined}
          maxMenuHeight={240}
          onChange={(option) => {
            if (option) runtime.selectLatestDebuggerRun(option.value);
          }}
        />
        <Portal zIndex={1000}>
          <div ref={setMenuPortalTarget} />
        </Portal>
      </div>
      {selected?.incomplete && <span role="status">Retained history is incomplete.</span>}
    </div>
  );
}
