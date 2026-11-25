import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import { fetchWorkflowProjectWebApps } from './workflowApi';
import { carryEditedWebAppDrafts } from './projectSettingsForm';
import {
  publicationSnapshotFromProject,
  publicationSnapshotFieldsAgree,
  isNextProjectPublication,
} from './projectPublicationReview';
import { isPublicationVersion } from './publicationVersion';
import type {
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
  WorkflowProjectWebAppSummary,
  WorkflowProjectWebAppsResponse,
  WorkflowPublicationPreconditions,
  WorkflowTreeResponse,
} from './types';

type ReviewReadScope = {
  relativePath: string;
  projectId: string | undefined;
  pending: object | null;
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

  return (
    fallback
      .trim()
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'web-app'
  );
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
  return Object.fromEntries(webApps.map((webApp) => [webApp.uiGraphId, (webApp.allowedEmails ?? []).join('\n')]));
}

/** One modal's reviewed snapshots and the editable values reconciled against them. */
export function useProjectPublicationReview({
  activeProject,
  isOpen,
  onRefresh,
}: {
  activeProject: WorkflowProjectItem;
  isOpen: boolean;
  onRefresh: () => Promise<WorkflowTreeResponse | null>;
}) {
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({
    endpointName: activeProject.settings.endpointName,
  });
  const previousServerEndpointName = useRef(activeProject.settings.endpointName);

  // The modal owns this review and its drafts. Background tree updates must
  // not silently approve a newer draft for publication.
  const [reviewedPublication, setReviewedPublication] = useState<WorkflowPublicationPreconditions | null>(null);
  const [snapshotProject, setSnapshotProject] = useState<WorkflowProjectItem | null>(null);
  const [publicationConflict, setPublicationConflict] = useState<'changed' | 'unconfirmed' | null>(null);

  const [webApps, setWebApps] = useState<WorkflowProjectWebAppSummary[]>([]);
  const [webAppSlugDrafts, setWebAppSlugDrafts] = useState<Record<string, string>>({});
  const [webAppAllowedEmailDrafts, setWebAppAllowedEmailDrafts] = useState<Record<string, string>>({});
  const serverWebAppSlugs = useRef<Record<string, string>>({});
  const serverWebAppAllowedEmails = useRef<Record<string, string>>({});
  const [hasMainGraph, setHasMainGraph] = useState<boolean | null>(null);
  const [loadingWebApps, setLoadingWebApps] = useState(false);
  // Opening, explicit review and mutation follow-up reads share one owner.
  // History can supersede any of them while their HTTP response is pending.
  const readScope = useRef<ReviewReadScope | null>(null);

  const getReadScope = () => {
    const scope = readScope.current;
    if (
      !isOpen ||
      !scope ||
      scope.relativePath !== activeProject.relativePath ||
      scope.projectId !== activeProject.projectMetadataId
    )
      return null;
    return scope;
  };

  const beginRead = () => {
    const scope = getReadScope();
    if (!scope) return null;
    const read = {};
    scope.pending = read;
    return read;
  };

  const retireRead = () => {
    const scope = getReadScope();
    if (!scope) return false;
    scope.pending = null;
    setLoadingWebApps(false);
    return true;
  };

  const finishRead = useCallback((read: object) => {
    const scope = readScope.current;
    if (scope?.pending !== read) return;
    scope.pending = null;
    setLoadingWebApps(false);
  }, []);

  useEffect(() => {
    if (!snapshotProject) return;
    const previous = previousServerEndpointName.current;
    const current = snapshotProject.settings.endpointName;
    previousServerEndpointName.current = current;
    setSettingsDraft((draft) => (draft.endpointName === previous ? { endpointName: current } : draft));
  }, [snapshotProject?.settings.endpointName]);

  const applyWebAppSnapshot = useCallback(
    (
      response: WorkflowProjectWebAppsResponse,
      preserveDrafts: boolean,
      expectedAfterMutation?: WorkflowPublicationPreconditions,
      reviewedDraftRevisionId?: string,
    ) => {
      const consistentProject =
        response.project?.relativePath === activeProject.relativePath &&
        (activeProject.projectMetadataId == null || response.projectId === activeProject.projectMetadataId) &&
        publicationSnapshotFieldsAgree(response) &&
        isPublicationVersion(response.publicationVersion);
      if (!consistentProject) {
        setReviewedPublication(null);
        setPublicationConflict('changed');
        toast.error('Publication state is inconsistent. Review the latest project before publishing.');
        return;
      }
      setWebApps(response.webApps);
      setHasMainGraph(response.hasMainGraph);
      setSnapshotProject(response.project);
      const matchesMutation =
        !expectedAfterMutation ||
        (response.projectId === expectedAfterMutation.expectedProjectId &&
          response.draftRevisionId === expectedAfterMutation.expectedDraftRevisionId &&
          response.publicationVersion === expectedAfterMutation.expectedPublicationVersion &&
          response.draftRevisionId === reviewedDraftRevisionId);
      if (response.projectId && response.draftRevisionId && matchesMutation) {
        setReviewedPublication({
          expectedProjectId: response.projectId,
          expectedDraftRevisionId: response.draftRevisionId,
          expectedPublicationVersion: response.publicationVersion,
        });
        setPublicationConflict(null);
      } else {
        setReviewedPublication(null);
        setPublicationConflict(expectedAfterMutation ? 'changed' : null);
        if (!expectedAfterMutation)
          toast.error('Publication state is unavailable. Refresh the project before publishing.');
      }
      const slugs = createInitialWebAppSlugDrafts(response.webApps);
      const emails = createInitialWebAppAllowedEmailDrafts(response.webApps);
      const previousSlugs = serverWebAppSlugs.current;
      const previousEmails = serverWebAppAllowedEmails.current;
      serverWebAppSlugs.current = slugs;
      serverWebAppAllowedEmails.current = emails;
      setWebAppSlugDrafts((drafts) => (preserveDrafts ? carryEditedWebAppDrafts(drafts, previousSlugs, slugs) : slugs));
      setWebAppAllowedEmailDrafts((drafts) =>
        preserveDrafts ? carryEditedWebAppDrafts(drafts, previousEmails, emails) : emails,
      );
    },
    [activeProject.relativePath, activeProject.projectMetadataId],
  );

  const reloadWebApps = async (project: WorkflowProjectItem, previous: WorkflowPublicationPreconditions) => {
    const read = beginRead();
    if (!read) return;
    const expectedAfterMutation = publicationSnapshotFromProject(project);
    if (
      project.relativePath !== activeProject.relativePath ||
      !isNextProjectPublication(expectedAfterMutation, previous)
    ) {
      setReviewedPublication(null);
      setPublicationConflict('changed');
      toast.error(
        'The change succeeded, but publication state could not be verified. Review the latest state before trying again.',
      );
      finishRead(read);
      return;
    }
    setLoadingWebApps(true);

    try {
      const response = await fetchWorkflowProjectWebApps(activeProject.relativePath);
      if (readScope.current?.pending !== read) return;
      applyWebAppSnapshot(response, true, expectedAfterMutation, previous.expectedDraftRevisionId);
    } catch {
      if (readScope.current?.pending !== read) return;
      toast.error(
        'The change succeeded, but publication state could not refresh. Review the latest state before trying again.',
      );
      setReviewedPublication(null);
      setPublicationConflict('changed');
    } finally {
      finishRead(read);
    }
  };

  useEffect(() => {
    readScope.current = null;
    setWebApps([]);
    setHasMainGraph(null);
    setSnapshotProject(null);
    setWebAppSlugDrafts({});
    setWebAppAllowedEmailDrafts({});
    serverWebAppSlugs.current = {};
    serverWebAppAllowedEmails.current = {};
    setReviewedPublication(null);
    setPublicationConflict(null);

    if (!isOpen) {
      setLoadingWebApps(false);
      return;
    }

    const read = {};
    const scope = {
      relativePath: activeProject.relativePath,
      projectId: activeProject.projectMetadataId,
      pending: read,
    };
    readScope.current = scope;
    setLoadingWebApps(true);

    fetchWorkflowProjectWebApps(activeProject.relativePath)
      .then((response) => {
        if (readScope.current?.pending !== read) {
          return;
        }

        applyWebAppSnapshot(response, false);
      })
      .catch((err: any) => {
        if (readScope.current?.pending === read) {
          toast.error(err.message || 'Failed to load project web apps');
        }
      })
      .finally(() => finishRead(read));

    return () => {
      if (readScope.current === scope) readScope.current = null;
    };
  }, [activeProject.relativePath, applyWebAppSnapshot, isOpen, finishRead]);

  const handleSettingsDraftChange = (key: 'endpointName') => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setSettingsDraft((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleWebAppSlugDraftChange = (uiGraphId: string) => (event: ChangeEvent<HTMLInputElement>) => {
    setWebAppSlugDrafts((prev) => ({
      ...prev,
      [uiGraphId]: event.target.value,
    }));
  };

  const handleWebAppAllowedEmailsDraftChange = (uiGraphId: string) => (event: ChangeEvent<HTMLTextAreaElement>) => {
    setWebAppAllowedEmailDrafts((prev) => ({
      ...prev,
      [uiGraphId]: event.target.value,
    }));
  };

  const refreshUnconfirmedPublication = async () => {
    if (retireRead()) {
      setReviewedPublication(null);
      setPublicationConflict('unconfirmed');
    }
    await onRefresh().catch(() => null);
  };

  const reviewLatestPublication = async () => {
    const read = beginRead();
    if (!read) return;
    setReviewedPublication(null);
    setLoadingWebApps(true);
    try {
      const snapshot = await fetchWorkflowProjectWebApps(activeProject.relativePath);
      if (readScope.current?.pending !== read) return;
      const tree = await onRefresh();
      if (readScope.current?.pending !== read) return;
      if (!tree) throw new Error('Could not refresh the project list. Try again.');
      applyWebAppSnapshot(snapshot, true);
    } catch (error: any) {
      if (readScope.current?.pending !== read) return;
      toast.error(error.message || 'Could not review the latest publication state.');
    } finally {
      finishRead(read);
    }
  };

  const acceptReturnedPublication = (project: WorkflowProjectItem, previous: WorkflowPublicationPreconditions) => {
    if (!retireRead()) return;
    const next = publicationSnapshotFromProject(project);
    if (project.relativePath !== activeProject.relativePath || !isNextProjectPublication(next, previous)) {
      setReviewedPublication(null);
      setPublicationConflict('changed');
      toast.error(
        'The change succeeded, but publication state could not be verified. Review the latest state before trying again.',
      );
      return;
    }
    setSnapshotProject(project);
    if (next.expectedDraftRevisionId !== previous.expectedDraftRevisionId) {
      setReviewedPublication(null);
      setPublicationConflict('changed');
      toast.error('The change succeeded, but the project draft changed. Review the latest state before publishing.');
      return;
    }
    // Access and unpublish commands do not review the graph draft. A newer
    // revision in their response must require explicit review, not re-arm it.
    setReviewedPublication({ ...previous, expectedPublicationVersion: next.expectedPublicationVersion });
  };

  const markPublicationChanged = () => {
    if (!retireRead()) return;
    setReviewedPublication(null);
    setPublicationConflict('changed');
  };

  return {
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
  };
}
