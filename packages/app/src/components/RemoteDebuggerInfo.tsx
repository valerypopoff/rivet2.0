import { useAtomValue } from 'jotai';
import { css } from '@emotion/react';
import { useState } from 'react';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { AppModalHeader } from './AppModalHeader.js';
import { currentRemoteObservationsState, remoteObservationNoticesState } from '../state/remoteObservation.js';
import { projectState, projectsState } from '../state/savedGraphs.js';
import { useExecutorSessionRegistry } from '../providers/ExecutorSessionContext.js';
import { executorSessionRevisionState } from '../state/execution.js';
import { useLoadProject } from '../hooks/useLoadProject.js';

export function RemoteDebuggerInfo({ connected }: { connected: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const observations = useAtomValue(currentRemoteObservationsState);
  const projectId = useAtomValue(projectState).metadata.id;
  const notices = useAtomValue(remoteObservationNoticesState);
  const notice = Object.hasOwn(notices, projectId) ? notices[projectId] : undefined;
  const opened = useAtomValue(projectsState).openedProjects;
  useAtomValue(executorSessionRevisionState);
  const registry = useExecutorSessionRegistry();
  const activate = useLoadProject();
  if (!connected && !observations.length && !notice) return null;
  const sources = [...new Map(observations.map((item) => [item.sourceProjectId, item])).values()];
  const blocked = observations.every((item) => item.status === 'blocked');
  return (
    <>
      <button
        type="button"
        className="remote-debugger-info"
        aria-label="Remote Debugger details"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        title="Remote Debugger details"
        onClick={() => setIsOpen(true)}
      >
        ?
      </button>
      <ModalTransition>
        {isOpen && (
          <Modal onClose={() => setIsOpen(false)}>
            <AppModalHeader title="Remote Debugger details" onClose={() => setIsOpen(false)} />
            <ModalBody>
              <div
                data-testid="remote-debugger-details"
                role="status"
                css={css`
                  display: flex;
                  flex-direction: column;
                  align-items: flex-start;
                  gap: 8px;
                  overflow-wrap: anywhere;
                `}
              >
                {!sources.length && connected && (
                  <div>Remote Debugger is active. Execution details will appear here when available.</div>
                )}
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
                      registry.getRemoteDebuggerRuntime(item.sourceProjectId) ??
                      registry.getRuntime(item.sourceProjectId)
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
                {notice && <div>{notice}</div>}
                {sources.map(
                  (item) =>
                    opened[item.sourceProjectId] && (
                      <Button
                        key={item.sourceProjectId}
                        onClick={() => {
                          setIsOpen(false);
                          void activate(opened[item.sourceProjectId]!);
                        }}
                      >
                        Go to debugger source: {item.sourceTitle}
                      </Button>
                    ),
                )}
              </div>
            </ModalBody>
            <ModalFooter>
              <Button appearance="primary" onClick={() => setIsOpen(false)}>
                Done
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>
    </>
  );
}
