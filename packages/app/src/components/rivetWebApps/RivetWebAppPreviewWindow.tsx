import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphProgress, UiComponentId, UiGraph } from '@valerypopoff/rivet2-core';
import {
  RivetWebAppRenderer,
  type RivetWebAppActionResult,
  type RivetWebAppStorageAdapter,
} from './RivetWebAppRenderer.js';

export const RIVET_WEB_APP_PREVIEW_PARAM = 'rivet-web-app-preview';
export const RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX = 'rivet-web-app-preview:';

type PreviewPayload = {
  storage?: Record<string, unknown>;
  uiGraph: UiGraph;
};

type PreviewActionRequest =
  | {
      componentId: UiComponentId;
      requestId: string;
      state: Record<string, unknown>;
      storage: Record<string, unknown>;
      type: 'runAction';
    }
  | {
      requestId: string;
      type: 'cancelAction';
    }
  | {
      requestId: string;
      type: 'requestPayload';
    };

type PreviewActionResponse =
  | {
      progress: GraphProgress;
      requestId: string;
      type: 'actionProgress';
    }
  | {
      requestId: string;
      result: RivetWebAppActionResult;
      type: 'actionResult';
    }
  | {
      error: string;
      requestId: string;
      type: 'actionError';
    }
  | {
      payload: PreviewPayload;
      requestId: string;
      type: 'previewPayload';
    }
  | {
      error: string;
      requestId: string;
      type: 'previewPayloadError';
    };

export function isRivetWebAppPreviewWindow(): boolean {
  return new URLSearchParams(window.location.search).has(RIVET_WEB_APP_PREVIEW_PARAM);
}

export function createRivetWebAppPreviewUrl(token: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(RIVET_WEB_APP_PREVIEW_PARAM, token);
  return url.toString();
}

export function writeRivetWebAppPreviewPayload(token: string, payload: PreviewPayload): void {
  try {
    localStorage.setItem(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`, JSON.stringify(payload));
  } catch {
    // The preview requests the same payload over BroadcastChannel below when
    // this webview cannot access browser storage.
  }
}

export function clearRivetWebAppPreviewPayload(token: string): void {
  try {
    localStorage.removeItem(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`);
  } catch {
    // The temporary payload is already inaccessible and expires with its token.
  }
}

export const RivetWebAppPreviewWindow: FC = () => {
  const token = new URLSearchParams(window.location.search).get(RIVET_WEB_APP_PREVIEW_PARAM);
  const [error, setError] = useState<string | undefined>();
  const [payload, setPayload] = useState<PreviewPayload | undefined>();
  const storageRef = useRef<Record<string, unknown>>({});
  const channel = useMemo(
    () => (token ? new BroadcastChannel(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`) : undefined),
    [token],
  );

  useEffect(() => {
    if (!token || !channel) {
      return;
    }

    let active = true;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    let removePayloadListener = () => {};
    const applyPayload = (nextPayload: PreviewPayload) => {
      storageRef.current = isRecord(nextPayload.storage) ? nextPayload.storage : {};
      document.title = nextPayload.uiGraph.name;
      setPayload(nextPayload);
      setError(undefined);
    };

    let storedPayload: string | null = null;
    try {
      storedPayload = localStorage.getItem(`${RIVET_WEB_APP_PREVIEW_STORAGE_PREFIX}${token}`);
    } catch {
      // Fall through to the parent-window payload request.
    }

    if (!storedPayload) {
      const requestId = crypto.randomUUID();
      const handlePayloadMessage = (event: MessageEvent<PreviewActionResponse>) => {
        if (!active || event.data.requestId !== requestId) {
          return;
        }

        removePayloadListener();

        if (event.data.type === 'previewPayload') {
          applyPayload(event.data.payload);
        } else if (event.data.type === 'previewPayloadError') {
          setError(event.data.error);
        }
      };

      removePayloadListener = () => {
        if (timeoutId) {
          globalThis.clearTimeout(timeoutId);
          timeoutId = undefined;
        }

        channel.removeEventListener('message', handlePayloadMessage);
      };

      channel.addEventListener('message', handlePayloadMessage);
      channel.postMessage({ requestId, type: 'requestPayload' } satisfies PreviewActionRequest);

      timeoutId = globalThis.setTimeout(() => {
        removePayloadListener();
        if (active) {
          setError('Rivet web app preview payload is missing.');
        }
      }, 5000);
    } else {
      try {
        applyPayload(JSON.parse(storedPayload) as PreviewPayload);
      } catch {
        setError('Failed to load Rivet web app preview.');
      }
    }

    return () => {
      active = false;
      removePayloadListener();
      channel.close();
    };
  }, [channel, token]);

  const storageAdapter = useMemo<RivetWebAppStorageAdapter>(
    () => ({
      applyPatch: (patch) => {
        storageRef.current = { ...storageRef.current, ...patch };
      },
      load: () => storageRef.current,
    }),
    [],
  );

  const runAction = (
    componentId: UiComponentId,
    state: Record<string, unknown>,
    abortSignal: AbortSignal,
    onProgress: (progress: GraphProgress) => void,
    storage: Record<string, unknown>,
  ): Promise<RivetWebAppActionResult> => {
    if (!channel) {
      return Promise.reject(new Error('Preview channel is not available.'));
    }

    const requestId = crypto.randomUUID();
    const request: PreviewActionRequest = { componentId, requestId, state, storage, type: 'runAction' };

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener('message', handleMessage);
        abortSignal.removeEventListener('abort', handleAbort);
      };
      const handleMessage = (event: MessageEvent<PreviewActionResponse>) => {
        if (event.data.requestId !== requestId) {
          return;
        }

        if (event.data.type === 'actionProgress') {
          onProgress(event.data.progress);
          return;
        }

        cleanup();
        if (event.data.type === 'actionResult') {
          resolve(event.data.result);
        } else if (event.data.type === 'actionError') {
          reject(new Error(event.data.error));
        }
      };
      const handleAbort = () => {
        cleanup();
        try {
          channel.postMessage({ requestId, type: 'cancelAction' } satisfies PreviewActionRequest);
        } catch {
          // The preview channel may already be closed while the window is unloading.
        }
        reject(abortSignal.reason ?? new DOMException('The web app action was aborted.', 'AbortError'));
      };

      if (abortSignal.aborted) {
        handleAbort();
        return;
      }
      channel.addEventListener('message', handleMessage);
      abortSignal.addEventListener('abort', handleAbort, { once: true });
      channel.postMessage(request);
    });
  };

  if (error) {
    return <div>{error}</div>;
  }

  if (!payload) {
    return <div>Loading Rivet web app preview...</div>;
  }

  return <RivetWebAppRenderer uiGraph={payload.uiGraph} onRunAction={runAction} storageAdapter={storageAdapter} />;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { PreviewActionRequest, PreviewActionResponse };
