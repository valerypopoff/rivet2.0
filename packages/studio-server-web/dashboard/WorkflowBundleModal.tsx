import { useEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import type { WorkflowFolderItem } from './types';
import type { WorkflowBundlePreview, WorkflowBundleVersion } from '../../studio-server-shared/workflow-bundle-types';
import { requestWorkflowBundle } from './workflowApi';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import type { HostedProjectReconciliationContext } from '../../studio-server-shared/editor-bridge';
import './WorkflowProjectBundleModal.css';

export function WorkflowBundleModal({
  source,
  parent,
  folders,
  onClose,
  onCreated,
  inspectEdits,
}: {
  source?: WorkflowFolderItem;
  parent: string;
  folders: WorkflowFolderItem[];
  onClose(): void;
  onCreated(folder: WorkflowFolderItem): void;
  inspectEdits(): Promise<HostedProjectReconciliationContext | null>;
}) {
  const [name, setName] = useState(source ? `${source.name} copy` : 'New bundle');
  const [destination, setDestination] = useState(parent);
  const [version, setVersion] = useState<WorkflowBundleVersion>('latest');
  const [preview, setPreview] = useState<WorkflowBundlePreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [unsaved, setUnsaved] = useState<string[]>([]);
  const [editCheckComplete, setEditCheckComplete] = useState(false);
  const [copySaved, setCopySaved] = useState(false);
  const acknowledgementRequired = unsaved.length > 0 || !editCheckComplete;
  const busyRef = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!source?.bundleId) return;
    const controller = new AbortController();
    setPreview(undefined);
    setError('');
    void Promise.all([
      requestWorkflowBundle<WorkflowBundlePreview>(`/${source.bundleId}/preview`, { version }, controller.signal),
      inspectEdits(),
    ])
      .then(([result, context]) => {
        if (!controller.signal.aborted) {
          setPreview(result);
          setEditCheckComplete(context?.editCheckComplete === true);
          setCopySaved(false);
          setUnsaved(
            result.members
              .filter((member) =>
                context?.projects.some(
                  (project) => project.projectId === member.projectId && project.hasUnsavedChanges,
                ),
              )
              .map((member) => member.relativePath),
          );
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [source?.bundleId, version, refresh]);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  const submit = async () => {
    if (busyRef.current || !name.trim() || (source && (!preview || (acknowledgementRequired && !copySaved)))) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await requestWorkflowBundle<{ folder: WorkflowFolderItem }>(
        source ? `/${source.bundleId}/duplicate` : '/',
        { name, parentRelativePath: destination, ...(source ? { version, fingerprint: preview!.fingerprint } : {}) },
      );
      onCreated(result.folder);
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : 'Bundle operation failed.'} Refresh the tree before retrying if the response was lost.`,
      );
      setPreview(undefined);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const allowedFolders = folders.filter(
    (folder) =>
      !folders.some(
        (candidate) =>
          candidate.bundleId &&
          (folder.relativePath === candidate.relativePath ||
            folder.relativePath.startsWith(`${candidate.relativePath}/`)),
      ),
  );
  return (
    <ModalDialog testId="workflow-bundle-modal" label={source ? 'Duplicate bundle' : 'New bundle'} onClose={close}>
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">{source ? 'Duplicate bundle' : 'New bundle'}</div>
            <button
              className="project-settings-close-button"
              type="button"
              aria-label="Close bundle dialog"
              onClick={close}
              disabled={busy}
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-project-bundle-content">
            <section className="workflow-project-bundle-card">
              <label>
                Name
                <input
                  aria-label="Bundle name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                Destination
                <select
                  aria-label="Bundle destination"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  disabled={busy}
                >
                  <option value="">Library root</option>
                  {allowedFolders.map((folder) => (
                    <option key={folder.id} value={folder.relativePath}>
                      {folder.relativePath}
                    </option>
                  ))}
                </select>
              </label>
              {source ? (
                <>
                  <SegmentedControl label="Bundle copy versions">
                    <SegmentedControlButton
                      selected={version === 'latest'}
                      disabled={busy}
                      onClick={() => setVersion('latest')}
                    >
                      Saved latest
                    </SegmentedControlButton>
                    <SegmentedControlButton
                      selected={version === 'published'}
                      disabled={busy}
                      onClick={() => setVersion('published')}
                    >
                      Published
                    </SegmentedControlButton>
                  </SegmentedControl>
                  <p>
                    Only saved content is copied. Save any unsaved member edits first. Copies are unpublished;
                    schedules, routes and recording history are not copied. External services and server configuration
                    remain shared.
                  </p>
                  {acknowledgementRequired && preview ? (
                    <div role="status">
                      {!editCheckComplete ? (
                        <p>
                          Open edits could not be fully checked. A project may be saving, loading, or using an older
                          editor. Only stored revisions will be copied.
                        </p>
                      ) : null}
                      {unsaved.length ? <p>These opened members have unsaved edits:</p> : null}
                      <ul>
                        {unsaved.map((path) => (
                          <li key={path}>{path}</li>
                        ))}
                      </ul>
                      <label>
                        <input
                          type="checkbox"
                          checked={copySaved}
                          disabled={busy}
                          onChange={(event) => setCopySaved(event.target.checked)}
                        />
                        {unsaved.length
                          ? 'Copy saved versions without these unsaved edits'
                          : 'Copy saved versions without checking open edits'}
                      </label>
                    </div>
                  ) : null}
                  {preview ? (
                    <>
                      {preview.warnings.length ? (
                        <div role="status">
                          <strong>Definitions need review</strong>
                          <ul>
                            {preview.warnings.map((warning) => (
                              <li key={warning}>{warning}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <p>{preview.members.length} projects will be copied, including disconnected members.</p>
                      <ul>
                        {preview.members.map((member) => (
                          <li key={member.projectId}>
                            {member.relativePath} —{' '}
                            {member.selectedVersion === 'published' ? 'Published' : 'Saved latest'}
                            {version === 'published' && member.selectedVersion === 'latest' ? ' (no publication)' : ''}
                          </li>
                        ))}
                      </ul>
                      <p>{preview.externalProjectIds.length} external dependencies remain shared.</p>
                      {preview.externalProjectIds.length ? (
                        <ul>
                          {preview.externalProjectIds.map((id) => (
                            <li key={id}>{id}</li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  ) : !error ? (
                    <p role="status">Preparing preview…</p>
                  ) : null}
                </>
              ) : (
                <p>Projects and ordinary subfolders placed here become members. Bundles have no entry project.</p>
              )}
              {error ? <p role="alert">{error}</p> : null}
            </section>
          </div>
          <div className="workflow-project-bundle-footer">
            <Button isDisabled={busy} onClick={close}>
              Cancel
            </Button>
            {source && !preview && error ? (
              <Button isDisabled={busy} onClick={() => setRefresh((value) => value + 1)}>
                Refresh preview
              </Button>
            ) : null}
            <Button
              appearance="primary"
              isDisabled={
                busy || !name.trim() || Boolean(source && (!preview || (acknowledgementRequired && !copySaved)))
              }
              onClick={() => void submit()}
            >
              {busy ? 'Working…' : source ? 'Duplicate bundle' : 'Create bundle'}
            </Button>
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
