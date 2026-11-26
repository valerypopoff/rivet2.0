import Button from '@atlaskit/button';
import ModalDialog, { ModalBody } from '@atlaskit/modal-dialog';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getWorkflowReleaseSelectorLabel } from '../../studio-server-shared/workflow-types';
import type {
  WorkflowBundleReferenceDetails,
  WorkflowFolderItem,
  WorkflowProjectItem,
  WorkflowReferenceOverview,
  WorkflowReleaseDependencyStatus,
} from '../../studio-server-shared/workflow-types';
import { fetchWorkflowBundleReferenceDetails, fetchWorkflowReferenceOverview } from './workflowApi';
import {
  buildWorkflowPublicationReferences,
  getWorkflowReferenceProjectId,
  type WorkflowProjectSummaryStatus,
} from './workflowProjectPublicationStatus';

const projectPath = (value: string) => value.replace(/\.rivet-project$/i, '');
type ReferenceDialog = { bundle: WorkflowFolderItem } | { callerId: string };
type ReferenceTarget = Pick<WorkflowReleaseDependencyStatus, 'projectId' | 'name' | 'relativePath'>;
type BundleReferenceSource = {
  name: string;
  savedAt: string;
  sites: Map<string, Map<string, ReferenceTarget>>;
};

function groupBundleReferences(projects: WorkflowBundleReferenceDetails['projects']) {
  const sources = new Map<string, BundleReferenceSource>();
  for (const target of projects) {
    for (const use of target.uses) {
      let source = sources.get(use.sourcePath);
      if (!source) {
        source = { name: use.sourceName, savedAt: use.savedAt, sites: new Map() };
        sources.set(use.sourcePath, source);
      }

      const location =
        [use.sourceGraphName, use.nodeTitle].filter(Boolean).join(' / ') || 'Reference location unavailable';
      let targets = source.sites.get(location);
      if (!targets) {
        targets = new Map();
        source.sites.set(location, targets);
      }
      targets.set(target.projectId, target);
    }
  }
  return [...sources].sort(([left], [right]) => left.localeCompare(right));
}

type ReferenceUI = ReturnType<typeof buildWorkflowPublicationReferences> & {
  checking: boolean;
  open(dialog: ReferenceDialog): void;
};

export const WorkflowPublicationReferenceContext = createContext<ReferenceUI | null>(null);
export const useWorkflowPublicationReferences = () => useContext(WorkflowPublicationReferenceContext);

export function useWorkflowReferenceOverview(projects: WorkflowProjectItem[], treeGeneration: unknown) {
  const [response, setResponse] = useState<{ generation: unknown; overview?: WorkflowReferenceOverview | null }>();
  const [dialog, setDialog] = useState<ReferenceDialog | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetchWorkflowReferenceOverview(controller.signal).then(
      (overview) => {
        if (!controller.signal.aborted) setResponse({ generation: treeGeneration, overview });
      },
      () => {
        if (!controller.signal.aborted) setResponse({ generation: treeGeneration });
      },
    );
    return () => controller.abort();
  }, [treeGeneration]);
  // Keep accepted reference indicators visible while a background read replaces them.
  const overview = response?.overview;
  const checking = response?.generation !== treeGeneration;
  const incomplete = !checking && (overview === undefined || overview?.complete === false);
  const value = useMemo<ReferenceUI>(
    () => ({
      ...buildWorkflowPublicationReferences(projects, overview, incomplete),
      checking,
      open: setDialog,
    }),
    [projects, overview, checking, incomplete],
  );
  return { value, dialog, close: () => setDialog(null) };
}

export function WorkflowPublicationStatusText({
  project,
  status,
  onOpenReferences,
}: {
  project: WorkflowProjectItem;
  status: WorkflowProjectSummaryStatus;
  onOpenReferences?: () => void;
}) {
  const context = useWorkflowPublicationReferences();
  const id = getWorkflowReferenceProjectId(project);
  const referenceLink = (text: string) =>
    context ? (
      <button
        className="publication-reference-link"
        type="button"
        aria-haspopup="dialog"
        title="Changes in referenced projects"
        onClick={() => {
          context.open({ callerId: id });
          onOpenReferences?.();
        }}
      >
        {text}
      </button>
    ) : (
      text
    );
  // Unavailable dependencies still need diagnostics even though they are not
  // counted as confirmed changes in the normal reference-count label.
  const unavailableOnly = !status.referenceText && Boolean(context?.changedByCaller.get(id)?.length);
  return (
    <span className="publication-status-text">
      {unavailableOnly ? referenceLink(status.text) : status.text}
      {status.referenceText ? (
        <>
          {' '}
          <span className="publication-status-reference">in {referenceLink(status.referenceText)}</span>
        </>
      ) : null}
    </span>
  );
}

export function WorkflowReferenceDetailsModal({
  dialog,
  projects,
  onOpen,
  onClose,
}: {
  dialog: ReferenceDialog;
  projects: WorkflowProjectItem[];
  onOpen(project: WorkflowProjectItem): void;
  onClose(): void;
}) {
  const [details, setDetails] = useState<WorkflowBundleReferenceDetails | null>(null);
  const [error, setError] = useState('');
  const bundleId = 'bundle' in dialog ? dialog.bundle.bundleId : null;
  useEffect(() => {
    if (!bundleId) return;
    const controller = new AbortController();
    void fetchWorkflowBundleReferenceDetails(bundleId, controller.signal).then(
      (response) => {
        if (!controller.signal.aborted) {
          setDetails(response);
          if (!response) setError('External references are unavailable.');
        }
      },
      (caught: Error) => {
        if (!controller.signal.aborted) setError(caught.message);
      },
    );
    return () => controller.abort();
  }, [bundleId]);
  const context = useWorkflowPublicationReferences();
  const title = 'bundle' in dialog ? 'External references' : 'Changes in referenced projects';
  const callerUnverified = 'callerId' in dialog && context?.unverifiedByCaller.has(dialog.callerId);
  const changedDependencies =
    'callerId' in dialog
      ? context?.changedByCaller.get(dialog.callerId) ?? (context?.checking || callerUnverified ? undefined : [])
      : undefined;
  const sources = useMemo(
    () => (bundleId && details ? groupBundleReferences(details.projects) : undefined),
    [bundleId, details],
  );
  const loading = 'bundle' in dialog ? !sources : !changedDependencies;
  const byId = new Map(projects.map((project) => [getWorkflowReferenceProjectId(project), project]));
  const callerBundleId = 'callerId' in dialog ? byId.get(dialog.callerId)?.bundleId : undefined;
  const inBundle: WorkflowReleaseDependencyStatus[] = [];
  const external: WorkflowReleaseDependencyStatus[] = [];
  for (const dependency of changedDependencies ?? []) {
    const sameBundle = callerBundleId && byId.get(dependency.projectId)?.bundleId === callerBundleId;
    (sameBundle ? inBundle : external).push(dependency);
  }
  const changedGroups = [
    { title: 'In this bundle', projects: inBundle },
    { title: 'External references', projects: external },
  ].filter((group) => group.projects.length > 0);

  const renderProjectHeading = (item: ReferenceTarget) => {
    const live = item.relativePath ? byId.get(item.projectId) : undefined;
    const relativePath = live?.relativePath ?? item.relativePath;
    return (
      <div key={item.projectId} className="workflow-reference-project-heading">
        <div>
          <h4>{live?.name ?? item.name}</h4>
          <p className="project-settings-help">{relativePath ? projectPath(relativePath) : 'Project unavailable'}</p>
        </div>
        {live && (
          <Button
            className="workflow-project-bundle-action button-size-l"
            onClick={() => {
              onClose();
              onOpen(live);
            }}
          >
            Open project
          </Button>
        )}
      </div>
    );
  };

  return (
    <ModalDialog testId="workflow-reference-details-modal" label={title} onClose={onClose}>
      <ModalBody>
        <div className="project-settings-modal-shell workflow-project-bundle-shell">
          <div className="project-settings-modal-header-row">
            <div className="project-settings-modal-title">{title}</div>
            <button
              className="project-settings-close-button"
              type="button"
              onClick={onClose}
              aria-label="Close reference details"
            >
              ×
            </button>
          </div>
          <div className="project-settings-modal-content workflow-project-bundle-content">
            {error && (
              <p className="workflow-project-bundle-error" role="alert">
                {error}
              </p>
            )}
            {loading && !error && (
              <div role="status">{callerUnverified ? 'Dependency status is unavailable.' : 'Checking references…'}</div>
            )}
            {details && !details.complete && (
              <div role="status">Some saved references are still being indexed or could not be listed.</div>
            )}
            {sources?.length === 0 && <div>No references to show.</div>}
            {sources?.map(([sourcePath, source]) => (
              <section key={sourcePath} className="workflow-external-reference-source">
                <h3
                  title={`${projectPath(sourcePath)}\nSource revision saved ${new Date(source.savedAt).toLocaleString()}`}
                >
                  {source.name}
                </h3>
                {[...source.sites]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([location, targets]) => (
                    <div key={location} className="workflow-external-reference-site">
                      <p className="project-settings-help">{location}</p>
                      <div className="workflow-reference-use workflow-external-reference-targets">
                        {[...targets.values()].map((target) => renderProjectHeading(target))}
                      </div>
                    </div>
                  ))}
              </section>
            ))}
            {changedDependencies?.length === 0 && <div>No changed referenced projects.</div>}
            {changedGroups.map((group) => (
              <section key={group.title} className="workflow-changed-reference-group">
                <h3>{group.title}</h3>
                {group.projects.map((item) => (
                  <article key={item.projectId} className="workflow-project-bundle-card">
                    {renderProjectHeading(item)}
                    <div>{item.unavailable ? 'Selected revision unavailable' : 'Saved revision changed'}</div>
                    {item.revisions?.map((revision) => (
                      <div key={revision.selector} className="workflow-reference-use">
                        <strong>{getWorkflowReleaseSelectorLabel(revision.selector)}</strong>
                        <div>
                          Active revision{' '}
                          <code title={revision.activeRevisionId}>{revision.activeRevisionId.slice(0, 8)}</code>
                        </div>
                        <div>
                          Saved selection{' '}
                          {revision.savedRevisionId ? (
                            <code title={revision.savedRevisionId}>{revision.savedRevisionId.slice(0, 8)}</code>
                          ) : (
                            'Unavailable'
                          )}
                        </div>
                      </div>
                    ))}
                  </article>
                ))}
              </section>
            ))}
          </div>
        </div>
      </ModalBody>
    </ModalDialog>
  );
}
