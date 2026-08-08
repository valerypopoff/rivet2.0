import { useEffect, useRef } from 'react';
import { useSaveProject } from './useSaveProject.js';
import { match } from 'ts-pattern';
import { useLoadProjectWithFileBrowser } from './useLoadProjectWithFileBrowser.js';
import { settingsModalOpenState } from '../components/SettingsModal.js';
import { graphState } from '../state/graph.js';
import { useLoadRecording } from './useLoadRecording.js';
import { helpModalOpenState, newProjectModalOpenState, overlayOpenState } from '../state/ui';
import { useToggleRemoteDebugger } from '../components/DebuggerConnectPanel';
import { graphRunHistoryByViewState, lastRunDataByNodeState, selectedGraphRunByViewState } from '../state/dataFlow';
import { useImportGraph } from './useImportGraph';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useIOProvider } from '../providers/ProvidersContext.js';
import { type NativeWindowHandle } from '../utils/platform/core.js';
import { getCurrentWindowHandle } from '../utils/platform/window.js';
import { openedProjectsSortedIdsState } from '../state/savedGraphs.js';
import { selectedOpeningProjectTabIdState } from '../state/openingProjectTabs.js';
import {
  isProjectWorkspaceSelected,
  shouldRunMenuCommandForProjectSelection,
} from '../utils/projectWorkspaceSelection.js';
import type { MenuIds } from '../utils/menuCommandIds.js';
import { isRivetAppHostCapabilityEnabled, useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { shouldRunFileMenuCommand } from '../utils/fileMenuConfiguration.js';

export type { MenuIds };

type MenuCommandEvent = { payload: MenuIds };
type MenuCommandHandler = (e: MenuCommandEvent) => void;

interface MenuCommandWindow extends Window {
  __rivetMenuCommandHandler?: MenuCommandHandler;
}

const noopMenuCommandHandler: MenuCommandHandler = () => {};

const handlerState: {
  handler: MenuCommandHandler;
} = { handler: noopMenuCommandHandler };

function getMenuCommandWindow() {
  return typeof window === 'undefined' ? undefined : (window as MenuCommandWindow);
}

function getCurrentMenuCommandHandler() {
  return getMenuCommandWindow()?.__rivetMenuCommandHandler ?? handlerState.handler;
}

function setCurrentMenuCommandHandler(handler: MenuCommandHandler) {
  handlerState.handler = handler;
  const currentWindow = getMenuCommandWindow();

  if (currentWindow) {
    currentWindow.__rivetMenuCommandHandler = handler;
  }
}

function clearCurrentMenuCommandHandler(handler: MenuCommandHandler) {
  if (handlerState.handler === handler) {
    handlerState.handler = noopMenuCommandHandler;
  }

  const currentWindow = getMenuCommandWindow();

  if (currentWindow?.__rivetMenuCommandHandler === handler) {
    delete currentWindow.__rivetMenuCommandHandler;
  }
}

function dispatchMenuCommand(event: MenuCommandEvent) {
  getCurrentMenuCommandHandler()(event);
}

export function runMenuCommand(command: MenuIds) {
  dispatchMenuCommand({ payload: command });
}

export function useRunMenuCommand() {
  return runMenuCommand;
}

export function useMenuCommands(
  options: {
    onRunGraph?: () => void;
  } = {},
) {
  const { onRunGraph } = options;
  const hostUiConfig = useRivetAppHostUiConfig();
  const ioProvider = useIOProvider();
  const [graphData] = useAtom(graphState);
  const openOverlay = useAtomValue(overlayOpenState);
  const openedProjectIds = useAtomValue(openedProjectsSortedIdsState);
  const selectedOpeningProjectTabId = useAtomValue(selectedOpeningProjectTabIdState);
  const projectWorkspaceSelected = isProjectWorkspaceSelected({
    openOverlay,
    openProjectCount: selectedOpeningProjectTabId == null ? openedProjectIds.length : 0,
  });
  const { saveProject, saveProjectAs } = useSaveProject();
  const setNewProjectModalOpen = useSetAtom(newProjectModalOpenState);
  const loadProject = useLoadProjectWithFileBrowser();
  const setSettingsOpen = useSetAtom(settingsModalOpenState);
  const { loadRecording } = useLoadRecording();
  const toggleRemoteDebugger = useToggleRemoteDebugger();
  const setLastRunData = useSetAtom(lastRunDataByNodeState);
  const setGraphRunHistoryByView = useSetAtom(graphRunHistoryByViewState);
  const setSelectedGraphRunByView = useSetAtom(selectedGraphRunByViewState);
  const importGraph = useImportGraph();
  const setHelpModalOpen = useSetAtom(helpModalOpenState);
  const mainWindowRef = useRef<NativeWindowHandle | null>(null);

  useEffect(() => {
    const handler: MenuCommandHandler = ({ payload }) => {
      if (!shouldRunFileMenuCommand(payload, hostUiConfig.fileMenu)) {
        return;
      }

      if (payload === 'load_recording' && !isRivetAppHostCapabilityEnabled(hostUiConfig, 'recordings')) {
        return;
      }

      if (!shouldRunMenuCommandForProjectSelection({ command: payload, projectWorkspaceSelected })) {
        return;
      }

      match(payload as MenuIds)
        .with('settings', () => {
          setSettingsOpen(true);
        })
        .with('quit', () => {
          void mainWindowRef.current?.close();
        })
        .with('new_project', () => {
          setNewProjectModalOpen(true);
        })
        .with('open_project', () => {
          loadProject();
        })
        .with('save_project', () => {
          saveProject();
        })
        .with('save_project_as', () => {
          saveProjectAs();
        })
        .with('export_graph', () => {
          ioProvider.saveGraphData(graphData);
        })
        .with('import_graph', () => {
          importGraph();
        })
        .with('run', () => {
          onRunGraph?.();
        })
        .with('load_recording', () => {
          loadRecording();
        })
        .with('remote_debugger', () => {
          toggleRemoteDebugger();
        })
        .with('toggle_devtools', () => {})
        .with('clear_outputs', () => {
          setLastRunData({});
          setGraphRunHistoryByView({});
          setSelectedGraphRunByView({});
        })
        .with('get_help', () => {
          setHelpModalOpen(true);
        })
        .exhaustive();
    };

    setCurrentMenuCommandHandler(handler);

    return () => {
      clearCurrentMenuCommandHandler(handler);
    };
  }, [
    saveProject,
    saveProjectAs,
    loadProject,
    setSettingsOpen,
    graphData,
    onRunGraph,
    ioProvider,
    loadRecording,
    importGraph,
    toggleRemoteDebugger,
    setLastRunData,
    setGraphRunHistoryByView,
    setSelectedGraphRunByView,
    setNewProjectModalOpen,
    setHelpModalOpen,
    projectWorkspaceSelected,
    hostUiConfig,
  ]);

  useEffect(() => {
    let unlistenMenu: (() => void | Promise<void>) | undefined;

    void getCurrentWindowHandle()
      .then(async (windowHandle) => {
        mainWindowRef.current = windowHandle;
        if (windowHandle?.onMenuClicked) {
          unlistenMenu = await windowHandle.onMenuClicked((e) => {
            dispatchMenuCommand(e as MenuCommandEvent);
          });
        }
      })
      .catch((err) => {
        console.warn(`Error getting main window, likely not running in tauri: ${err}`);
      });

    return () => {
      mainWindowRef.current = null;
      void unlistenMenu?.();
    };
  }, []);
}
