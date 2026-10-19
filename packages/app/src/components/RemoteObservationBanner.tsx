import { useAtomValue } from 'jotai';
import { css } from '@emotion/react';
import { currentRemoteObservationsState, remoteObservationNoticesState } from '../state/remoteObservation.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { useExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';
import { useLoadProject } from '../hooks/useLoadProject.js';

export function RemoteObservationBanner() {
  const observations = useAtomValue(currentRemoteObservationsState);
  const projectId = useAtomValue(projectState).metadata.id;
  const notices = useAtomValue(remoteObservationNoticesState);
  const opened = useAtomValue(projectsState).openedProjects;
  useAtomValue(executorSessionRevisionState);
  const registry = useExecutorSessionRegistry();
  const activate = useLoadProject();
  if (!observations.length && !notices[projectId]) return null;
  const sources = [...new Map(observations.map((item) => [item.sourceProjectId, item])).values()];
  const blocked = observations.every((item) => item.status === 'blocked');
  return (
    <div
      data-testid="remote-observation-banner"
      role="status"
      css={css`
        max-width: min(560px, 65vw);
        padding: 6px 10px;
        border: 1px solid var(--grey);
        border-radius: 6px;
        background: var(--grey-darkest);
        color: var(--grey-lightest);
        font-size: 12px;
        button {
          margin: 2px 4px;
          cursor: pointer;
        }
      `}
    >
      {sources.length > 0 && (
        <div>
          {blocked ? 'Remote observation unavailable' : 'Observing Remote Debugger'} through{' '}
          {sources.map((item) => item.sourceTitle).join(', ')} — view only
        </div>
      )}
      {observations.some((item) => item.status === 'interrupted') && (
        <div>Remote run interrupted. Received execution data is retained.</div>
      )}
      {observations.length > 0 && observations.every((item) => item.status === 'complete') && (
        <div>Remote run completed.</div>
      )}
      {sources.some(
        (item) =>
          (
            registry.getRemoteDebuggerRuntime(item.sourceProjectId) ?? registry.getRuntime(item.sourceProjectId)
          ).getRuntimeState().status === 'reconnecting',
      ) && <div>Reconnecting to the source debugger. Execution is not restarted.</div>}
      {observations.some((item) => item.needsInput) && <div>The source project needs user input.</div>}
      {observations.some((item) => item.paused) && <div>The source debugger is paused.</div>}
      {[...new Set(observations.map((item) => item.version).filter(Boolean))].map((version) => (
        <span key={version}>Runtime target: {version === 'mixed' ? 'latest and published' : version}. </span>
      ))}
      {[...new Set(observations.map((item) => item.message).filter(Boolean))].map((message) => (
        <div key={message}>{message}</div>
      ))}
      {notices[projectId] && <div>{notices[projectId]}</div>}
      {sources.map(
        (item) =>
          opened[item.sourceProjectId] && (
            <button key={item.sourceProjectId} onClick={() => void activate(opened[item.sourceProjectId]!)}>
              Go to debugger source: {item.sourceTitle}
            </button>
          ),
      )}
    </div>
  );
}
