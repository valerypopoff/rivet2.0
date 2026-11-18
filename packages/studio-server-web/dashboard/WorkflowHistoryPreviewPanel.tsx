import Button from '@atlaskit/button';
import { useState } from 'react';
import type {
  WorkflowFolderItem,
  WorkflowReleaseProject,
} from '../../studio-server-shared/workflow-types';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  getWorkflowReleaseSelectorLabel,
} from '../../studio-server-shared/workflow-types';
import { WorkflowFolderRow } from './WorkflowFolderTree';
import { WorkflowProjectLabel } from './WorkflowProjectRow';

import type { HistoryPreviewSession } from './useWorkflowHistoryPreview';

type Branch = {
  path: string;
  folders: Map<string, Branch>;
  projects: WorkflowReleaseProject[];
  projectCount: number;
};

function previewFolders(projects: WorkflowReleaseProject[]) {
  const root: Branch = { path: '', folders: new Map(), projects: [], projectCount: projects.length };
  for (const project of projects) {
    let branch = root;
    for (const name of project.relativePath.split('/').slice(0, -1)) {
      let next = branch.folders.get(name);
      if (!next) {
        const path = branch.path ? `${branch.path}/${name}` : name;
        next = { path, folders: new Map(), projects: [], projectCount: 0 };
        branch.folders.set(name, next);
      }
      branch = next;
      branch.projectCount++;
    }
    branch.projects.push(project);
  }
  return root;
}

export function WorkflowHistoryPreviewPanel({
  session,
  openedPath,
  bundleFolders,
  onOpen,
  onExit,
}: {
  session: HistoryPreviewSession;
  openedPath: string;
  bundleFolders: readonly WorkflowFolderItem[];
  onOpen(artifactId: string): void;
  onExit(): void;
}) {
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const { preview } = session;
  const selected = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(openedPath);
  const activeArtifactId = selected?.sessionId === session.id ? selected.artifactId : undefined;
  const activePath = preview.projects.find((project) => project.artifactId === activeArtifactId)?.relativePath;
  const bundles = new Set(
    preview.coverage === 'project-only'
      ? bundleFolders.map((folder) => folder.relativePath)
      : preview.projects.flatMap((project) => (project.bundleRelativePath ? [project.bundleRelativePath] : [])),
  );
  const versions = new Map<string, number>();
  for (const project of preview.projects) versions.set(project.projectId, (versions.get(project.projectId) ?? 0) + 1);
  const revisionSelectors = new Map<string, Set<string>>();
  for (const reference of preview.references) {
    const labels = revisionSelectors.get(reference.targetArtifactId) ?? new Set<string>();
    labels.add(getWorkflowReleaseSelectorLabel(reference.selector));
    revisionSelectors.set(reference.targetArtifactId, labels);
  }

  const renderProjects = (projects: WorkflowReleaseProject[]) =>
    [...projects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => {
        const active = project.artifactId === activeArtifactId;
        const details = [
          ...(project.artifactId === preview.rootArtifactId ? ['Endpoint'] : []),
          ...((versions.get(project.projectId) ?? 0) > 1
            ? [...(revisionSelectors.get(project.artifactId) ?? []), new Date(project.savedAt).toLocaleString()]
            : []),
        ].join(' · ');
        return (
          <button
            className={`project-row${active ? ' active' : ''}`}
            type="button"
            key={project.artifactId}
            aria-current={active ? 'true' : undefined}
            onClick={() => onOpen(project.artifactId)}
            title={project.relativePath.replace(/\.rivet-project$/i, '')}
          >
            <div className="project-main">
              <WorkflowProjectLabel name={project.name} />
              {details && (
                <small className="history-preview-project-details" title={details}>
                  {details}
                </small>
              )}
            </div>
          </button>
        );
      });
  const renderFolders = (branch: Branch): JSX.Element[] =>
    [...branch.folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => {
        const expanded = !collapsed.has(child.path);
        const toggle = () =>
          setCollapsed((current) => {
            const next = new Set(current);
            if (!next.delete(child.path)) next.add(child.path);
            return next;
          });
        const containsSelection = !expanded && activePath?.startsWith(`${child.path}/`);
        return (
          <div className="folder" key={child.path}>
            <WorkflowFolderRow
              name={name}
              expanded={expanded}
              isBundle={bundles.has(child.path)}
              projectCount={child.projectCount}
              className={containsSelection ? 'folder-row contains-selection' : undefined}
              onClick={toggle}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggle();
                }
              }}
            />
            {expanded && (
              <div className="folder-children">
                {renderFolders(child)}
                {renderProjects(child.projects)}
              </div>
            )}
          </div>
        );
      });
  const tree = previewFolders(preview.projects);

  return (
    <section className="workflow-history-preview" aria-label="History preview">
      <div className="history-preview-heading">
        <strong>History preview</strong>
        <span>
          {preview.endpointName} · {new Date(preview.publishedAt).toLocaleString()}
        </span>
        <p>
          {preview.coverage === 'frozen'
            ? 'Browsing the project revisions captured for this endpoint.'
            : 'Dependencies weren’t saved with this revision.'}
        </p>
        {preview.capturedAt && Date.parse(preview.capturedAt) > Date.parse(preview.publishedAt) + 1000 && (
          <span>Dependencies captured {new Date(preview.capturedAt).toLocaleString()}</span>
        )}
        <Button className="project-settings-secondary-button button-size-m" onClick={onExit}>
          Exit history preview
        </Button>
      </div>
      {tree.projects.length > 0 && <div className="projects">{renderProjects(tree.projects)}</div>}
      {renderFolders(tree)}
    </section>
  );
}
