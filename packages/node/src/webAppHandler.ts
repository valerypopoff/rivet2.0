import {
  type DataValue,
  type LooseDataValue,
  type Project,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
  type UiGraphId,
  formatUiGraphButtonBindingIssues,
  getUiGraphActionComponent,
  getUiGraphActionState,
  getUiGraphInitialState,
  jsonValueToDataValue,
  normalizeProjectUiGraphs,
  normalizeUiGraph,
  RIVET_MARKDOWN_SANITIZER_POLICY,
  resolveUiGraphActionOutputStatePatch,
  resolveUiGraphActionInputs,
  validateUiGraphButtonBindings,
} from '@valerypopoff/rivet2-core';
import { createProcessor, type NodeCreateProcessorOptions } from './api.js';
import {
  RIVET_WEB_APP_ASSET_CACHE_CONTROL,
  RIVET_WEB_APP_ASSET_ROUTE,
  getRivetWebAppAssetManifest,
  type RivetWebAppAsset,
} from './webAppAssets.js';

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
  assetMode?: RivetWebAppAssetMode;
  basePath?: string;
  createProcessorOptions?: RivetWebAppCreateProcessorOptions;
  onActionError?: (context: RivetWebAppActionContext & { error: unknown }) => Promise<void> | void;
  onActionFinish?: (context: RivetWebAppActionContext & RivetWebAppActionResult) => Promise<void> | void;
  onActionStart?: (context: RivetWebAppActionContext) => Promise<void> | void;
  resolveContext?: (request: Request) => Promise<Record<string, DataValue>> | Record<string, DataValue>;
  resolveCspNonce?: (request: Request) => Promise<string | undefined> | string | undefined;
  revisionKey?: string;
  uiGraphId?: UiGraphId | string;
};

export type RivetWebAppAssetMode = 'external' | 'inline';

type RivetWebAppHtmlBaseOptions = {
  actionPath: string;
  cspNonce?: string;
  revisionKey?: string;
};

export type RenderRivetWebAppHtmlOptions = RivetWebAppHtmlBaseOptions &
  ({ assetBasePath: string; assetMode: 'external' } | { assetBasePath?: never; assetMode?: 'inline' });

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
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RivetWebAppActionHttpError';
  }
}

export function createRivetWebAppHandler(
  project: Project,
  options: RivetWebAppHandlerOptions = {},
): RivetWebAppHandler {
  const normalizedProject = normalizeProjectUiGraphs(project);
  const basePath = normalizeBasePath(options.basePath ?? '/');
  const assetMode = options.assetMode ?? 'inline';

  return {
    async handleRequest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const routePath = stripBasePath(url.pathname, basePath);

      if (routePath == null) {
        return jsonResponse({ error: 'Not found' }, 404);
      }

      if (
        assetMode === 'external' &&
        (request.method === 'GET' || request.method === 'HEAD') &&
        routePath.startsWith(`${RIVET_WEB_APP_ASSET_ROUTE}/`)
      ) {
        return serveRivetWebAppAsset(request, routePath.slice(RIVET_WEB_APP_ASSET_ROUTE.length + 1));
      }

      if (request.method === 'GET' && (routePath === '/' || routePath === '')) {
        const uiGraph = resolveUiGraph(normalizedProject, options.uiGraphId);
        if (!uiGraph) {
          return htmlResponse(renderErrorHtml('Rivet web app not found'), 404);
        }

        const htmlOptions: RenderRivetWebAppHtmlOptions = {
          actionPath: joinUrlPath(basePath, '/actions/run'),
          cspNonce: await options.resolveCspNonce?.(request),
          revisionKey: options.revisionKey,
          ...(assetMode === 'external'
            ? {
                assetBasePath: joinUrlPath(basePath, RIVET_WEB_APP_ASSET_ROUTE),
                assetMode,
              }
            : { assetMode }),
        };
        return htmlResponse(renderRivetWebAppHtml(uiGraph, htmlOptions));
      }

      if (request.method === 'GET' && routePath === '/app.json') {
        const uiGraph = resolveUiGraph(normalizedProject, options.uiGraphId);
        return uiGraph ? jsonResponse(uiGraph) : jsonResponse({ error: 'Rivet web app not found' }, 404);
      }

      if (request.method === 'POST' && routePath === '/actions/run') {
        const uiGraph = resolveUiGraph(normalizedProject, options.uiGraphId);
        if (!uiGraph) {
          return jsonResponse({ error: 'Rivet web app not found' }, 404);
        }

        try {
          const body = await readActionRequestBody(request);
          const result = await runRivetWebAppAction(normalizedProject, {
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
          const errorCode = getActionErrorCode(error);
          return jsonResponse(
            {
              error: error instanceof Error ? error.message : String(error),
              ...(errorCode ? { code: errorCode } : {}),
            },
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
  const receivedState = normalizeActionState(state);
  const normalizedUiGraph = normalizeUiGraph(uiGraph);

  if (revisionKey != null && requestRevisionKey !== revisionKey) {
    throw new RivetWebAppActionHttpError('Rivet web app revision mismatch.', 409, 'revision_mismatch');
  }

  if (typeof componentId !== 'string' || !componentId) {
    throw new Error('Missing componentId.');
  }

  const resolvedComponentId = componentId as UiComponentId;
  const component = getUiGraphActionComponent(normalizedUiGraph, resolvedComponentId);
  if (!component) {
    throw new Error('UI action component not found.');
  }

  if (component.action.type !== 'runGraph') {
    throw new Error(`Unsupported UI action type: ${component.action.type}`);
  }

  if (!component.action.graphId) {
    throw new Error('This UI action is not connected to a graph.');
  }

  const actionState = getUiGraphActionState(component.action, receivedState);
  const rawInputs = resolveUiGraphActionInputs(component.action, actionState);
  const actionContext: RivetWebAppActionContext = {
    actionInput: rawInputs,
    component,
    componentId: resolvedComponentId,
    request: actionRequest,
    revisionKey,
    state: actionState,
    uiGraph: normalizedUiGraph,
  };

  try {
    const bindingErrors = validateUiGraphButtonBindings(project, normalizedUiGraph, resolvedComponentId);
    if (bindingErrors.length > 0) {
      throw new RivetWebAppActionHttpError(
        `Invalid web app button bindings: ${formatUiGraphButtonBindingIssues(bindingErrors)}`,
        400,
        'invalid_button_bindings',
      );
    }

    await callActionHook(onActionStart, actionContext);

    const processorOptions = await resolveProcessorOptions(createProcessorOptions, actionContext);
    const defaultContext: Record<string, LooseDataValue> = {};
    const context = (processorOptions.context ??
      (resolveContext ? await resolveContext(actionRequest) : defaultContext)) as Record<string, LooseDataValue>;
    const inputs = (processorOptions.inputs ??
      Object.fromEntries(
        Object.entries(rawInputs).map(([key, value]) => [key, jsonValueToDataValue(value)]),
      )) as Record<string, LooseDataValue>;
    const configuredAbortSignal = (processorOptions as { abortSignal?: AbortSignal }).abortSignal;
    const sourceAbortSignal = configuredAbortSignal ?? request?.signal;
    sourceAbortSignal?.throwIfAborted();
    const actionAbortController = sourceAbortSignal ? new AbortController() : undefined;
    const forwardAbort = () => actionAbortController?.abort(sourceAbortSignal?.reason);
    sourceAbortSignal?.addEventListener('abort', forwardAbort, { once: true });

    let outputs: Record<string, DataValue>;
    try {
      const processor = createProcessor(project, {
        ...processorOptions,
        abortSignal: actionAbortController?.signal,
        context,
        graph: component.action.graphId,
        inputs,
      });
      outputs = await processor.run();
    } finally {
      sourceAbortSignal?.removeEventListener('abort', forwardAbort);
    }
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
  return uiGraphId ? project.uiGraphs?.[uiGraphId as UiGraphId] : Object.values(project.uiGraphs ?? {})[0];
}

export function renderRivetWebAppHtml(uiGraph: UiGraph, options: RenderRivetWebAppHtmlOptions): string {
  const normalizedUiGraph = normalizeUiGraph(uiGraph);
  const manifest = getRivetWebAppAssetManifest();
  const nonceAttribute = getNonceAttribute(options.cspNonce);
  const bootstrap = escapeHtml(
    JSON.stringify({
      actionPath: options.actionPath,
      initialState: getUiGraphInitialState(normalizedUiGraph),
      markdownSanitizerPolicy: RIVET_MARKDOWN_SANITIZER_POLICY,
      revisionKey: options.revisionKey,
      uiGraph: normalizedUiGraph,
    }),
  );
  const styleMarkup =
    options.assetMode === 'external'
      ? renderExternalStylesheet(manifest.styles, options.assetBasePath)
      : `<style${nonceAttribute}>${styleForHtml(manifest.styles.content)}</style>`;
  const scriptMarkup = [manifest.marked, manifest.domPurify, manifest.client]
    .map((asset) =>
      options.assetMode === 'external'
        ? renderExternalScript(asset, options.assetBasePath, nonceAttribute)
        : `<script${nonceAttribute}>${scriptForHtml(asset.content)}</script>`,
    )
    .join('\n  ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(normalizedUiGraph.name)}</title>
  ${styleMarkup}
</head>
<body>
  <div id="app" class="rivet-web-app-root" data-rivet-web-app-config="${bootstrap}"></div>
  ${scriptMarkup}
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

function getActionErrorCode(error: unknown): string | undefined {
  return error instanceof RivetWebAppActionHttpError ? error.code : undefined;
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

function scriptForHtml(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script');
}

function styleForHtml(style: string): string {
  return style.replace(/<\/style/gi, '<\\/style');
}

function serveRivetWebAppAsset(request: Request, fileName: string): Response {
  const asset = Object.values(getRivetWebAppAssetManifest()).find((candidate) => candidate.fileName === fileName);
  if (!asset) {
    return request.method === 'HEAD'
      ? new Response(null, { headers: { 'content-type': 'application/json; charset=utf-8' }, status: 404 })
      : jsonResponse({ error: 'Not found' }, 404);
  }

  const headers = new Headers({
    'cache-control': RIVET_WEB_APP_ASSET_CACHE_CONTROL,
    'content-type': asset.contentType,
    etag: asset.etag,
    'x-content-type-options': 'nosniff',
  });
  const requestEtags = request.headers
    .get('if-none-match')
    ?.split(',')
    .map((etag) => etag.trim());
  if (requestEtags?.some((etag) => etag === '*' || etag.replace(/^W\//, '') === asset.etag)) {
    return new Response(null, { headers, status: 304 });
  }
  return new Response(request.method === 'HEAD' ? null : asset.content, { headers });
}

function renderExternalStylesheet(asset: RivetWebAppAsset, assetBasePath: string): string {
  return `<link rel="stylesheet" href="${escapeHtml(joinAssetUrl(assetBasePath, asset.fileName))}" integrity="${asset.integrity}" crossorigin="anonymous" />`;
}

function renderExternalScript(asset: RivetWebAppAsset, assetBasePath: string, nonceAttribute: string): string {
  return `<script${nonceAttribute} src="${escapeHtml(joinAssetUrl(assetBasePath, asset.fileName))}" integrity="${asset.integrity}" crossorigin="anonymous"></script>`;
}

function joinAssetUrl(basePath: string, fileName: string): string {
  return `${basePath.replace(/\/+$/, '')}/${fileName}`;
}

function getNonceAttribute(nonce: string | undefined): string {
  return nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
}

function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
