import { type FC, useEffect, useRef, useState } from 'react';
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
  onActiveComponentChange?(componentId: UiComponentId): void;
  onRunAction(componentId: UiComponentId, state: Record<string, unknown>): Promise<RivetWebAppActionResult>;
  uiGraph: UiGraph;
};

export const RivetWebAppRenderer: FC<RivetWebAppRendererProps> = ({
  activeComponentId,
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
        {uiGraph.components.map((component) => (
          <div
            key={component.id}
            className={`rivet-web-app-component-frame${activeComponentId === component.id ? ' active' : ''}`}
            onFocusCapture={() => onActiveComponentChange?.(component.id)}
            onPointerDownCapture={() => onActiveComponentChange?.(component.id)}
          >
            <RivetWebAppComponent
              component={component}
              isRunning={runningComponentId === component.id}
              state={state}
              onRunAction={runAction}
              onStateChange={updateState}
            />
          </div>
        ))}
        {error && <div className="rivet-web-app-error">{error}</div>}
      </main>
    </div>
  );
};

const RivetWebAppComponent: FC<{
  component: UiGraphComponent;
  isRunning: boolean;
  state: Record<string, unknown>;
  onRunAction(component: Extract<UiGraphComponent, { type: 'button' }>): Promise<void> | void;
  onStateChange(key: string, value: unknown): void;
}> = ({ component, isRunning, onRunAction, onStateChange, state }) => {
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
    case 'output':
      return (
        <section className="rivet-web-app-card rivet-web-app-output">
          <div className="rivet-web-app-output-title">{component.label || component.stateKey}</div>
          {outputRenderMode === 'markdown' ? (
            <div
              className="rivet-web-app-output-markdown markdown-body rivet-markdown-output"
              dangerouslySetInnerHTML={markdownHtml}
            />
          ) : (
            <pre>{renderOutputValue(state[component.stateKey], outputRenderMode ?? 'text')}</pre>
          )}
        </section>
      );
  }
};

function renderOutputValue(value: unknown, renderAs: 'text' | 'json' | 'markdown'): string {
  if (renderAs === 'json') {
    return stringifyOutputValue(value);
  }

  return typeof value === 'string' ? value : value == null ? '' : stringifyOutputValue(value);
}

function stringifyOutputValue(value: unknown): string {
  try {
    return JSON.stringify(value ?? null, null, 2) ?? `${value ?? ''}`;
  } catch {
    return '[Unserializable value]';
  }
}
