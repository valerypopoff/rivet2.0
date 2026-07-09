import { Fragment, type FC, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type DataValue,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  RIVET_WEB_APP_RENDERER_CSS,
  getUiGraphInitialState,
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
  uiGraph,
}) => {
  const previousUiGraphId = useRef(uiGraph.id);
  const [state, setState] = useState<Record<string, unknown>>(() => getUiGraphInitialState(uiGraph));
  const [runningComponentId, setRunningComponentId] = useState<UiComponentId | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (previousUiGraphId.current === uiGraph.id) {
      return;
    }

    previousUiGraphId.current = uiGraph.id;
    setState(getUiGraphInitialState(uiGraph));
    setError(undefined);
    setRunningComponentId(undefined);
  }, [uiGraph]);

  const updateState = (key: string, value: unknown) => {
    setState((current) => ({ ...current, [key]: value }));
  };

  const runAction = async (component: Extract<UiGraphComponent, { type: 'button' }>) => {
    setRunningComponentId(component.id);
    setError(undefined);

    try {
      const result = await onRunAction(component.id, state);
      setState((current) => ({ ...current, ...(result.statePatch ?? {}) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningComponentId(undefined);
    }
  };

  return (
    <div className="rivet-web-app-root">
      <style>{RIVET_WEB_APP_RENDERER_CSS}</style>
      <main className="rivet-web-app-surface">
        {uiGraph.components.map((component) => {
          const frameProps: RivetWebAppComponentFrameProps = {
            className: `rivet-web-app-component-frame${activeComponentId === component.id ? ' active' : ''}`,
            component,
            onFocusCapture: () => onActiveComponentChange?.(component.id),
            onPointerDownCapture: () => onActiveComponentChange?.(component.id),
            children: (
              <RivetWebAppComponent
                component={component}
                isRunning={runningComponentId === component.id}
                uiGraphName={uiGraph.name}
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
  const outputRenderMode = component.type === 'output' ? component.renderAs ?? 'text' : undefined;
  const markdownText =
    component.type === 'markdown'
      ? component.markdown
      : component.type === 'output' && outputRenderMode === 'markdown'
        ? renderOutputValue(state[component.stateKey], 'markdown')
        : undefined;
  const markdownHtml = useMarkdown(markdownText, markdownText != null, { allowHtml: false });

  switch (component.type) {
    case 'text':
      return <div className="rivet-web-app-card">{component.text}</div>;
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
          <span>{component.label}</span>
          <input
            className="rivet-web-app-control inputarea"
            placeholder={component.placeholder ?? ''}
            value={`${state[component.stateKey] ?? component.defaultValue ?? ''}`}
            onChange={(event) => onStateChange(component.stateKey, event.target.value)}
          />
        </label>
      );
    case 'textarea':
      return (
        <label className="rivet-web-app-field">
          <span>{component.label}</span>
          <textarea
            className="rivet-web-app-control inputarea"
            placeholder={component.placeholder ?? ''}
            value={`${state[component.stateKey] ?? component.defaultValue ?? ''}`}
            onChange={(event) => onStateChange(component.stateKey, event.target.value)}
          />
        </label>
      );
    case 'button':
      return (
        <button className="rivet-web-app-button" disabled={isRunning} onClick={() => void onRunAction(component)}>
          {isRunning ? 'Running...' : component.label}
        </button>
      );
    case 'output': {
      const rawOutputValue = state[component.stateKey];
      const renderedOutputValue = renderOutputValue(rawOutputValue, outputRenderMode ?? 'text');
      const canCopyOutput = hasRenderedOutputValue(state, component.stateKey);
      const jsonDownloadValue =
        canCopyOutput && outputRenderMode === 'json' ? stringifyJsonDownloadValue(rawOutputValue) : undefined;

      return (
        <section
          className={`rivet-web-app-card rivet-web-app-output${
            jsonDownloadValue != null ? ' rivet-web-app-output-has-download' : ''
          }`}
        >
          <div className="rivet-web-app-output-title">{component.label || component.stateKey}</div>
          {canCopyOutput && (
            <button
              type="button"
              className="rivet-web-app-output-action-button rivet-web-app-output-copy-button"
              title="Copy output"
              aria-label="Copy output"
              onClick={(event) => {
                event.stopPropagation();
                void copyWebAppOutputValue(renderedOutputValue);
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
          {outputRenderMode === 'markdown' ? (
            <div
              className="rivet-web-app-output-markdown markdown-body rivet-markdown-output"
              dangerouslySetInnerHTML={markdownHtml}
            />
          ) : (
            <pre>{renderedOutputValue}</pre>
          )}
        </section>
      );
    }
  }
};

function hasRenderedOutputValue(state: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key) && state[key] !== undefined;
}

function downloadWebAppJsonOutput(value: string, appName: string) {
  const blob = new Blob([value], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = getWebAppJsonOutputFilename(appName);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getWebAppJsonOutputFilename(appName: string): string {
  const safeName = appName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);

  return `${safeName || 'Rivet web app'} ${formatDownloadDateTime(new Date())}.json`;
}

function formatDownloadDateTime(date: Date): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(
    date.getMinutes(),
  )}-${pad(date.getSeconds())}`;
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

function renderOutputValue(value: unknown, renderAs: 'text' | 'json' | 'markdown'): string {
  if (renderAs === 'json') {
    return stringifyOutputValue(value);
  }

  return typeof value === 'string' ? value : value == null ? '' : stringifyOutputValue(value);
}

function stringifyOutputValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '[Unserializable value]';
  }
}

function stringifyJsonDownloadValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2) ?? undefined;
  } catch {
    return undefined;
  }
}
