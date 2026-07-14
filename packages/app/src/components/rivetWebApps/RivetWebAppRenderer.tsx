import {
  Fragment,
  type FC,
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
import {
  type DataValue,
  type GraphProgress,
  type UiComponentId,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphComponent,
  RIVET_WEB_APP_RENDERER_CSS,
  createUiGraphInteractionController,
  createUiGraphChatSubmissionStatePatch,
  getUiGraphChatDraftStateKey,
  getUiGraphComponentRenderModel,
  normalizeUiGraph,
} from '@valerypopoff/rivet2-core';
import { copyUiGraphText, downloadUiGraphJsonOutput } from '@valerypopoff/rivet2-core/web-app-runtime';
import { useMarkdown } from '../../hooks/useMarkdown.js';

export type RivetWebAppActionResult = {
  outputs: Record<string, DataValue>;
  statePatch?: Record<string, unknown>;
};

export type RivetWebAppRendererProps = {
  activeComponentId?: UiComponentId;
  renderComponentFrame?(props: RivetWebAppComponentFrameProps): ReactNode;
  onActiveComponentChange?(componentId: UiComponentId): void;
  onRunAction(
    componentId: UiComponentId,
    state: Record<string, unknown>,
    abortSignal: AbortSignal,
    onProgress: (progress: GraphProgress) => void,
  ): Promise<RivetWebAppActionResult>;
  rootRef?: RefObject<HTMLDivElement>;
  uiGraph: UiGraph;
};

export type RivetWebAppComponentFrameProps = {
  children: ReactNode;
  className: string;
  component: UiGraphComponent;
  onFocusCapture(): void;
  onPointerDownCapture(): void;
};

export const RivetWebAppRenderer: FC<RivetWebAppRendererProps> = ({
  activeComponentId,
  renderComponentFrame,
  onActiveComponentChange,
  onRunAction,
  rootRef,
  uiGraph,
}) => {
  const normalizedUiGraph = useMemo(() => normalizeUiGraph(uiGraph), [uiGraph]);
  const [interactionController] = useState(() => createUiGraphInteractionController(normalizedUiGraph));
  const interaction = useSyncExternalStore(
    interactionController.subscribe,
    interactionController.getSnapshot,
    interactionController.getSnapshot,
  );

  useLayoutEffect(() => {
    interactionController.setUiGraph(normalizedUiGraph);
  }, [interactionController, normalizedUiGraph]);

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
    <div ref={rootRef} className="rivet-web-app-root">
      <style>{RIVET_WEB_APP_RENDERER_CSS}</style>
      <main className="rivet-web-app-surface">
        {normalizedUiGraph.components.map((component) => {
          const frameProps: RivetWebAppComponentFrameProps = {
            className: `rivet-web-app-component-frame${activeComponentId === component.id ? ' active' : ''}`,
            component,
            onFocusCapture: () => onActiveComponentChange?.(component.id),
            onPointerDownCapture: () => onActiveComponentChange?.(component.id),
            children: (
              <RivetWebAppComponent
                component={component}
                actionError={interaction.actionErrors[component.id]}
                actionProgress={interaction.actionProgress[component.id]}
                isRunning={interaction.runningComponentIds.has(component.id)}
                uiGraphName={normalizedUiGraph.name}
                state={interaction.state}
                onRunAction={runAction}
                onCancelAction={interactionController.cancelAction}
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
  isRunning: boolean;
  uiGraphName: string;
  state: Readonly<Record<string, unknown>>;
  onRunAction(component: UiGraphActionComponent): Promise<void> | void;
  onCancelAction(componentId: UiComponentId): void;
  onStateChange(key: string, value: unknown): void;
  onStatePatch(patch: Record<string, unknown>): void;
}> = ({
  actionError,
  actionProgress,
  component,
  isRunning,
  onCancelAction,
  onRunAction,
  onStateChange,
  onStatePatch,
  state,
  uiGraphName,
}) => {
  const renderModel = getUiGraphComponentRenderModel(component, state);
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
    case 'button':
      return (
        <div className="rivet-web-app-action-stack">
          <button
            className="rivet-web-app-button"
            disabled={isRunning}
            onClick={() => void onRunAction(renderModel.component)}
          >
            {isRunning ? 'Running...' : renderModel.label}
          </button>
          {isRunning && (
            <button
              type="button"
              className="rivet-web-app-stop-button"
              onClick={() => onCancelAction(renderModel.component.id)}
            >
              Stop
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

      return (
        <section
          className={`rivet-web-app-card rivet-web-app-output${
            output.jsonDownloadValue != null ? ' rivet-web-app-output-has-download' : ''
          }`}
        >
          <div className="rivet-web-app-output-title">{renderModel.label}</div>
          {output.hasValue && (
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
          )}
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
          ) : (
            <pre>{output.renderedValue}</pre>
          )}
        </section>
      );
    }
  }
};

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
            <button type="button" className="rivet-web-app-stop-button" onClick={() => onCancelAction(component.id)}>
              Stop
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
            <span>Send a message to run the connected Rivet graph.</span>
          </div>
        )}
        {messages.map((message, index) => (
          <div
            key={`${index}-${message.role}`}
            className={`rivet-web-app-chat-message rivet-web-app-chat-message-${message.role}`}
          >
            {message.content}
          </div>
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

const RivetWebAppProgress: FC<{ progress?: GraphProgress }> = ({ progress }) =>
  progress ? (
    <div className="rivet-web-app-progress" aria-live="polite">
      {progress.message && <span>{progress.message}</span>}
      {progress.percent != null && <progress aria-label="Action progress" max={100} value={progress.percent} />}
    </div>
  ) : null;
