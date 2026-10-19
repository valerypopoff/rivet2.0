import {
  InMemoryDatasetProvider,
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  type Project,
  type ProjectId,
  type SubgraphProjectTarget,
  type SubgraphProjectRun,
} from '@valerypopoff/rivet2-core';
import type { SubgraphProjectCatalogProvider } from '../../app/src/providers/ProvidersContext';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { postMessageToDashboard } from '../../studio-server-shared/editor-bridge';
import { rememberSubgraphPreviewStreamingOutputs } from '../../app/src/utils/subgraphPreviewStreaming';
import type { WorkflowProjectReferencesResponse } from '../../studio-server-shared/workflow-types';

function targetUrl(target: SubgraphProjectTarget, operation: 'preview' | 'execution'): string {
  return `${RIVET_API_BASE_URL}/workflows/subgraph-projects/${encodeURIComponent(target.projectId)}/${operation}?version=${target.version}`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw Object.assign(
      new Error(body?.error ?? body?.message ?? `Could not load Subgraph project (${response.status}).`),
      {
        status: response.status,
      },
    );
  }
  return (await response.json()) as T;
}

export const hostedSubgraphProjectCatalog: SubgraphProjectCatalogProvider = {
  async graphReferences(target, signal) {
    if (!target.graphIds.length) return { projectId: target.projectId, complete: true, references: [] };
    let relativePath: string | undefined;
    const read = () =>
      fetch(`${RIVET_API_BASE_URL}/workflows/projects/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal,
        body: JSON.stringify({ projectId: target.projectId, graphIds: target.graphIds, relativePath }),
      });
    let response = await read();
    // Legacy filesystem catalogs lack indexed project IDs. Resolve a fresh tree
    // path only for that fallback; the scan still verifies the expected ID.
    if (response.status === 404) {
      const tree = await readJson<Awaited<ReturnType<SubgraphProjectCatalogProvider['listTree']>>>(
        await fetch(`${RIVET_API_BASE_URL}/workflows/tree`, { cache: 'no-store', signal }),
      );
      const matches: string[] = [];
      const visit = (items: typeof tree) => {
        for (const project of items.projects) {
          if (project.projectMetadataId === target.projectId || project.id === target.projectId)
            matches.push(project.relativePath);
        }
        for (const folder of items.folders) visit(folder);
      };
      visit(tree);
      if (matches.length !== 1) throw new Error('The target project could not be identified. Refresh before deleting.');
      relativePath = matches[0]!;
      response = await read();
    }
    const result = await readJson<WorkflowProjectReferencesResponse>(response);
    if (
      result.projectId !== target.projectId ||
      !Array.isArray(result.graphReferences) ||
      typeof result.complete !== 'boolean'
    ) {
      throw new Error('Graph reference checking is unavailable or the project changed.');
    }
    return {
      projectId: result.projectId,
      complete: result.complete,
      references: result.graphReferences.map(({ source, ...reference }) => ({
        ...reference,
        sourceDescription:
          source.kind === 'saved-latest'
            ? 'Saved draft'
            : source.kind === 'published-endpoint'
              ? `Published endpoint${source.label ? `: ${source.label}` : ''}`
              : `Published web app${source.label ? `: ${source.label}` : ''}`,
      })),
    };
  },
  openGraph({ projectId, graphId }) {
    postMessageToDashboard({ type: 'open-subgraph-target', projectId, graphId });
  },
  async listTree() {
    return readJson(await fetch(`${RIVET_API_BASE_URL}/workflows/tree`, { cache: 'no-store' }));
  },
  async preview(target) {
    const body = await readJson<{ project: Project; streamingOutputNodeIdsByGraph?: Record<string, string[]> }>(
      await fetch(targetUrl(target, 'preview'), { cache: 'no-store' }),
    );
    if (body.project?.metadata?.id !== target.projectId) throw new Error('Subgraph preview project identity changed.');
    if (body.streamingOutputNodeIdsByGraph) {
      rememberSubgraphPreviewStreamingOutputs(body.project, body.streamingOutputNodeIdsByGraph);
    }
    return body.project;
  },
};

export const hostedSubgraphProjectLoader = {
  async loadTarget(target: { projectId: ProjectId; version: 'latest' | 'published' }) {
    const body = await readJson<{
      projectContents: string;
      datasetsContents?: string;
      revisionKey?: string;
      sourceProjectPath?: string;
    }>(await fetch(targetUrl(target, 'execution'), { cache: 'no-store' }));
    if (typeof body.projectContents !== 'string') {
      throw new Error('Subgraph execution service did not return a saved project.');
    }
    const [project] = loadProjectAndAttachedDataFromString(body.projectContents);
    const datasets = body.datasetsContents ? deserializeDatasets(body.datasetsContents) : [];
    if (project.metadata.id !== target.projectId) {
      throw new Error('Subgraph execution project identity changed.');
    }
    return {
      project,
      datasetProvider: new InMemoryDatasetProvider(datasets),
      revisionKey: body.revisionKey,
      projectContents: body.projectContents,
      datasetsContents: body.datasetsContents,
      sourceProjectPath: body.sourceProjectPath,
    };
  },
};

export async function persistHostedSubgraphProjectRun(run: SubgraphProjectRun): Promise<void> {
  if (!run.resolved.projectContents) throw new Error('Subgraph replay has no saved project snapshot.');
  const response = await fetch(`${RIVET_API_BASE_URL}/workflows/local-editor-recordings/subgraph-run`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: run.target.projectId,
      projectContents: run.resolved.projectContents,
      datasetsContents: run.resolved.datasetsContents,
      recordingSerialized: run.recorder.serialize(),
      graphId: run.graphId,
      revisionKey: run.resolved.revisionKey,
      correlationId: run.correlationId,
      status: run.status,
      durationMs: run.durationMs,
      errorMessage: run.errorMessage,
    }),
  });
  await readJson(response);
}
