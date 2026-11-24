import { useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { namespaceIdentity, MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import { useWorkflowLibraryActionLifetime } from './useWorkflowLibraryActionLifetime';
import { useProjectPublicationReview } from './useProjectPublicationReview';
import {
  deleteWorkflowProject,
  publishWorkflowProject,
  reviewEndpointRelease,
  publishWorkflowProjectWebApps,
  unpublishWorkflowProject,
  updateWorkflowEndpointAccess,
  unpublishWorkflowProjectWebApp,
  updateWorkflowProjectWebAppAccess,
} from './workflowApi';
import { WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE } from '../../studio-server-shared/workflow-types';
import { ENDPOINT_NAME_PATTERN, validateEndpointName, parseWebAppAllowedEmailDraft } from './projectSettingsForm';
import { isUnconfirmedPublication } from './publicationVersion';
import type {
  WorkflowPublicationPreconditions,
  WorkflowProjectItem,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppSummary,
  WorkflowTreeResponse,
} from './types';

type UseProjectSettingsActionsOptions = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  getDirtyProjectIds(): readonly string[];
  isOpen: boolean;
  onClose: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  // Tree refresh returns null on failure or when superseded by another refresh.
  onRefresh: () => Promise<WorkflowTreeResponse | null>;
  onStructuralMutation?: (message: string) => void;
};

function validateAllowedEmails(emails: readonly string[]): string | null {
  const invalidEmail = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return invalidEmail ? `Invalid email: ${invalidEmail}` : null;
}

export function useProjectSettingsActions(options: UseProjectSettingsActionsOptions) {
  const { activeProject, allProjects, getDirtyProjectIds, isOpen, onClose, onDeleteProject, onRefresh } = options;
  const captureDelete = useWorkflowLibraryActionLifetime(
    isOpen ? activeProject.projectMetadataId ?? activeProject.absolutePath : null,
  );
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingEndpointAccess, setSavingEndpointAccess] = useState(false);
  const [savingWebApps, setSavingWebApps] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  const {
    settingsDraft,
    reviewedPublication,
    snapshotProject,
    publicationConflict,
    webApps,
    webAppSlugDrafts,
    webAppAllowedEmailDrafts,
    hasMainGraph,
    loadingWebApps,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handleWebAppAllowedEmailsDraftChange,
    reloadWebApps,
    acceptReturnedPublication,
    refreshUnconfirmedPublication,
    reviewLatestPublication,
    markPublicationChanged,
  } = useProjectPublicationReview({ activeProject, isOpen, onRefresh });

  const trimmedDraftEndpointName = useMemo(() => settingsDraft.endpointName.trim(), [settingsDraft.endpointName]);
  const endpointLookupName = useMemo(() => trimmedDraftEndpointName.toLowerCase(), [trimmedDraftEndpointName]);

  const endpointDuplicateProject = useMemo(() => {
    if (!endpointLookupName) {
      return null;
    }

    return (
      allProjects.find(
        (project) =>
          project.absolutePath !== activeProject.absolutePath &&
          project.settings.status !== 'unpublished' &&
          project.settings.endpointName.trim().toLowerCase() === endpointLookupName,
      ) ?? null
    );
  }, [activeProject.absolutePath, allProjects, endpointLookupName]);

  const endpointValidationError = useMemo(() => {
    if (hasMainGraph === false) {
      return WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE;
    }

    const endpointNameError = validateEndpointName(
      trimmedDraftEndpointName,
      endpointDuplicateProject?.fileName ?? null,
    );
    return endpointNameError;
  }, [endpointDuplicateProject, hasMainGraph, trimmedDraftEndpointName]);

  const webAppSlugValidationErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    const seenSlugs = new Map<string, string>();

    for (const webApp of webApps) {
      if (webApp.isMissingFromProject && webApp.publishedSlug) {
        seenSlugs.set(webApp.publishedSlug.toLowerCase(), webApp.name);
      }
    }

    for (const webApp of webApps) {
      const slug = (webAppSlugDrafts[webApp.uiGraphId] ?? '').trim();
      if (webApp.isMissingFromProject) {
        continue;
      }

      if (!slug) {
        errors[webApp.uiGraphId] = 'Web app URL slug is required.';
        continue;
      }

      if (!ENDPOINT_NAME_PATTERN.test(slug)) {
        errors[webApp.uiGraphId] = 'URL slug must contain only letters, numbers, and hyphens.';
        continue;
      }

      const lookup = slug.toLowerCase();
      const existingWebAppName = seenSlugs.get(lookup);
      if (existingWebAppName) {
        errors[webApp.uiGraphId] = `URL slug is already used by ${existingWebAppName}.`;
        continue;
      }

      seenSlugs.set(lookup, webApp.name);
    }

    return errors;
  }, [webApps, webAppSlugDrafts]);

  const webAppAccessValidationErrors = useMemo(() => {
    const errors: Record<string, string> = {};
    for (const webApp of webApps) {
      const error = validateAllowedEmails(
        parseWebAppAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
      );
      if (error) {
        errors[webApp.uiGraphId] = error;
      }
    }

    return errors;
  }, [webAppAllowedEmailDrafts, webApps]);

  const requireReviewedPublication = (): WorkflowPublicationPreconditions | null => {
    if (reviewedPublication) return reviewedPublication;
    toast.error('Review the latest project and publication state before trying again.');
    return null;
  };

  const handlePublicationError = async (
    error: { status?: number; code?: string; message?: string },
    fallback: string,
    submitted = true,
  ) => {
    if (submitted && isUnconfirmedPublication(error)) {
      await refreshUnconfirmedPublication();
      return;
    }
    if (error.status === 409 && error.code?.startsWith('publication_')) {
      markPublicationChanged();
    }
    toast.error(error.message || fallback);
  };

  const refreshTreeAfterSuccess = async () => {
    try {
      if (!(await onRefresh()))
        toast.error('The change succeeded, but the project list could not refresh. Refresh to see the latest state.');
    } catch {
      toast.error('The change succeeded, but the project list could not refresh. Refresh to see the latest state.');
    }
  };

  const handlePublishProject = async () => {
    if (endpointValidationError) {
      return;
    }
    const preconditions = requireReviewedPublication();
    if (!preconditions?.expectedDraftRevisionId) return;

    setSavingSettings(true);
    let submitting = false;

    try {
      const release = await reviewEndpointRelease(activeProject.relativePath, preconditions);
      const dirtyIds = new Set(getDirtyProjectIds());
      if (
        dirtyIds.has(preconditions.expectedProjectId) ||
        release?.projects.some((project) => project.fromDraft && dirtyIds.has(project.projectId))
      ) {
        toast.error('Save the edited projects before publishing this endpoint.');
        return;
      }
      if (
        release?.missingRollback &&
        !window.confirm(
          'The currently served revision cannot be captured for rollback. Publish the reviewed replacement?',
        )
      )
        return;
      submitting = true;
      const project = await publishWorkflowProject(
        activeProject.relativePath,
        {
          endpointName: settingsDraft.endpointName,
          releaseReviewToken: release?.token,
          acknowledgeMissingRollback: release?.missingRollback,
        },
        preconditions,
      );
      submitting = false;
      acceptReturnedPublication(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to update project publication state', submitting);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUnpublishProject = async () => {
    const preconditions = requireReviewedPublication();
    if (!preconditions) return;
    const shouldProceed = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingSettings(true);

    try {
      const project = await unpublishWorkflowProject(activeProject.relativePath, preconditions);
      acceptReturnedPublication(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleEndpointAccessChange = async (access: 'public' | 'internal') => {
    const currentProject = snapshotProject ?? activeProject;
    if (
      currentProject.settings.status === 'unpublished' ||
      access === (currentProject.settings.endpointAccess ?? 'public')
    )
      return;
    const preconditions = requireReviewedPublication();
    if (!preconditions) return;
    setSavingEndpointAccess(true);
    try {
      const project = await updateWorkflowEndpointAccess(activeProject.relativePath, access, preconditions);
      acceptReturnedPublication(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to update endpoint access');
    } finally {
      setSavingEndpointAccess(false);
    }
  };

  const handleDeleteActiveProject = async () => {
    const isCurrent = captureDelete();
    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
      const deletedProject = await deleteWorkflowProject(activeProject.relativePath, namespaceIdentity(activeProject));
      onDeleteProject(activeProject.absolutePath, deletedProject.projectId);
      if (isCurrent()) onClose();
      if (options.onStructuralMutation)
        options.onStructuralMutation('Project deleted, but library synchronization is pending.');
      else await onRefresh();
    } catch (err: any) {
      if (err instanceof MutationOutcomeUnknownError) options.onStructuralMutation?.(err.message);
      if (isCurrent()) toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  const createWebAppPublicationDrafts = (uiGraphId?: string): WorkflowProjectWebAppPublicationDraft[] => {
    const selectedWebApps = uiGraphId ? webApps.filter((webApp) => webApp.uiGraphId === uiGraphId) : webApps;

    return selectedWebApps.reduce<WorkflowProjectWebAppPublicationDraft[]>((drafts, webApp) => {
      if (webApp.isMissingFromProject) {
        return drafts;
      }

      const slug = (webAppSlugDrafts[webApp.uiGraphId] ?? '').trim();
      if (webApp.publishedSlug != null && webApp.status !== 'unpublished_changes' && slug === webApp.publishedSlug) {
        return drafts;
      }

      drafts.push({
        uiGraphId: webApp.uiGraphId,
        slug,
        allowedEmails: parseWebAppAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
      });
      return drafts;
    }, []);
  };

  const handlePublishWebApps = async (uiGraphId?: string) => {
    const preconditions = requireReviewedPublication();
    if (!preconditions?.expectedDraftRevisionId) return;
    const validationError = uiGraphId
      ? webAppSlugValidationErrors[uiGraphId]
      : Object.values(webAppSlugValidationErrors)[0];
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const accessValidationError = uiGraphId
      ? webAppAccessValidationErrors[uiGraphId]
      : Object.values(webAppAccessValidationErrors)[0];
    if (accessValidationError) {
      toast.error(accessValidationError);
      return;
    }

    const publications = createWebAppPublicationDrafts(uiGraphId);
    if (publications.length === 0) {
      toast.error(uiGraphId ? 'No web app changes to update.' : 'No web app changes to publish.');
      return;
    }

    setSavingWebApps(true);

    try {
      const project = await publishWorkflowProjectWebApps(activeProject.relativePath, publications, preconditions);
      await reloadWebApps(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to publish web app');
    } finally {
      setSavingWebApps(false);
    }
  };

  const createWebAppAccessDraft = (webApp: WorkflowProjectWebAppSummary): WorkflowProjectWebAppAccessDraft => ({
    uiGraphId: webApp.uiGraphId,
    allowedEmails: parseWebAppAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
  });

  const handleSaveWebAppAccess = async (webApp: WorkflowProjectWebAppSummary) => {
    const preconditions = requireReviewedPublication();
    if (!preconditions) return;
    const validationError = webAppAccessValidationErrors[webApp.uiGraphId];
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSavingWebApps(true);

    try {
      const project = await updateWorkflowProjectWebAppAccess(
        activeProject.relativePath,
        [createWebAppAccessDraft(webApp)],
        preconditions,
      );
      await reloadWebApps(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to update web app access');
    } finally {
      setSavingWebApps(false);
    }
  };

  const handleUnpublishWebApp = async (webApp: WorkflowProjectWebAppSummary) => {
    const preconditions = requireReviewedPublication();
    if (!preconditions) return;
    const shouldProceed = window.confirm(`Unpublish web app "${webApp.name}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingWebApps(true);

    try {
      const project = await unpublishWorkflowProjectWebApp(activeProject.relativePath, webApp.uiGraphId, preconditions);
      await reloadWebApps(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      await handlePublicationError(err, 'Failed to unpublish web app');
    } finally {
      setSavingWebApps(false);
    }
  };

  return {
    settingsDraft,
    snapshotProject,
    savingSettings,
    savingEndpointAccess,
    webApps,
    webAppSlugDrafts,
    webAppAllowedEmailDrafts,
    webAppSlugValidationErrors,
    webAppAccessValidationErrors,
    loadingWebApps,
    reviewedPublication,
    publicationConflict,
    refreshUnconfirmedPublication,
    reviewLatestPublication,
    savingWebApps,
    deletingProject,
    trimmedDraftEndpointName,
    endpointValidationError,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handleWebAppAllowedEmailsDraftChange,
    handlePublishProject,
    handleUnpublishProject,
    handleEndpointAccessChange,
    handlePublishWebApps,
    handleUnpublishWebApp,
    handleSaveWebAppAccess,
    handleDeleteActiveProject,
  };
}
