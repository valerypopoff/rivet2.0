import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type DataValue,
  type Project,
  RIVET_WEB_APP_DOCUMENT_CSS,
  RIVET_WEB_APP_RENDERER_CSS,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  type UiGraphId,
  getUiGraphActionComponent,
  getUiGraphInitialState,
  jsonValueToDataValue,
  resolveUiGraphActionOutputStatePatch,
  resolveUiGraphActionInputs,
} from '@valerypopoff/rivet2-core';
import { createProcessor, type NodeCreateProcessorOptions } from './api.js';

const requireForWebAppAssets = createRequire(import.meta.url);
let githubMarkdownCss: string | undefined;
let markedBrowserScript: string | undefined;

export type RivetWebAppProcessorOptions = Omit<NodeCreateProcessorOptions, 'graph'>;

export type RivetWebAppActionContext = {
  actionInput: Record<string, unknown>;
  component: Extract<UiGraphComponent, { type: 'button' }>;
  componentId: UiComponentId;
  request: Request;
  revisionKey?: string;
  state: Record<string, unknown>;
  uiGraph: UiGraph;
};

export type RivetWebAppProcessorOptionsResult = RivetWebAppProcessorOptions | null | undefined;

export type RivetWebAppCreateProcessorOptions =
  | RivetWebAppProcessorOptions
  | ((
      context: RivetWebAppActionContext,
    ) => Promise<RivetWebAppProcessorOptionsResult> | RivetWebAppProcessorOptionsResult);

export type RivetWebAppActionResult = {
  outputs: Record<string, DataValue>;
  statePatch: Record<string, unknown>;
};

export type RivetWebAppHandlerOptions = {
  basePath?: string;
  createProcessorOptions?: RivetWebAppCreateProcessorOptions;
  onActionError?: (context: RivetWebAppActionContext & { error: unknown }) => Promise<void> | void;
  onActionFinish?: (context: RivetWebAppActionContext & RivetWebAppActionResult) => Promise<void> | void;
  onActionStart?: (context: RivetWebAppActionContext) => Promise<void> | void;
  resolveContext?: (request: Request) => Promise<Record<string, DataValue>> | Record<string, DataValue>;
  revisionKey?: string;
  uiGraphId?: UiGraphId | string;
};

export type RivetWebAppHandler = {
  handleRequest(request: Request): Promise<Response>;
};

type RunActionRequestBody = {
  componentId?: string;
  revisionKey?: string;
  state?: Record<string, unknown>;
};

export type RunRivetWebAppActionOptions = {
  componentId?: string;
  createProcessorOptions?: RivetWebAppCreateProcessorOptions;
  onActionError?: RivetWebAppHandlerOptions['onActionError'];
  onActionFinish?: RivetWebAppHandlerOptions['onActionFinish'];
  onActionStart?: RivetWebAppHandlerOptions['onActionStart'];
  request?: Request;
  requestRevisionKey?: string;
  resolveContext?: RivetWebAppHandlerOptions['resolveContext'];
  revisionKey?: string;
  state?: Record<string, unknown>;
  uiGraph: UiGraph;
};

export class RivetWebAppActionHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RivetWebAppActionHttpError';
  }
}

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

        return htmlResponse(
          renderRivetWebAppHtml(uiGraph, {
            actionPath: joinUrlPath(basePath, '/actions/run'),
            revisionKey: options.revisionKey,
          }),
        );
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
          const body = await readActionRequestBody(request);
          const result = await runRivetWebAppAction(project, {
            componentId: body.componentId,
            createProcessorOptions: options.createProcessorOptions,
            onActionError: options.onActionError,
            onActionFinish: options.onActionFinish,
            onActionStart: options.onActionStart,
            request,
            requestRevisionKey: body.revisionKey,
            resolveContext: options.resolveContext,
            revisionKey: options.revisionKey,
            state: body.state,
            uiGraph,
          });

          return jsonResponse(result);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : String(error) },
            getActionErrorStatus(error),
          );
        }
      }

      return jsonResponse({ error: 'Not found' }, 404);
    },
  };
}

export async function runRivetWebAppAction(
  project: Project,
  {
    componentId,
    createProcessorOptions,
    onActionError,
    onActionFinish,
    onActionStart,
    request,
    requestRevisionKey,
    resolveContext,
    revisionKey,
    state = {},
    uiGraph,
  }: RunRivetWebAppActionOptions,
): Promise<RivetWebAppActionResult> {
  const actionRequest = request ?? new Request('https://rivet.local/web-app-action');
  const actionState = normalizeActionState(state);

  if (revisionKey != null && requestRevisionKey !== revisionKey) {
    throw new RivetWebAppActionHttpError('Rivet web app revision mismatch.', 409);
  }

  if (typeof componentId !== 'string' || !componentId) {
    throw new Error('Missing componentId.');
  }

  const resolvedComponentId = componentId as UiComponentId;
  const component = getUiGraphActionComponent(uiGraph, resolvedComponentId);
  if (!component) {
    throw new Error('UI action component not found.');
  }

  if (component.action.type !== 'runGraph') {
    throw new Error(`Unsupported UI action type: ${component.action.type}`);
  }

  if (!component.action.graphId) {
    throw new Error('This UI action is not connected to a graph.');
  }

  const rawInputs = resolveUiGraphActionInputs(component.action, actionState);
  const actionContext: RivetWebAppActionContext = {
    actionInput: rawInputs,
    component,
    componentId: resolvedComponentId,
    request: actionRequest,
    revisionKey,
    state: actionState,
    uiGraph,
  };

  try {
    await callActionHook(onActionStart, actionContext);

    const processorOptions = await resolveProcessorOptions(createProcessorOptions, actionContext);
    const processor = createProcessor(project, {
      ...processorOptions,
      context: processorOptions.context ?? (resolveContext ? await resolveContext(actionRequest) : {}),
      graph: component.action.graphId,
      inputs:
        processorOptions.inputs ??
        Object.fromEntries(Object.entries(rawInputs).map(([key, value]) => [key, jsonValueToDataValue(value)])),
    });
    const outputs = await processor.run();
    const result = {
      outputs,
      statePatch: resolveUiGraphActionOutputStatePatch(component.action, outputs),
    };

    await callActionHook(onActionFinish, { ...actionContext, ...result });
    return result;
  } catch (error) {
    await callActionHook(onActionError, { ...actionContext, error });
    throw error;
  }
}

function resolveUiGraph(project: Project, uiGraphId: UiGraphId | string | undefined): UiGraph | undefined {
  if (uiGraphId) {
    return project.uiGraphs?.[uiGraphId as UiGraphId];
  }

  return Object.values(project.uiGraphs ?? {})[0];
}

export function renderRivetWebAppHtml(uiGraph: UiGraph, options: { actionPath: string; revisionKey?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(uiGraph.name)}</title>
  <style>${styleForHtml(RIVET_WEB_APP_DOCUMENT_CSS)}</style>
  <style>${styleForHtml(getGithubMarkdownCss())}</style>
  <style>${styleForHtml(RIVET_WEB_APP_RENDERER_CSS)}</style>
</head>
<body>
  <div id="app" class="rivet-web-app-root"></div>
  <script>
    window.__RIVET_WEB_APP__ = ${jsonForScript({ actionPath: options.actionPath, initialState: getUiGraphInitialState(uiGraph), revisionKey: options.revisionKey, uiGraph })};
  </script>
  <script>${scriptForHtml(getMarkedBrowserScript())}</script>
  <script>${scriptForHtml(WEB_APP_CLIENT_JS)}</script>
</body>
</html>`;
}

async function readActionRequestBody(request: Request): Promise<RunActionRequestBody> {
  try {
    const body = await request.json();
    if (!isRecord(body)) {
      throw new RivetWebAppActionHttpError('Invalid action request body.', 400);
    }

    const componentId = body.componentId;
    const revisionKey = body.revisionKey;

    if (componentId != null && typeof componentId !== 'string') {
      throw new RivetWebAppActionHttpError('Invalid componentId.', 400);
    }

    if (revisionKey != null && typeof revisionKey !== 'string') {
      throw new RivetWebAppActionHttpError('Invalid revisionKey.', 400);
    }

    return {
      componentId: componentId ?? undefined,
      revisionKey: revisionKey ?? undefined,
      state: normalizeActionState(body.state),
    };
  } catch (error) {
    if (error instanceof RivetWebAppActionHttpError) {
      throw error;
    }

    throw new RivetWebAppActionHttpError('Invalid JSON request body.', 400);
  }
}

function normalizeActionState(state: unknown): Record<string, unknown> {
  if (state == null) {
    return {};
  }

  if (isRecord(state)) {
    return state;
  }

  throw new RivetWebAppActionHttpError('Invalid action state.', 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getActionErrorStatus(error: unknown): number {
  return error instanceof RivetWebAppActionHttpError ? error.status : 400;
}

async function resolveProcessorOptions(
  createProcessorOptions: RivetWebAppCreateProcessorOptions | undefined,
  context: RivetWebAppActionContext,
): Promise<RivetWebAppProcessorOptions> {
  if (!createProcessorOptions) {
    return {};
  }

  const options =
    typeof createProcessorOptions === 'function' ? await createProcessorOptions(context) : createProcessorOptions;
  if (options == null) {
    return {};
  }

  const { graph: _ignoredGraph, ...processorOptions } = options as RivetWebAppProcessorOptions & { graph?: unknown };
  return processorOptions;
}

async function callActionHook<TContext>(
  hook: ((context: TContext) => Promise<void> | void) | undefined,
  context: TContext,
): Promise<void> {
  try {
    await hook?.(context);
  } catch {
    // Web app action hooks are observability-only; route policy stays wrapper-owned.
  }
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

function scriptForHtml(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script');
}

function styleForHtml(style: string): string {
  return style.replace(/<\/style/gi, '<\\/style');
}

function getGithubMarkdownCss(): string {
  githubMarkdownCss ??= readFileSync(
    requireForWebAppAssets.resolve('github-markdown-css/github-markdown-dark-dimmed.css'),
    'utf8',
  );
  return githubMarkdownCss;
}

function getMarkedBrowserScript(): string {
  markedBrowserScript ??= readFileSync(requireForWebAppAssets.resolve('marked/marked.min.js'), 'utf8');
  return markedBrowserScript;
}

function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const WEB_APP_CLIENT_JS = String.raw`
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

  const createSafeMarkdownRenderer = () => {
    const Renderer = globalThis.marked?.Renderer;
    if (typeof Renderer !== 'function') return undefined;
    const renderer = new Renderer();
    renderer.html = (html) => escapeHtml(html);
    return renderer;
  };

  const safeMarkdownRenderer = createSafeMarkdownRenderer();

  const renderMarkdown = (value) => {
    const parser = globalThis.marked?.parse ?? globalThis.marked?.marked;
    if (typeof parser !== 'function' || !safeMarkdownRenderer) {
      return escapeHtml(value);
    }

    return parser(String(value ?? ''), { renderer: safeMarkdownRenderer });
  };

  const renderMarkdownElement = (value, className) => {
    const node = el('div', { className });
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
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ componentId: component.id, revisionKey: config.revisionKey, state }),
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
    if (component.type === 'text') return el('div', { className: 'rivet-web-app-card', text: component.text });
    if (component.type === 'markdown') return renderMarkdownElement(component.markdown, 'rivet-web-app-card rivet-web-app-markdown markdown-body');
    if (component.type === 'input' || component.type === 'textarea') {
      const control = el(component.type === 'textarea' ? 'textarea' : 'input', {
        placeholder: component.placeholder || '',
      });
      control.value = state[component.stateKey] ?? component.defaultValue ?? '';
      control.addEventListener('input', () => { state = { ...state, [component.stateKey]: control.value }; });
      return el('label', { className: 'rivet-web-app-field' }, [
        el('span', { text: component.label || component.stateKey }),
        control,
      ]);
    }
    if (component.type === 'button') {
      const button = el('button', { className: 'rivet-web-app-button', text: pending ? 'Running...' : component.label, onClick: () => runAction(component) });
      button.disabled = pending;
      return button;
    }
    if (component.type === 'output') {
      const value = state[component.stateKey];
      const outputBody = component.renderAs === 'markdown'
        ? renderMarkdownElement(renderValue(value, 'markdown'), 'rivet-web-app-output-markdown markdown-body rivet-markdown-output')
        : el('pre', { text: renderValue(value, component.renderAs || 'text') });

      return el('section', { className: 'rivet-web-app-card rivet-web-app-output' }, [
        el('div', { className: 'rivet-web-app-output-title', text: component.label || component.stateKey }),
        outputBody,
      ]);
    }
    return el('div', { className: 'rivet-web-app-card', text: 'Unsupported component' });
  }

  function render() {
    const surface = el('main', { className: 'rivet-web-app-surface' }, [
      ...config.uiGraph.components.map(renderComponent),
      ...(error ? [el('div', { className: 'rivet-web-app-error', text: error })] : []),
    ]);
    root.replaceChildren(surface);
  }

  render();
})();`;
