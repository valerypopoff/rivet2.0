import { useRef, useState } from 'react';
import Button from '@atlaskit/button';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import { readBundleArchive, readBundleFolder } from './projectBundleUpload';
import { uploadWorkflowBundle } from './workflowApi';
import type { WorkflowFolderItem } from './types';
import './WorkflowProjectBundleModal.css';

export function WorkflowBundleUploadModal({
  folder,
  onClose,
  onImported,
}: {
  folder: WorkflowFolderItem;
  onClose(): void;
  onImported(folder: WorkflowFolderItem): void;
}) {
  const folderInput = useRef<HTMLInputElement | null>(null);
  const archiveInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const upload = async (files: File[], kind: 'folder' | 'archive') => {
    if (!files.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setStatus('Reading and validating bundle…');
    let imported: WorkflowFolderItem;
    try {
      const contents = kind === 'folder' ? await readBundleFolder(files) : await readBundleArchive(files[0]!);
      setStatus('Uploading projects…');
      const result = await uploadWorkflowBundle(folder.relativePath, contents);
      imported = result.folder;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Bundle upload failed.');
      setStatus('');
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    onImported(imported);
  };
  const close = () => {
    if (!busyRef.current) onClose();
  };
  return (
    <ModalDialog testId="workflow-bundle-upload-modal" label="Upload bundle" onClose={close}>
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">Upload bundle</div>
            <button
              type="button"
              className="project-settings-close-button"
              aria-label="Close bundle upload"
              disabled={busy}
              onClick={close}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-project-bundle-content">
            <section className="workflow-project-bundle-card">
              <p className="project-settings-help">
                Choose an extracted bundle folder or a bundle ZIP archive containing <code>rivet-bundle.json</code>.
              </p>
              <p className="project-settings-help">
                Projects and datasets will be imported together into a new folder inside {folder.name}. You can move the
                projects afterward. Imported projects are unpublished. Portable dependency snapshots are placed in a
                separate neighboring folder, outside the bundle membership. Existing projects are never reused or
                overwritten.
              </p>
              <p className="project-settings-help">
                Maximum bundle contents: 64 MiB. Existing projects are not overwritten.
              </p>
              <input
                ref={(element) => {
                  folderInput.current = element;
                  element?.setAttribute('webkitdirectory', '');
                }}
                type="file"
                multiple
                hidden
                aria-label="Bundle folder"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void upload(files, 'folder');
                }}
              />
              <input
                ref={archiveInput}
                type="file"
                accept=".zip,application/zip"
                hidden
                aria-label="Bundle archive"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void upload(files, 'archive');
                }}
              />
              {busy ? <p role="status">{status}</p> : null}
              {error ? (
                <div role="alert" className="workflow-project-bundle-error">
                  <p>{error}</p>
                  <p>
                    If the connection was lost, refresh the tree before uploading again; the import may have completed.
                  </p>
                </div>
              ) : null}
            </section>
          </div>
          <div className="workflow-project-bundle-footer">
            <Button className="workflow-project-bundle-action button-size-l" isDisabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              className="workflow-project-bundle-action button-size-l"
              isDisabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              Choose bundle folder
            </Button>
            <Button
              appearance="primary"
              className="workflow-project-bundle-action workflow-project-bundle-primary button-size-l"
              isDisabled={busy}
              onClick={() => archiveInput.current?.click()}
            >
              Choose bundle archive
            </Button>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
