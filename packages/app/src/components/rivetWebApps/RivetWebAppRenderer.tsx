import { Fragment, type FC, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DataValue,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  RIVET_WEB_APP_RENDERER_CSS,
  applyUiGraphStatePatch,
  getUiGraphActionState,
  getUiGraphComponentRenderModel,
  getUiGraphJsonOutputFilename,
  getUiGraphInitialState,
  normalizeUiGraphComponentIds,
} from '@valerypopoff/rivet2-core';
import { useMarkdown } from '../../hooks/useMarkdown.js';

export type RivetWebAppActionResult = {
  outputs: Record<string, DataValue>;
  statePatch?: Record<string, unknown>;
};

export type RivetWebAppRendererProps = {
  activeComponentId?: UiComponentId;
  renderComponentFrame?(props: RivetWebAppComponentFrameProps): ReactNode;
  onActiveComponentChange?(componentId: UiComponentId): void;
  onRunAction(componentId: UiComponentId, state: Record<string, unknown>): Promise<RivetWebAppActionResult>;
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
  const normalizedUiGraph = useMemo(() => normalizeUiGraphComponentIds(uiGraph), [uiGraph]);
  const previousUiGraphId = useRef(normalizedUiGraph.id);
  const [state, setState] = useState<Record<string, unknown>>(() => getUiGraphInitialState(normalizedUiGraph));
  const [runningComponentId, setRunningComponentId] = useState<UiComponentId | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (previousUiGraphId.current === normalizedUiGraph.id) {
      return;
    }

    previousUiGraphId.current = normalizedUiGraph.id;
    setState(getUiGraphInitialState(normalizedUiGraph));
    setError(undefined);
    setRunningComponentId(undefined);
  }, [normalizedUiGraph]);

  const updateState = (key: string, value: unknown) => {
    setState((current) => ({ ...current, [key]: value }));
  };

  const runAction = async (component: Extract<UiGraphComponent, { type: 'button' }>) => {
    setRunningComponentId(component.id);
    setError(undefined);

    try {
      const result = await onRunAction(component.id, getUiGraphActionState(component.action, state));
      setState((current) => applyUiGraphStatePatch(current, result.statePatch));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningComponentId(undefined);
    }
  };

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
                isRunning={runningComponentId === component.id}
                uiGraphName={normalizedUiGraph.name}
                state={state}
                onRunAction={runAction}
                onStateChange={updateState}
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
        {error && <div className="rivet-web-app-error">{error}</div>}
      </main>
    </div>
  );
};

const RivetWebAppComponent: FC<{
  component: UiGraphComponent;
  isRunning: boolean;
  uiGraphName: string;
  state: Record<string, unknown>;
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
      return <div className="rivet-web-app-card">{renderModel.text}</div>;
    case 'markdown':
      return (
        <div
          className="rivet-web-app-card rivet-web-app-markdown markdown-body"
          dangerouslySetInnerHTML={markdownHtml}
        />
      );
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
                void copyWebAppOutputValue(output.renderedValue);
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
                downloadWebAppJsonOutput(jsonDownloadValue, uiGraphName);
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

function downloadWebAppJsonOutput(value: string, appName: string) {
  const blob = new Blob([value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = getUiGraphJsonOutputFilename(appName);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyWebAppOutputValue(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fall back for preview hosts that do not expose the clipboard API.
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.select();

  try {
    document.execCommand('copy');
  } finally {
    textArea.remove();
  }
}
