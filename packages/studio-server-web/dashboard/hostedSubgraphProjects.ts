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

function targetUrl(target: SubgraphProjectTarget, operation: 'preview' | 'execution'): string {
  return `${RIVET_API_BASE_URL}/workflows/subgraph-projects/${encodeURIComponent(target.projectId)}/${operation}?version=${target.version}`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
    throw Object.assign(new Error(body?.error ?? body?.message ?? `Could not load Subgraph project (${response.status}).`), {
      status: response.status,
    });
  }
  return await response.json() as T;
}

export const hostedSubgraphProjectCatalog: SubgraphProjectCatalogProvider = {
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
    const body = await readJson<{ projectContents: string; datasetsContents?: string; revisionKey?: string; sourceProjectPath?: string }>(
      await fetch(targetUrl(target, 'execution'), { cache: 'no-store' }),
    );
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
