import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type {
  EvaluationLibraryConflictResolution,
  EvaluationLibrarySyncIssue,
} from '@valerypopoff/rivet2-evaluations';
import { useEffect, useState, type FC } from 'react';
import { AppModalHeader } from '../AppModalHeader.js';
import { getEvaluationLibrarySyncDialogPresentation } from './evaluationLibrarySyncDialogPresentation.js';

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

export const EvaluationLibrarySyncDialog: FC<{
  issue?: EvaluationLibrarySyncIssue;
  onResolve: (input: EvaluationLibraryConflictResolution) => Promise<void>;
  onRetry: () => Promise<void>;
}> = ({ issue, onResolve, onRetry }) => {
  const [isResolving, setIsResolving] = useState(false);
  const [error, setError] = useState<string>();
  const presentation = getEvaluationLibrarySyncDialogPresentation(issue);
  const conflict = presentation?.conflict;

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
      {presentation === undefined ? null : (
        <Modal autoFocus={false} onClose={() => undefined} width="medium">
          <AppModalHeader title={presentation.title} />
          <ModalBody>
            <div css={bodyStyles}>
              {conflict ? (
                <>
                  <p>{conflict.description}</p>
                  <div css={valueStyles}>
                    <div>
                      <strong>Server version</strong>
                      <span>{conflict.serverTitle}</span>
                    </div>
                    <div>
                      <strong>Your pending version</strong>
                      <span>{conflict.localTitle}</span>
                    </div>
                  </div>
                  {conflict.draft.local.value === undefined ? (
                    <p>Your pending change deletes this resource, so there is no local value to keep as a copy.</p>
                  ) : null}
                </>
              ) : (
                <p>{presentation.message}</p>
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
                      onResolve({
                        issueId: issue!.id,
                        kind: conflict.draft.kind,
                        id: conflict.draft.id,
                        action: 'use-server',
                      }),
                    )
                  }
                >
                  Use server version
                </Button>
                {conflict.canKeepMineAsCopy ? (
                  <Button
                    appearance="primary"
                    isDisabled={isResolving}
                    onClick={() =>
                      void run(() =>
                        onResolve({
                          issueId: issue!.id,
                          kind: conflict.draft.kind,
                          id: conflict.draft.id,
                          action: 'keep-mine-as-copy',
                        }),
                      )
                    }
                  >
                    Keep mine as copy
                  </Button>
                ) : null}
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
