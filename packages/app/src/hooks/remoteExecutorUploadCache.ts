import type { DataId, Project, Settings } from '@valerypopoff/rivet2-core';
import stableStringify from 'safe-stable-stringify';

export type RemoteExecutorUploadCache = {
  sessionKey?: string;
  uploadKey?: string;
};

export type RemoteExecutorUploadResult = 'cached' | 'uploaded';

const uploadCachesBySocket = new WeakMap<WebSocket, RemoteExecutorUploadCache>();

/** Upload state belongs to a connection, not the selected tab or its URL. */
export function getRemoteExecutorUploadCacheForSocket(socket: WebSocket | null): RemoteExecutorUploadCache {
  if (!socket) throw new Error('Cannot cache project uploads without an executor connection.');
  let cache = uploadCachesBySocket.get(socket);
  if (!cache) {
    cache = {};
    uploadCachesBySocket.set(socket, cache);
  }
  return cache;
}

export type RemoteExecutorUploadTransport = {
  sendDynamicData: (payload: { project: Project; settings: Settings }) => boolean;
  sendStaticData: (id: DataId, value: string) => boolean;
};

export function resetRemoteExecutorUploadCache(cache: RemoteExecutorUploadCache): void {
  cache.sessionKey = undefined;
  cache.uploadKey = undefined;
}

type RemoteExecutorProjectUploadOptions = {
  cache: RemoteExecutorUploadCache;
  project: Project;
  projectData?: Record<DataId, string>;
  sessionKey: string;
  settings: Settings;
  transport: RemoteExecutorUploadTransport;
};

/** Prepare once, then recheck the shared upload slot immediately before each run. */
export function prepareRemoteExecutorProjectUpload(options: RemoteExecutorProjectUploadOptions) {
  const { cache, project, projectData, sessionKey, settings, transport } = options;
  const staticDataEntries = getStaticProjectDataEntries(projectData);
  const uploadKey = createRemoteExecutorUploadKey(project, settings, staticDataEntries);
  return (): RemoteExecutorUploadResult => {
    if (cache.sessionKey === sessionKey && cache.uploadKey === uploadKey) return 'cached';
    // A partial upload replaces the executor's dynamic data too. Never leave
    // the previous key reusable when a later static-data send fails.
    resetRemoteExecutorUploadCache(cache);
    const projectUploadSent = transport.sendDynamicData({ project, settings });
    if (!projectUploadSent) {
      throw new Error('Remote executor disconnected before the project upload could be sent.');
    }

    for (const [id, dataValue] of staticDataEntries) {
      const staticDataSent = transport.sendStaticData(id, dataValue);
      if (!staticDataSent) {
        throw new Error('Remote executor disconnected before static project data could be sent.');
      }
    }

    cache.sessionKey = sessionKey;
    cache.uploadKey = uploadKey;
    return 'uploaded';
  };
}

export function uploadRemoteExecutorProjectIfNeeded(
  options: RemoteExecutorProjectUploadOptions,
): RemoteExecutorUploadResult {
  return prepareRemoteExecutorProjectUpload(options)();
}

function createRemoteExecutorUploadKey(
  project: Project,
  settings: Settings,
  staticDataEntries: Array<[DataId, string]>,
): string {
  const key = stableStringify({
    project,
    projectData: Object.fromEntries(staticDataEntries),
    settings,
  });

  if (key == null) {
    throw new Error('Failed to create remote executor upload cache key.');
  }

  return key;
}

function getStaticProjectDataEntries(projectData: Record<DataId, string> | undefined): Array<[DataId, string]> {
  return Object.entries(projectData ?? {}).sort(([left], [right]) => left.localeCompare(right)) as Array<
    [DataId, string]
  >;
}
