import { css } from '@emotion/react';
import { type FC, useEffect, useRef, useState } from 'react';
import {
  type DataValue,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
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

const styles = css`
  height: 100%;
  background: var(--grey-dark-colorish);
  color: var(--foreground);
  overflow: auto;

  .rivet-web-app-surface {
    box-sizing: border-box;
    display: grid;
    gap: 16px;
    margin: 0 auto;
    max-width: 760px;
    padding: 48px 20px;
  }

  .rivet-web-app-card,
  .rivet-web-app-field {
    border: 1px solid var(--foldable-section-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--modal-surface-bg) 88%, var(--foreground) 4%);
    padding: 16px;
  }

  .rivet-web-app-component-frame {
    border-radius: 12px;
    margin: -5px;
    padding: 4px;
  }

  .rivet-web-app-component-frame.active {
    background: color-mix(in srgb, var(--modal-surface-bg) 75%, var(--primary) 16%);
  }

  .rivet-web-app-field {
    display: grid;
    gap: 8px;
    color: var(--foreground);
    font-size: var(--ui-font-size-base);
    font-weight: 600;
  }

  .rivet-web-app-field input,
  .rivet-web-app-field textarea {
    appearance: none;
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--form-control-border);
    border-radius: 8px;
    background: var(--form-control-bg);
    color: var(--foreground);
    font: inherit;
    font-weight: 400;
    padding: 10px 12px;
  }

  .rivet-web-app-field textarea {
    min-height: 110px;
    resize: vertical;
  }

  .rivet-web-app-button {
    width: fit-content;
    border: 0;
    border-radius: var(--ui-button-radius);
    background: var(--success);
    color: var(--grey-lightest);
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 10px 16px;
  }

  .rivet-web-app-button:disabled {
    cursor: wait;
    opacity: 0.72;
  }

  .rivet-web-app-output {
    display: grid;
    gap: 8px;
  }

  .rivet-web-app-output-title {
    color: var(--primary-text);
    font-weight: 700;
  }

  .rivet-web-app-output pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .rivet-web-app-markdown,
  .rivet-web-app-output-markdown {
    word-break: break-word;
  }

  .rivet-web-app-markdown > :first-child,
  .rivet-web-app-output-markdown > :first-child {
    margin-top: 0;
  }

  .rivet-web-app-markdown > :last-child,
  .rivet-web-app-output-markdown > :last-child {
    margin-bottom: 0;
  }

  .rivet-web-app-error {
    color: var(--error);
    font-weight: 700;
  }
`;

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
    <div css={styles}>
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
  const markdownHtml = useMarkdown(markdownText, markdownText != null);

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
