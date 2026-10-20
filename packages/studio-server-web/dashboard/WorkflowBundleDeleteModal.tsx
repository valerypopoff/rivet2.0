import { useRef, useState } from 'react';
import Button from '@atlaskit/button';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import type { WorkflowFolderItem } from './types';
import { requestWorkflowBundle } from './workflowApi';
import './WorkflowProjectBundleModal.css';

export type WorkflowBundleDeleteResult = {
  deleted: boolean;
  deletedProjects: Array<{ path: string; projectId: string }>;
};

export function WorkflowBundleDeleteModal({
  folder,
  onClose,
  onDeleted,
}: {
  folder: WorkflowFolderItem;
  onClose(): void;
  onDeleted(result: WorkflowBundleDeleteResult): void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const close = () => {
    if (!pending.current) onClose();
  };
  const submit = async () => {
    if (pending.current || confirmation !== folder.name || !folder.bundleId) return;
    pending.current = true;
    setBusy(true);
    setError('');
    let result: WorkflowBundleDeleteResult;
    try {
      result = await requestWorkflowBundle<WorkflowBundleDeleteResult>(`/${folder.bundleId}/delete`, {
        name: confirmation,
        relativePath: folder.relativePath,
      });
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : 'Could not delete bundle.'} If the response was lost, refresh the project tree before retrying.`,
      );
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    onDeleted(result);
  };
  return (
    <ModalDialog testId="workflow-bundle-delete-modal" label="Delete bundle" onClose={close}>
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">Delete bundle?</div>
            <button
              className="project-settings-close-button"
              type="button"
              aria-label="Close bundle deletion"
              onClick={close}
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-project-bundle-content workflow-bundle-delete-content">
            <p>
              Delete this bundle and all its projects, subfolders, saved versions and datasets? This cannot be undone.
              Open member tabs will close and unsaved edits will be discarded.
            </p>
            <p>Shared projects and recording retention are unchanged. Unpublish member endpoints and web apps first.</p>
            <p id="bundle-delete-instructions">
              Type this bundle name to confirm:{' '}
              <strong className="workflow-bundle-delete-name" data-testid="bundle-delete-name">
                {folder.name}
              </strong>
            </p>
            <input
              autoFocus
              className="project-settings-input workflow-bundle-delete-input"
              aria-label="Bundle name"
              aria-describedby="bundle-delete-instructions"
              placeholder="Type bundle name"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              readOnly={busy}
            />
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <div className="workflow-project-bundle-footer">
            <Button isDisabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button appearance="danger" isDisabled={busy || confirmation !== folder.name} onClick={() => void submit()}>
              {busy ? 'Deleting…' : 'Delete bundle'}
            </Button>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
