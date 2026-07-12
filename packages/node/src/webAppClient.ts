import {
  applyUiGraphStatePatch,
  getUiGraphActionState,
  getUiGraphComponentRenderModel,
  getUiGraphJsonOutputFilename,
  type RivetMarkdownSanitizerPolicy,
  type UiComponentId,
  type UiGraph,
  type UiGraphComponent,
} from '@valerypopoff/rivet2-core/web-app-runtime';

type WebAppClientConfig = {
  actionPath: string;
  initialState: Record<string, unknown>;
  markdownSanitizerPolicy: RivetMarkdownSanitizerPolicy;
  revisionKey?: string;
  uiGraph: UiGraph;
};

declare global {
  interface Window {
    __RIVET_WEB_APP__?: WebAppClientConfig;
  }
}

type MarkedRenderer = {
  html: (html: string) => string;
};

type MarkedApi = {
  Renderer?: new () => MarkedRenderer;
  marked?: (value: string, options: { renderer: MarkedRenderer }) => string;
  parse?: (value: string, options: { renderer: MarkedRenderer }) => string;
};

type DomPurifyApi = {
  sanitize?: (value: string, options: Record<string, unknown>) => string;
};

type WebAppActionResponse = {
  code?: string;
  error?: string;
  statePatch?: Record<string, unknown>;
};

const browserGlobals = globalThis as typeof globalThis & {
  DOMPurify?: DomPurifyApi;
  marked?: MarkedApi;
};

const config = window.__RIVET_WEB_APP__;
const root = document.getElementById('app');

if (config && root) {
  let state = { ...config.initialState };
  let error = '';
  let pendingComponentId: UiComponentId | undefined;
  let revisionMismatch = false;

  const createElement = <TagName extends keyof HTMLElementTagNameMap>(
    tagName: TagName,
    attributes: Record<string, unknown> = {},
    children: Node[] = [],
  ): HTMLElementTagNameMap[TagName] => {
    const element = document.createElement(tagName);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'className') {
        element.className = `${value ?? ''}`;
      } else if (key === 'text') {
        element.textContent = `${value ?? ''}`;
      } else if (key.startsWith('on') && typeof value === 'function') {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (value != null) {
        element.setAttribute(key, `${value}`);
      }
    }
    element.append(...children);
    return element;
  };

  const escapeHtml = (value: unknown): string =>
    `${value ?? ''}`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  const createSafeMarkdownRenderer = () => {
    const Renderer = browserGlobals.marked?.Renderer;
    if (typeof Renderer !== 'function') return undefined;
    const renderer = new Renderer();
    renderer.html = (html: string) => escapeHtml(html);
    return renderer;
  };

  const markdownRenderer = createSafeMarkdownRenderer();

  const renderMarkdown = (value: string): string => {
    const parser = browserGlobals.marked?.parse ?? browserGlobals.marked?.marked;
    const sanitize = browserGlobals.DOMPurify?.sanitize;
    if (typeof parser !== 'function' || typeof sanitize !== 'function' || !markdownRenderer) {
      return escapeHtml(value);
    }

    const policy = config.markdownSanitizerPolicy;
    return sanitize(parser(value, { renderer: markdownRenderer }), {
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_ATTR: policy.allowedAttributes,
      ALLOWED_TAGS: policy.allowedTags,
      ALLOWED_URI_REGEXP: new RegExp(policy.allowedUriRegExpSource, 'i'),
    });
  };

  const renderMarkdownElement = (value: string, className: string): HTMLDivElement => {
    const element = createElement('div', { className });
    element.innerHTML = renderMarkdown(value);
    return element;
  };

  const copyText = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Browser preview hosts may not expose the modern clipboard API.
    }

    const textArea = document.createElement('textarea');
    textArea.value = value;
    textArea.style.opacity = '0';
    textArea.style.position = 'fixed';
    document.body.append(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
    } finally {
      textArea.remove();
    }
  };

  const downloadJson = (value: string): void => {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = getUiGraphJsonOutputFilename(config.uiGraph.name);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const getActionFailureMessage = (response: Pick<Response, 'status' | 'statusText'>): string =>
    `${response.status} ${response.statusText || 'Action failed'}`;

  const isWebAppActionResponse = (value: unknown): value is WebAppActionResponse =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const readActionResponse = async (response: Response): Promise<WebAppActionResponse> => {
    const body = (await response.text()).trim();
    if (!body) {
      throw new Error(response.ok ? 'Action returned an invalid response.' : getActionFailureMessage(response));
    }

    try {
      const result: unknown = JSON.parse(body);
      if (isWebAppActionResponse(result)) return result;
    } catch {
      // Proxy and upstream failures may return HTML or plain text instead of action JSON.
    }

    throw new Error(response.ok ? 'Action returned an invalid response.' : getActionFailureMessage(response));
  };

  const renderError = (): Node[] =>
    error && !revisionMismatch ? [createElement('div', { className: 'rivet-web-app-error', text: error })] : [];

  const renderRevisionMismatchModal = (): Node[] => {
    if (!revisionMismatch) return [];

    return [
      createElement('div', { className: 'rivet-web-app-modal-backdrop' }, [
        createElement(
          'div',
          {
            'aria-labelledby': 'rivet-web-app-revision-mismatch-title',
            'aria-modal': 'true',
            className: 'rivet-web-app-modal',
            role: 'dialog',
          },
          [
            createElement('div', {
              className: 'rivet-web-app-modal-message',
              id: 'rivet-web-app-revision-mismatch-title',
              text: 'This app was updated. Reload to continue.',
            }),
            createElement('button', {
              className: 'rivet-web-app-button rivet-web-app-modal-button',
              onClick: () => window.location.reload(),
              text: 'Reload',
              type: 'button',
            }),
          ],
        ),
      ]),
    ];
  };

  const runAction = async (component: Extract<UiGraphComponent, { type: 'button' }>): Promise<void> => {
    pendingComponentId = component.id;
    error = '';
    revisionMismatch = false;
    render();

    try {
      const response = await fetch(config.actionPath, {
        body: JSON.stringify({
          componentId: component.id,
          revisionKey: config.revisionKey,
          state: getUiGraphActionState(component.action, state),
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      const result = await readActionResponse(response);
      if (!response.ok) {
        if (response.status === 409 && result.code === 'revision_mismatch') {
          revisionMismatch = true;
          return;
        }
        throw new Error(result.error || 'Action failed.');
      }
      state = applyUiGraphStatePatch(state, result.statePatch);
    } catch (caughtError) {
      error = caughtError instanceof Error ? caughtError.message : `${caughtError}`;
    } finally {
      pendingComponentId = undefined;
      render();
    }
  };

  const renderComponent = (component: UiGraphComponent): HTMLElement => {
    const renderModel = getUiGraphComponentRenderModel(component, state);
    let content: HTMLElement | undefined;

    switch (renderModel.type) {
      case 'text':
        content = createElement('div', { className: 'rivet-web-app-text', text: renderModel.text });
        break;
      case 'markdown':
        content = renderMarkdownElement(renderModel.markdown, 'rivet-web-app-markdown markdown-body');
        break;
      case 'gap':
        content = createElement('div', {
          'aria-hidden': 'true',
          className: `rivet-web-app-gap rivet-web-app-gap-${renderModel.size}`,
        });
        break;
      case 'input':
      case 'textarea': {
        const control = createElement(renderModel.type === 'textarea' ? 'textarea' : 'input', {
          className: 'rivet-web-app-control inputarea',
          placeholder: renderModel.component.placeholder ?? '',
        }) as HTMLInputElement | HTMLTextAreaElement;
        control.value = renderModel.value;
        control.addEventListener('input', () => {
          state = { ...state, [renderModel.component.stateKey]: control.value };
        });
        content = createElement('label', { className: 'rivet-web-app-field' }, [
          createElement('span', { text: renderModel.label }),
          control,
        ]);
        break;
      }
      case 'button': {
        const isRunning = pendingComponentId === renderModel.component.id;
        content = createElement('button', {
          className: 'rivet-web-app-button',
          onClick: () => void runAction(renderModel.component),
          text: isRunning ? 'Running...' : renderModel.label,
          type: 'button',
        });
        (content as HTMLButtonElement).disabled = isRunning;
        break;
      }
      case 'output': {
        const { output } = renderModel;
        const children: Node[] = [
          createElement('div', { className: 'rivet-web-app-output-title', text: renderModel.label }),
        ];
        if (output.hasValue) {
          children.push(
            createElement('button', {
              'aria-label': 'Copy output',
              className: 'rivet-web-app-output-action-button rivet-web-app-output-copy-button',
              onClick: (event: Event) => {
                event.stopPropagation();
                void copyText(output.renderedValue);
              },
              title: 'Copy output',
              type: 'button',
            }),
          );
        }
        if (output.jsonDownloadValue != null) {
          children.push(
            createElement('button', {
              'aria-label': 'Download JSON',
              className: 'rivet-web-app-output-action-button rivet-web-app-output-download-button',
              onClick: (event: Event) => {
                event.stopPropagation();
                downloadJson(output.jsonDownloadValue!);
              },
              title: 'Download JSON',
              type: 'button',
            }),
          );
        }
        children.push(
          output.renderAs === 'markdown'
            ? renderMarkdownElement(
                output.renderedValue,
                'rivet-web-app-output-markdown markdown-body rivet-markdown-output',
              )
            : createElement('pre', { text: output.renderedValue }),
        );
        content = createElement(
          'section',
          {
            className: `rivet-web-app-card rivet-web-app-output${
              output.jsonDownloadValue != null ? ' rivet-web-app-output-has-download' : ''
            }`,
          },
          children,
        );
        break;
      }
    }

    if (!content) {
      throw new Error('Unsupported UI graph component.');
    }

    return createElement('div', { className: 'rivet-web-app-component-frame' }, [content]);
  };

  const render = (): void => {
    const surface = createElement('main', { className: 'rivet-web-app-surface' }, [
      ...config.uiGraph.components.map(renderComponent),
      ...renderError(),
    ]);
    root.replaceChildren(surface, ...renderRevisionMismatchModal());
    if (revisionMismatch) {
      root.querySelector<HTMLButtonElement>('.rivet-web-app-modal-button')?.focus();
    }
  };

  render();
}
