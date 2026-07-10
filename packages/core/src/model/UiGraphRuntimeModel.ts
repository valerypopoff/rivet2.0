import type { UiGraphComponent } from './UiGraph.js';

export type UiGraphOutputRenderMode = 'text' | 'json' | 'markdown';

export type UiGraphOutputRenderModel = {
  hasValue: boolean;
  jsonDownloadValue?: string;
  renderedValue: string;
  renderAs: UiGraphOutputRenderMode;
};

export type UiGraphComponentRenderModel =
  | {
      component: Extract<UiGraphComponent, { type: 'text' }>;
      text: string;
      type: 'text';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'markdown' }>;
      markdown: string;
      type: 'markdown';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'input' | 'textarea' }>;
      label: string;
      type: 'input' | 'textarea';
      value: string;
    }
  | {
      component: Extract<UiGraphComponent, { type: 'button' }>;
      label: string;
      type: 'button';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'output' }>;
      label: string;
      output: UiGraphOutputRenderModel;
      type: 'output';
    };

export function getUiGraphComponentRenderModel(
  component: UiGraphComponent,
  state: Record<string, unknown>,
): UiGraphComponentRenderModel {
  switch (component.type) {
    case 'text':
      return { component, text: component.text, type: 'text' };
    case 'markdown':
      return { component, markdown: component.markdown, type: 'markdown' };
    case 'input':
    case 'textarea':
      return {
        component,
        label: getUiGraphComponentLabel(component),
        type: component.type,
        value: `${state[component.stateKey] ?? component.defaultValue ?? ''}`,
      };
    case 'button':
      return { component, label: component.label, type: 'button' };
    case 'output':
      return {
        component,
        label: getUiGraphComponentLabel(component),
        output: getUiGraphOutputRenderModel(state, component.stateKey, component.renderAs ?? 'text'),
        type: 'output',
      };
  }
}

export function getUiGraphComponentLabel(
  component: Extract<UiGraphComponent, { type: 'input' | 'textarea' | 'output' }>,
): string {
  return component.label || component.stateKey;
}

export function getUiGraphOutputRenderModel(
  state: Record<string, unknown>,
  stateKey: string,
  renderAs: UiGraphOutputRenderMode,
): UiGraphOutputRenderModel {
  const value = state[stateKey];
  const hasValue = hasUiGraphStateValue(state, stateKey);
  const renderedValue = renderUiGraphOutputValue(value, renderAs);

  return {
    hasValue,
    ...(hasValue && renderAs === 'json' ? { jsonDownloadValue: stringifyUiGraphValue(value) } : {}),
    renderedValue,
    renderAs,
  };
}

export function hasUiGraphStateValue(state: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key) && state[key] !== undefined;
}

export function renderUiGraphOutputValue(value: unknown, renderAs: UiGraphOutputRenderMode): string {
  if (renderAs === 'json') {
    return stringifyUiGraphValue(value) ?? '';
  }

  return typeof value === 'string' ? value : value == null ? '' : stringifyUiGraphValue(value) ?? '';
}

export function stringifyUiGraphValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unserializable value]';
  }
}

export function getUiGraphJsonOutputFilename(appName: string, date = new Date()): string {
  const safeName = appName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);

  return `${safeName || 'Rivet web app'} ${formatUiGraphDownloadDateTime(date)}.json`;
}

export function formatUiGraphDownloadDateTime(date: Date): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(
    date.getMinutes(),
  )}-${pad(date.getSeconds())}`;
}

export function applyUiGraphStatePatch(
  state: Record<string, unknown>,
  statePatch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return statePatch ? { ...state, ...statePatch } : state;
}
