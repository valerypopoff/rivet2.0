import Button, { LoadingButton } from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { type FC, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { WORKFLOW_PUBLISHED_VERSION_COMMENT_MAX_LENGTH } from '../../studio-server-shared/workflow-types';

import type {
  WorkflowProjectItem,
  WorkflowPublishedVersionRestoreResponse,
  WorkflowPublishedVersionSummary,
} from './types';
import {
  downloadWorkflowPublishedVersion,
  fetchWorkflowPublishedVersions,
  restoreWorkflowPublishedVersion,
  setWorkflowPublishedVersionComment,
  setWorkflowPublishedVersionStar,
} from './workflowApi';

const PUBLISHED_VERSION_HISTORY_PAGE_SIZE = 10;

type WorkflowPublishedVersionHistoryModalProps = {
  project: WorkflowProjectItem | null;
  isOpen: boolean;
  onClose: () => void;
  onPreviewVersion: (relativePath: string, versionId: string) => void;
  onRestored: (response: WorkflowPublishedVersionRestoreResponse) => void | Promise<void>;
};

function formatPublishedVersionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function createCommentDrafts(versions: WorkflowPublishedVersionSummary[]): Record<string, string> {
  return Object.fromEntries(versions.map((version) => [version.id, version.comment]));
}

export const WorkflowPublishedVersionHistoryModal: FC<WorkflowPublishedVersionHistoryModalProps> = ({
  project,
  isOpen,
  onClose,
  onPreviewVersion,
  onRestored,
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
  const skipCommentSaveVersionIdRef = useRef<string | null>(null);
  const canClose = !downloadingVersionId && !starringVersionId && !commentingVersionId && !restoringVersionId;
  const projectTitle = useMemo(() => project?.name ?? 'Published version history', [project?.name]);
  const totalPages = Math.max(1, Math.ceil(versions.length / PUBLISHED_VERSION_HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleVersions = useMemo(() => {
    const startIndex = (currentPage - 1) * PUBLISHED_VERSION_HISTORY_PAGE_SIZE;
    return versions.slice(startIndex, startIndex + PUBLISHED_VERSION_HISTORY_PAGE_SIZE);
  }, [currentPage, versions]);
  const shouldShowPagination = versions.length > PUBLISHED_VERSION_HISTORY_PAGE_SIZE;

  useEffect(() => {
    if (!isOpen || !project) {
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
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setEditingCommentVersionId(null);
    void fetchWorkflowPublishedVersions(project.relativePath)
      .then((response) => {
        if (!cancelled) {
          setVersions(response.versions);
          setCommentDrafts(createCommentDrafts(response.versions));
          setPage(1);
        }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load published version history');
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
  }, [isOpen, project]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const replaceVersion = (nextVersion: WorkflowPublishedVersionSummary) => {
    setVersions((currentVersions) => currentVersions.map((currentVersion) =>
      currentVersion.id === nextVersion.id ? nextVersion : currentVersion));
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
      setEditingCommentVersionId((currentId) => currentId === version.id ? null : currentId);
      return;
    }

    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    const draft = getCommentDraft(version);
    if (draft === version.comment) {
      setEditingCommentVersionId((currentId) => currentId === version.id ? null : currentId);
      return;
    }

    setCommentingVersionId(version.id);
    try {
      const response = await setWorkflowPublishedVersionComment(project.relativePath, version.id, draft);
      replaceVersion(response.version);
      setEditingCommentVersionId((currentId) => currentId === version.id ? null : currentId);
    } catch (err: any) {
      setCommentDrafts((currentDrafts) => ({
        ...currentDrafts,
        [version.id]: version.comment,
      }));
      setEditingCommentVersionId((currentId) => currentId === version.id ? null : currentId);
      toast.error(err.message || 'Failed to update published version comment');
    } finally {
      setCommentingVersionId((currentId) => currentId === version.id ? null : currentId);
    }
  };

  const handleCommentKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    version: WorkflowPublishedVersionSummary,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      skipCommentSaveVersionIdRef.current = version.id;
      setCommentDrafts((currentDrafts) => ({
        ...currentDrafts,
        [version.id]: version.comment,
      }));
      setEditingCommentVersionId((currentId) => currentId === version.id ? null : currentId);
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
      setDownloadingVersionId((currentId) => currentId === version.id ? null : currentId);
    }
  };

  const handleToggleStar = async (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    const nextIsStarred = !version.isStarred;
    setStarringVersionId(version.id);
    setVersions((currentVersions) => currentVersions.map((currentVersion) =>
      currentVersion.id === version.id
        ? { ...currentVersion, isStarred: nextIsStarred }
        : currentVersion));

    try {
      const response = await setWorkflowPublishedVersionStar(project.relativePath, version.id, nextIsStarred);
      replaceVersion(response.version);
    } catch (err: any) {
      setVersions((currentVersions) => currentVersions.map((currentVersion) =>
        currentVersion.id === version.id
          ? { ...currentVersion, isStarred: version.isStarred }
          : currentVersion));
      toast.error(err.message || 'Failed to update published version star');
    } finally {
      setStarringVersionId((currentId) => currentId === version.id ? null : currentId);
    }
  };

  const handlePreviewVersion = (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    onPreviewVersion(project.relativePath, version.id);
  };

  const handleRestoreVersion = async (version: WorkflowPublishedVersionSummary) => {
    if (!project || downloadingVersionId || starringVersionId || commentingVersionId || restoringVersionId) {
      return;
    }

    const confirmed = window.confirm(
      'Restore this published version and publish it as the current version?',
    );
    if (!confirmed) {
      return;
    }

    setRestoringVersionId(version.id);
    try {
      const response = await restoreWorkflowPublishedVersion(project.relativePath, version.id);
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
      toast.error(err.message || 'Failed to restore published version');
    } finally {
      setRestoringVersionId((currentId) => currentId === version.id ? null : currentId);
    }
  };

  return (
    <ModalTransition>
      {isOpen && project ? (
        <ModalDialog
          testId="workflow-published-version-history-modal"
          width="large"
          label="Published version history"
          onClose={onClose}
          shouldCloseOnOverlayClick={canClose}
          shouldCloseOnEscapePress={canClose}
        >
          <ModalBody>
            <div className="project-settings-modal-shell published-version-history-modal-shell">
              <div className="project-settings-modal-header-row">
                <div className="project-settings-modal-heading">
                  <span className="project-settings-modal-title">Published version history</span>
                  <span className="published-version-history-project-name" title={projectTitle}>
                    {projectTitle}
                  </span>
                </div>
                <button
                  type="button"
                  className="project-settings-close-button"
                  onClick={onClose}
                  disabled={!canClose}
                  aria-label="Close published version history"
                >
                  Close
                </button>
              </div>

              <div className="project-settings-modal-content published-version-history-content">
                {loading ? (
                  <div className="published-version-history-state">Loading published versions...</div>
                ) : error ? (
                  <div className="published-version-history-state published-version-history-error">{error}</div>
                ) : versions.length === 0 ? (
                  <div className="published-version-history-state">
                    No published versions have been saved for this project yet.
                  </div>
                ) : (
                  <>
                    <div className="published-version-history-list" role="list">
                      {visibleVersions.map((version) => (
                        <div className="published-version-history-row" role="listitem" key={version.id}>
                          <div className="published-version-history-details">
                            <div className="published-version-history-date-row">
                              <span className="published-version-history-date">
                                {formatPublishedVersionDate(version.publishedAt)}
                              </span>
                              {version.isCurrent ? (
                                <span className="published-version-history-current-badge">Current</span>
                              ) : null}
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
                                disabled={downloadingVersionId != null || starringVersionId != null || commentingVersionId != null || restoringVersionId != null}
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
                              className={[
                                'published-version-history-star-button',
                                version.isStarred ? 'starred' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={() => void handleToggleStar(version)}
                              disabled={downloadingVersionId != null || starringVersionId != null || commentingVersionId != null || restoringVersionId != null}
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
                              isDisabled={downloadingVersionId != null || starringVersionId != null || commentingVersionId != null || restoringVersionId != null}
                            >
                              Preview
                            </Button>
                            <LoadingButton
                              appearance="subtle"
                              className="project-settings-secondary-button button-size-m published-version-history-restore-button"
                              onClick={() => void handleRestoreVersion(version)}
                              isLoading={restoringVersionId === version.id}
                              isDisabled={downloadingVersionId != null || starringVersionId != null || commentingVersionId != null || (restoringVersionId != null && restoringVersionId !== version.id)}
                            >
                              Restore
                            </LoadingButton>
                            <LoadingButton
                              appearance="subtle"
                              className="project-settings-secondary-button button-size-m published-version-history-download-button"
                              onClick={() => void handleDownloadVersion(version)}
                              isLoading={downloadingVersionId === version.id}
                              isDisabled={starringVersionId != null || commentingVersionId != null || restoringVersionId != null || (downloadingVersionId != null && downloadingVersionId !== version.id)}
                            >
                              Download
                            </LoadingButton>
                          </div>
                        </div>
                      ))}
                    </div>
                    {shouldShowPagination ? (
                      <div className="published-version-history-pagination" aria-label="Published version history pages">
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
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
