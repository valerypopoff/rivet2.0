import { useInAppMenuHotkeys } from '../hooks/useInAppMenuHotkeys';
import { GraphBuilder } from './GraphBuilder.js';
import { NodeLibraryBuilder } from './NodeLibraryBuilder.js';
import { UiGraphBuilder } from './UiGraphBuilder.js';
import { type CSSProperties, type FC, useEffect, useMemo } from 'react';
import { css } from '@emotion/react';
import { SettingsModal } from './SettingsModal.js';
import { setGlobalTheme } from '@atlaskit/tokens';
import { LeftSidebar } from './LeftSidebar.js';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { PromptDesignerRenderer } from './PromptDesigner.js';
import { useGraphExecutor } from '../hooks/useGraphExecutor.js';
import { useMenuCommands } from '../hooks/useMenuCommands.js';
import { TrivetRenderer } from './trivet/Trivet.js';
import { ActionBar } from './ActionBar';
import { DebuggerPanelRenderer } from './DebuggerConnectPanel';
import { ChatViewerRenderer } from './ChatViewer';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  canvasBackgroundColorModeState,
  canvasBackgroundCustomColorState,
  customThemePrimaryColorState,
  customThemeSecondaryColorState,
  getCanvasBackgroundColor,
  getCustomThemeCssVariables,
  getThemeContrastCssVariables,
  resolveCanvasBackgroundColorMode,
  selectedExecutorState,
  themeState,
  themes,
} from '../state/settings';
import clsx from 'clsx';
import { useLoadStaticData } from '../hooks/useLoadStaticData';
import { DataStudioRenderer } from './dataStudio/DataStudio';
import { StatusBar } from './StatusBar';
import { FullscreenNodeOutputModalRenderer } from './NodeOutput.js';
import { useCheckForUpdate } from '../hooks/useCheckForUpdate';
import useAsyncEffect from 'use-async-effect';
import { ProjectSelector } from './ProjectSelector';
import { NewProjectModalRenderer } from './NewProjectModal';
import { useWindowTitle } from '../hooks/useWindowTitle';
import { HelpModal } from './HelpModal';
import { selectedOpeningProjectTabIdState, workspaceVisibleTabCountState } from '../state/openingProjectTabs.js';
import { NoProject } from './NoProject';
import { AppErrorBoundary } from './AppErrorBoundary';
import { wrapAsync } from '../utils/errorHandling';
import { useExecutorSessionCoordinator } from '../hooks/useExecutorSessionCoordinator';
import { useRestorePersistedWorkspace } from '../hooks/useRestorePersistedWorkspace.js';
import { DeleteGraphInputConfirmModalRenderer } from './DeleteGraphInputConfirmModal';
import { dataBusFullRowCountState, leftSidebarLiveWidthState, overlayOpenState, uiFontSizeState } from '../state/ui.js';
import { getUiFontScale, getUiFontSizeCssVariables } from '../utils/uiFontSize.js';
import { useProjectPlugins } from '../hooks/useProjectPlugins.js';
import { MissingAppPluginsModalRenderer } from './MissingAppPluginsModal.js';
import { warmCodeEditor } from './LazyComponents.js';
import { NodeRunningIndicator } from './visualNode/NodeRunningIndicator.js';
import type { EditorGraphRunOptions } from '../hooks/editorGraphRunOptions.js';
import { useProjectWorkspaceTarget } from '../hooks/useProjectWorkspaceTarget.js';
import { getProjectWorkspaceTargetCapabilities } from '../domain/workspace/projectWorkspaceTarget.js';
import { sidebarOpenState } from '../state/graphBuilder.js';
import { getDataBusFullRowsHeight } from './nodeCanvas/dataBusRailLayout.js';

const styles = css`
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: var(--font-family);
  font-size: var(--ui-font-size-base);
`;

const openingProjectPlaceholderStyles = css`
  align-items: center;
  background-color: var(--canvas-background-color, var(--grey-darker));
  color: var(--grey-lightest);
  display: flex;
  flex-direction: column;
  gap: 12px;
  inset: var(--project-selector-height) 0 0 0;
  justify-content: center;
  position: absolute;

  .opening-project-placeholder-spinner {
    color: currentColor;
    filter: drop-shadow(0 0 10px color-mix(in srgb, currentColor 28%, transparent));

    .node-running-indicator {
      border-width: 3px;
      height: 42px;
      width: 42px;
    }
  }

  .opening-project-placeholder-title {
    color: currentColor;
    font-size: var(--ui-font-size-base);
    font-weight: 600;
  }
`;

setGlobalTheme({
  colorMode: 'dark',
});

export const RivetApp: FC = () => {
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const setSelectedExecutor = useSetAtom(selectedExecutorState);

  useEffect(() => {
    setSelectedExecutor(selectedExecutor);
    // Freeze the startup default into the live executor selection. The app
    // settings default should only affect future app starts.
  }, [selectedExecutor, setSelectedExecutor]);

  useExecutorSessionCoordinator(selectedExecutor);
  const { tryRunGraph, tryRunTests, tryAbortGraph, tryPauseGraph, tryResumeGraph } = useGraphExecutor();
  const theme = useAtomValue(themeState);
  const customThemePrimaryColor = useAtomValue(customThemePrimaryColorState);
  const customThemeSecondaryColor = useAtomValue(customThemeSecondaryColorState);
  const uiFontSize = useAtomValue(uiFontSizeState);
  const dataBusFullRowCount = useAtomValue(dataBusFullRowCountState);
  const leftSidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarLiveWidth = useAtomValue(leftSidebarLiveWidthState);
  const openOverlay = useAtomValue(overlayOpenState);
  const workspaceVisibleTabCount = useAtomValue(workspaceVisibleTabCountState);
  const selectedOpeningProjectTabId = useAtomValue(selectedOpeningProjectTabIdState);
  const workspaceTarget = useProjectWorkspaceTarget();
  const uiFontSizeCssVariables = useMemo(() => getUiFontSizeCssVariables(uiFontSize), [uiFontSize]);
  const customThemeCssVariables = useMemo<Record<string, string>>(
    () =>
      theme === 'custom'
        ? getCustomThemeCssVariables({
            primaryColor: customThemePrimaryColor,
            secondaryColor: customThemeSecondaryColor,
          })
        : {},
    [customThemePrimaryColor, customThemeSecondaryColor, theme],
  );
  const themeContrastCssVariables = useMemo<Record<string, string>>(
    () =>
      getThemeContrastCssVariables({
        theme,
        customThemePrimaryColor,
      }),
    [customThemePrimaryColor, theme],
  );
  const rootThemeCssVariables = useMemo(
    () => ({ ...customThemeCssVariables, ...themeContrastCssVariables }),
    [customThemeCssVariables, themeContrastCssVariables],
  );
  const appCssVariables = useMemo(
    () =>
      ({
        ...uiFontSizeCssVariables,
        ...rootThemeCssVariables,
        '--data-bus-full-row-height': `${getDataBusFullRowsHeight({
          rowCount: dataBusFullRowCount,
          uiFontScale: getUiFontScale(uiFontSize),
        })}px`,
        '--data-bus-full-row-left': leftSidebarOpen ? `${leftSidebarLiveWidth}px` : '0px',
      }) as CSSProperties,
    [
      dataBusFullRowCount,
      leftSidebarLiveWidth,
      leftSidebarOpen,
      rootThemeCssVariables,
      uiFontSize,
      uiFontSizeCssVariables,
    ],
  );

  const noProjectOpen = workspaceVisibleTabCount === 0;
  const isCanvasMode = openOverlay === undefined;
  const openingProjectSelected = isCanvasMode && selectedOpeningProjectTabId != null;
  const nodeLibraryOpen = workspaceTarget?.type === 'nodeLibrary';
  const uiGraphOpen = workspaceTarget?.type === 'uiGraph';
  const workspaceCapabilities = getProjectWorkspaceTargetCapabilities(workspaceTarget);

  useLoadStaticData();
  useRestorePersistedWorkspace();
  useProjectPlugins();

  const runGraph = wrapAsync(async (options?: EditorGraphRunOptions) => {
    if (!workspaceCapabilities.canRun) {
      return;
    }

    await tryRunGraph(options);
  }, 'Run graph');
  const runTests = wrapAsync(tryRunTests, 'Run tests');

  useMenuCommands({
    onRunGraph: runGraph,
  });

  useInAppMenuHotkeys();

  const checkForUpdate = useCheckForUpdate();

  useAsyncEffect(async () => {
    await checkForUpdate();
  }, []);

  useWindowTitle();

  useEffect(() => {
    let cancelled = false;
    const preload = () => {
      if (!cancelled) {
        warmCodeEditor();
      }
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    if (idleWindow.requestIdleCallback) {
      const idleId = idleWindow.requestIdleCallback(preload, { timeout: 2500 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idleId);
      };
    }

    const timeoutId = window.setTimeout(preload, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    const rootStyle = document.documentElement.style;

    for (const [name, value] of Object.entries(uiFontSizeCssVariables)) {
      rootStyle.setProperty(name, value);
    }

    return () => {
      for (const name of Object.keys(uiFontSizeCssVariables)) {
        rootStyle.removeProperty(name);
      }
    };
  }, [uiFontSizeCssVariables]);

  useEffect(() => {
    const rootStyle = document.documentElement.style;

    for (const [name, value] of Object.entries(rootThemeCssVariables)) {
      rootStyle.setProperty(name, value);
    }

    return () => {
      for (const name of Object.keys(rootThemeCssVariables)) {
        rootStyle.removeProperty(name);
      }
    };
  }, [rootThemeCssVariables]);

  useEffect(() => {
    const rootElement = document.documentElement;
    const themeClasses = ['theme-default', ...themes.map(({ value }) => `theme-${value}`)];
    const themeClass = theme ? `theme-${theme}` : 'theme-default';

    rootElement.classList.remove(...themeClasses);
    rootElement.classList.add(themeClass);

    return () => {
      rootElement.classList.remove(themeClass);
    };
  }, [theme]);

  return (
    <div className={clsx('app', theme ? `theme-${theme}` : 'theme-default')} css={styles} style={appCssVariables}>
      {noProjectOpen ? (
        <>
          <ProjectSelector mode="workspace" />
          <NoProject />
          <PromptDesignerRenderer />
          <TrivetRenderer tryRunTests={tryRunTests} />
          <ChatViewerRenderer />
          <DataStudioRenderer />
          <NewProjectModalRenderer />
          <AppErrorBoundary context="Settings Modal" fallback={<div>Failed to render Settings</div>}>
            <SettingsModal />
          </AppErrorBoundary>
        </>
      ) : (
        <>
          <ProjectSelector />
          {openingProjectSelected ? <OpeningProjectPlaceholder /> : null}
          {isCanvasMode && !openingProjectSelected && !nodeLibraryOpen && !uiGraphOpen && (
            <ActionBar
              onRunGraph={runGraph}
              onRunTests={runTests}
              onAbortGraph={tryAbortGraph}
              onPauseGraph={tryPauseGraph}
              onResumeGraph={tryResumeGraph}
            />
          )}
          {!openingProjectSelected && !nodeLibraryOpen && !uiGraphOpen && <StatusBar />}
          {isCanvasMode && !openingProjectSelected && !nodeLibraryOpen && !uiGraphOpen && <DebuggerPanelRenderer />}
          {!openingProjectSelected && <LeftSidebar />}
          {!openingProjectSelected &&
            (nodeLibraryOpen ? (
              <NodeLibraryBuilder />
            ) : uiGraphOpen ? (
              <UiGraphBuilder runGraph={tryRunGraph} />
            ) : (
              <GraphBuilder />
            ))}
          <AppErrorBoundary context="Settings Modal" fallback={<div>Failed to render Settings</div>}>
            <SettingsModal />
          </AppErrorBoundary>
          <PromptDesignerRenderer />
          <TrivetRenderer tryRunTests={tryRunTests} />
          <ChatViewerRenderer />
          <DataStudioRenderer />
          <NewProjectModalRenderer />
          <MissingAppPluginsModalRenderer />
          <DeleteGraphInputConfirmModalRenderer />
        </>
      )}
      <AppErrorBoundary context="Fullscreen Output Modal" fallback={<div>Failed to render Fullscreen Output</div>}>
        <FullscreenNodeOutputModalRenderer />
      </AppErrorBoundary>
      <HelpModal />
      <ToastContainer enableMultiContainer position="bottom-right" hideProgressBar newestOnTop />
      <ToastContainer
        enableMultiContainer
        containerId="wide"
        style={{ width: 600 }}
        position="bottom-right"
        hideProgressBar
        newestOnTop
      />
    </div>
  );
};

const OpeningProjectPlaceholder: FC = () => {
  const canvasBackgroundColorMode = useAtomValue(canvasBackgroundColorModeState);
  const canvasBackgroundCustomColor = useAtomValue(canvasBackgroundCustomColorState);
  const canvasBackgroundColor = getCanvasBackgroundColor({
    mode: resolveCanvasBackgroundColorMode(canvasBackgroundColorMode),
    customColor: canvasBackgroundCustomColor,
  });

  return (
    <div
      css={openingProjectPlaceholderStyles}
      style={{ '--canvas-background-color': canvasBackgroundColor } as CSSProperties}
      aria-live="polite"
    >
      <div className="opening-project-placeholder-spinner">
        <NodeRunningIndicator isRunning delayMs={0} label="Opening project" />
      </div>
      <div className="opening-project-placeholder-title">Opening project...</div>
    </div>
  );
};
