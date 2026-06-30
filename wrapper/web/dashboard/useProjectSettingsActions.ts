import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import {
  deleteWorkflowProject,
  fetchWorkflowProjectWebApps,
  publishWorkflowProject,
  publishWorkflowProjectWebApps,
  unpublishWorkflowProject,
  unpublishWorkflowProjectWebApp,
  updateWorkflowProjectWebAppAccess,
} from './workflowApi';
import { ENDPOINT_NAME_PATTERN, validateEndpointName } from './projectSettingsForm';
import type {
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppAccessDraft,
  WorkflowProjectWebAppPublicationDraft,
  WorkflowProjectWebAppSummary,
} from './types';

type UseProjectSettingsActionsOptions = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onRefresh: () => void | Promise<void>;
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

export function useProjectSettingsActions(options: UseProjectSettingsActionsOptions) {
  const {
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
  } = options;
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({ endpointName: '' });
  const [savingSettings, setSavingSettings] = useState(false);
  const [webApps, setWebApps] = useState<WorkflowProjectWebAppSummary[]>([]);
  const [webAppSlugDrafts, setWebAppSlugDrafts] = useState<Record<string, string>>({});
  const [webAppAllowedEmailDrafts, setWebAppAllowedEmailDrafts] = useState<Record<string, string>>({});
  const [loadingWebApps, setLoadingWebApps] = useState(false);
  const [savingWebApps, setSavingWebApps] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
  }, [activeProject.relativePath, activeProject.settings.endpointName, activeProject.settings.status, isOpen]);

  const reloadWebApps = useCallback(async () => {
    setLoadingWebApps(true);

    try {
      const response = await fetchWorkflowProjectWebApps(activeProject.relativePath);
      setWebApps(response.webApps);
      setWebAppSlugDrafts(createInitialWebAppSlugDrafts(response.webApps));
      setWebAppAllowedEmailDrafts(createInitialWebAppAllowedEmailDrafts(response.webApps));
    } catch (err: any) {
      toast.error(err.message || 'Failed to load project web apps');
      setWebApps([]);
      setWebAppSlugDrafts({});
      setWebAppAllowedEmailDrafts({});
    } finally {
      setLoadingWebApps(false);
    }
  }, [activeProject.relativePath]);

  useEffect(() => {
    setWebApps([]);
    setWebAppSlugDrafts({});
    setWebAppAllowedEmailDrafts({});

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

        setWebApps(response.webApps);
        setWebAppSlugDrafts(createInitialWebAppSlugDrafts(response.webApps));
        setWebAppAllowedEmailDrafts(createInitialWebAppAllowedEmailDrafts(response.webApps));
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
  }, [activeProject.relativePath, isOpen]);

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
    return validateEndpointName(
      trimmedDraftEndpointName,
      endpointDuplicateProject?.fileName ?? null,
    );
  }, [endpointDuplicateProject, trimmedDraftEndpointName]);

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

  const handlePublishProject = async () => {
    setSavingSettings(true);

    try {
      await publishWorkflowProject(activeProject.relativePath, {
        endpointName: settingsDraft.endpointName,
      });
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUnpublishProject = async () => {
    const shouldProceed = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingSettings(true);

    try {
      await unpublishWorkflowProject(activeProject.relativePath);
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
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
      await publishWorkflowProjectWebApps(activeProject.relativePath, publications);
      await reloadWebApps();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to publish web app');
    } finally {
      setSavingWebApps(false);
    }
  };

  const createWebAppAccessDraft = (webApp: WorkflowProjectWebAppSummary): WorkflowProjectWebAppAccessDraft => ({
    uiGraphId: webApp.uiGraphId,
    allowedEmails: parseAllowedEmailDraft(webAppAllowedEmailDrafts[webApp.uiGraphId] ?? ''),
  });

  const handleSaveWebAppAccess = async (webApp: WorkflowProjectWebAppSummary) => {
    const validationError = webAppAccessValidationErrors[webApp.uiGraphId];
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSavingWebApps(true);

    try {
      await updateWorkflowProjectWebAppAccess(activeProject.relativePath, [createWebAppAccessDraft(webApp)]);
      await reloadWebApps();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update web app access');
    } finally {
      setSavingWebApps(false);
    }
  };

  const handleUnpublishWebApp = async (webApp: WorkflowProjectWebAppSummary) => {
    const shouldProceed = window.confirm(`Unpublish web app "${webApp.name}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingWebApps(true);

    try {
      await unpublishWorkflowProjectWebApp(activeProject.relativePath, webApp.uiGraphId);
      await reloadWebApps();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to unpublish web app');
    } finally {
      setSavingWebApps(false);
    }
  };

  return {
    settingsDraft,
    savingSettings,
    webApps,
    webAppSlugDrafts,
    webAppAllowedEmailDrafts,
    webAppSlugValidationErrors,
    webAppAccessValidationErrors,
    loadingWebApps,
    savingWebApps,
    deletingProject,
    trimmedDraftEndpointName,
    endpointValidationError,
    handleSettingsDraftChange,
    handleWebAppSlugDraftChange,
    handleWebAppAllowedEmailsDraftChange,
    handlePublishProject,
    handleUnpublishProject,
    handlePublishWebApps,
    handleUnpublishWebApp,
    handleSaveWebAppAccess,
    handleDeleteActiveProject,
  };
}
