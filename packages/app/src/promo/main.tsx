import 'core-js/actual';
import '@fontsource/roboto/300.css';
import '@fontsource/roboto/400.css';
import '@fontsource/roboto/500.css';
import '@fontsource/roboto/700.css';
import '@fontsource/roboto/900.css';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/700.css';
import ReactDOM from 'react-dom/client';
import { useCallback, useRef, useState } from 'react';
import { deserializeProject, getError, type GraphId } from '@valerypopoff/rivet2-core';
import { MemoryAsyncStorage, MemoryStaticDataStore, RivetAppHost, type RivetWorkspaceHost } from '../host.js';
import { installGlobalErrorHandlers } from '../utils/errorHandling.js';
import agentProjectSource from './projects/promo-agent.rivet-project?raw';
import batchRunsProjectSource from './projects/promo-batch-runs.rivet-project?raw';
import structuredOutputProjectSource from './projects/promo-structured-output.rivet-project?raw';
import webAppProjectSource from './projects/promo-web-app.rivet-project?raw';
import workflowProjectSource from './projects/promo-workflow.rivet-project?raw';
import { isPromoProjectKey, PROMO_PROJECT_MANIFEST, type PromoProjectKey } from './promoProjectManifest.js';
import '../host.css';
import './promo.css';

const PROMO_PROJECT_SOURCES = {
  agent: agentProjectSource,
  'batch-runs': batchRunsProjectSource,
  'structured-output': structuredOutputProjectSource,
  'web-app': webAppProjectSource,
  workflow: workflowProjectSource,
} satisfies Record<PromoProjectKey, string>;

type PromoProjectDefinition = (typeof PROMO_PROJECT_MANIFEST)[PromoProjectKey] & { source: string };
type PromoProjectSelection = { definition: PromoProjectDefinition } | { error: string };

function getSelectedPromoProject(search: string): PromoProjectSelection {
  const requestedProject = new URLSearchParams(search).get('project');
  if (!requestedProject) {
    return {
      definition: { ...PROMO_PROJECT_MANIFEST.agent, source: PROMO_PROJECT_SOURCES.agent },
    };
  }

  if (isPromoProjectKey(requestedProject)) {
    return {
      definition: {
        ...PROMO_PROJECT_MANIFEST[requestedProject],
        source: PROMO_PROJECT_SOURCES[requestedProject],
      },
    };
  }

  return { error: `Unknown Rivet demo project "${requestedProject}".` };
}

const selectedPromoProject = getSelectedPromoProject(window.location.search);
const selectedPromoDefinition = 'definition' in selectedPromoProject ? selectedPromoProject.definition : undefined;
const PROMO_HOST_UI = {
  checkForUpdates: false,
  fileMenu: { visibleItems: [] },
  preloadCodeEditor: false,
  workspaceTabs: { visibleItems: [] },
} as const;

type PromoMessage =
  | { type: 'rivet-demo:error'; message: string }
  | { type: 'rivet-demo:ready' }
  | { type: 'rivet-demo:release' };

let latestStartupMessage: Extract<PromoMessage, { type: 'rivet-demo:error' | 'rivet-demo:ready' }> | undefined;

function postToParent(message: PromoMessage) {
  if (message.type === 'rivet-demo:error' || message.type === 'rivet-demo:ready') {
    latestStartupMessage = message;
  }

  if (window.parent !== window) {
    window.parent.postMessage(message, '*');
  }
}

function createPromoSnapshot(definition: PromoProjectDefinition) {
  const [deserializedProject] = deserializeProject(definition.source);
  const { data, ...project } = deserializedProject;

  return {
    data,
    openedGraph: definition.graphId as GraphId,
    path: definition.path,
    project,
    testSuites: [],
  };
}

function PromoApp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  const openedRef = useRef(false);
  const providersRef = useRef({
    staticData: new MemoryStaticDataStore(),
    storage: new MemoryAsyncStorage(),
  });

  const openPromoProject = useCallback(async (workspaceHost: RivetWorkspaceHost) => {
    if (openedRef.current) {
      return;
    }

    openedRef.current = true;
    if ('error' in selectedPromoProject) {
      setError(selectedPromoProject.error);
      postToParent({ type: 'rivet-demo:error', message: selectedPromoProject.error });
      return;
    }

    try {
      const opened = await workspaceHost.openProjectSnapshot(createPromoSnapshot(selectedPromoProject.definition));
      if (!opened) {
        throw new Error('Rivet declined to open the bundled demo project.');
      }
    } catch (openError) {
      const message = getError(openError).message;
      setError(message);
      postToParent({ type: 'rivet-demo:error', message });
    }
  }, []);

  const handleActiveProjectChanged = useCallback((event: { projectId: string | null }) => {
    if (!selectedPromoDefinition || event.projectId !== selectedPromoDefinition.projectId) {
      return;
    }

    setReady(true);
    postToParent({ type: 'rivet-demo:ready' });
  }, []);

  return (
    <>
      <RivetAppHost
        onActiveProjectChanged={handleActiveProjectChanged}
        onOpenError={({ error: openError }) => {
          const message = getError(openError).message;
          setError(message);
          postToParent({ type: 'rivet-demo:error', message });
        }}
        onWorkspaceHostReady={(workspaceHost) => {
          void openPromoProject(workspaceHost);
        }}
        providers={providersRef.current}
        ui={PROMO_HOST_UI}
      />
      {!ready && !error ? (
        <div className="promo-loading" role="status">
          <div className="promo-loading-content">
            <span className="promo-loading-indicator" aria-hidden="true" />
            <strong>Opening the Rivet demo project</strong>
            <span>{selectedPromoDefinition?.loadingHint ?? 'Checking the requested demo…'}</span>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="promo-error" role="alert">
          <div className="promo-error-content">
            <strong>The live demo could not start</strong>
            <span>{error}</span>
            <button type="button" onClick={() => window.location.reload()}>
              Reload demo
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

installGlobalErrorHandlers();
window.addEventListener(
  'message',
  (event) => {
    if (
      event.source === window.parent &&
      typeof event.data === 'object' &&
      event.data != null &&
      'type' in event.data &&
      event.data.type === 'rivet-demo:status-request' &&
      latestStartupMessage
    ) {
      postToParent(latestStartupMessage);
    }
  },
  true,
);
window.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Escape') {
      postToParent({ type: 'rivet-demo:release' });
    }
  },
  true,
);

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<PromoApp />);
