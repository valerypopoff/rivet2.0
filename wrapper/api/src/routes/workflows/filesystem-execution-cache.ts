import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  NodeDatasetProvider,
  deserializeDatasets,
  type AttachedData,
  type Project,
} from '@valerypopoff/rivet2-node';

import {
  arePathSignaturesEqual,
  capturePathMetadata,
  capturePathSignature,
  isPathValidationStateFresh,
  loadFilesystemExecutionMaterialization,
  resolveFilesystemLatestExecutionPointer,
  resolveFilesystemPublishedExecutionPointer,
  scanFilesystemExecutionCandidates,
  type FilesystemExecutionCandidate,
  type FilesystemExecutionMaterialization,
  type FilesystemExecutionPointer,
  type FilesystemExecutionRunKind,
  type FilesystemPathValidationState,
  type PathSignature,
} from './filesystem-execution-source.js';
import { getWorkflowDatasetPath } from './fs-helpers.js';
import { normalizeWorkflowEndpointLookupName } from './endpoint-names.js';

export type FilesystemExecutionProjectResult = {
  project: Project;
  attachedData: AttachedData;
  datasetProvider: NodeDatasetProvider;
  projectVirtualPath: string;
  revisionKey: string;
  debug: {
    cacheStatus: 'hit' | 'miss' | 'bypass';
    resolveMs: number;
    materializeMs: number;
  };
};

type FilesystemEndpointIndex = {
  latestByEndpoint: Map<string, FilesystemExecutionPointer>;
  publishedByEndpoint: Map<string, FilesystemExecutionPointer>;
  globalValidationState: FilesystemValidationState;
};

type FilesystemMaterializationCacheEntry = FilesystemExecutionMaterialization;

type FilesystemPendingMaterializationLoad = {
  pointer: FilesystemExecutionPointer;
  promise: Promise<FilesystemMaterializationCacheEntry>;
};

type FilesystemValidationState = {
  directories: Map<string, PathSignature>;
  settingsPaths: FilesystemPathValidationState;
};

function createCachedExecutionPointer(
  candidate: FilesystemExecutionCandidate,
  executionProjectPath: string,
  liveInputSignatures?: FilesystemPathValidationState,
): FilesystemExecutionPointer {
  return {
    sourceProjectPath: candidate.projectPath,
    executionProjectPath,
    settingsPath: candidate.settingsPath,
    routingValidationState: {
      settingsSignature: candidate.settingsSignature,
      liveInputSignatures: new Map(liveInputSignatures ?? []),
    },
  };
}

function createFilesystemExecutionRevisionKey(
  pointer: FilesystemExecutionPointer,
  materialization: FilesystemExecutionMaterialization,
): string {
  const hash = createHash('sha256');
  for (const signature of [materialization.projectSignature, materialization.datasetSignature]) {
    hash.update(signature.type);
    hash.update('\0');
    hash.update(String(signature.size ?? ''));
    hash.update('\0');
    hash.update(String(signature.mtimeMs ?? ''));
    hash.update('\0');
    hash.update(signature.entriesKey ?? '');
    hash.update('\0');
  }
  hash.update(pointer.sourceProjectPath);
  hash.update('\0');
  hash.update(pointer.executionProjectPath);
  return `filesystem:${hash.digest('hex').slice(0, 32)}`;
}

async function isMaterializationFresh(entry: FilesystemMaterializationCacheEntry): Promise<boolean> {
  const [currentProjectSignature, currentDatasetSignature] = await Promise.all([
    capturePathSignature(entry.executionProjectPath),
    capturePathSignature(getWorkflowDatasetPath(entry.executionProjectPath)),
  ]);

  if (!arePathSignaturesEqual(entry.projectSignature, currentProjectSignature)) {
    return false;
  }

  return arePathSignaturesEqual(entry.datasetSignature, currentDatasetSignature);
}

async function isValidationStateFresh(validationState: FilesystemValidationState): Promise<boolean> {
  if (!await isPathValidationStateFresh(validationState.settingsPaths)) {
    return false;
  }

  const currentMetadata = await Promise.all(
    [...validationState.directories.values()].map((signature) => capturePathMetadata(signature.path)),
  );

  const changedDirectoryPaths: string[] = [];
  for (const [index, directorySignature] of [...validationState.directories.values()].entries()) {
    const metadata = currentMetadata[index];
    if (metadata.type !== directorySignature.type) {
      return false;
    }

    if (metadata.type !== 'directory') {
      if (!arePathSignaturesEqual(directorySignature, { ...metadata, entriesKey: null })) {
        return false;
      }

      continue;
    }

    if (metadata.mtimeMs !== directorySignature.mtimeMs) {
      changedDirectoryPaths.push(directorySignature.path);
    }
  }

  if (changedDirectoryPaths.length === 0) {
    return true;
  }

  const changedSignatures = await Promise.all(
    changedDirectoryPaths.map((directoryPath) => capturePathSignature(directoryPath)),
  );

  for (const [index, currentSignature] of changedSignatures.entries()) {
    const directoryPath = changedDirectoryPaths[index];
    const previousSignature = validationState.directories.get(directoryPath);
    if (!previousSignature) {
      return false;
    }

    if (currentSignature.entriesKey !== previousSignature.entriesKey) {
      return false;
    }

    validationState.directories.set(directoryPath, currentSignature);
  }

  return true;
}

async function isPointerRoutingFresh(pointer: FilesystemExecutionPointer): Promise<boolean> {
  if (!arePathSignaturesEqual(
    pointer.routingValidationState.settingsSignature,
    await capturePathSignature(pointer.settingsPath),
  )) {
    return false;
  }

  return isPathValidationStateFresh(pointer.routingValidationState.liveInputSignatures);
}

export class FilesystemExecutionCache {
  #root: string | null = null;
  #endpointIndex: FilesystemEndpointIndex | null = null;
  #indexDirty = true;
  #indexVersion = 0;
  #rebuildPromise: Promise<void> | null = null;
  #materializationCache = new Map<string, FilesystemMaterializationCacheEntry>();
  #materializationLoadPromises = new Map<string, FilesystemPendingMaterializationLoad>();
  #materializationVersions = new Map<string, number>();

  async initialize(root: string): Promise<void> {
    this.reset(root);
    await this.#rebuildIndex(root);
  }

  reset(nextRoot: string | null = null): void {
    this.#root = nextRoot;
    this.#endpointIndex = null;
    this.#indexDirty = true;
    this.#indexVersion = 0;
    this.#rebuildPromise = null;
    this.#materializationCache.clear();
    this.#materializationLoadPromises.clear();
    this.#materializationVersions.clear();
  }

  markIndexDirty(): void {
    this.#indexDirty = true;
    this.#indexVersion += 1;
  }

  invalidateProjectMaterializations(projectPaths: Iterable<string>): void {
    const invalidatedPaths = new Set(projectPaths);
    if (invalidatedPaths.size === 0) {
      return;
    }

    const invalidatedExecutionProjectPaths = new Set<string>();

    for (const [executionProjectPath, entry] of this.#materializationCache.entries()) {
      if (
        invalidatedPaths.has(entry.sourceProjectPath) ||
        invalidatedPaths.has(entry.executionProjectPath)
      ) {
        this.#materializationCache.delete(executionProjectPath);
        invalidatedExecutionProjectPaths.add(executionProjectPath);
      }
    }

    for (const [executionProjectPath, pendingLoad] of this.#materializationLoadPromises.entries()) {
      if (
        invalidatedPaths.has(pendingLoad.pointer.sourceProjectPath) ||
        invalidatedPaths.has(pendingLoad.pointer.executionProjectPath)
      ) {
        this.#materializationLoadPromises.delete(executionProjectPath);
        invalidatedExecutionProjectPaths.add(executionProjectPath);
      }
    }

    for (const executionProjectPath of invalidatedExecutionProjectPaths) {
      this.#materializationVersions.set(
        executionProjectPath,
        (this.#materializationVersions.get(executionProjectPath) ?? 0) + 1,
      );
    }
  }

  async loadPublishedExecutionProject(root: string, endpointName: string): Promise<FilesystemExecutionProjectResult | null> {
    return this.#loadExecutionProject(root, 'published', endpointName);
  }

  async loadLatestExecutionProject(root: string, endpointName: string): Promise<FilesystemExecutionProjectResult | null> {
    return this.#loadExecutionProject(root, 'latest', endpointName);
  }

  async #loadExecutionProject(
    root: string,
    runKind: FilesystemExecutionRunKind,
    endpointName: string,
  ): Promise<FilesystemExecutionProjectResult | null> {
    const lookupName = normalizeWorkflowEndpointLookupName(endpointName);
    const resolveStartedAt = performance.now();
    const cacheStatus = await this.#ensureFreshIndex(root);
    const pointer = this.#getCachedPointer(runKind, lookupName);

    if (!pointer) {
      return null;
    }

    if (!await isPointerRoutingFresh(pointer)) {
      this.markIndexDirty();
      return this.#loadExecutionProjectBypass(root, runKind, lookupName, resolveStartedAt);
    }

    const resolveMs = Math.max(0, Math.round(performance.now() - resolveStartedAt));
    const materializeStartedAt = performance.now();

    let materialization: FilesystemMaterializationCacheEntry;
    try {
      materialization = await this.#getOrLoadMaterialization(pointer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.invalidateProjectMaterializations([pointer.sourceProjectPath, pointer.executionProjectPath]);
        this.markIndexDirty();
        return this.#loadExecutionProjectBypass(root, runKind, lookupName, resolveStartedAt);
      }

      throw error;
    }

    return this.#createExecutionProjectResult(
      pointer,
      materialization,
      cacheStatus,
      resolveMs,
      materializeStartedAt,
    );
  }

  #getCachedPointer(
    runKind: FilesystemExecutionRunKind,
    lookupName: string,
  ): FilesystemExecutionPointer | null {
    const index = this.#endpointIndex;
    if (!index) {
      return null;
    }

    return runKind === 'published'
      ? index.publishedByEndpoint.get(lookupName) ?? null
      : index.latestByEndpoint.get(lookupName) ?? null;
  }

  async #loadExecutionProjectBypass(
    root: string,
    runKind: FilesystemExecutionRunKind,
    lookupName: string,
    resolveStartedAt: number,
  ): Promise<FilesystemExecutionProjectResult | null> {
    const pointer = runKind === 'published'
      ? await resolveFilesystemPublishedExecutionPointer(root, lookupName)
      : await resolveFilesystemLatestExecutionPointer(root, lookupName);

    if (!pointer) {
      return null;
    }

    const resolveMs = Math.max(0, Math.round(performance.now() - resolveStartedAt));
    const materializeStartedAt = performance.now();
    const materialization = await loadFilesystemExecutionMaterialization(pointer);
    return this.#createExecutionProjectResult(
      pointer,
      materialization,
      'bypass',
      resolveMs,
      materializeStartedAt,
    );
  }

  #createExecutionProjectResult(
    pointer: FilesystemExecutionPointer,
    materialization: FilesystemExecutionMaterialization,
    cacheStatus: 'hit' | 'miss' | 'bypass',
    resolveMs: number,
    materializeStartedAt: number,
  ): FilesystemExecutionProjectResult {
    const datasetProvider = new NodeDatasetProvider(
      materialization.datasetsContents ? deserializeDatasets(materialization.datasetsContents) : [],
    );

    return {
      project: materialization.project,
      attachedData: materialization.attachedData,
      datasetProvider,
      projectVirtualPath: pointer.sourceProjectPath,
      revisionKey: createFilesystemExecutionRevisionKey(pointer, materialization),
      debug: {
        cacheStatus,
        resolveMs,
        materializeMs: Math.max(0, Math.round(performance.now() - materializeStartedAt)),
      },
    };
  }

  async #ensureFreshIndex(root: string): Promise<'hit' | 'miss'> {
    if (this.#root !== root) {
      this.reset(root);
    }

    if (!this.#endpointIndex || this.#indexDirty) {
      await this.#rebuildIndex(root);
      return 'miss';
    }

    if (!await isValidationStateFresh(this.#endpointIndex.globalValidationState)) {
      this.#indexDirty = true;
      await this.#rebuildIndex(root);
      return 'miss';
    }

    return 'hit';
  }

  async #rebuildIndex(root: string): Promise<void> {
    if (this.#rebuildPromise) {
      await this.#rebuildPromise;
      return;
    }

    this.#rebuildPromise = (async () => {
      while (this.#root === root) {
        const rebuildVersion = this.#indexVersion;
        const nextIndex = await this.#buildIndex(root);
        if (this.#root !== root) {
          return;
        }

        if (rebuildVersion !== this.#indexVersion) {
          continue;
        }

        this.#endpointIndex = nextIndex;
        this.#indexDirty = false;
        return;
      }
    })().finally(() => {
      this.#rebuildPromise = null;
    });

    await this.#rebuildPromise;
  }

  async #buildIndex(root: string): Promise<FilesystemEndpointIndex> {
    const scan = await scanFilesystemExecutionCandidates(root);
    const latestByEndpoint = new Map<string, FilesystemExecutionPointer>();
    const publishedByEndpoint = new Map<string, FilesystemExecutionPointer>();
    const publishedLiveInputsByEndpoint = new Map<string, FilesystemPathValidationState>();

    for (const candidate of scan.candidates) {
      if (candidate.latestLookupName && !latestByEndpoint.has(candidate.latestLookupName)) {
        latestByEndpoint.set(
          candidate.latestLookupName,
          createCachedExecutionPointer(candidate, candidate.projectPath),
        );
      }

      if (!candidate.publishedLookupName) {
        continue;
      }

      if (publishedByEndpoint.has(candidate.publishedLookupName)) {
        continue;
      }

      let endpointLiveInputs = publishedLiveInputsByEndpoint.get(candidate.publishedLookupName);
      if (!endpointLiveInputs) {
        endpointLiveInputs = new Map();
        publishedLiveInputsByEndpoint.set(candidate.publishedLookupName, endpointLiveInputs);
      }

      for (const [filePath, signature] of candidate.publishedLiveInputSignatures) {
        endpointLiveInputs.set(filePath, signature);
      }

      if (candidate.publishedExecutionProjectPath) {
        publishedByEndpoint.set(
          candidate.publishedLookupName,
          createCachedExecutionPointer(candidate, candidate.publishedExecutionProjectPath, endpointLiveInputs),
        );
      }
    }

    return {
      latestByEndpoint,
      publishedByEndpoint,
      globalValidationState: {
        directories: new Map(
          await Promise.all(scan.directories.map(async (directoryPath) =>
            [directoryPath, await capturePathSignature(directoryPath)] as const)),
        ),
        settingsPaths: new Map(scan.candidates.map((candidate) => [candidate.settingsPath, candidate.settingsSignature])),
      },
    };
  }

  async #getOrLoadMaterialization(pointer: FilesystemExecutionPointer): Promise<FilesystemMaterializationCacheEntry> {
    const cached = this.#materializationCache.get(pointer.executionProjectPath);
    if (
      cached &&
      cached.sourceProjectPath === pointer.sourceProjectPath &&
      await isMaterializationFresh(cached)
    ) {
      return cached;
    }

    const existingLoad = this.#materializationLoadPromises.get(pointer.executionProjectPath);
    if (existingLoad && existingLoad.pointer.sourceProjectPath === pointer.sourceProjectPath) {
      return existingLoad.promise;
    }

    const loadVersion = this.#materializationVersions.get(pointer.executionProjectPath) ?? 0;
    const loadPromise = loadFilesystemExecutionMaterialization(pointer)
      .then((entry) => {
        if ((this.#materializationVersions.get(pointer.executionProjectPath) ?? 0) === loadVersion) {
          this.#materializationCache.set(pointer.executionProjectPath, entry);
        }

        return entry;
      })
      .finally(() => {
        const pendingLoad = this.#materializationLoadPromises.get(pointer.executionProjectPath);
        if (pendingLoad?.promise === loadPromise) {
          this.#materializationLoadPromises.delete(pointer.executionProjectPath);
        }
      });

    this.#materializationLoadPromises.set(pointer.executionProjectPath, {
      pointer,
      promise: loadPromise,
    });
    return loadPromise;
  }
}

const filesystemExecutionCache = new FilesystemExecutionCache();

export function getFilesystemExecutionCache(): FilesystemExecutionCache {
  return filesystemExecutionCache;
}

export function resetFilesystemExecutionCacheForTests(): void {
  filesystemExecutionCache.reset();
}
