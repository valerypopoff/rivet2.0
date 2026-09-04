import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type {
  EvaluationLibraryConflictDraft,
  EvaluationLibraryConflictResolution,
  EvaluationLibrarySyncIssue,
} from '@valerypopoff/rivet2-evaluations';
import { useEffect, useState, type FC } from 'react';
import { AppModalHeader } from '../AppModalHeader.js';

const bodyStyles = css`
  display: flex;
  flex-direction: column;
  gap: 12px;

  p {
    margin: 0;
    line-height: 1.5;
  }
`;

const valueStyles = css`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;

  > div {
    border: 1px solid var(--ds-border, #dfe1e6);
    border-radius: 3px;
    padding: 8px;
  }

  strong,
  span {
    display: block;
  }

  span {
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
`;

function resourceTitle(conflict: EvaluationLibraryConflictDraft, source: 'local' | 'server'): string {
  const resource = conflict[source];
  if (resource.value === undefined) return 'Deleted';
  return resource.kind === 'suite' ? resource.value.suite.name || 'Untitled evaluation suite' : resource.value.name || 'Untitled evaluation dataset';
}

function conflictDescription(conflict: EvaluationLibraryConflictDraft): string {
  return `The ${conflict.kind} “${resourceTitle(conflict, 'server')}” was changed by another browser after your edit began. Choose which version to retain; Rivet will never overwrite the other editor automatically.`;
}

export const EvaluationLibrarySyncDialog: FC<{
  issue?: EvaluationLibrarySyncIssue;
  onResolve: (input: EvaluationLibraryConflictResolution) => Promise<void>;
  onRetry: () => Promise<void>;
}> = ({ issue, onResolve, onRetry }) => {
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string>();
  const conflict = issue?.kind === 'conflict' ? issue.conflicts[0] : undefined;

  useEffect(() => {
    setError(undefined);
    setIsResolving(false);
  }, [issue?.id]);

  const run = async (action: () => Promise<void>) => {
    setIsResolving(true);
    setError(undefined);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <ModalTransition>
      {issue == null ? null : (
        <Modal autoFocus={false} onClose={() => undefined} width="medium">
          <AppModalHeader title={issue.kind === 'conflict' ? 'Resolve shared evaluation conflict' : 'Evaluation library save needs attention'} />
          <ModalBody>
            <div css={bodyStyles}>
              {conflict ? (
                <>
                  <p>{conflictDescription(conflict)}</p>
                  <div css={valueStyles}>
                    <div>
                      <strong>Server version</strong>
                      <span>{resourceTitle(conflict, 'server')}</span>
                    </div>
                    <div>
                      <strong>Your pending version</strong>
                      <span>{resourceTitle(conflict, 'local')}</span>
                    </div>
                  </div>
                  {conflict.local.value === undefined ? (
                    <p>Your pending change deletes this resource, so there is no local value to keep as a copy.</p>
                  ) : null}
                </>
              ) : (
                <p>{issue.message} Your pending changes remain in this browser until you retry the save.</p>
              )}
              {error ? <p role="alert">{error}</p> : null}
            </div>
          </ModalBody>
          <ModalFooter>
            {conflict ? (
              <>
                <Button
                  appearance="subtle"
                  isDisabled={isResolving}
                  onClick={() =>
                    void run(() =>
                      onResolve({ issueId: issue.id, kind: conflict.kind, id: conflict.id, action: 'use-server' }),
                    )
                  }
                >
                  Use server version
                </Button>
                {conflict.local.value === undefined ? null : (
                  <Button
                    appearance="primary"
                    isDisabled={isResolving}
                    onClick={() =>
                      void run(() =>
                        onResolve({ issueId: issue.id, kind: conflict.kind, id: conflict.id, action: 'keep-mine-as-copy' }),
                      )
                    }
                  >
                    Keep mine as copy
                  </Button>
                )}
              </>
            ) : (
              <Button appearance="primary" isDisabled={isResolving} onClick={() => void run(onRetry)}>
                {isResolving ? 'Retrying save…' : 'Retry save'}
              </Button>
            )}
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
