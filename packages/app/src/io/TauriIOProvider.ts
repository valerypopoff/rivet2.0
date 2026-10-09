import {
  ExecutionRecorder,
  type NodeGraph,
  type Project,
  deserializeGraph,
  deserializeProject,
  serializeGraph,
  serializeProject,
} from '@valerypopoff/rivet2-core';
import {
  deserializeLegacyEvaluationProjectData,
  type PathBasedIOProvider,
  type LoadedProjectData,
  type ProjectLoadOptions,
} from './IOProvider.js';
import { getDefaultPathPolicyProvider, isInTauri } from '../utils/tauri.js';
import { saveDatasetsFile, readDatasetsFile } from './datasets.js';
import { type AppDatasetProvider, type PathPolicyProvider } from '../providers/ProvidersContext.js';
import { openDialog, saveDialog } from '../utils/platform/dialog.js';
import { nativeReadBinaryFile, nativeReadTextFile, nativeWriteFile } from '../utils/platform/fs.js';
import { readDesktopProjectBundle } from './DesktopProjectBundle.js';

export class TauriIOProvider implements PathBasedIOProvider {
  readonly readProjectBundle = readDesktopProjectBundle;
  readonly #datasetProvider: AppDatasetProvider;
  readonly #pathPolicy: PathPolicyProvider;

  constructor(datasetProvider: AppDatasetProvider, pathPolicy: PathPolicyProvider = getDefaultPathPolicyProvider()) {
    this.#datasetProvider = datasetProvider;
    this.#pathPolicy = pathPolicy;
  }

  static isSupported(): boolean {
    return isInTauri();
  }

  async saveGraphData(graphData: NodeGraph) {
    const filePath = await saveDialog({
      filters: [
        {
          name: 'Rivet Graph',
          extensions: ['rivet-graph'],
        },
      ],
      title: 'Save graph',
      defaultPath: `${graphData.metadata?.name ?? 'graph'}.rivet-graph`,
    });

    const data = serializeGraph(graphData) as string;

    if (filePath) {
      await nativeWriteFile({
        contents: data,
        path: filePath,
      });
    }
  }

  async saveProjectData(project: Project) {
    const filePath = await saveDialog({
      filters: [
        {
          name: 'Rivet Project',
          extensions: ['rivet-project'],
        },
      ],
      title: 'Save project',
      defaultPath: `${project.metadata?.title ?? 'project'}.rivet-project`,
    });

    const data = serializeProject(project) as string;

    if (filePath) {
      await nativeWriteFile({
        contents: data,
        path: filePath,
      });

      await saveDatasetsFile(filePath, project, this.#datasetProvider, this.#pathPolicy);

      return filePath;
    }

    return undefined;
  }

  async saveProjectDataNoPrompt(project: Project, path: string) {
    const data = serializeProject(project) as string;

    await nativeWriteFile({
      contents: data,
      path,
    });

    await saveDatasetsFile(path, project, this.#datasetProvider, this.#pathPolicy);
  }

  async loadGraphData(callback: (graphData: NodeGraph) => void) {
    const path = await openDialog({
      filters: [
        {
          name: 'Rivet Graph',
          extensions: ['rivet-graph'],
        },
      ],
      multiple: false,
      directory: false,
      recursive: false,
      title: 'Open graph',
    });

    if (path) {
      const data = await nativeReadTextFile(path as string);
      const graphData = deserializeGraph(data);
      callback(graphData);
    }
  }

  async loadProjectData(
    callback: (data: LoadedProjectData & { path: string }) => void | Promise<void>,
    options?: ProjectLoadOptions,
  ) {
    const path = (await openDialog({
      filters: [
        {
          name: 'Rivet Project or Bundle',
          extensions: ['rivet-project', 'json'],
        },
        {
          name: 'Rivet Bundle (rivet-bundle.json)',
          extensions: ['json'],
        },
        {
          name: 'Rivet Project',
          extensions: ['rivet-project'],
        },
      ],
      multiple: false,
      directory: false,
      recursive: false,
      title: 'Open project or bundle',
    })) as string | undefined;

    if (path) {
      const projectData = await this.loadProjectDataNoPrompt(path, options);
      await callback({ ...projectData, path: projectData.path ?? path });
    }
  }

  async loadProjectDataNoPrompt(path: string, options: ProjectLoadOptions = {}): Promise<LoadedProjectData> {
    options.signal?.throwIfAborted();
    const bundle = await this.readProjectBundle(path);
    options.signal?.throwIfAborted();
    const [projectData, attachedData] = bundle
      ? [structuredClone(bundle.snapshot.project), bundle.attachments]
      : deserializeProject(await nativeReadTextFile(path), path);
    if (bundle) projectData.plugins = structuredClone(bundle.manifest.plugins);

    const evaluationData = deserializeLegacyEvaluationProjectData(attachedData.evaluations);

    const { datasets, evaluationDatasets } = bundle
      ? { datasets: bundle.snapshot.datasets, evaluationDatasets: bundle.evaluationDatasets }
      : await readDatasetsFile(path, projectData, this.#pathPolicy);
    options.signal?.throwIfAborted();
    const bundleProjects = bundle?.workspaceProjects?.map((member) => ({
      path: member.path,
      project: { ...structuredClone(member.project), plugins: structuredClone(bundle.manifest.plugins) },
      evaluation: {
        evaluationData: deserializeLegacyEvaluationProjectData(member.attachments.evaluations),
        evaluationDatasets: member.evaluationDatasets,
      },
    }));
    const commit: NonNullable<LoadedProjectData['commit']> = async (isCurrent, skipProjects) => {
      if (!isCurrent() || options.signal?.aborted) return false;
      if (bundle?.workspaceProjects) {
        for (const member of bundle.workspaceProjects) {
          if (!isCurrent() || options.signal?.aborted) return false;
          if (skipProjects?.has(member.project.metadata.id) || member.project.metadata.id === projectData.metadata.id)
            continue;
          await this.#datasetProvider.importDatasetsForProject?.(member.project.metadata.id, member.datasets, {
            isCurrent,
            signal: options.signal,
            activate: false,
          });
        }
      }
      if (skipProjects?.has(projectData.metadata.id)) return isCurrent() && !options.signal?.aborted;
      await this.#datasetProvider.importDatasetsForProject?.(projectData.metadata.id, datasets, {
        isCurrent,
        signal: options.signal,
        activate: options.activateDatasets !== false,
      });
      return isCurrent() && !options.signal?.aborted;
    };
    const result = {
      project: projectData,
      evaluation: { evaluationData, evaluationDatasets },
      ...(bundleProjects ? { bundleProjects, bundleManifestPath: bundle!.manifestPath } : {}),
      ...(bundle ? { path: bundle.snapshot.sourceProjectPath } : {}),
    };
    if (options.deferCommit) return { ...result, commit };
    if (!(await commit(() => !options.signal?.aborted))) throw new DOMException('Project load cancelled', 'AbortError');
    return result;
  }

  async loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void) {
    const path = await openDialog({
      filters: [
        {
          name: 'Rivet Recording',
          extensions: ['rivet-recording'],
        },
      ],
      multiple: false,
      directory: false,
      recursive: false,
      title: 'Open recording',
    });

    if (path) {
      const data = await nativeReadTextFile(path as string);
      const recorder = ExecutionRecorder.deserializeFromString(data);
      callback({ recorder, path: path as string });
    }
  }

  async openDirectory() {
    const path = await openDialog({
      filters: [],
      multiple: false,
      directory: true,
      recursive: true,
      title: 'Choose Directory',
    });

    return path;
  }

  async openFilePath() {
    const path = await openDialog({
      filters: [],
      multiple: false,
      directory: false,
      recursive: false,
      title: 'Choose File',
    });

    return path as string;
  }

  async saveString(content: string, defaultFileName: string) {
    const path = await saveDialog({
      filters: [],
      title: 'Save File',
      defaultPath: defaultFileName,
    });

    if (path) {
      await nativeWriteFile({
        contents: content,
        path,
      });
    }
  }

  async readFileAsString(callback: (data: string, fileName: string) => void): Promise<void> {
    const path = await openDialog({
      multiple: false,
    });

    if (path) {
      const fileName = (path as string).split('/').pop() as string;

      const contents = await nativeReadTextFile(path as string);
      callback(contents, fileName);
    }
  }

  async readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void> {
    const path = await openDialog({
      multiple: false,
    });

    if (path) {
      const fileName = (path as string).split('/').pop() as string;

      const contents = await nativeReadBinaryFile(path as string);
      callback(contents, fileName);
    }
  }

  async readPathAsString(path: string): Promise<string> {
    const contents = await nativeReadTextFile(path);
    return contents;
  }

  async readPathAsBinary(path: string): Promise<Uint8Array> {
    const contents = await nativeReadBinaryFile(path);
    return contents;
  }
}
