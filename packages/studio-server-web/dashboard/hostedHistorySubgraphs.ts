import { loadProjectAndAttachedDataFromString, type Project } from '@valerypopoff/rivet2-core';
import type { SubgraphProjectCatalogProvider } from '../../app/src/providers/ProvidersContext';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  type WorkflowHistoryPreview,
  type WorkflowPublishedVersionPreviewReference,
  type WorkflowReleaseProject,
  type WorkflowReleaseSelector,
} from '../../studio-server-shared/workflow-types';
import { fetchWorkflowHistoryPreview, fetchWorkflowPublishedVersionPreview } from './workflowApi';

type PreviewTarget = Parameters<SubgraphProjectCatalogProvider['preview']>[0];

function subgraphKey(
  artifactId: string,
  sourceGraphId: string | undefined,
  nodeId: string | undefined,
  selector: WorkflowReleaseSelector,
  projectId: string,
  targetGraphId: string | undefined,
) {
  return JSON.stringify([artifactId, sourceGraphId, nodeId, selector, projectId, targetGraphId]);
}

function indexHistory(preview: WorkflowHistoryPreview) {
  const byArtifact = new Map(preview.projects.map((project) => [project.artifactId, project]));
  const root = byArtifact.get(preview.rootArtifactId);
  if (!root) throw new Error('The history preview is unavailable.');

  const subgraphs = new Map<string, WorkflowReleaseProject>();
  const declared = new Set<string>();
  for (const edge of preview.references) {
    const target = byArtifact.get(edge.targetArtifactId);
    if (!target) continue;
    if (edge.selector === 'project-reference') declared.add(target.artifactId);
    const key = subgraphKey(
      edge.sourceArtifactId, edge.sourceGraphId, edge.nodeId, edge.selector, target.projectId, edge.targetGraphId,
    );
    if (!subgraphs.has(key)) subgraphs.set(key, target);
  }

  const projectReferences = new Map<string, WorkflowReleaseProject>();
  for (const project of preview.projects) {
    if (declared.has(project.artifactId) && !projectReferences.has(project.projectId)) {
      projectReferences.set(project.projectId, project);
    }
  }
  return { root, subgraphs, projectReferences };
}

let historyLookup: { key: string; pending: Promise<ReturnType<typeof indexHistory>> } | undefined;

function loadHistoryScope(source: WorkflowPublishedVersionPreviewReference) {
  const key = JSON.stringify([source.ownerId, source.relativePath, source.versionId, source.sessionId]);
  if (historyLookup?.key !== key) {
    const pending = fetchWorkflowHistoryPreview(source.relativePath, source.versionId, { ownerId: source.ownerId })
      .then(indexHistory)
      .catch((error) => {
        if (historyLookup?.pending === pending) historyLookup = undefined;
        throw error;
      });
    historyLookup = { key, pending };
  }
  return historyLookup.pending;
}

const artifactLookups = new Map<string, Promise<Project>>();
function loadHistoryProject(
  source: WorkflowPublishedVersionPreviewReference,
  ownerId: string,
  artifactId: string,
  projectId: string,
) {
  const key = JSON.stringify([ownerId, source.versionId, artifactId, source.sessionId]);
  const cached = artifactLookups.get(key);
  if (cached) return cached;
  const pending = fetchWorkflowPublishedVersionPreview(source.relativePath, source.versionId, { ownerId, artifactId })
    .then((result) => {
      const [project] = loadProjectAndAttachedDataFromString(result.contents);
      if (project.metadata.id !== projectId) throw new Error('The captured project has a different saved identity.');
      return project;
    })
    .catch((error) => {
      if (artifactLookups.get(key) === pending) artifactLookups.delete(key);
      throw error;
    });
  artifactLookups.set(key, pending);
  if (artifactLookups.size > 16) artifactLookups.delete(artifactLookups.keys().next().value!);
  return pending;
}

export async function resolveHistoricalSubgraph(target: PreviewTarget) {
  const source = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(target.callerProjectId ?? '');
  if (!source) return null;
  const { root, subgraphs } = await loadHistoryScope(source);
  const captured = subgraphs.get(subgraphKey(
    source.artifactId ?? root.artifactId,
    target.sourceGraphId,
    target.sourceNodeId,
    target.version,
    target.projectId,
    target.targetGraphId,
  ));
  if (!captured) throw new Error('This reference wasn’t captured in this revision.');
  return { source, target: captured, root };
}

export async function loadHistoricalSubgraph(target: PreviewTarget) {
  const matched = await resolveHistoricalSubgraph(target);
  return matched ? loadHistoryProject(matched.source, matched.root.projectId, matched.target.artifactId, target.projectId) : null;
}

export const loadHistoryProjectReference: NonNullable<SubgraphProjectCatalogProvider['loadHistoryProjectReference']> =
  async (sourcePath, projectId) => {
    const source = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(sourcePath);
    if (!source) throw new Error('The history preview is unavailable.');
    const { root, projectReferences } = await loadHistoryScope(source);
    const artifact = projectReferences.get(projectId);
    if (!artifact) throw new Error('This reference wasn’t captured in this revision.');
    return loadHistoryProject(source, root.projectId, artifact.artifactId, projectId);
  };
