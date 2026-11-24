import Button, { LoadingButton } from '@atlaskit/button';
import { type FC, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { publicationSnapshotFieldsAgree } from './projectPublicationReview';
import {
  WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH,
  type WorkflowPublicationPreconditions,
} from '../../studio-server-shared/workflow-types';

import type {
  WorkflowProjectItem,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
} from './types';
import { isNextPublicationVersion, isPublicationVersion, isUnconfirmedPublication } from './publicationVersion';
import {
  downloadWorkflowPublishedVersion,
  fetchWorkflowProjectWebApps,
  fetchWorkflowPublishedVersions,
  restoreWorkflowPublishedVersion,
  setWorkflowPublishedVersionComment,
  setWorkflowPublishedVersionStar,
} from './workflowApi';

const PUBLISHED_VERSION_HISTORY_PAGE_SIZE = 10;

type WorkflowPublishedVersionHistoryPanelProps = {
  project: WorkflowProjectItem | null;
  isOpen: boolean;
  onPreviewVersion: (relativePath: string, versionId: string) => void;
  onRestored: (response: WorkflowPublishedVersionRestoreResponse) => void | Promise<void>;
  onRestoreUnconfirmed: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};

function getRestoreEndpointName(project: WorkflowProjectItem): string {
  return project.settings.publishedEndpointName || project.settings.endpointName;
}

function formatPublishedVersionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createCommentDrafts(versions: WorkflowPublishedVersionSummary[]): Record<string, string> {
  return Object.fromEntries(versions.map((version) => [version.id, version.comment]));
}

export const WorkflowPublishedVersionHistoryPanel: FC<WorkflowPublishedVersionHistoryPanelProps> = ({
  project,
  isOpen,
  onPreviewVersion,
  onRestored,
  onRestoreUnconfirmed,
  onBusyChange,
}) => {
  const [versions, setVersions] = useState<WorkflowPublishedVersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingVersionId, setDownloadingVersionId] = useState<string | null>(null);
  const [starringVersionId, setStarringVersionId] = useState<string | null>(null);
  const [commentingVersionId, setCommentingVersionId] = useState<string | null>(null);
  const [editingCommentVersionId, setEditingCommentVersionId] = useState<string | null>(null);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [review, setReview] = useState<{
    preconditions: WorkflowPublicationPreconditions;
    endpointName: string;
  } | null>(null);
  const [reviewRequested, setReviewRequested] = useState(0);
  const projectRelativePath = project?.relativePath;
  const projectMetadataId = project?.projectMetadataId;
  const skipCommentSaveVersionIdRef = useRef<string | null>(null);
  const canClose = !downloadingVersionId && !starringVersionId && !commentingVersionId && !restoringVersionId;
  useEffect(() => {
    onBusyChange(!canClose);
  }, [canClose, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const totalPages = Math.max(1, Math.ceil(versions.length / PUBLISHED_VERSION_HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleVersions = useMemo(() => {
    const startIndex = (currentPage - 1) * PUBLISHED_VERSION_HISTORY_PAGE_SIZE;
    return versions.slice(startIndex, startIndex + PUBLISHED_VERSION_HISTORY_PAGE_SIZE);
  }, [currentPage, versions]);
  const shouldShowPagination = versions.length > PUBLISHED_VERSION_HISTORY_PAGE_SIZE;

  useEffect(() => {
    if (!isOpen || !projectRelativePath) {
      setVersions([]);
      setError(null);
      setLoading(false);
      setDownloadingVersionId(null);
      setStarringVersionId(null);
      setCommentingVersionId(null);
      setEditingCommentVersionId(null);
      setCommentDrafts({});
      setRestoringVersionId(null);
      setPage(1);
      setReview(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditingCommentVersionId(null);
    void Promise.all([
      fetchWorkflowPublishedVersions(projectRelativePath),
      fetchWorkflowProjectWebApps(projectRelativePath),
    ])
      .then(([response, snapshot]) => {
        if (!cancelled) {
          if (
            !snapshot.projectId ||
            (projectMetadataId != null && snapshot.projectId !== projectMetadataId) ||
            response.versions.some((version) => version.projectId !== snapshot.projectId) ||
            !snapshot.draftRevisionId ||
            !isPublicationVersion(snapshot.publicationVersion) ||
            snapshot.project?.relativePath !== projectRelativePath ||
            !publicationSnapshotFieldsAgree(snapshot)
          ) {
            throw new Error('Publication state is unavailable. Refresh before restoring.');
          }
          setReview({
            preconditions: {
              expectedProjectId: snapshot.projectId,
              expectedDraftRevisionId: snapshot.draftRevisionId,
              expectedPublicationVersion: snapshot.publicationVersion,
            },
            endpointName: getRestoreEndpointName(snapshot.project),
          });
          setVersions(response.versions);
          setCommentDrafts(createCommentDrafts(response.versions));
          setPage(1);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setReview(null);
          setError(err.message || 'Failed to load published revision history');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectRelativePath, projectMetadataId, reviewRequested]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const replaceVersion = (nextVersion: WorkflowPublishedVersionSummary) => {
    setVersions((currentVersions) =>
      currentVersions.map((currentVersion) => (currentVersion.id === nextVersion.id ? nextVersion : currentVersion)),
    );
    setCommentDrafts((currentDrafts) => ({
      ...currentDrafts,
      [nextVersion.id]: nextVersion.comment,
    }));
  };

  const getCommentDraft = (version: WorkflowPublishedVersionSummary) => commentDrafts[version.id] ?? version.comment;

  const canEditComment = !downloadingVersionId && !starringVersionId && !commentingVersionId && !restoringVersionId;

  const handleStartCommentEdit = (version: WorkflowPublishedVersionSummary) => {
    if (!canEditComment) {
      return;
    }

    skipCommentSaveVersionIdRef.current = null;
    setCommentDrafts((currentDrafts) => ({
      ...currentDrafts,
      [version.id]: version.comment,
    }));
    setEditingCommentVersionId(version.id);
  };

  const handleCommentDraftChange = (versionId: string, comment: string) => {
    setCommentDrafts((currentDrafts) => ({
      ...currentDrafts,
      [versionId]: comment,
    }));
  };

  const handleSaveComment = async (version: WorkflowPublishedVersionSummary) => {
    if (skipCommentSaveVersionIdRef.current === version.id) {
      skipCommentSaveVersionIdRef.current = null;
      setEditingCommentVersionId((currentId) => (currentId === version.id ? null : currentId));
      return;
    }

    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    const draft = getCommentDraft(version);
    if (draft === version.comment) {
      setEditingCommentVersionId((currentId) => (currentId === version.id ? null : currentId));
      return;
    }

    setCommentingVersionId(version.id);
    try {
      const response = await setWorkflowPublishedVersionComment(project.relativePath, version.id, draft);
      replaceVersion(response.version);
      setEditingCommentVersionId((currentId) => (currentId === version.id ? null : currentId));
    } catch (err: any) {
      setCommentDrafts((currentDrafts) => ({
        ...currentDrafts,
        [version.id]: version.comment,
      }));
      setEditingCommentVersionId((currentId) => (currentId === version.id ? null : currentId));
      toast.error(err.message || 'Failed to update published version comment');
    } finally {
      setCommentingVersionId((currentId) => (currentId === version.id ? null : currentId));
    }
  };

  const handleCommentKeyDown = (event: KeyboardEvent<HTMLInputElement>, version: WorkflowPublishedVersionSummary) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      skipCommentSaveVersionIdRef.current = version.id;
      setCommentDrafts((currentDrafts) => ({
        ...currentDrafts,
        [version.id]: version.comment,
      }));
      setEditingCommentVersionId((currentId) => (currentId === version.id ? null : currentId));
      event.currentTarget.blur();
    }
  };

  const handleDownloadVersion = async (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    setDownloadingVersionId(version.id);
    try {
      await downloadWorkflowPublishedVersion(project.relativePath, version.id);
    } catch (err: any) {
      toast.error(err.message || 'Failed to download published version');
    } finally {
      setDownloadingVersionId((currentId) => (currentId === version.id ? null : currentId));
    }
  };

  const handleToggleStar = async (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    const nextIsStarred = !version.isStarred;
    setStarringVersionId(version.id);
    setVersions((currentVersions) =>
      currentVersions.map((currentVersion) =>
        currentVersion.id === version.id ? { ...currentVersion, isStarred: nextIsStarred } : currentVersion,
      ),
    );

    try {
      const response = await setWorkflowPublishedVersionStar(project.relativePath, version.id, nextIsStarred);
      replaceVersion(response.version);
    } catch (err: any) {
      setVersions((currentVersions) =>
        currentVersions.map((currentVersion) =>
          currentVersion.id === version.id ? { ...currentVersion, isStarred: version.isStarred } : currentVersion,
        ),
      );
      toast.error(err.message || 'Failed to update published version star');
    } finally {
      setStarringVersionId((currentId) => (currentId === version.id ? null : currentId));
    }
  };

  const handlePreviewVersion = (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    onPreviewVersion(project.relativePath, version.id);
  };

  const handleRestoreVersion = async (version: WorkflowPublishedVersionSummary) => {
    if (
      !project ||
      !review?.endpointName ||
      downloadingVersionId ||
      starringVersionId ||
      commentingVersionId ||
      restoringVersionId
    ) {
      return;
    }

    const { endpointName, preconditions } = review;
    const confirmed = window.confirm(
      `Serve this revision at the ${endpointName} endpoint? Drafts stay in the project tree.`,
    );
    if (!confirmed) {
      return;
    }

    setRestoringVersionId(version.id);
    let submitting = true;
    try {
      const response = await restoreWorkflowPublishedVersion(project.relativePath, version.id, preconditions);
      submitting = false;
      const returnedProjectId = response.project.projectMetadataId;
      const returnedRevisionId = response.project.revisionId;
      const returnedPublicationVersion = response.project.settings.publicationVersion;
      if (
        response.project.relativePath !== project.relativePath ||
        returnedProjectId !== preconditions.expectedProjectId ||
        response.version.projectId !== preconditions.expectedProjectId ||
        response.version.endpointName !== endpointName ||
        response.version.isCurrent !== true ||
        getRestoreEndpointName(response.project) !== endpointName ||
        !returnedRevisionId ||
        !isNextPublicationVersion(preconditions.expectedPublicationVersion, returnedPublicationVersion)
      ) {
        setReview(null);
        setError('The restored publication state could not be verified.');
        await onRestoreUnconfirmed();
        return;
      }
      setReview({
        preconditions: {
          expectedProjectId: returnedProjectId,
          expectedDraftRevisionId: returnedRevisionId,
          expectedPublicationVersion: returnedPublicationVersion,
        },
        endpointName,
      });
      setVersions((currentVersions) => [
        response.version,
        ...currentVersions
          .filter((currentVersion) => currentVersion.id !== response.version.id)
          .map((currentVersion) => ({
            ...currentVersion,
            isCurrent: false,
          })),
      ]);
      setCommentDrafts((currentDrafts) => ({
        ...currentDrafts,
        [response.version.id]: response.version.comment,
      }));
      setEditingCommentVersionId(null);
      setPage(1);
      await Promise.resolve(onRestored(response)).catch((refreshError: any) => {
        toast.error(refreshError.message || 'Restored published version, but failed to refresh the project tree');
      });
    } catch (err: any) {
      if (submitting && isUnconfirmedPublication(err)) {
        setReview(null);
        setError('The restore outcome could not be confirmed.');
        await onRestoreUnconfirmed();
      } else {
        toast.error(err.message || 'Failed to restore published version');
        if (err.status === 409 && err.code?.startsWith('publication_')) {
          setReview(null);
          setError('The project or publication changed. Review the latest state before restoring.');
        }
      }
    } finally {
      setRestoringVersionId((currentId) => (currentId === version.id ? null : currentId));
    }
  };

  return isOpen && project ? (
    <div className="published-version-history-content">
      {loading ? (
        <div className="published-version-history-state">Loading published revisions...</div>
      ) : error ? (
        <div className="published-version-history-state published-version-history-error">
          {error}{' '}
          <Button appearance="subtle" onClick={() => setReviewRequested((count) => count + 1)}>
            Review latest
          </Button>
        </div>
      ) : versions.length === 0 ? (
        <div className="published-version-history-state">
          No published revisions have been saved for this project yet.
        </div>
      ) : (
        <>
          {review && !review.endpointName && <div role="status">Restore requires a configured endpoint name.</div>}
          <div className="published-version-history-list" role="list">
            {visibleVersions.map((version) => (
              <div className="published-version-history-row" role="listitem" key={version.id}>
                <div className="published-version-history-details">
                  <div className="published-version-history-date-row">
                    <span className="published-version-history-date" title={version.publishedAt}>
                      {formatPublishedVersionDate(version.publishedAt)}
                    </span>
                    {version.isCurrent ? (
                      <span className="published-version-history-current-badge">Current</span>
                    ) : null}
                    {version.coverage === 'project-only' && (
                      <span title="Earlier dependency revisions may be unavailable">Project only</span>
                    )}
                  </div>
                  <div className="published-version-history-endpoint" title={version.endpointName}>
                    {version.endpointName}
                  </div>
                  {editingCommentVersionId === version.id ? (
                    <input
                      type="text"
                      className="published-version-history-comment-input"
                      value={getCommentDraft(version)}
                      placeholder="Add comment"
                      maxLength={WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH}
                      disabled={
                        downloadingVersionId != null ||
                        starringVersionId != null ||
                        commentingVersionId != null ||
                        restoringVersionId != null
                      }
                      aria-label={`Comment for published version ${version.id}`}
                      autoFocus
                      onChange={(event) => handleCommentDraftChange(version.id, event.currentTarget.value)}
                      onBlur={() => void handleSaveComment(version)}
                      onKeyDown={(event) => handleCommentKeyDown(event, version)}
                    />
                  ) : version.comment ? (
                    <button
                      type="button"
                      className="published-version-history-comment-text"
                      onClick={() => handleStartCommentEdit(version)}
                      disabled={!canEditComment}
                      aria-label={`Edit comment for published version ${version.id}`}
                      title="Edit comment"
                    >
                      {version.comment}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="published-version-history-comment-link"
                      onClick={() => handleStartCommentEdit(version)}
                      disabled={!canEditComment}
                      aria-label={`Add comment for published version ${version.id}`}
                    >
                      Comment
                    </button>
                  )}
                </div>
                <div className="published-version-history-actions">
                  <button
                    type="button"
                    className={['published-version-history-star-button', version.isStarred ? 'starred' : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => void handleToggleStar(version)}
                    disabled={
                      downloadingVersionId != null ||
                      starringVersionId != null ||
                      commentingVersionId != null ||
                      restoringVersionId != null
                    }
                    aria-label={`${version.isStarred ? 'Unstar' : 'Star'} published version`}
                    aria-pressed={version.isStarred}
                    title={version.isStarred ? 'Unstar version' : 'Star version'}
                  >
                    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                      <path
                        d="M12 3.5l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.52 6.9 19.2l.97-5.68L3.75 9.5l5.7-.83L12 3.5z"
                        fill={version.isStarred ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        strokeLinejoin="round"
                        strokeWidth="1.8"
                      />
                    </svg>
                  </button>
                  <Button
                    appearance="subtle"
                    className="project-settings-secondary-button button-size-m published-version-history-preview-button"
                    onClick={() => handlePreviewVersion(version)}
                    isDisabled={
                      downloadingVersionId != null ||
                      starringVersionId != null ||
                      commentingVersionId != null ||
                      restoringVersionId != null
                    }
                  >
                    Preview
                  </Button>
                  <LoadingButton
                    appearance="subtle"
                    className="project-settings-secondary-button button-size-m published-version-history-restore-button"
                    onClick={() => void handleRestoreVersion(version)}
                    isLoading={restoringVersionId === version.id}
                    isDisabled={
                      !review?.endpointName ||
                      downloadingVersionId != null ||
                      starringVersionId != null ||
                      commentingVersionId != null ||
                      (restoringVersionId != null && restoringVersionId !== version.id)
                    }
                  >
                    Restore
                  </LoadingButton>
                  <LoadingButton
                    appearance="subtle"
                    className="project-settings-secondary-button button-size-m published-version-history-download-button"
                    onClick={() => void handleDownloadVersion(version)}
                    isLoading={downloadingVersionId === version.id}
                    isDisabled={
                      starringVersionId != null ||
                      commentingVersionId != null ||
                      restoringVersionId != null ||
                      (downloadingVersionId != null && downloadingVersionId !== version.id)
                    }
                  >
                    Download
                  </LoadingButton>
                </div>
              </div>
            ))}
          </div>
          {shouldShowPagination ? (
            <div className="published-version-history-pagination" aria-label="Published revision history pages">
              <button
                type="button"
                className="published-version-history-page-button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={currentPage <= 1}
              >
                Previous
              </button>
              <span className="published-version-history-page-status">
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                className="published-version-history-page-button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={currentPage >= totalPages}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  ) : null;
};
