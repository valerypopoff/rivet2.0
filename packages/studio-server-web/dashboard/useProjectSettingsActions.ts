import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import {
  deleteWorkflowProject,
  fetchWorkflowProjectWebApps,
  publishWorkflowProject,
  publishWorkflowProjectWebApps,
  unpublishWorkflowProject,
  updateWorkflowEndpointAccess,
  unpublishWorkflowProjectWebApp,
  updateWorkflowProjectWebAppAccess,
} from './workflowApi';
import { WORKFLOW_ENDPOINT_MAIN_GRAPH_REQUIRED_MESSAGE } from '../../studio-server-shared/workflow-types';
import { ENDPOINT_NAME_PATTERN, validateEndpointName } from './projectSettingsForm';
import { isNextPublicationVersion, isPublicationVersion } from './publicationVersion';
import type {
  WorkflowPublicationPreconditions,
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppSummary,
  WorkflowProjectWebAppsResponse,
  WorkflowTreeResponse,
} from './types';

type UseProjectSettingsActionsOptions = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  // Tree refresh returns null on failure or when superseded by another refresh.
  onRefresh: () => Promise<WorkflowTreeResponse | null>;
};

function createSlugFromWebAppName(name: string, fallback: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  if (normalized) {
    return normalized;
  }

  return fallback
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'web-app';
}

function createInitialWebAppSlugDrafts(webApps: WorkflowProjectWebAppSummary[]): Record<string, string> {
  const seen = new Set<string>();
  const drafts: Record<string, string> = {};

  for (const webApp of webApps) {
    const baseSlug = webApp.publishedSlug ?? createSlugFromWebAppName(webApp.name, webApp.uiGraphId);
    let slug = baseSlug;
    let suffix = 2;
    while (seen.has(slug.toLowerCase())) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }

    seen.add(slug.toLowerCase());
    drafts[webApp.uiGraphId] = slug;
  }

  return drafts;
}

function createInitialWebAppAllowedEmailDrafts(webApps: WorkflowProjectWebAppSummary[]): Record<string, string> {
  return Object.fromEntries(webApps.map((webApp) => [
    webApp.uiGraphId,
    (webApp.allowedEmails ?? []).join('\n'),
  ]));
}

function parseAllowedEmailDraft(value: string): string[] {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const rawEmail of value.split(/[\n,;]/)) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || seen.has(email)) {
      continue;
    }

    seen.add(email);
    emails.push(email);
  }

  return emails;
}

function validateAllowedEmails(emails: readonly string[]): string | null {
  const invalidEmail = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return invalidEmail ? `Invalid email: ${invalidEmail}` : null;
}

function carryEditedWebAppDrafts(
  drafts: Record<string, string>,
  previousServerValues: Record<string, string>,
  nextServerValues: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(nextServerValues).map(([id, value]) => [
    id,
    Object.hasOwn(previousServerValues, id) && Object.hasOwn(drafts, id) && drafts[id] !== previousServerValues[id]
      ? drafts[id]
      : value,
  ]));
}

function publicationSnapshotFromProject(
  project: WorkflowProjectItem,
): WorkflowPublicationPreconditions {
  return {
    // Missing server tokens must never re-arm the modal after a mutation.
    expectedProjectId: project.projectMetadataId ?? '',
    expectedDraftRevisionId: project.revisionId ?? '',
    expectedPublicationVersion: project.settings.publicationVersion ?? '',
  };
}

export function useProjectSettingsActions(options: UseProjectSettingsActionsOptions) {
  const {
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
  } = options;
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({
    endpointName: activeProject.settings.endpointName,
  });
  const previousServerEndpointName = useRef(activeProject.settings.endpointName);
  // The modal is keyed by project and unmounted on close. Background tree
  // updates must not silently approve a newer draft for publication.
  const [reviewedPublication, setReviewedPublication] = useState<WorkflowPublicationPreconditions | null>(null);
  const [snapshotProject, setSnapshotProject] = useState<WorkflowProjectItem | null>(null);
  const [publicationConflict, setPublicationConflict] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingEndpointAccess, setSavingEndpointAccess] = useState(false);
  const [webApps, setWebApps] = useState<WorkflowProjectWebAppSummary[]>([]);
  const [webAppSlugDrafts, setWebAppSlugDrafts] = useState<Record<string, string>>({});
  const [webAppAllowedEmailDrafts, setWebAppAllowedEmailDrafts] = useState<Record<string, string>>({});
  const serverWebAppSlugs = useRef<Record<string, string>>({});
  const serverWebAppAllowedEmails = useRef<Record<string, string>>({});
  const [hasMainGraph, setHasMainGraph] = useState<boolean | null>(null);
  const [loadingWebApps, setLoadingWebApps] = useState(false);
  const [savingWebApps, setSavingWebApps] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    if (!snapshotProject) return;
    const previous = previousServerEndpointName.current;
    const current = snapshotProject.settings.endpointName;
    previousServerEndpointName.current = current;
    setSettingsDraft((draft) => draft.endpointName === previous ? { endpointName: current } : draft);
  }, [snapshotProject?.settings.endpointName]);

  const applyWebAppSnapshot = useCallback((
    response: WorkflowProjectWebAppsResponse,
    preserveDrafts: boolean,
    expectedAfterMutation?: WorkflowPublicationPreconditions,
    reviewedDraftRevisionId?: string,
  ) => {
    const consistentProject = response.project?.relativePath === activeProject.relativePath &&
      response.project.projectMetadataId === response.projectId &&
      response.project.revisionId === response.draftRevisionId &&
      response.project.settings.publicationVersion === response.publicationVersion &&
      isPublicationVersion(response.publicationVersion);
    if (!consistentProject) {
      setReviewedPublication(null);
      setPublicationConflict(true);
      toast.error('Publication state is inconsistent. Review the latest project before publishing.');
      return;
    }
    setWebApps(response.webApps);
    setHasMainGraph(response.hasMainGraph);
    setSnapshotProject(response.project);
    const matchesMutation = !expectedAfterMutation || (
      response.projectId === expectedAfterMutation.expectedProjectId &&
      response.draftRevisionId === expectedAfterMutation.expectedDraftRevisionId &&
      response.publicationVersion === expectedAfterMutation.expectedPublicationVersion &&
      response.draftRevisionId === reviewedDraftRevisionId
    );
    if (response.projectId && response.draftRevisionId && matchesMutation) {
      setReviewedPublication({
        expectedProjectId: response.projectId,
        expectedDraftRevisionId: response.draftRevisionId,
        expectedPublicationVersion: response.publicationVersion,
      });
      setPublicationConflict(false);
    } else {
      setReviewedPublication(null);
      setPublicationConflict(Boolean(expectedAfterMutation));
      if (!expectedAfterMutation) toast.error('Publication state is unavailable. Refresh the project before publishing.');
    }
    const slugs = createInitialWebAppSlugDrafts(response.webApps);
    const emails = createInitialWebAppAllowedEmailDrafts(response.webApps);
    const previousSlugs = serverWebAppSlugs.current;
    const previousEmails = serverWebAppAllowedEmails.current;
    serverWebAppSlugs.current = slugs;
    serverWebAppAllowedEmails.current = emails;
    setWebAppSlugDrafts((drafts) => preserveDrafts ? carryEditedWebAppDrafts(drafts, previousSlugs, slugs) : slugs);
    setWebAppAllowedEmailDrafts((drafts) => preserveDrafts ? carryEditedWebAppDrafts(drafts, previousEmails, emails) : emails);
  }, [activeProject.relativePath]);

  const reloadWebApps = useCallback(async (
    project: WorkflowProjectItem,
    previous: WorkflowPublicationPreconditions,
  ) => {
    const expectedAfterMutation = publicationSnapshotFromProject(project);
    if (project.relativePath !== activeProject.relativePath ||
        expectedAfterMutation.expectedProjectId !== previous.expectedProjectId ||
        !expectedAfterMutation.expectedDraftRevisionId ||
        !isNextPublicationVersion(previous.expectedPublicationVersion, expectedAfterMutation.expectedPublicationVersion)) {
      setReviewedPublication(null);
      setPublicationConflict(true);
      toast.error('The change succeeded, but publication state could not be verified. Review the latest state before trying again.');
      return;
    }
    setLoadingWebApps(true);

    try {
      const response = await fetchWorkflowProjectWebApps(activeProject.relativePath);
      applyWebAppSnapshot(response, true, expectedAfterMutation, previous.expectedDraftRevisionId);
    } catch {
      toast.error('The change succeeded, but publication state could not refresh. Review the latest state before trying again.');
      setReviewedPublication(null);
      setPublicationConflict(true);
    } finally {
      setLoadingWebApps(false);
    }
  }, [activeProject.relativePath, applyWebAppSnapshot]);

  useEffect(() => {
    setWebApps([]);
    setHasMainGraph(null);
    setSnapshotProject(null);
    setWebAppSlugDrafts({});
    setWebAppAllowedEmailDrafts({});
    serverWebAppSlugs.current = {};
    serverWebAppAllowedEmails.current = {};
    setReviewedPublication(null);
    setPublicationConflict(false);

    if (!isOpen) {
      setLoadingWebApps(false);
      return;
    }

    let cancelled = false;
    setLoadingWebApps(true);

    fetchWorkflowProjectWebApps(activeProject.relativePath)
      .then((response) => {
        if (cancelled) {
          return;
        }

        applyWebAppSnapshot(response, false);
      })
      .catch((err: any) => {
        if (!cancelled) {
          toast.error(err.message || 'Failed to load project web apps');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingWebApps(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeProject.relativePath, applyWebAppSnapshot, isOpen]);

  const trimmedDraftEndpointName = useMemo(() => settingsDraft.endpointName.trim(), [settingsDraft.endpointName]);
  const endpointLookupName = useMemo(() => trimmedDraftEndpointName.toLowerCase(), [trimmedDraftEndpointName]);

  const endpointDuplicateProject = useMemo(() => {
    if (!endpointLookupName) {
      return null;
    }

    return allProjects.find(
      (project) =>
        project.absolutePath !== activeProject.absolutePath &&
        project.settings.status !== 'unpublished' &&
        project.settings.endpointName.trim().toLowerCase() === endpointLookupName,
    ) ?? null;
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
      const error = validateAllowedEmails(parseAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''));
      if (error) {
        errors[webApp.uiGraphId] = error;
      }
    }

    return errors;
  }, [webAppAllowedEmailDrafts, webApps]);

  const handleSettingsDraftChange =
    <K extends keyof WorkflowProjectSettingsDraft>(key: K) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as WorkflowProjectSettingsDraft[K];
      setSettingsDraft((prev) => ({
        ...prev,
        [key]: value,
      }));
    };

  const handleWebAppSlugDraftChange =
    (uiGraphId: string) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      setWebAppSlugDrafts((prev) => ({
        ...prev,
        [uiGraphId]: event.target.value,
      }));
    };

  const handleWebAppAllowedEmailsDraftChange =
    (uiGraphId: string) =>
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      setWebAppAllowedEmailDrafts((prev) => ({
        ...prev,
        [uiGraphId]: event.target.value,
      }));
    };

  const requireReviewedPublication = (): WorkflowPublicationPreconditions | null => {
    if (reviewedPublication) return reviewedPublication;
    toast.error('Review the latest project and publication state before trying again.');
    return null;
  };

  const handlePublicationError = (error: { status?: number; code?: string; message?: string }, fallback: string) => {
    if (error.status === 409 && error.code?.startsWith('publication_')) {
      setReviewedPublication(null);
      setPublicationConflict(true);
    }
    toast.error(error.message || fallback);
  };

  const reviewLatestPublication = async () => {
    setLoadingWebApps(true);
    try {
      const snapshot = await fetchWorkflowProjectWebApps(activeProject.relativePath);
      const tree = await onRefresh();
      if (!tree) throw new Error('Could not refresh the project list. Try again.');
      applyWebAppSnapshot(snapshot, true);
    } catch (error: any) {
      toast.error(error.message || 'Could not review the latest publication state.');
    } finally {
      setLoadingWebApps(false);
    }
  };

  const refreshTreeAfterSuccess = async () => {
    try {
      if (!await onRefresh()) toast.error('The change succeeded, but the project list could not refresh. Refresh to see the latest state.');
    } catch {
      toast.error('The change succeeded, but the project list could not refresh. Refresh to see the latest state.');
    }
  };

  const acceptReturnedPublication = (project: WorkflowProjectItem, previous: WorkflowPublicationPreconditions) => {
    const next = publicationSnapshotFromProject(project);
    if (
      project.relativePath !== activeProject.relativePath ||
      next.expectedProjectId !== previous.expectedProjectId ||
      !next.expectedDraftRevisionId ||
      !isNextPublicationVersion(previous.expectedPublicationVersion, next.expectedPublicationVersion)
    ) {
      setReviewedPublication(null);
      setPublicationConflict(true);
      toast.error('The change succeeded, but publication state could not be verified. Review the latest state before trying again.');
      return;
    }
    setSnapshotProject(project);
    if (next.expectedDraftRevisionId !== previous.expectedDraftRevisionId) {
      setReviewedPublication(null);
      setPublicationConflict(true);
      toast.error('The change succeeded, but the project draft changed. Review the latest state before publishing.');
      return;
    }
    // Access and unpublish commands do not review the graph draft. A newer
    // revision in their response must require explicit review, not re-arm it.
    setReviewedPublication({ ...previous, expectedPublicationVersion: next.expectedPublicationVersion });
  };

  const handlePublishProject = async () => {
    if (endpointValidationError) {
      return;
    }
    const preconditions = requireReviewedPublication();
    if (!preconditions?.expectedDraftRevisionId) return;

    setSavingSettings(true);

    try {
      const project = await publishWorkflowProject(activeProject.relativePath, {
        endpointName: settingsDraft.endpointName,
      }, preconditions);
      acceptReturnedPublication(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      handlePublicationError(err, 'Failed to update project publication state');
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
      handlePublicationError(err, 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleEndpointAccessChange = async (access: 'public' | 'internal') => {
    const currentProject = snapshotProject ?? activeProject;
    if (currentProject.settings.status === 'unpublished' || access === (currentProject.settings.endpointAccess ?? 'public')) return;
    const preconditions = requireReviewedPublication();
    if (!preconditions) return;
    setSavingEndpointAccess(true);
    try {
      const project = await updateWorkflowEndpointAccess(activeProject.relativePath, access, preconditions);
      acceptReturnedPublication(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      handlePublicationError(err, 'Failed to update endpoint access');
    } finally {
      setSavingEndpointAccess(false);
    }
  };

  const handleDeleteActiveProject = async () => {
    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
      const deletedProject = await deleteWorkflowProject(activeProject.relativePath);
      onDeleteProject(activeProject.absolutePath, deletedProject.projectId);
      onClose();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  const createWebAppPublicationDrafts = (uiGraphId?: string): WorkflowProjectWebAppPublicationDraft[] => {
    const selectedWebApps = uiGraphId
      ? webApps.filter((webApp) => webApp.uiGraphId === uiGraphId)
      : webApps;

    return selectedWebApps.reduce<WorkflowProjectWebAppPublicationDraft[]>((drafts, webApp) => {
      if (webApp.isMissingFromProject) {
        return drafts;
      }

      const slug = (webAppSlugDrafts[webApp.uiGraphId] ?? '').trim();
      if (
        webApp.publishedSlug != null &&
        webApp.status !== 'unpublished_changes' &&
        slug === webApp.publishedSlug
      ) {
        return drafts;
      }

      drafts.push({
        uiGraphId: webApp.uiGraphId,
        slug,
        allowedEmails: parseAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
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
      handlePublicationError(err, 'Failed to publish web app');
    } finally {
      setSavingWebApps(false);
    }
  };

  const createWebAppAccessDraft = (webApp: WorkflowProjectWebAppSummary): WorkflowProjectWebAppAccessDraft => ({
    uiGraphId: webApp.uiGraphId,
    allowedEmails: parseAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
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
      const project = await updateWorkflowProjectWebAppAccess(activeProject.relativePath, [createWebAppAccessDraft(webApp)], preconditions);
      await reloadWebApps(project, preconditions);
      await refreshTreeAfterSuccess();
    } catch (err: any) {
      handlePublicationError(err, 'Failed to update web app access');
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
      handlePublicationError(err, 'Failed to unpublish web app');
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
