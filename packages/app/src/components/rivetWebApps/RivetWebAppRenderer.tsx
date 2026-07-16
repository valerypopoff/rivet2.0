import {
  Fragment,
  type FC,
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
import {
  type DataValue,
  type GraphProgress,
  type UiComponentId,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphComponent,
  type UiGraphInteractionController,
  RIVET_WEB_APP_RENDERER_CSS,
  createUiGraphInteractionController,
  createUiGraphChatSubmissionStatePatch,
  getUiGraphChatDraftStateKey,
  getUiGraphComponentRenderModel,
  getUiGraphProgressiveJsonOutputChunks,
  normalizeUiGraph,
} from '@valerypopoff/rivet2-core';
import {
  copyUiGraphText,
  downloadUiGraphJsonOutput,
  observeUiGraphOutputResizeBounds,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import { useMarkdown } from '../../hooks/useMarkdown.js';

// Vite resolves this CommonJS compatibility export directly, while tsx exposes
// the same component beneath `default` during source-level tests.
const Select = (AtlaskitSelect as unknown as { default?: typeof AtlaskitSelect }).default ?? AtlaskitSelect;

export type RivetWebAppActionResult = {
  outputs: Record<string, DataValue>;
  statePatch?: Record<string, unknown>;
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
  ): Promise<RivetWebAppActionResult>;
  rootRef?: RefObject<HTMLDivElement>;
  selectedComponentIds?: ReadonlySet<UiComponentId>;
  uiGraph: UiGraph;
};

export type RivetWebAppComponentFrameProps = {
  children: ReactNode;
  className: string;
  component: UiGraphComponent;
  onFocusCapture(): void;
  onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void;
};

export const RivetWebAppRenderer: FC<RivetWebAppRendererProps> = ({
  interactionController: interactionControllerProp,
  interactionUiGraph,
  renderComponentFrame,
  onComponentSelectionChange,
  onRootPointerDownCapture,
  onRunAction,
  rootRef,
  selectedComponentIds,
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

  useLayoutEffect(() => {
    interactionController.setUiGraph(normalizedInteractionUiGraph);
  }, [interactionController, normalizedInteractionUiGraph]);

  useEffect(() => {
    const abortActions = () => interactionController.abortActions();
    window.addEventListener('pagehide', abortActions);
    return () => {
      window.removeEventListener('pagehide', abortActions);
      interactionController.abortActions();
    };
  }, [interactionController]);

  const runAction = useCallback(
    (component: UiGraphActionComponent) =>
      interactionController.runAction(component, ({ componentId, reportProgress, signal, state }) =>
        onRunAction(componentId, state, signal, reportProgress),
      ),
    [interactionController, onRunAction],
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
            onClick={() => interactionController.reset()}
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
  onStateChange(key: string, value: unknown): void;
  onStatePatch(patch: Record<string, unknown>): void;
  renderModel: Extract<ReturnType<typeof getUiGraphComponentRenderModel>, { type: 'chat' }>;
  state: Readonly<Record<string, unknown>>;
}> = ({
  actionError,
  actionProgress,
  isRunning,
  onCancelAction,
  onRunAction,
  onStateChange,
  onStatePatch,
  renderModel,
  state,
}) => {
  const messagesRef = useRef<HTMLDivElement>(null);
  const { component, draft, messages } = renderModel;

  useEffect(() => {
    const messagesElement = messagesRef.current;
    if (messagesElement) {
      messagesElement.scrollTop = messagesElement.scrollHeight;
    }
  }, [isRunning, messages.length]);

  const submit = () => {
    const statePatch = createUiGraphChatSubmissionStatePatch(component.id, state);
    if (!statePatch || isRunning) {
      return;
    }
    onStatePatch(statePatch);
    void onRunAction(component);
  };

  return (
    <section className="rivet-web-app-chat">
      <div className="rivet-web-app-chat-header">
        <span>Chat</span>
        <span className="rivet-web-app-chat-header-actions">
          <span className="rivet-web-app-chat-status">{isRunning ? 'Responding' : 'Ready'}</span>
          {isRunning && (
            <button type="button" className="rivet-web-app-abort-button" onClick={() => onCancelAction(component.id)}>
              Abort
            </button>
          )}
        </span>
      </div>
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
        {messages.map((message, index) => (
          <RivetWebAppChatMessage key={`${index}-${message.role}`} content={message.content} role={message.role} />
        ))}
        {isRunning && (
          <div className="rivet-web-app-chat-message rivet-web-app-chat-message-assistant rivet-web-app-chat-thinking">
            <span />
            <span />
            <span />
          </div>
        )}
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
          type="submit"
          className="rivet-web-app-chat-send"
          aria-label="Send message"
          title="Send message"
          disabled={isRunning || !draft.trim()}
        >
          &uarr;
        </button>
      </form>
    </section>
  );
};

const RivetWebAppChatMessage: FC<{ content: string; role: 'assistant' | 'user' }> = ({ content, role }) => {
  const markdownHtml = useMarkdown(content, true, { allowHtml: false });

  return (
    <div
      className={`rivet-web-app-chat-message rivet-web-app-chat-message-${role} rivet-web-app-chat-message-markdown markdown-body`}
      dangerouslySetInnerHTML={markdownHtml}
    />
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
