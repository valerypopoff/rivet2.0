import {
  Fragment,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import AtlaskitSelect from '@atlaskit/select';
import ChevronLeftIcon from 'majesticons/line/chevron-left-line.svg?react';
import ChevronRightIcon from 'majesticons/line/chevron-right-line.svg?react';
import CrossIcon from 'majesticons/line/multiply-line.svg?react';
import MoreMenuIcon from 'majesticons/line/more-menu-line.svg?react';
import PinIcon from 'majesticons/line/pin-line.svg?react';
import SearchIcon from 'majesticons/line/search-line.svg?react';
import {
  type DataValue,
  type GraphProgress,
  type UiComponentId,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphChatPin,
  type UiGraphComponent,
  type UiGraphInteractionController,
  RIVET_WEB_APP_RENDERER_CSS,
  createUiGraphChatHistoryFlushStatePatch,
  createUiGraphInteractionController,
  createUiGraphChatPinStatePatch,
  createUiGraphChatSubmissionStatePatch,
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagesStateKey,
  getUiGraphComponentRenderModel,
  getUiGraphProgressiveJsonOutputChunks,
  normalizeUiGraph,
} from '@valerypopoff/rivet2-core';
import {
  clearUiGraphChatSearchMatches,
  applyUiGraphWebAppStorageActionPatch,
  applyUiGraphWebAppStoragePatch,
  copyUiGraphText,
  downloadUiGraphJsonOutput,
  hasUiGraphChatPersistentStateChanged,
  getUiGraphChatPersistentState,
  getUiGraphChatMessagePresentations,
  getUiGraphWebAppStorageKey,
  highlightUiGraphChatSearchMatches,
  loadUiGraphChatPersistentState,
  loadUiGraphWebAppStorage,
  observeUiGraphOutputResizeBounds,
  revealUiGraphChatElement,
  revealUiGraphChatSearchMatch,
  saveUiGraphChatPersistentState,
  type UiGraphChatMessagePresentation,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import { useMarkdown } from '../../hooks/useMarkdown.js';

// Vite resolves this CommonJS compatibility export directly, while tsx exposes
// the same component beneath `default` during source-level tests.
const Select = (AtlaskitSelect as unknown as { default?: typeof AtlaskitSelect }).default ?? AtlaskitSelect;

const ChatSendIcon: FC = () => (
  <svg aria-hidden="true" fill="none" focusable="false" viewBox="0 0 24 24">
    <path
      d="M12 19V5m0 0 5 5m-5-5-5 5"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

type WebAppStorageActionState = {
  appliedActionByKey: Map<string, number>;
  nextAction: number;
};

// An editor preview can unmount while its action keeps running. Keep ordering
// metadata by browser storage key, rather than by the temporary React tree.
const storageActionStatesByStorageKey = new Map<string, WebAppStorageActionState>();

function getWebAppStorageActionState(uiGraph: UiGraph): WebAppStorageActionState {
  const storageKey = getUiGraphWebAppStorageKey(uiGraph);
  if (!storageKey) {
    return { appliedActionByKey: new Map(), nextAction: 0 };
  }

  let actionState = storageActionStatesByStorageKey.get(storageKey);
  if (!actionState) {
    actionState = { appliedActionByKey: new Map(), nextAction: 0 };
    storageActionStatesByStorageKey.set(storageKey, actionState);
  }
  return actionState;
}

export type RivetWebAppActionResult = {
  outputs: Record<string, DataValue>;
  statePatch?: Record<string, unknown>;
  storagePatch?: Record<string, unknown>;
};

/**
 * Lets a host provide an action-scoped storage view without exposing its
 * persistence mechanism to UI components. Detached desktop previews use this
 * because their Tauri webview can have isolated browser storage.
 */
export type RivetWebAppStorageAdapter = {
  applyPatch(patch: Record<string, unknown>): void;
  load(): Record<string, unknown>;
};

export type RivetWebAppRendererProps = {
  interactionController?: UiGraphInteractionController;
  interactionUiGraph?: UiGraph;
  renderComponentFrame?(props: RivetWebAppComponentFrameProps): ReactNode;
  onComponentSelectionChange?(componentId: UiComponentId, mode: 'replace' | 'toggle'): void;
  onRootPointerDownCapture?(event: PointerEvent<HTMLDivElement>): void;
  onRunAction(
    componentId: UiComponentId,
    state: Record<string, unknown>,
    abortSignal: AbortSignal,
    onProgress: (progress: GraphProgress) => void,
    storage: Record<string, unknown>,
  ): Promise<RivetWebAppActionResult>;
  /**
   * Keeps active actions alive if React temporarily removes this renderer.
   * Page unload still aborts them. This is for the desktop editor's persistent
   * UI-graph preview session; detached and hosted renderers keep the default.
   */
  preserveActionsOnUnmount?: boolean;
  rootRef?: RefObject<HTMLDivElement>;
  selectedComponentIds?: ReadonlySet<UiComponentId>;
  storageAdapter?: RivetWebAppStorageAdapter;
  uiGraph: UiGraph;
};

export type RivetWebAppComponentFrameProps = {
  children: ReactNode;
  className: string;
  component: UiGraphComponent;
  onFocusCapture(): void;
  onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void;
};

function useUiGraphChatBrowserPersistence(
  interactionController: UiGraphInteractionController,
  uiGraph: UiGraph,
): () => void {
  const isRestoringRef = useRef(false);

  useLayoutEffect(() => {
    interactionController.setUiGraph(uiGraph);

    if (Object.keys(getUiGraphChatPersistentState(uiGraph, interactionController.getSnapshot().state)).length === 0) {
      const storedState = loadUiGraphChatPersistentState(uiGraph);
      if (Object.keys(storedState).length > 0) {
        isRestoringRef.current = true;
        interactionController.updateStatePatch(storedState);
        isRestoringRef.current = false;
      }
    }

    let previousState = interactionController.getSnapshot().state;
    saveUiGraphChatPersistentState(uiGraph, previousState);
    return interactionController.subscribe(() => {
      const nextState = interactionController.getSnapshot().state;
      if (!isRestoringRef.current && hasUiGraphChatPersistentStateChanged(uiGraph, previousState, nextState)) {
        saveUiGraphChatPersistentState(uiGraph, nextState);
      }
      previousState = nextState;
    });
  }, [interactionController, uiGraph]);

  return useCallback(() => {
    const chatState = getUiGraphChatPersistentState(uiGraph, interactionController.getSnapshot().state);
    isRestoringRef.current = true;
    interactionController.reset();
    if (Object.keys(chatState).length > 0) {
      interactionController.updateStatePatch(chatState);
    }
    isRestoringRef.current = false;
    saveUiGraphChatPersistentState(uiGraph, interactionController.getSnapshot().state);
  }, [interactionController, uiGraph]);
}

export const RivetWebAppRenderer: FC<RivetWebAppRendererProps> = ({
  interactionController: interactionControllerProp,
  interactionUiGraph,
  renderComponentFrame,
  onComponentSelectionChange,
  onRootPointerDownCapture,
  onRunAction,
  preserveActionsOnUnmount = false,
  rootRef,
  selectedComponentIds,
  storageAdapter,
  uiGraph,
}) => {
  const normalizedUiGraph = useMemo(() => normalizeUiGraph(uiGraph), [uiGraph]);
  const normalizedInteractionUiGraph = useMemo(
    () => normalizeUiGraph(interactionUiGraph ?? uiGraph),
    [interactionUiGraph, uiGraph],
  );
  const ownedInteractionControllerRef = useRef<UiGraphInteractionController | null>(null);
  const interactionController =
    interactionControllerProp ??
    ownedInteractionControllerRef.current ??
    (ownedInteractionControllerRef.current = createUiGraphInteractionController(normalizedInteractionUiGraph));
  const interaction = useSyncExternalStore(
    interactionController.subscribe,
    interactionController.getSnapshot,
    interactionController.getSnapshot,
  );
  const resetApp = useUiGraphChatBrowserPersistence(interactionController, normalizedInteractionUiGraph);

  useEffect(() => {
    const abortActions = () => interactionController.abortActions();
    window.addEventListener('pagehide', abortActions);
    return () => {
      window.removeEventListener('pagehide', abortActions);
      if (!preserveActionsOnUnmount) {
        interactionController.abortActions();
      }
    };
  }, [interactionController, preserveActionsOnUnmount]);

  const runAction = useCallback(
    (component: UiGraphActionComponent) =>
      interactionController.runAction(component, async ({ componentId, reportProgress, signal, state }) => {
        const storageActionState = getWebAppStorageActionState(normalizedInteractionUiGraph);
        const actionNumber = ++storageActionState.nextAction;
        const result = await onRunAction(
          componentId,
          state,
          signal,
          reportProgress,
          storageAdapter?.load() ?? loadUiGraphWebAppStorage(normalizedInteractionUiGraph),
        );
        signal.throwIfAborted();
        if (result.storagePatch && Object.keys(result.storagePatch).length > 0) {
          applyUiGraphWebAppStorageActionPatch(
            result.storagePatch,
            actionNumber,
            storageActionState.appliedActionByKey,
            (applicablePatch) => {
              if (storageAdapter) {
                storageAdapter.applyPatch(applicablePatch);
              } else {
                applyUiGraphWebAppStoragePatch(
                  normalizedInteractionUiGraph,
                  loadUiGraphWebAppStorage(normalizedInteractionUiGraph),
                  applicablePatch,
                );
              }
            },
          );
        }
        return { statePatch: result.statePatch };
      }),
    [interactionController, normalizedInteractionUiGraph, onRunAction, storageAdapter],
  );

  return (
    <div ref={rootRef} className="rivet-web-app-root" onPointerDownCapture={onRootPointerDownCapture}>
      <style>{RIVET_WEB_APP_RENDERER_CSS}</style>
      <main className="rivet-web-app-surface">
        <div className="rivet-web-app-toolbar">
          <button
            type="button"
            className="rivet-web-app-reset-button"
            aria-label="Reset app"
            title="Reset app"
            onClick={resetApp}
          />
        </div>
        {normalizedUiGraph.components.map((component) => {
          const frameProps: RivetWebAppComponentFrameProps = {
            className: `rivet-web-app-component-frame${selectedComponentIds?.has(component.id) ? ' active' : ''}`,
            component,
            onFocusCapture: () => onComponentSelectionChange?.(component.id, 'replace'),
            onPointerDownCapture: (event) =>
              onComponentSelectionChange?.(
                component.id,
                event.shiftKey || event.metaKey || event.ctrlKey ? 'toggle' : 'replace',
              ),
            children: (
              <RivetWebAppComponent
                component={component}
                actionError={interaction.actionErrors[component.id]}
                actionProgress={interaction.actionProgress[component.id]}
                isLoading={interaction.loadingComponentIds.has(component.id)}
                isRunning={interaction.runningComponentIds.has(component.id)}
                isOutputCollapsed={interaction.collapsedOutputComponentIds.has(component.id)}
                uiGraphName={normalizedUiGraph.name}
                state={interaction.state}
                onRunAction={runAction}
                onCancelAction={interactionController.cancelAction}
                onToggleOutputCollapsed={interactionController.toggleOutputCollapsed}
                onStateChange={interactionController.updateState}
                onStatePatch={interactionController.updateStatePatch}
                onFlushChatHistory={(componentId) =>
                  interactionController.updateStatePatch(createUiGraphChatHistoryFlushStatePatch(componentId))
                }
              />
            ),
          };

          return renderComponentFrame ? (
            <Fragment key={component.id}>{renderComponentFrame(frameProps)}</Fragment>
          ) : (
            <div
              key={component.id}
              className={frameProps.className}
              data-rivet-web-app-component-type={component.type}
              onFocusCapture={frameProps.onFocusCapture}
              onPointerDownCapture={frameProps.onPointerDownCapture}
            >
              {frameProps.children}
            </div>
          );
        })}
        {Object.entries(interaction.actionErrors).flatMap(([componentId, message]) =>
          normalizedUiGraph.components.some((component) => component.id === componentId && component.type === 'chat')
            ? []
            : [
                <div key={componentId} className="rivet-web-app-error">
                  {message}
                </div>,
              ],
        )}
      </main>
    </div>
  );
};

const RivetWebAppComponent: FC<{
  actionError?: string;
  actionProgress?: GraphProgress;
  component: UiGraphComponent;
  isLoading: boolean;
  isRunning: boolean;
  isOutputCollapsed: boolean;
  uiGraphName: string;
  state: Readonly<Record<string, unknown>>;
  onRunAction(component: UiGraphActionComponent): Promise<void> | void;
  onCancelAction(componentId: UiComponentId): void;
  onToggleOutputCollapsed(componentId: UiComponentId): void;
  onStateChange(key: string, value: unknown): void;
  onStatePatch(patch: Record<string, unknown>): void;
  onFlushChatHistory(componentId: UiComponentId): void;
}> = ({
  actionError,
  actionProgress,
  component,
  isLoading,
  isRunning,
  isOutputCollapsed,
  onCancelAction,
  onRunAction,
  onToggleOutputCollapsed,
  onStateChange,
  onStatePatch,
  onFlushChatHistory,
  state,
  uiGraphName,
}) => {
  const renderModel = useMemo(() => getUiGraphComponentRenderModel(component, state), [component, state]);
  const outputResizeCleanupRef = useRef<(() => void) | undefined>(undefined);
  const outputResizeRef = useCallback((element: HTMLElement | null) => {
    outputResizeCleanupRef.current?.();
    outputResizeCleanupRef.current = element ? observeUiGraphOutputResizeBounds(element) : undefined;
  }, []);

  useEffect(
    () => () => {
      outputResizeCleanupRef.current?.();
    },
    [],
  );

  const markdownText =
    renderModel.type === 'markdown'
      ? renderModel.markdown
      : renderModel.type === 'output' && renderModel.output.renderAs === 'markdown'
        ? renderModel.output.renderedValue
        : undefined;
  const markdownHtml = useMarkdown(markdownText, markdownText != null, { allowHtml: false });

  switch (renderModel.type) {
    case 'text':
      return <div className="rivet-web-app-text">{renderModel.text}</div>;
    case 'markdown':
      return <div className="rivet-web-app-markdown markdown-body" dangerouslySetInnerHTML={markdownHtml} />;
    case 'gap':
      return <div aria-hidden="true" className={`rivet-web-app-gap rivet-web-app-gap-${renderModel.size}`} />;
    case 'input':
      return (
        <label className="rivet-web-app-field">
          <span>{renderModel.label}</span>
          <input
            className="rivet-web-app-control inputarea"
            placeholder={renderModel.component.placeholder ?? ''}
            value={renderModel.value}
            onChange={(event) => onStateChange(renderModel.component.stateKey, event.target.value)}
          />
        </label>
      );
    case 'textarea':
      return (
        <label className="rivet-web-app-field">
          <span>{renderModel.label}</span>
          <textarea
            className="rivet-web-app-control inputarea"
            placeholder={renderModel.component.placeholder ?? ''}
            value={renderModel.value}
            onChange={(event) => onStateChange(renderModel.component.stateKey, event.target.value)}
          />
        </label>
      );
    case 'dropdown':
      return (
        <div className="rivet-web-app-field">
          <span>{renderModel.label}</span>
          <RivetWebAppDropdown
            componentId={renderModel.component.id}
            items={renderModel.items}
            label={renderModel.label}
            value={renderModel.value}
            onChange={(value) => onStateChange(renderModel.component.stateKey, value)}
          />
        </div>
      );
    case 'button':
      return (
        <div className={`rivet-web-app-action-stack${isLoading ? ' rivet-web-app-action-stack-running' : ''}`}>
          <button
            aria-busy={isLoading}
            aria-label={isLoading ? `${renderModel.label} (running)` : undefined}
            className="rivet-web-app-button"
            disabled={isLoading}
            onClick={() => void onRunAction(renderModel.component)}
            type="button"
          >
            {renderModel.label}
            {isLoading && <span aria-hidden="true" className="rivet-web-app-running-indicator" />}
          </button>
          {isLoading && (
            <button
              type="button"
              className="rivet-web-app-abort-button"
              onClick={() => onCancelAction(renderModel.component.id)}
            >
              Abort
            </button>
          )}
          <RivetWebAppProgress progress={actionProgress} />
        </div>
      );
    case 'chat':
      return (
        <RivetWebAppChat
          actionError={actionError}
          actionProgress={actionProgress}
          isRunning={isRunning}
          renderModel={renderModel}
          onRunAction={onRunAction}
          onCancelAction={onCancelAction}
          onStateChange={onStateChange}
          onStatePatch={onStatePatch}
          onFlushChatHistory={onFlushChatHistory}
          state={state}
        />
      );
    case 'output': {
      const { output } = renderModel;
      const jsonDownloadValue = output.jsonDownloadValue;
      const isCollapsed = output.hasValue && isOutputCollapsed;

      return (
        <section
          ref={outputResizeRef}
          className={`rivet-web-app-card rivet-web-app-output${output.hasValue ? ' rivet-web-app-output-has-value' : ''}${
            isCollapsed ? ' rivet-web-app-output-collapsed' : ''
          }`}
        >
          {output.hasValue ? (
            <button
              type="button"
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? `Expand ${renderModel.label}` : `Collapse ${renderModel.label}`}
              className="rivet-web-app-output-header rivet-web-app-output-toggle"
              title={isCollapsed ? 'Expand output' : 'Collapse output'}
              onClick={() => onToggleOutputCollapsed(renderModel.component.id)}
            >
              <span className="rivet-web-app-output-title">{renderModel.label}</span>
              <span
                aria-hidden="true"
                className={`rivet-web-app-output-toggle-icon${isCollapsed ? ' collapsed' : ''}`}
              />
            </button>
          ) : (
            <div className="rivet-web-app-output-header">
              <div className="rivet-web-app-output-title">{renderModel.label}</div>
            </div>
          )}
          {output.hasValue && !isCollapsed && (
            <div className="rivet-web-app-output-content">
              <div className="rivet-web-app-output-content-actions">
                <button
                  type="button"
                  className="rivet-web-app-output-action-button rivet-web-app-output-copy-button"
                  title="Copy output"
                  aria-label="Copy output"
                  onClick={(event) => {
                    event.stopPropagation();
                    void copyUiGraphText(output.renderedValue);
                  }}
                />
                {jsonDownloadValue != null && (
                  <button
                    type="button"
                    className="rivet-web-app-output-action-button rivet-web-app-output-download-button"
                    title="Download JSON"
                    aria-label="Download JSON"
                    onClick={(event) => {
                      event.stopPropagation();
                      downloadUiGraphJsonOutput(jsonDownloadValue, uiGraphName);
                    }}
                  />
                )}
              </div>
              <div className="rivet-web-app-output-content-body">
                {output.renderAs === 'image' ? (
                  output.imageSource ? (
                    <img
                      alt={renderModel.label}
                      className="rivet-web-app-output-image"
                      decoding="async"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      src={output.imageSource}
                    />
                  ) : (
                    <div className="rivet-web-app-output-image-placeholder">{output.imageErrorMessage}</div>
                  )
                ) : output.renderAs === 'markdown' ? (
                  <div
                    className="rivet-web-app-output-markdown markdown-body rivet-markdown-output"
                    dangerouslySetInnerHTML={markdownHtml}
                  />
                ) : output.renderAs === 'json' ? (
                  <ProgressiveJsonOutput value={output.renderedValue} />
                ) : (
                  <pre>{output.renderedValue}</pre>
                )}
              </div>
            </div>
          )}
        </section>
      );
    }
  }
};

const ProgressiveJsonOutput: FC<{
  value: string;
}> = ({ value }) => {
  const chunks = useMemo(() => getUiGraphProgressiveJsonOutputChunks(value), [value]);
  const [visibleChunkState, setVisibleChunkState] = useState(() => ({ chunkCount: chunks ? 1 : 0, value }));
  const visibleChunkCount = chunks && visibleChunkState.value === value ? visibleChunkState.chunkCount : 1;

  useEffect(() => {
    if (!chunks || chunks.length < 2) {
      return;
    }

    let chunkCount = 1;
    let cancelScheduledFrame = () => {};
    setVisibleChunkState({ chunkCount, value });
    const appendNextChunk = () => {
      chunkCount += 1;
      setVisibleChunkState({ chunkCount, value });
      if (chunkCount < chunks.length) {
        cancelScheduledFrame = scheduleAnimationFrame(appendNextChunk);
      }
    };
    cancelScheduledFrame = scheduleAnimationFrame(appendNextChunk);

    return () => cancelScheduledFrame();
  }, [chunks, value]);

  return (
    <pre className="rivet-web-app-output-json">
      {chunks
        ? chunks.slice(0, visibleChunkCount).map((chunk, index) => <Fragment key={index}>{chunk}</Fragment>)
        : value}
    </pre>
  );
};

function scheduleAnimationFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const frameId = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frameId);
  }

  const timeoutId = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timeoutId);
}

const RivetWebAppChat: FC<{
  actionError?: string;
  actionProgress?: GraphProgress;
  isRunning: boolean;
  onRunAction(component: Extract<UiGraphComponent, { type: 'chat' }>): Promise<void> | void;
  onCancelAction(componentId: UiComponentId): void;
  onFlushChatHistory(componentId: UiComponentId): void;
  onStateChange(key: string, value: unknown): void;
  onStatePatch(patch: Record<string, unknown>): void;
  renderModel: Extract<ReturnType<typeof getUiGraphComponentRenderModel>, { type: 'chat' }>;
  state: Readonly<Record<string, unknown>>;
}> = ({
  actionError,
  actionProgress,
  isRunning,
  onCancelAction,
  onFlushChatHistory,
  onRunAction,
  onStateChange,
  onStatePatch,
  renderModel,
  state,
}) => {
  const messagesRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const overflowMenuRef = useRef<HTMLSpanElement>(null);
  const [isOverflowMenuOpen, setIsOverflowMenuOpen] = useState(false);
  const [isPinsOpen, setIsPinsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [requestedSearchMatchIndex, setRequestedSearchMatchIndex] = useState(0);
  const [searchMatchState, setSearchMatchState] = useState({ activeIndex: -1, count: 0 });
  const { component, draft, messages, pins } = renderModel;
  const messagePresentations = useMemo(() => getUiGraphChatMessagePresentations(messages), [messages]);
  const pinnedMessageIndexes = new Set(pins.map((pin) => pin.messageIndex));
  const chatMessagesState = state[getUiGraphChatMessagesStateKey(component.id)];

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  }, [isRunning, messages.length]);

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isSearchOpen]);

  useEffect(() => {
    if (messages.length > 0 || !isSearchOpen) return;
    setIsSearchOpen(false);
    setSearchQuery('');
    setRequestedSearchMatchIndex(0);
  }, [isSearchOpen, messages.length]);

  useEffect(() => {
    if (pins.length === 0 && isPinsOpen) {
      setIsPinsOpen(false);
    }
  }, [isPinsOpen, pins.length]);

  useEffect(() => {
    if (!isOverflowMenuOpen) return;

    const closeMenuOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!overflowMenuRef.current?.contains(event.target as Node)) {
        setIsOverflowMenuOpen(false);
      }
    };
    const closeMenuOnKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsOverflowMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenuOnPointerDown);
    document.addEventListener('keydown', closeMenuOnKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeMenuOnPointerDown);
      document.removeEventListener('keydown', closeMenuOnKeyDown);
    };
  }, [isOverflowMenuOpen]);

  useLayoutEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) return;

    const result = isSearchOpen
      ? highlightUiGraphChatSearchMatches(messagesElement, searchQuery, requestedSearchMatchIndex)
      : (clearUiGraphChatSearchMatches(messagesElement), { activeIndex: -1, matches: [] as HTMLElement[] });
    const nextState = { activeIndex: result.activeIndex, count: result.matches.length };
    setSearchMatchState((currentState) =>
      currentState.activeIndex === nextState.activeIndex && currentState.count === nextState.count
        ? currentState
        : nextState,
    );
    revealUiGraphChatSearchMatch(messagesElement, result.matches[result.activeIndex]);
  }, [chatMessagesState, isSearchOpen, requestedSearchMatchIndex, searchQuery]);

  const closeSearch = () => {
    setIsSearchOpen(false);
    setSearchQuery('');
    setRequestedSearchMatchIndex(0);
    globalThis.setTimeout(() => searchButtonRef.current?.focus(), 0);
  };

  const openSearch = () => {
    if (messages.length === 0) return;
    setIsOverflowMenuOpen(false);
    setIsPinsOpen(false);
    setIsSearchOpen(true);
    setRequestedSearchMatchIndex(0);
    globalThis.setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  const togglePins = () => {
    setIsOverflowMenuOpen(false);
    setIsSearchOpen(false);
    setIsPinsOpen((isOpen) => !isOpen);
  };

  const toggleOverflowMenu = () => {
    setIsSearchOpen(false);
    setIsOverflowMenuOpen((isOpen) => !isOpen);
  };

  const flushChatHistory = () => {
    setIsOverflowMenuOpen(false);
    setIsPinsOpen(false);
    onFlushChatHistory(component.id);
  };

  const togglePin = (messageIndex: number) => {
    const statePatch = createUiGraphChatPinStatePatch(component.id, state, messageIndex);
    if (statePatch) {
      onStatePatch(statePatch);
    }
  };

  const revealPinnedMessage = (pin: UiGraphChatPin) => {
    const messagesElement = messagesRef.current;
    const messageIndex = pin.promptMessageIndex ?? pin.messageIndex;
    const message = messagesElement?.querySelector<HTMLElement>(`[data-rivet-chat-message-index="${messageIndex}"]`);
    if (messagesElement && message) {
      revealUiGraphChatElement(messagesElement, message, 'start');
    }
  };

  const handleSearchShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (messages.length === 0 || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') {
      return;
    }

    event.preventDefault();
    openSearch();
  };

  const submit = () => {
    const statePatch = createUiGraphChatSubmissionStatePatch(component.id, state);
    if (!statePatch || isRunning) {
      return;
    }
    onStatePatch(statePatch);
    void onRunAction(component);
  };

  return (
    <section className="rivet-web-app-chat" onKeyDownCapture={handleSearchShortcut}>
      <div className="rivet-web-app-chat-header">
        <span className="rivet-web-app-chat-title">
          <span>Chat</span>
          <span ref={overflowMenuRef} className="rivet-web-app-chat-menu-anchor">
            <button
              type="button"
              className="rivet-web-app-chat-menu-button"
              aria-expanded={isOverflowMenuOpen}
              aria-haspopup="menu"
              aria-label="Chat options"
              title="Chat options"
              onClick={toggleOverflowMenu}
            >
              <MoreMenuIcon aria-hidden="true" />
            </button>
            {isOverflowMenuOpen && (
              <span className="rivet-web-app-chat-menu" role="menu">
                <button type="button" role="menuitem" onClick={flushChatHistory}>
                  Flush chat history
                </button>
              </span>
            )}
          </span>
        </span>
        <span className="rivet-web-app-chat-header-actions">
          {pins.length > 0 && (
            <button
              type="button"
              className="rivet-web-app-chat-pins-button"
              aria-label={`${isPinsOpen ? 'Hide' : 'Show'} ${pins.length} pinned ${pins.length === 1 ? 'response' : 'responses'}`}
              aria-pressed={isPinsOpen}
              title={isPinsOpen ? 'Hide pinned responses' : 'Show pinned responses'}
              onClick={togglePins}
            >
              <PinIcon aria-hidden="true" />
              <span>{pins.length}</span>
            </button>
          )}
          {messages.length > 0 && (
            <button
              ref={searchButtonRef}
              type="button"
              className="rivet-web-app-chat-search-button"
              aria-label={isSearchOpen ? 'Close chat search' : 'Search chat'}
              aria-pressed={isSearchOpen}
              title={isSearchOpen ? 'Close chat search' : 'Search chat'}
              onClick={() => (isSearchOpen ? closeSearch() : openSearch())}
            >
              <SearchIcon aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      <div className="rivet-web-app-chat-history">
        {isPinsOpen && pins.length > 0 ? (
          <div className="rivet-web-app-chat-pins" aria-label="Pinned responses" role="region">
            {pins.map((pin) => (
              <RivetWebAppChatPin key={pin.messageIndex} pin={pin} onReveal={revealPinnedMessage} />
            ))}
          </div>
        ) : isSearchOpen ? (
          <div className="rivet-web-app-chat-search" role="search">
            <input
              ref={searchInputRef}
              type="search"
              className="rivet-web-app-chat-search-input"
              aria-label="Search chat messages"
              placeholder="Search chat"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setRequestedSearchMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeSearch();
                } else if (event.key === 'Enter' && searchQuery.trim()) {
                  event.preventDefault();
                  setRequestedSearchMatchIndex((index) => index + (event.shiftKey ? -1 : 1));
                }
              }}
            />
            <span className="rivet-web-app-chat-search-count" aria-live="polite">
              {searchMatchState.count === 0
                ? '0\u2009/\u20090'
                : `${searchMatchState.activeIndex + 1}\u2009/\u2009${searchMatchState.count}`}
            </span>
            <span className="rivet-web-app-chat-search-navigation">
              <button
                type="button"
                className="rivet-web-app-chat-search-navigation-button"
                aria-label="Previous chat search result"
                disabled={searchMatchState.count === 0}
                onClick={() => setRequestedSearchMatchIndex((index) => index - 1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <button
                type="button"
                className="rivet-web-app-chat-search-navigation-button"
                aria-label="Next chat search result"
                disabled={searchMatchState.count === 0}
                onClick={() => setRequestedSearchMatchIndex((index) => index + 1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </span>
            <button
              type="button"
              className="rivet-web-app-chat-search-close-button"
              aria-label="Close chat search"
              title="Close chat search"
              onClick={closeSearch}
            >
              <CrossIcon aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div
          ref={messagesRef}
          className="rivet-web-app-chat-messages"
          aria-live="polite"
          aria-relevant="additions text"
          role="log"
        >
          {messages.length === 0 && (
            <div className="rivet-web-app-chat-empty">
              <strong>Start a conversation</strong>
            </div>
          )}
          {messages.map((message, index) => {
            const presentation = messagePresentations[index];
            return (
              <Fragment key={`${index}-${message.role}`}>
                {presentation?.dateSeparator && (
                  <div
                    className="rivet-web-app-chat-date-separator"
                    data-rivet-chat-search-ignore="true"
                    role="separator"
                  >
                    <time dateTime={presentation.dateSeparator.dateTime}>{presentation.dateSeparator.label}</time>
                  </div>
                )}
                <RivetWebAppChatMessage
                  content={message.content}
                  messageIndex={index}
                  pinned={pinnedMessageIndexes.has(index)}
                  presentation={presentation}
                  role={message.role}
                  onTogglePin={togglePin}
                />
              </Fragment>
            );
          })}
          {isRunning && (
            <div className="rivet-web-app-chat-message rivet-web-app-chat-message-assistant rivet-web-app-chat-thinking">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>
      {actionError && (
        <div className="rivet-web-app-chat-error" role="alert">
          {actionError}
        </div>
      )}
      <RivetWebAppProgress progress={actionProgress} />
      <form
        className="rivet-web-app-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          aria-label="Message"
          placeholder={component.placeholder || 'Message...'}
          rows={1}
          value={draft}
          onChange={(event) => onStateChange(getUiGraphChatDraftStateKey(component.id), event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type={isRunning ? 'button' : 'submit'}
          className={`rivet-web-app-chat-send${isRunning ? ' rivet-web-app-chat-stop' : ''}`}
          aria-label={isRunning ? 'Stop response' : 'Send message'}
          title={isRunning ? 'Stop response' : 'Send message'}
          disabled={!isRunning && !draft.trim()}
          onClick={isRunning ? () => onCancelAction(component.id) : undefined}
        >
          {isRunning ? <span aria-hidden="true" className="rivet-web-app-chat-stop-icon" /> : <ChatSendIcon />}
        </button>
      </form>
    </section>
  );
};

const RivetWebAppChatMessage: FC<{
  content: string;
  messageIndex: number;
  pinned: boolean;
  presentation?: UiGraphChatMessagePresentation;
  role: 'assistant' | 'user';
  onTogglePin(messageIndex: number): void;
}> = ({ content, messageIndex, pinned, presentation, role, onTogglePin }) => {
  const markdownHtml = useMarkdown(content, true, { allowHtml: false });
  const message = (
    <div
      className={`rivet-web-app-chat-message rivet-web-app-chat-message-${role}`}
      data-rivet-chat-message-index={role === 'user' ? messageIndex : undefined}
    >
      <div className="rivet-web-app-chat-message-markdown markdown-body" dangerouslySetInnerHTML={markdownHtml} />
      {presentation?.timestamp && (
        <time
          className="rivet-web-app-chat-message-time"
          data-rivet-chat-search-ignore="true"
          dateTime={presentation.timestamp.dateTime}
          title={presentation.timestamp.dateTime}
        >
          {presentation.timestamp.label}
        </time>
      )}
    </div>
  );

  if (role === 'user') {
    return message;
  }

  return (
    <div className="rivet-web-app-chat-message-row" data-rivet-chat-message-index={messageIndex}>
      {message}
      <button
        type="button"
        className={`rivet-web-app-chat-pin-button${pinned ? ' active' : ''}`}
        aria-label={pinned ? 'Unpin response' : 'Pin response'}
        aria-pressed={pinned}
        title={pinned ? 'Unpin response' : 'Pin response'}
        onClick={() => onTogglePin(messageIndex)}
      >
        <PinIcon aria-hidden="true" />
      </button>
    </div>
  );
};

const RivetWebAppChatPin: FC<{ pin: UiGraphChatPin; onReveal(pin: UiGraphChatPin): void }> = ({ pin, onReveal }) => {
  const promptHtml = useMarkdown(pin.prompt?.content ?? '', true, { allowHtml: false });
  const responseHtml = useMarkdown(pin.response.content, true, { allowHtml: false });

  return (
    <button type="button" className="rivet-web-app-chat-pin" onClick={() => onReveal(pin)}>
      {pin.prompt && (
        <div className="rivet-web-app-chat-pin-exchange">
          <strong>You asked</strong>
          <div className="rivet-web-app-chat-pin-markdown markdown-body" dangerouslySetInnerHTML={promptHtml} />
        </div>
      )}
      <div className="rivet-web-app-chat-pin-exchange">
        <strong>Response</strong>
        <div className="rivet-web-app-chat-pin-markdown markdown-body" dangerouslySetInnerHTML={responseHtml} />
      </div>
    </button>
  );
};

const RivetWebAppDropdown: FC<{
  componentId: UiComponentId;
  items: readonly { label: string; value: string }[];
  label: string;
  onChange(value: string): void;
  value: string;
}> = ({ componentId, items, label, onChange, value }) => {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const selectedItem = items.find((item) => item.value === value) ?? null;

  return (
    <div
      className="rivet-web-app-dropdown"
      data-rivet-dropdown-value={value}
      data-rivet-focus-component-id={componentId}
    >
      <Select
        aria-label={label}
        isDisabled={items.length === 0}
        menuPlacement="auto"
        menuPortalTarget={menuPortalTarget}
        menuPosition="fixed"
        menuShouldScrollIntoView={false}
        noOptionsMessage={() => 'No options available'}
        options={items}
        placeholder="Select an option"
        value={selectedItem}
        onChange={(item) => item && onChange(item.value)}
      />
      <div ref={setMenuPortalTarget} data-ui-graph-builder-owned-portal />
    </div>
  );
};

const RivetWebAppProgress: FC<{ progress?: GraphProgress }> = ({ progress }) =>
  progress ? (
    <div className="rivet-web-app-progress" aria-live="polite">
      {progress.message && <span>{progress.message}</span>}
      {progress.percent != null && <progress aria-label="Action progress" max={100} value={progress.percent} />}
    </div>
  ) : null;
