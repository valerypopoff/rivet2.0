import {
  type NodeGraph,
  type Project,
  ExecutionRecorder,
  deserializeGraph,
  deserializeProject,
  serializeGraph,
  serializeProject,
} from '@valerypopoff/rivet2-core';
import { type EvaluationProjectFileData, type IOProvider } from './IOProvider.js';
import {
  createEmptyEvaluationProjectData,
  deserializeEvaluationProjectData,
  serializeEvaluationProjectData,
} from '@valerypopoff/rivet2-evaluations';
import { openBrowserFile } from './browserFileInput.js';

const PROJECT_FILE_EXTENSION = '.rivet-project';
const PROJECT_FILE_HANDLE_PATH_PREFIX = 'browser-project-handle';

type BrowserFilePermissionMode = 'read' | 'readwrite';

type PermissionAwareFileHandle = FileSystemFileHandle & {
  queryPermission?: (descriptor?: { mode?: BrowserFilePermissionMode }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: BrowserFilePermissionMode }) => Promise<PermissionState>;
};

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'name' in error && error.name === 'AbortError';
}

function isProjectFileName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(PROJECT_FILE_EXTENSION);
}

async function ensureFileHandlePermission(
  fileHandle: FileSystemFileHandle,
  mode: BrowserFilePermissionMode,
): Promise<boolean> {
  const permissionAwareFileHandle = fileHandle as PermissionAwareFileHandle;
  const descriptor = { mode };

  if (!permissionAwareFileHandle.queryPermission && !permissionAwareFileHandle.requestPermission) {
    return true;
  }

  try {
    const currentPermission = await permissionAwareFileHandle.queryPermission?.(descriptor);

    if (currentPermission === 'granted') {
      return true;
    }

    const requestedPermission = await permissionAwareFileHandle.requestPermission?.(descriptor);
    return requestedPermission === 'granted';
  } catch {
    return false;
  }
}

async function writeProjectFile(
  fileHandle: FileSystemFileHandle,
  project: Project,
  evaluation: EvaluationProjectFileData,
): Promise<void> {
  const canWrite = await ensureFileHandlePermission(fileHandle, 'readwrite');

  if (!canWrite) {
    throw new Error('Browser write permission was not granted for this project file. Use Save project as...');
  }

  const writable = await fileHandle.createWritable();
  await writable.write(serializeProject(project, { evaluations: serializeEvaluationProjectData(evaluation.evaluationData) }) as string);
  await writable.close();
}

export class BrowserIOProvider implements IOProvider {
  readonly #projectFileHandles = new Map<string, FileSystemFileHandle>();
  #nextProjectFileHandleId = 0;

  static isSupported(): boolean {
    return 'showSaveFilePicker' in window;
  }

  async saveGraphData(graphData: NodeGraph): Promise<void> {
    const fileHandle = await window.showSaveFilePicker();
    const writable = await fileHandle.createWritable();
    await writable.write(serializeGraph(graphData) as string);
    await writable.close();
  }

  async saveProjectData(project: Project, evaluation: EvaluationProjectFileData): Promise<string | undefined> {
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: `${project.metadata?.title ?? 'project'}${PROJECT_FILE_EXTENSION}`,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return undefined;
      }
      throw error;
    }

    await writeProjectFile(fileHandle, project, evaluation);

    return this.rememberProjectFileHandle(fileHandle);
  }

  canSaveProjectDataNoPrompt(path: string): boolean {
    return this.#projectFileHandles.has(path);
  }

  async saveProjectDataNoPrompt(project: Project, evaluation: EvaluationProjectFileData, path: string): Promise<void> {
    const fileHandle = this.#projectFileHandles.get(path);

    if (!fileHandle) {
      throw new Error('Browser project file handle is not available. Use Save project as... to choose a save target.');
    }

    await writeProjectFile(fileHandle, project, evaluation);
  }

  async loadGraphData(callback: (graphData: NodeGraph) => void): Promise<void> {
    const file = await openBrowserFile({ accept: '.rivet-graph' });
    if (!file) return;

    const text = await file.text();
    callback(deserializeGraph(text));
  }

  async loadProjectData(
    callback: (data: { project: Project; evaluation: EvaluationProjectFileData; path: string }) => void,
  ): Promise<void> {
    const projectFile = await this.openProjectFile();
    if (!projectFile) return;

    const text = await projectFile.file.text();

    const [project, attachedData] = deserializeProject(text);

    const evaluationData = attachedData?.evaluations
      ? deserializeEvaluationProjectData(attachedData.evaluations)
      : createEmptyEvaluationProjectData();

    callback({ project, evaluation: { evaluationData, evaluationDatasets: [] }, path: projectFile.path });
  }

  private async openProjectFile(): Promise<{ file: File; path: string } | undefined> {
    const projectFileFromPicker = await this.openProjectFileWithHandle();
    if (projectFileFromPicker !== 'fallback') {
      return projectFileFromPicker;
    }

    const file = await openBrowserFile({ accept: PROJECT_FILE_EXTENSION });
    return file ? { file, path: file.name } : undefined;
  }

  private async openProjectFileWithHandle(): Promise<{ file: File; path: string } | undefined | 'fallback'> {
    if (!('showOpenFilePicker' in window)) {
      return 'fallback';
    }

    let fileHandle: FileSystemFileHandle | undefined;

    try {
      [fileHandle] = await window.showOpenFilePicker({
        multiple: false,
      });
    } catch (err) {
      if (isAbortError(err)) {
        return undefined;
      }

      return 'fallback';
    }

    if (!fileHandle) {
      return undefined;
    }

    if (!isProjectFileName(fileHandle.name)) {
      throw new Error(`Expected a ${PROJECT_FILE_EXTENSION} project file, but "${fileHandle.name}" was selected.`);
    }

    let file: File;
    try {
      file = await fileHandle.getFile();
    } catch (err) {
      throw new Error(
        `Browser could not read "${fileHandle.name}" from the file picker. Try opening Rivet in a browser that supports writable local file handles, or use Save project as... after opening through the fallback file picker.`,
        { cause: err },
      );
    }

    return { file, path: this.rememberProjectFileHandle(fileHandle) };
  }

  private rememberProjectFileHandle(fileHandle: FileSystemFileHandle): string {
    const path = `${PROJECT_FILE_HANDLE_PATH_PREFIX}/${++this.#nextProjectFileHandleId}/${fileHandle.name}`;
    this.#projectFileHandles.set(path, fileHandle);
    return path;
  }

  async loadRecordingData(callback: (data: { recorder: ExecutionRecorder; path: string }) => void): Promise<void> {
    const file = await openBrowserFile({ accept: '.rivet-recording' });
    if (!file) return;

    const text = await file.text();
    callback({ recorder: ExecutionRecorder.deserializeFromString(text), path: file.name });
  }

  async saveString(content: string, defaultFileName: string): Promise<void> {
    const fileHandle = await window.showSaveFilePicker({ suggestedName: defaultFileName });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async readFileAsString(callback: (data: string, fileName: string) => void): Promise<void> {
    const file = await openBrowserFile();
    if (!file) return;

    const text = await file.text();
    callback(text, file.name);
  }

  async readFileAsBinary(callback: (data: Uint8Array, fileName: string) => void): Promise<void> {
    const file = await openBrowserFile();
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    callback(new Uint8Array(arrayBuffer), file.name);
  }
}
