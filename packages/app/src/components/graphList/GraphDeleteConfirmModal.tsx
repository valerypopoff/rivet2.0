import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { css } from '@emotion/react';
import { listProjectGraphCallSites, type ProjectId } from '@valerypopoff/rivet2-core';
import type { GraphDeletionRequest } from './graphDeletion.js';
import { AppModalHeader } from '../AppModalHeader.js';
import { useSubgraphProjectCatalog, type SubgraphProjectCatalogProvider } from '../../providers/ProvidersContext.js';
import { openedProjectSnapshotsState, projectUnsavedChangesState, projectState } from '../../state/savedGraphs.js';

type Check = Awaited<ReturnType<NonNullable<SubgraphProjectCatalogProvider['graphReferences']>>>;

const warningStyles = css`
  background: var(--error-dark);
  color: #fff;
  border-radius: 6px;
  padding: 12px 16px;
  margin: 12px 0;
  overflow-wrap: anywhere;

  p,
  li,
  strong {
    color: inherit;
  }

  > :first-child,
  > section > :first-child {
    margin-top: 0;
  }

  > :last-child,
  > section > :last-child {
    margin-bottom: 0;
  }
`;

export function GraphDeleteConfirmModal({
  request,
  onClose,
  onConfirm,
}: {
  request: GraphDeletionRequest;
  onClose(): void;
  onConfirm(): void;
}) {
  const catalog = useSubgraphProjectCatalog();
  const snapshots = useAtomValue(openedProjectSnapshotsState);
  const targetProject = useAtomValue(projectState);
  const dirty = useAtomValue(projectUnsavedChangesState);
  const [attempt, setAttempt] = useState(0);
  const [check, setCheck] = useState<{ result?: Check; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setCheck(null);
    if (!catalog?.graphReferences) {
      setCheck({});
      return () => controller.abort();
    }
    const timeout = setTimeout(() => {
      setCheck({ error: 'The reference check timed out. Other projects may depend on these graphs.' });
      controller.abort();
    }, 35_000);
    void Promise.resolve()
      .then(() => catalog.graphReferences!(request, controller.signal))
      .then(
        (result) => {
          clearTimeout(timeout);
          if (!controller.signal.aborted)
            setCheck(
              result.projectId === request.projectId
                ? { result }
                : { error: 'The project changed. Close this dialog and review again.' },
            );
        },
        () => {
          clearTimeout(timeout);
          if (!controller.signal.aborted)
            setCheck({
              error: 'Could not check incoming graph references. Other projects may depend on these graphs.',
            });
        },
      );
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [catalog, request, attempt]);

  const savedScanComplete = check?.result?.complete === true;
  const local = useMemo(() => {
    const ids = new Set<string>(request.graphIds);
    const references: Check['references'] = [];
    let incomplete = false;
    for (const [id, snapshot] of Object.entries(snapshots)) {
      if (id === request.projectId || (savedScanComplete && dirty[id as ProjectId] === false)) continue;
      try {
        for (const call of listProjectGraphCallSites(snapshot.project)) {
          if (call.targetProjectId === request.projectId && ids.has(call.targetGraphId)) {
            references.push({
              ...call,
              projectId: id,
              projectName: snapshot.project.metadata.title || id,
              sourceDescription: dirty[id as ProjectId] ? 'Unsaved open editor' : 'Open editor',
            });
          }
        }
      } catch {
        incomplete = true;
      }
    }
    return { references, incomplete };
  }, [snapshots, dirty, request, savedScanComplete]);
  const references = [...(check?.result?.references ?? []), ...local.references];
  const incomplete = local.incomplete || Boolean(check?.error) || check?.result?.complete === false;
  const hasWarning = references.length > 0 || incomplete;
  return (
    <ModalTransition>
      <Modal autoFocus={false} onClose={onClose} width="medium">
        <AppModalHeader title={request.folderPath ? 'Delete Folder?' : 'Delete Graph?'} onClose={onClose} />
        <ModalBody>
          <p>
            Delete <strong>{request.name}</strong>
            {request.folderPath ? ` and its ${request.graphIds.length} graphs` : ''}? This cannot be undone.
          </p>
          {check === null && <p role="status">Checking incoming graph references…</p>}
          {hasWarning && (
            <section aria-label="Graph deletion warning" css={warningStyles}>
              {references.length > 0 && (
                <section aria-label="Incoming graph references">
                  <p role="alert">
                    <strong>Other projects reference {request.folderPath ? 'these graphs' : 'this graph'}.</strong>{' '}
                    Deleting may break their runs.
                  </p>
                  <ul>
                    {references.map((reference, index) => (
                      <li key={`${reference.projectId}/${reference.sourceGraphId}/${reference.nodeId}/${index}`}>
                        <strong>{reference.projectName}</strong>
                        {reference.relativePath ? ` (${reference.relativePath})` : ''}
                        {' — '}
                        {reference.sourceGraphName}
                        {' → '}
                        {reference.nodeTitle}
                        {` → ${targetProject.metadata.id === request.projectId ? targetProject.graphs[reference.targetGraphId as keyof typeof targetProject.graphs]?.metadata?.name ?? reference.targetGraphId : reference.targetGraphId}`}
                        {` — ${reference.sourceDescription}; target: ${reference.targetVersion === 'latest' ? 'Saved latest' : reference.targetVersion === 'published' ? 'Published' : 'Legacy project reference'}`}
                      </li>
                    ))}
                  </ul>
                  <p>
                    Saved latest calls can fail after you save this deletion. Published calls keep the existing
                    published graph until the target publication changes. Published callers may also use Saved latest
                    targets.
                  </p>
                </section>
              )}
              {check?.error && <p role="alert">{check.error}</p>}
              {incomplete && (
                <p role="alert">The reference check is incomplete. Missing results do not mean deletion is safe.</p>
              )}
            </section>
          )}
          {!catalog?.graphReferences && (
            <p>Only open projects can be checked in this host. Closed projects may also reference these graphs.</p>
          )}
          {check?.result?.complete && !references.length && !local.incomplete && (
            <p>No incoming cross-project references were found in saved projects and active publications.</p>
          )}
          <p>This is a point-in-time warning, not a lock. Other users’ unsaved changes cannot be checked.</p>
        </ModalBody>
        <ModalFooter>
          {catalog?.graphReferences && (
            <Button
              onClick={() => {
                setCheck(null);
                setAttempt((value) => value + 1);
              }}
              isDisabled={check === null}
            >
              Check again
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button appearance="danger" isDisabled={check === null} onClick={onConfirm}>
            {hasWarning ? 'Delete anyway' : 'Delete'}
          </Button>
        </ModalFooter>
      </Modal>
    </ModalTransition>
  );
}
