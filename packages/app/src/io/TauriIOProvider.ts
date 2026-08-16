import {
  ExecutionRecorder,
  type NodeGraph,
  type Project,
  deserializeGraph,
  deserializeProject,
  serializeGraph,
  serializeProject,
} from '@valerypopoff/rivet2-core';
import { type EvaluationProjectFileData, type PathBasedIOProvider } from './IOProvider.js';
import { getDefaultPathPolicyProvider, isInTauri } from '../utils/tauri.js';
import {
  createEmptyEvaluationProjectData,
  deserializeEvaluationProjectData,
  serializeEvaluationProjectData,
} from '@valerypopoff/rivet2-evaluations';
import { saveDatasetsFile, loadDatasetsFile } from './datasets.js';
import { type AppDatasetProvider, type PathPolicyProvider } from '../providers/ProvidersContext.js';
import { openDialog, saveDialog } from '../utils/platform/dialog.js';
import { nativeReadBinaryFile, nativeReadTextFile, nativeWriteFile } from '../utils/platform/fs.js';

export class TauriIOProvider implements PathBasedIOProvider {
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

  async saveProjectData(project: Project, evaluation: EvaluationProjectFileData) {
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

    const data = serializeProject(project, {
      evaluations: serializeEvaluationProjectData(evaluation.evaluationData),
    }) as string;

    if (filePath) {
      await nativeWriteFile({
        contents: data,
        path: filePath,
      });

      await saveDatasetsFile(filePath, project, this.#datasetProvider, evaluation.evaluationDatasets, this.#pathPolicy);

      return filePath;
    }

    return undefined;
  }

  async saveProjectDataNoPrompt(project: Project, evaluation: EvaluationProjectFileData, path: string) {
    const data = serializeProject(project, {
      evaluations: serializeEvaluationProjectData(evaluation.evaluationData),
    }) as string;

    await nativeWriteFile({
      contents: data,
      path,
    });

    await saveDatasetsFile(path, project, this.#datasetProvider, evaluation.evaluationDatasets, this.#pathPolicy);
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

  async loadProjectData(callback: (data: { project: Project; evaluation: EvaluationProjectFileData; path: string }) => void) {
    const path = (await openDialog({
      filters: [
        {
          name: 'Rivet Project',
          extensions: ['rivet-project'],
        },
      ],
      multiple: false,
      directory: false,
      recursive: false,
      title: 'Open graph',
    })) as string | undefined;

    if (path) {
      const projectData = await this.loadProjectDataNoPrompt(path);
      callback({ ...projectData, path });
    }
  }

  async loadProjectDataNoPrompt(path: string): Promise<{ project: Project; evaluation: EvaluationProjectFileData }> {
    const data = await nativeReadTextFile(path);
    const [projectData, attachedData] = deserializeProject(data, path);

    const evaluationData = attachedData.evaluations
      ? deserializeEvaluationProjectData(attachedData.evaluations)
      : createEmptyEvaluationProjectData();

    const evaluationDatasets = await loadDatasetsFile(path, projectData, this.#datasetProvider, this.#pathPolicy);

    return { project: projectData, evaluation: { evaluationData, evaluationDatasets } };
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
