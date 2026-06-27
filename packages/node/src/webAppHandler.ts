import {
  type DataValue,
  type Project,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
  getUiGraphActionComponent,
  getUiGraphInitialState,
  resolveUiGraphActionOutputStatePatch,
  resolveUiGraphActionInputs,
} from '@valerypopoff/rivet2-core';
import { createProcessor, type NodeCreateProcessorOptions } from './api.js';

export type RivetWebAppHandlerOptions = {
  basePath?: string;
  createProcessorOptions?: Omit<NodeCreateProcessorOptions, 'context' | 'graph' | 'inputs'>;
  resolveContext?: (request: Request) => Promise<Record<string, DataValue>> | Record<string, DataValue>;
  uiGraphId?: UiGraphId | string;
};

export type RivetWebAppHandler = {
  handleRequest(request: Request): Promise<Response>;
};

type RunActionRequestBody = {
  componentId?: string;
  state?: Record<string, unknown>;
};

export function createRivetWebAppHandler(
  project: Project,
  options: RivetWebAppHandlerOptions = {},
): RivetWebAppHandler {
  const basePath = normalizeBasePath(options.basePath ?? '/');

  return {
    async handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const routePath = stripBasePath(url.pathname, basePath);

      if (routePath == null) {
        return jsonResponse({ error: 'Not found' }, 404);
      }

      if (request.method === 'GET' && (routePath === '/' || routePath === '')) {
        const uiGraph = resolveUiGraph(project, options.uiGraphId);
        if (!uiGraph) {
          return htmlResponse(renderErrorHtml('Rivet web app not found'), 404);
        }

        return htmlResponse(renderWebAppHtml(uiGraph, { actionPath: joinUrlPath(basePath, '/actions/run') }));
      }

      if (request.method === 'GET' && routePath === '/app.json') {
        const uiGraph = resolveUiGraph(project, options.uiGraphId);
        return uiGraph ? jsonResponse(uiGraph) : jsonResponse({ error: 'Rivet web app not found' }, 404);
      }

      if (request.method === 'POST' && routePath === '/actions/run') {
        const uiGraph = resolveUiGraph(project, options.uiGraphId);
        if (!uiGraph) {
          return jsonResponse({ error: 'Rivet web app not found' }, 404);
        }

        try {
          const body = (await request.json()) as RunActionRequestBody;
          const result = await runUiGraphAction({
            body,
            createProcessorOptions: options.createProcessorOptions,
            project,
            request,
            resolveContext: options.resolveContext,
            uiGraph,
          });

          return jsonResponse(result);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }

      return jsonResponse({ error: 'Not found' }, 404);
    },
  };
}

async function runUiGraphAction({
  body,
  createProcessorOptions,
  project,
  request,
  resolveContext,
  uiGraph,
}: {
  body: RunActionRequestBody;
  createProcessorOptions: RivetWebAppHandlerOptions['createProcessorOptions'];
  project: Project;
  request: Request;
  resolveContext: RivetWebAppHandlerOptions['resolveContext'];
  uiGraph: UiGraph;
}): Promise<{ outputs: Record<string, DataValue>; statePatch: Record<string, unknown> }> {
  if (!body.componentId) {
    throw new Error('Missing componentId.');
  }

  const component = getUiGraphActionComponent(uiGraph, body.componentId as UiComponentId);
  if (!component) {
    throw new Error('UI action component not found.');
  }

  if (component.action.type !== 'runGraph') {
    throw new Error(`Unsupported UI action type: ${component.action.type}`);
  }

  if (!component.action.graphId) {
    throw new Error('This UI action is not connected to a graph.');
  }

  const rawInputs = resolveUiGraphActionInputs(component.action, body.state ?? {});
  const processor = createProcessor(project, {
    ...createProcessorOptions,
    context: resolveContext ? await resolveContext(request) : {},
    graph: component.action.graphId,
    inputs: Object.fromEntries(Object.entries(rawInputs).map(([key, value]) => [key, toDataValue(value)])),
  });
  const outputs = await processor.run();

  return {
    outputs,
    statePatch: resolveUiGraphActionOutputStatePatch(component.action, outputs),
  };
}

function toDataValue(value: unknown): DataValue {
  if (isDataValue(value)) {
    return value;
  }

  if (typeof value === 'string') {
    return { type: 'string', value };
  }

  if (typeof value === 'number') {
    return { type: 'number', value };
  }

  if (typeof value === 'boolean') {
    return { type: 'boolean', value };
  }

  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return { type: 'object', value: value as Record<string, unknown> };
  }

  return { type: 'any', value };
}

function isDataValue(value: unknown): value is DataValue {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    'value' in value
  );
}

function resolveUiGraph(project: Project, uiGraphId: UiGraphId | string | undefined): UiGraph | undefined {
  if (uiGraphId) {
    return project.uiGraphs?.[uiGraphId as UiGraphId];
  }

  return Object.values(project.uiGraphs ?? {})[0];
}

function renderWebAppHtml(uiGraph: UiGraph, options: { actionPath: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(uiGraph.name)}</title>
  <style>${WEB_APP_CSS}</style>
</head>
<body>
  <main id="app" class="rivet-web-app"></main>
  <script>
    window.__RIVET_WEB_APP__ = ${jsonForScript({ actionPath: options.actionPath, initialState: getUiGraphInitialState(uiGraph), uiGraph })};
  </script>
  <script>${WEB_APP_CLIENT_JS}</script>
</body>
</html>`;
}

function renderErrorHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Rivet web app</title><body>${escapeHtml(message)}</body>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    status,
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    status,
  });
}

function normalizeBasePath(basePath: string): string {
  const normalized = `/${basePath}`.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '/';
}

function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === '/') {
    return pathname || '/';
  }

  if (pathname === basePath) {
    return '/';
  }

  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function joinUrlPath(basePath: string, path: string): string {
  return `${basePath === '/' ? '' : basePath}/${path}`.replace(/\/+/g, '/');
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const WEB_APP_CSS = `
:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #191d24; color: #f4f7fb; }
body { margin: 0; min-height: 100vh; background: #191d24; }
.rivet-web-app { box-sizing: border-box; display: grid; gap: 16px; margin: 0 auto; max-width: 760px; padding: 48px 20px; }
.rivet-card, .rivet-field { background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); border-radius: 12px; padding: 16px; }
.rivet-markdown > :first-child { margin-top: 0; }
.rivet-markdown > :last-child { margin-bottom: 0; }
.rivet-markdown code { background: rgba(255,255,255,.12); border-radius: 4px; padding: 1px 4px; }
.rivet-markdown pre { white-space: pre-wrap; }
.rivet-field { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
.rivet-field-label { opacity: .9; }
input, textarea, button { border-radius: 8px; box-sizing: border-box; font: inherit; }
input, textarea { appearance: none; background: rgba(0,0,0,.22); border: 1px solid rgba(255,255,255,.18); color: inherit; padding: 10px 12px; width: 100%; }
textarea { min-height: 110px; resize: vertical; }
button { align-items: center; background: #3ba85b; border: 0; color: #fff; cursor: pointer; display: inline-flex; font-weight: 700; justify-content: center; padding: 10px 16px; }
button:disabled { cursor: wait; opacity: .65; }
pre { background: rgba(0,0,0,.22); border-radius: 8px; overflow: auto; padding: 12px; white-space: pre-wrap; }
.rivet-error { color: #ff938a; font-weight: 700; }
`;

const WEB_APP_CLIENT_JS = `
(() => {
  const config = window.__RIVET_WEB_APP__;
  const root = document.getElementById('app');
  let state = { ...(config.initialState || {}) };
  let pending = false;
  let error = '';

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'className') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value != null) node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  };

  const stringifyOutputValue = (value) => {
    try {
      const json = JSON.stringify(value ?? null, null, 2);
      return json == null ? String(value ?? '') : json;
    } catch {
      return '[Unserializable value]';
    }
  };

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const renderInlineMarkdown = (value) => escapeHtml(value)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');

  const renderMarkdown = (value) => {
    const lines = String(value ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    let listItems = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        blocks.push('<p>' + renderInlineMarkdown(paragraph.join(' ')) + '</p>');
        paragraph = [];
      }
    };
    const flushList = () => {
      if (listItems.length) {
        blocks.push('<ul>' + listItems.map((item) => '<li>' + renderInlineMarkdown(item) + '</li>').join('') + '</ul>');
        listItems = [];
      }
    };

    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const listItem = /^[-*]\s+(.*)$/.exec(line);

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        blocks.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
        continue;
      }

      if (listItem) {
        flushParagraph();
        listItems.push(listItem[1]);
        continue;
      }

      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    return blocks.join('');
  };

  const renderMarkdownElement = (value) => {
    const node = el('div', { className: 'rivet-markdown' });
    node.innerHTML = renderMarkdown(value);
    return node;
  };

  const renderValue = (value, mode) => {
    if (mode === 'json') return stringifyOutputValue(value);
    return typeof value === 'string' ? value : value == null ? '' : stringifyOutputValue(value);
  };

  async function runAction(component) {
    pending = true;
    error = '';
    render();
    try {
      const response = await fetch(config.actionPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ componentId: component.id, state }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Action failed.');
      state = { ...state, ...(data.statePatch || {}) };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
      render();
    }
  }

  function renderComponent(component) {
    if (component.type === 'text') return el('div', { className: 'rivet-card', text: component.text });
    if (component.type === 'markdown') return el('div', { className: 'rivet-card' }, [renderMarkdownElement(component.markdown)]);
    if (component.type === 'input' || component.type === 'textarea') {
      const control = el(component.type === 'textarea' ? 'textarea' : 'input', {
        placeholder: component.placeholder || '',
      });
      control.value = state[component.stateKey] ?? component.defaultValue ?? '';
      control.addEventListener('input', () => { state = { ...state, [component.stateKey]: control.value }; });
      return el('label', { className: 'rivet-field' }, [
        el('span', { className: 'rivet-field-label', text: component.label || component.stateKey }),
        control,
      ]);
    }
    if (component.type === 'button') {
      const button = el('button', { text: pending ? 'Running...' : component.label, onClick: () => runAction(component) });
      button.disabled = pending;
      return button;
    }
    if (component.type === 'output') {
      const value = state[component.stateKey];
      const outputBody = component.renderAs === 'markdown'
        ? renderMarkdownElement(renderValue(value, 'markdown'))
        : el('pre', { text: renderValue(value, component.renderAs || 'text') });

      return el('section', { className: 'rivet-card' }, [
        el('strong', { text: component.label || component.stateKey }),
        outputBody,
      ]);
    }
    return el('div', { className: 'rivet-card', text: 'Unsupported component' });
  }

  function render() {
    root.replaceChildren(...config.uiGraph.components.map(renderComponent), ...(error ? [el('div', { className: 'rivet-error', text: error })] : []));
  }

  render();
})();`;
