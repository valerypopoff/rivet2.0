import Button from '@atlaskit/button';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import './WorkflowProjectBundleModal.css';

export type WorkflowBundleConversionFailure = {
  folderPath: string;
  creatingBundle: boolean;
  referenceConflict: boolean;
  message: string;
};

export function WorkflowBundleConversionErrorModal({
  failure,
  onClose,
}: {
  failure: WorkflowBundleConversionFailure;
  onClose(): void;
}) {
  const title = failure.creatingBundle ? 'Could not create bundle' : 'Could not convert bundle';
  return (
    <ModalDialog testId="workflow-bundle-conversion-error-modal" label={title} onClose={onClose}>
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">{title}</div>
            <button
              className="project-settings-close-button"
              type="button"
              aria-label="Close bundle conversion error"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-project-bundle-content">
            <section className="workflow-project-bundle-card">
              <p>Folder: {failure.folderPath}</p>
              <div className="workflow-project-bundle-error" role="alert">
                {failure.message}
              </div>
              <h3>What to do next</h3>
              {failure.referenceConflict ? (
                <>
                  <p>Projects in different bundles cannot reference each other. The folder has not been converted.</p>
                  <ol>
                    <li>Open the project named above and find its reference to the other bundle.</li>
                    <li>
                      Select the intended project inside this folder, or an ordinary shared project outside any bundle.
                      Copy missing projects into this folder and retarget their references if needed.
                    </li>
                    <li>
                      Save the affected projects. If the error names a published snapshot, republish the affected
                      workflow endpoint or web app after fixing it, or unpublish it.
                    </li>
                    <li>
                      Close this dialog and choose <strong>Convert to bundle</strong> again.
                    </li>
                  </ol>
                </>
              ) : (
                <p>
                  Follow the details above to resolve the problem. If the connection failed or the response was lost,
                  refresh the project tree to check whether the conversion completed before retrying.
                </p>
              )}
            </section>
          </div>
          <div className="workflow-project-bundle-footer">
            <Button appearance="primary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
