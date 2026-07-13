import {
  Fragment,
  type FC,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type DataValue,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  RIVET_WEB_APP_RENDERER_CSS,
  createUiGraphInteractionController,
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
    (component: Extract<UiGraphComponent, { type: 'button' }>) =>
      interactionController.runAction(component, ({ componentId, signal, state }) =>
        onRunAction(componentId, state, signal),
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
                isRunning={interaction.runningComponentIds.has(component.id)}
                uiGraphName={normalizedUiGraph.name}
                state={interaction.state}
                onRunAction={runAction}
                onStateChange={interactionController.updateState}
              />
            ),
          };

          return renderComponentFrame ? (
            <Fragment key={component.id}>{renderComponentFrame(frameProps)}</Fragment>
          ) : (
            <div
              key={component.id}
              className={frameProps.className}
              onFocusCapture={frameProps.onFocusCapture}
              onPointerDownCapture={frameProps.onPointerDownCapture}
            >
              {frameProps.children}
            </div>
          );
        })}
        {Object.entries(interaction.actionErrors).map(([componentId, message]) => (
          <div key={componentId} className="rivet-web-app-error">
            {message}
          </div>
        ))}
      </main>
    </div>
  );
};

const RivetWebAppComponent: FC<{
  component: UiGraphComponent;
  isRunning: boolean;
  uiGraphName: string;
  state: Readonly<Record<string, unknown>>;
  onRunAction(component: Extract<UiGraphComponent, { type: 'button' }>): Promise<void> | void;
  onStateChange(key: string, value: unknown): void;
}> = ({ component, isRunning, onRunAction, onStateChange, state, uiGraphName }) => {
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
        <button
          className="rivet-web-app-button"
          disabled={isRunning}
          onClick={() => void onRunAction(renderModel.component)}
        >
          {isRunning ? 'Running...' : renderModel.label}
        </button>
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
          {output.renderAs === 'markdown' ? (
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
