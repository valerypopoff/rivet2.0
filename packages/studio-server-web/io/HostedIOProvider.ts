// HostedIOProvider: API-backed IOProvider for hosted mode
// Supports server-side path-based save/load alongside browser FSA API fallbacks

import {
  type NodeGraph,
  type Project,
  type ProjectId,
  ExecutionRecorder,
  deserializeDatasets,
  deserializeGraph,
  serializeDatasets,
  serializeGraph,
  serializeProject,
} from '@valerypopoff/rivet2-core';
import {
  deserializeLegacyEvaluationProjectData,
  type EvaluationProjectFileData,
  type IOProvider,
  type LoadedProjectData,
  type ProjectLoadOptions,
} from '../../app/src/io/IOProvider.js';
import type { EvaluationStore } from '@valerypopoff/rivet2-evaluations';
import { getDefaultStore } from 'jotai';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { apiReadBinary, apiReadText } from '../../studio-server-shared/api';
import {
  getWorkflowPublishedVersionPreviewFromVirtualProjectPath,
  MANAGED_WORKFLOW_VIRTUAL_ROOT,
  type WorkflowPublishedVersionPreviewReference,
} from '../../studio-server-shared/workflow-types';
import { getWorkflowRecordingIdFromVirtualProjectPath } from '../../studio-server-shared/workflow-recording-types';
import { loadedProjectState } from '../../app/src/state/savedGraphs.js';
import { evaluationLibraryState } from '../../app/src/state/evaluations.js';
import type { AppDatasetProvider } from '../../app/src/host';
import {
  fetchWorkflowPublishedVersionPreview,
  fetchWorkflowRecordingArtifactText,
  getWorkflowTreeMutationHeaders,
} from '../dashboard/workflowApi';
import { deserializeHostedProjectPayloadAsync } from '../overrides/utils/deserializeProject';
import {
  assertHostedProjectRevisionCanSave,
  beginHostedProjectSave,
  bindHostedProjectRevision,
  clearHostedProjectRevisionPath as clearTrackedHostedProjectRevisionPath,
  getHostedProjectExpectedRevision,
  remapHostedProjectRevisionPaths as remapTrackedHostedProjectRevisionPaths,
} from './hostedProjectRevisionTracker';

const API = RIVET_API_BASE_URL;
const jotaiStore = getDefaultStore();
let workflowStorageBackendPromise: Promise<'filesystem' | 'managed'> | null = null;

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'name' in error && error.name === 'AbortError';
}

type HostedDatasetProvider = AppDatasetProvider & {
  importDatasetsForProject: (
    projectId: ProjectId,
    datasets: ReturnType<typeof deserializeDatasets>,
    options?: { isCurrent?: () => boolean; signal?: AbortSignal; activate?: boolean },
  ) => Promise<void>;
};

export function clearHostedProjectRevisionPath(path: string | null | undefined): void {
  clearTrackedHostedProjectRevisionPath(path);
}

export function remapHostedProjectRevisionPaths(
  moves: Iterable<{
    fromAbsolutePath: string;
    toAbsolutePath: string;
  }>,
): void {
  remapTrackedHostedProjectRevisionPaths(moves);
}

async function apiListProjects(signal?: AbortSignal): Promise<string[]> {
  const resp = await fetch(`${API}/projects/list`, { signal });
  if (!resp.ok) throw new Error(`Failed to list projects: ${resp.statusText}`);
  const data = await resp.json();
  return data.files;
}

async function apiLoadProject(
  path: string,
  signal?: AbortSignal,
): Promise<{
  contents: string;
  datasetsContents: string | null;
  revisionId: string | null;
}> {
  const response = await fetch(`${API}/projects/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load project: ${response.statusText}`);
  }

  return response.json();
}

async function apiSaveProject(options: {
  path: string;
  contents: string;
  datasetsContents: string | null;
  expectedRevisionId: string | null;
  projectId: string;
  saveIntent: 'in-place' | 'save-as';
}): Promise<{
  path: string;
  revisionId: string | null;
}> {
  const response = await fetch(`${API}/projects/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getWorkflowTreeMutationHeaders() },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    const error = new Error(data.error || response.statusText) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function getWorkflowStorageBackend(): Promise<'filesystem' | 'managed'> {
  if (!workflowStorageBackendPromise) {
    workflowStorageBackendPromise = (async () => {
      const response = await fetch(`${API}/config`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Failed to load hosted config: ${response.status}`);
      }

      const config = (await response.json().catch(() => ({}))) as { storageMode?: unknown };
      const value = typeof config.storageMode === 'string' ? config.storageMode.trim().toLowerCase() : '';
      return value === 'managed' ? 'managed' : 'filesystem';
    })().catch((error) => {
      workflowStorageBackendPromise = null;
      throw error;
    });
  }

  return workflowStorageBackendPromise;
}

async function getSuggestedProjectPath(defaultName: string): Promise<string> {
  const currentPath = getCurrentLoadedProjectPath();

  if (
    !currentPath ||
    getWorkflowRecordingIdFromVirtualProjectPath(currentPath) ||
    getWorkflowPublishedVersionPreviewFromVirtualProjectPath(currentPath)
  ) {
    return (await getWorkflowStorageBackend()) === 'managed'
      ? `${MANAGED_WORKFLOW_VIRTUAL_ROOT}/${defaultName}`
      : `/workflows/${defaultName}`;
  }

  const lastSeparatorIndex = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  if (lastSeparatorIndex === -1) {
    return defaultName;
  }

  const directory = currentPath.slice(0, lastSeparatorIndex + 1);
  return `${directory}${defaultName}`;
}

function getCurrentLoadedProjectPath(): string | null {
  const loadedProject = jotaiStore.get(loadedProjectState) as {
    loaded: boolean;
    path: string | null;
  };

  return loadedProject.path?.trim() || null;
}

function createPublishedVersionPreviewProjectId(): ProjectId {
  const randomId =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  return `published-version-preview:${randomId}` as ProjectId;
}

function isPublishedVersionPreviewProject(project: Project): boolean {
  return String(project.metadata.id).startsWith('published-version-preview:');
}

function createPublishedVersionPreviewProject(
  project: Project,
  reference: WorkflowPublishedVersionPreviewReference,
): Project {
  const title = project.metadata.title?.trim() || reference.relativePath.split('/').pop() || 'Published version';

  return {
    ...project,
    metadata: {
      ...project.metadata,
      id: createPublishedVersionPreviewProjectId(),
      title: `${title} (published preview)`,
    },
  };
}

function assertProjectIsWritable(project: Project, path?: string | null): void {
  if (
    isPublishedVersionPreviewProject(project) ||
    (path && getWorkflowPublishedVersionPreviewFromVirtualProjectPath(path))
  ) {
    throw new Error('Published version previews are read-only.');
  }
}

async function pickSingleFile(options: { accept?: string } = {}): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';

    if (options.accept) {
      input.accept = options.accept;
    }

    let settled = false;
    let focusTimerId: number | null = null;
    const finish = (file: File | null) => {
      if (settled) {
        return;
      }

      settled = true;
      if (focusTimerId != null) {
        window.clearTimeout(focusTimerId);
        focusTimerId = null;
      }
      window.removeEventListener('focus', handleWindowFocus, true);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      focusTimerId = window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 300);
    };

    input.addEventListener(
      'change',
      () => {
        finish(input.files?.[0] ?? null);
      },
      { once: true },
    );
    window.addEventListener('focus', handleWindowFocus, true);
    document.body.appendChild(input);
    input.click();
  });
}

async function deserializeHostedProjectPayload(
  contents: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ project: Project; evaluation: EvaluationProjectFileData }> {
  const { project, serializedEvaluationData } = await deserializeHostedProjectPayloadAsync(contents, path, { signal });

  return {
    project,
    evaluation: {
      evaluationData: deserializeLegacyEvaluationProjectData(serializedEvaluationData),
      evaluationDatasets: [],
    },
  };
}

export class HostedIOProvider implements IOProvider {
  readonly #datasetProvider: HostedDatasetProvider;
  readonly #evaluationStore: EvaluationStore;
  readonly #loadTimeoutMs: number;

  constructor(
    datasetProvider: HostedDatasetProvider,
    evaluationStore: EvaluationStore,
    options: { loadTimeoutMs?: number } = {},
  ) {
    this.#datasetProvider = datasetProvider;
    this.#evaluationStore = evaluationStore;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.#loadTimeoutMs) || this.#loadTimeoutMs <= 0)
      throw new Error('Hosted project loadTimeoutMs must be a positive integer.');
  }

  async #flushEvaluationLibrary(): Promise<void> {
    await this.#evaluationStore.putLibrary(structuredClone(jotaiStore.get(evaluationLibraryState)));
  }

  static isSupported(): boolean {
    return true;
  }

  async saveGraphData(graphData: NodeGraph): Promise<void> {
    // Use browser FSA API for graph export
    if ('showSaveFilePicker' in window) {
      try {
        const fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: `${graphData.metadata?.name ?? 'graph'}.rivet-graph`,
        });
        const writable = await fileHandle.createWritable();
        await writable.write(serializeGraph(graphData) as string);
        await writable.close();
        return;
      } catch {
        // User cancelled
        return;
      }
    }
    // Fallback: download
    const data = serializeGraph(graphData) as string;
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${graphData.metadata?.name ?? 'graph'}.rivet-graph`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async saveProjectData(project: Project): Promise<string | undefined> {
    assertProjectIsWritable(project, getCurrentLoadedProjectPath());
    const finishSave = beginHostedProjectSave(project.metadata.id);
    try {
      const defaultName = `${project.metadata?.title ?? 'project'}.rivet-project`;
      const filePath = prompt('Save project to server path:', await getSuggestedProjectPath(defaultName));
      if (!filePath) return undefined;

      await this.#flushEvaluationLibrary();
      const datasets = await this.#datasetProvider.exportDatasetsForProject(project.metadata.id);
      const saved = await apiSaveProject({
        path: filePath,
        contents: serializeProject(project) as string,
        datasetsContents: datasets.length > 0 ? serializeDatasets(datasets) : null,
        expectedRevisionId: null,
        projectId: project.metadata.id,
        saveIntent: 'save-as',
      });

      bindHostedProjectRevision(project.metadata.id, saved.path, saved.revisionId ?? null);
      return saved.path;
    } finally {
      finishSave();
    }
  }

  async saveProjectDataNoPrompt(project: Project, path: string): Promise<string> {
    assertProjectIsWritable(project, path);

    if (getWorkflowRecordingIdFromVirtualProjectPath(path)) {
      throw new Error('Recording replay projects are read-only. Use Save As to create a new project file.');
    }

    assertHostedProjectRevisionCanSave(project.metadata.id);
    const finishSave = beginHostedProjectSave(project.metadata.id);
    try {
      await this.#flushEvaluationLibrary();
      const datasets = await this.#datasetProvider.exportDatasetsForProject(project.metadata.id);
      const saved = await apiSaveProject({
        path,
        contents: serializeProject(project) as string,
        datasetsContents: datasets.length > 0 ? serializeDatasets(datasets) : null,
        expectedRevisionId: getHostedProjectExpectedRevision(project.metadata.id, path),
        projectId: project.metadata.id,
        saveIntent: 'in-place',
      });

      bindHostedProjectRevision(project.metadata.id, saved.path, saved.revisionId ?? null);
      return saved.path;
    } finally {
      finishSave();
    }
  }

  async loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        // Chromium rejects custom extensions like ".rivet-graph" in picker type filters.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback(deserializeGraph(text));
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile({ accept: '.rivet-graph' });
    if (!file) {
      return;
    }

    const text = await file.text();
    callback(deserializeGraph(text));
  }

  async loadProjectData(
    callback: (data: LoadedProjectData & { path: string }) => void | Promise<void>,
    options: ProjectLoadOptions = {},
  ): Promise<void> {
    // Try to list known server projects first so users can pick from an index when possible.
    // This stays separate from the manual path prompt because fresh installs still need a
    // direct-entry fallback even when listing fails or returns no saved projects.
    let files: string[];
    try {
      files = await apiListProjects(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      files = [];
    }
    options.signal?.throwIfAborted();
    if (files.length > 0) {
      const selection = prompt(
        `Available projects on server:\n${files.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nEnter number or full path:`,
      );

      if (!selection) return;

      let path: string;
      const num = parseInt(selection, 10);
      if (!isNaN(num) && num >= 1 && num <= files.length) {
        path = files[num - 1]!;
      } else {
        path = selection;
      }

      const projectData = await this.loadProjectDataNoPrompt(path, options);
      await callback({ ...projectData, path });
      return;
    }

    // Preserve the explicit manual-path prompt for empty servers and listing failures.
    const path = prompt('Enter server path to .rivet-project file:');
    if (!path) return;

    const projectData = await this.loadProjectDataNoPrompt(path, options);
    await callback({ ...projectData, path });
  }

  async loadProjectDataNoPrompt(path: string, options: ProjectLoadOptions = {}): Promise<LoadedProjectData> {
    const deadline = Date.now() + this.#loadTimeoutMs;
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error('Project loading timed out. Please retry.')),
      this.#loadTimeoutMs,
    );
    try {
      controller.signal.throwIfAborted();
      const result = await this.prepareProject(path, { ...options, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (result.commit) {
        const commit = result.commit;
        result.commit = async (isCurrent) => {
          // One overall budget includes preparation and the deferred import.
          // Waiting to commit must not grant a second full timeout window.
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
          const remaining = deadline - Date.now();
          if (remaining <= 0) controller.abort(new Error('Project loading timed out. Please retry.'));
          const commitTimer = setTimeout(
            () => controller.abort(new Error('Project loading timed out. Please retry.')),
            Math.max(0, remaining),
          );
          try {
            controller.signal.throwIfAborted();
            return await commit(isCurrent);
          } finally {
            clearTimeout(commitTimer);
            options.signal?.removeEventListener('abort', abort);
          }
        };
      }
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  private async prepareProject(path: string, options: ProjectLoadOptions): Promise<LoadedProjectData> {
    const complete = async (
      project: Project,
      evaluation: EvaluationProjectFileData,
      datasets: ReturnType<typeof deserializeDatasets>,
      revision?: string | null,
    ): Promise<LoadedProjectData> => {
      const commit = async (isCurrent: () => boolean): Promise<boolean> => {
        if (!isCurrent() || options.signal?.aborted) return false;
        await this.#datasetProvider.importDatasetsForProject(project.metadata.id, datasets, {
          isCurrent,
          signal: options.signal,
          activate: options.activateDatasets !== false,
        });
        if (!isCurrent() || options.signal?.aborted) return false;
        if (revision !== undefined)
          bindHostedProjectRevision(project.metadata.id, path, revision, { awaitingActivation: true });
        return true;
      };
      if (options.deferCommit) return { project, evaluation, commit };
      if (!(await commit(() => !options.signal?.aborted)))
        throw new DOMException('Project load cancelled', 'AbortError');
      return { project, evaluation };
    };
    const previewReference = getWorkflowPublishedVersionPreviewFromVirtualProjectPath(path);
    if (previewReference) {
      const preview = await fetchWorkflowPublishedVersionPreview(
        previewReference.relativePath,
        previewReference.versionId,
        { signal: options.signal },
      );
      const { project: projectData, evaluation } = await deserializeHostedProjectPayload(
        preview.contents,
        path,
        options.signal,
      );
      const previewProject = createPublishedVersionPreviewProject(projectData, previewReference);
      let datasets: ReturnType<typeof deserializeDatasets> = [];

      if (preview.datasetsContents) {
        datasets = deserializeDatasets(preview.datasetsContents);
        const evaluationDatasets =
          (
            JSON.parse(preview.datasetsContents) as {
              evaluationDatasets?: EvaluationProjectFileData['evaluationDatasets'];
            }
          ).evaluationDatasets ?? [];
        evaluation.evaluationDatasets = evaluationDatasets.map((dataset) => ({
          ...dataset,
          projectId: previewProject.metadata.id,
        }));
      }

      return complete(previewProject, evaluation, datasets);
    }

    const recordingId = getWorkflowRecordingIdFromVirtualProjectPath(path);
    if (recordingId) {
      const [data, replayDatasetResult] = await Promise.all([
        fetchWorkflowRecordingArtifactText(recordingId, 'replay-project', { signal: options.signal }),
        fetchWorkflowRecordingArtifactText(recordingId, 'replay-dataset', { signal: options.signal })
          .then((datasetsText) => ({ datasetsText }))
          .catch((error) => {
            const status =
              typeof error === 'object' &&
              error != null &&
              'status' in error &&
              typeof (error as { status?: unknown }).status === 'number'
                ? (error as { status: number }).status
                : undefined;

            if (status === 404) {
              return { datasetsText: null };
            }

            throw error;
          }),
      ]);
      const { project: projectData, evaluation } = await deserializeHostedProjectPayload(data, path, options.signal);
      let datasets: ReturnType<typeof deserializeDatasets> = [];

      if (replayDatasetResult.datasetsText) {
        datasets = deserializeDatasets(replayDatasetResult.datasetsText);
        evaluation.evaluationDatasets =
          (
            JSON.parse(replayDatasetResult.datasetsText) as {
              evaluationDatasets?: EvaluationProjectFileData['evaluationDatasets'];
            }
          ).evaluationDatasets ?? [];
      }

      return complete(projectData, evaluation, datasets);
    }

    const loaded = await apiLoadProject(path, options.signal);
    const data = loaded.contents;
    const { project: projectData, evaluation } = await deserializeHostedProjectPayload(data, path, options.signal);
    let datasets: ReturnType<typeof deserializeDatasets> = [];

    if (loaded.datasetsContents) {
      datasets = deserializeDatasets(loaded.datasetsContents);
      evaluation.evaluationDatasets =
        (
          JSON.parse(loaded.datasetsContents) as {
            evaluationDatasets?: EvaluationProjectFileData['evaluationDatasets'];
          }
        ).evaluationDatasets ?? [];
    }

    return complete(projectData, evaluation, datasets, loaded.revisionId ?? null);
  }

  async loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        // Chromium rejects custom extensions like ".rivet-recording" in picker type filters.
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: fileHandle.name });
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile({ accept: '.rivet-recording' });
    if (!file) {
      return;
    }

    const text = await file.text();
    callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: file.name });
  }

  async openDirectory(): Promise<string | string[] | null> {
    const path = prompt('Enter server directory path:');
    return path;
  }

  async openFilePath(): Promise<string> {
    const path = prompt('Enter server file path:');
    return path ?? '';
  }

  async saveString(content: string, defaultFileName: string): Promise<void> {
    if ('showSaveFilePicker' in window) {
      try {
        const fileHandle = await (window as any).showSaveFilePicker({ suggestedName: defaultFileName });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        // Fall back when the advertised picker API is unavailable or unusable.
      }
    }
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  async readFileAsString(callback: (data: string, fileName: string) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const text = await file.text();
        callback(text, file.name);
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile();
    if (!file) {
      return;
    }

    const text = await file.text();
    callback(text, file.name);
  }

  async readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void> {
    if ('showOpenFilePicker' in window) {
      try {
        const [fileHandle] = await (window as any).showOpenFilePicker();
        const file = await fileHandle.getFile();
        const buffer = await file.arrayBuffer();
        callback(new Uint8Array(buffer), file.name);
        return;
      } catch {
        return;
      }
    }

    const file = await pickSingleFile();
    if (!file) {
      return;
    }

    const buffer = await file.arrayBuffer();
    callback(new Uint8Array(buffer), file.name);
  }

  async readPathAsString(path: string): Promise<string> {
    if (path.endsWith('.rivet-project')) {
      return (await apiLoadProject(path)).contents;
    }

    return apiReadText(path);
  }

  async readPathAsBinary(path: string): Promise<Uint8Array> {
    return apiReadBinary(path);
  }
}
