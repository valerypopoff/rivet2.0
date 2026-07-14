import {
  copyUiGraphText,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphInteractionController,
  downloadUiGraphJsonOutput,
  getUiGraphComponentRenderModel,
  getUiGraphChatDraftStateKey,
  type RivetMarkdownSanitizerPolicy,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphComponent,
  type UiGraphInteractionSnapshot,
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

const root = document.getElementById('app');
const config = window.__RIVET_WEB_APP__ ?? readEmbeddedConfig(root);

if (config && root) {
  let revisionMismatch = false;
  const interactionController = createUiGraphInteractionController(config.uiGraph, {
    initialState: config.initialState,
  });

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

  const renderErrors = (): Node[] =>
    revisionMismatch
      ? []
      : Object.entries(interactionController.getSnapshot().actionErrors).flatMap(([componentId, message]) =>
          config.uiGraph.components.some((component) => component.id === componentId && component.type === 'chat')
            ? []
            : [
                createElement('div', {
                  className: 'rivet-web-app-error',
                  'data-component-id': componentId,
                  text: message,
                }),
              ],
        );

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

  const runAction = async (component: UiGraphActionComponent): Promise<void> => {
    revisionMismatch = false;
    await interactionController.runAction(component, async ({ abortOtherActions, componentId, signal, state }) => {
      const response = await fetch(config.actionPath, {
        body: JSON.stringify({
          componentId,
          revisionKey: config.revisionKey,
          state,
        }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal,
      });
      const result = await readActionResponse(response);
      if (!response.ok) {
        if (response.status === 409 && result.code === 'revision_mismatch') {
          revisionMismatch = true;
          abortOtherActions();
          return {};
        }
        throw new Error(result.error || 'Action failed.');
      }
      return { statePatch: result.statePatch };
    });
  };

  const renderComponent = (component: UiGraphComponent, interaction: UiGraphInteractionSnapshot): HTMLElement => {
    const renderModel = getUiGraphComponentRenderModel(component, interaction.state);
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
          interactionController.updateState(renderModel.component.stateKey, control.value);
        });
        content = createElement('label', { className: 'rivet-web-app-field' }, [
          createElement('span', { text: renderModel.label }),
          control,
        ]);
        break;
      }
      case 'button': {
        const isRunning = interaction.runningComponentIds.has(renderModel.component.id);
        content = createElement('button', {
          className: 'rivet-web-app-button',
          onClick: () => void runAction(renderModel.component),
          text: isRunning ? 'Running...' : renderModel.label,
          type: 'button',
        });
        (content as HTMLButtonElement).disabled = isRunning;
        break;
      }
      case 'chat': {
        const isRunning = interaction.runningComponentIds.has(renderModel.component.id);
        const submit = () => {
          const statePatch = createUiGraphChatSubmissionStatePatch(
            renderModel.component.id,
            interactionController.getSnapshot().state,
          );
          if (!statePatch || isRunning) return;
          textarea.focus();
          interactionController.updateStatePatch(statePatch);
          void runAction(renderModel.component);
        };
        const messageNodes = renderModel.messages.map((message) =>
          createElement('div', {
            className: `rivet-web-app-chat-message rivet-web-app-chat-message-${message.role}`,
            text: message.content,
          }),
        );
        if (messageNodes.length === 0) {
          messageNodes.push(
            createElement('div', { className: 'rivet-web-app-chat-empty' }, [
              createElement('strong', { text: 'Start a conversation' }),
              createElement('span', { text: 'Send a message to run the connected Rivet graph.' }),
            ]),
          );
        }
        if (isRunning) {
          messageNodes.push(
            createElement(
              'div',
              {
                className:
                  'rivet-web-app-chat-message rivet-web-app-chat-message-assistant rivet-web-app-chat-thinking',
              },
              [createElement('span'), createElement('span'), createElement('span')],
            ),
          );
        }

        const textarea = createElement('textarea', {
          'aria-label': 'Message',
          'data-rivet-chat-component-id': renderModel.component.id,
          placeholder: renderModel.component.placeholder || 'Message...',
          rows: '1',
        });
        textarea.value = renderModel.draft;
        const sendButton = createElement('button', {
          'aria-label': 'Send message',
          className: 'rivet-web-app-chat-send',
          text: String.fromCodePoint(8593),
          title: 'Send message',
          type: 'submit',
        });
        sendButton.disabled = isRunning || !renderModel.draft.trim();
        textarea.addEventListener('input', () => {
          interactionController.updateState(getUiGraphChatDraftStateKey(renderModel.component.id), textarea.value);
          sendButton.disabled = isRunning || !textarea.value.trim();
        });
        textarea.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            submit();
          }
        });
        const composer = createElement(
          'form',
          {
            className: 'rivet-web-app-chat-composer',
            onSubmit: (event: Event) => {
              event.preventDefault();
              submit();
            },
          },
          [textarea, sendButton],
        );
        const actionError = interaction.actionErrors[renderModel.component.id];
        content = createElement('section', { className: 'rivet-web-app-chat' }, [
          createElement('div', { className: 'rivet-web-app-chat-header' }, [
            createElement('span', { text: 'Chat' }),
            createElement('span', {
              className: 'rivet-web-app-chat-status',
              text: isRunning ? 'Responding' : 'Ready',
            }),
          ]),
          createElement(
            'div',
            {
              'aria-live': 'polite',
              'aria-relevant': 'additions text',
              className: 'rivet-web-app-chat-messages',
              role: 'log',
            },
            messageNodes,
          ),
          ...(actionError
            ? [createElement('div', { className: 'rivet-web-app-chat-error', role: 'alert', text: actionError })]
            : []),
          composer,
        ]);
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
                void copyUiGraphText(output.renderedValue);
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
                downloadUiGraphJsonOutput(output.jsonDownloadValue!, config.uiGraph.name);
              },
              title: 'Download JSON',
              type: 'button',
            }),
          );
        }
        children.push(
          output.renderAs === 'image'
            ? output.imageSource
              ? createElement('img', {
                  alt: renderModel.label,
                  className: 'rivet-web-app-output-image',
                  decoding: 'async',
                  loading: 'lazy',
                  referrerpolicy: 'no-referrer',
                  src: output.imageSource,
                })
              : createElement('div', {
                  className: 'rivet-web-app-output-image-placeholder',
                  text: output.imageErrorMessage ?? '',
                })
            : output.renderAs === 'markdown'
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

    return createElement(
      'div',
      {
        className: 'rivet-web-app-component-frame',
        'data-rivet-web-app-component-type': component.type,
      },
      [content],
    );
  };

  const render = (): void => {
    const activeElement = document.activeElement;
    const focusedChatComponentId =
      activeElement instanceof HTMLTextAreaElement && root.contains(activeElement)
        ? activeElement.dataset.rivetChatComponentId
        : undefined;
    const interaction = interactionController.getSnapshot();
    const surface = createElement('main', { className: 'rivet-web-app-surface' }, [
      ...config.uiGraph.components.map((component) => renderComponent(component, interaction)),
      ...renderErrors(),
    ]);
    root.replaceChildren(surface, ...renderRevisionMismatchModal());
    root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-messages').forEach((messages) => {
      messages.scrollTop = messages.scrollHeight;
    });
    if (revisionMismatch) {
      root.querySelector<HTMLButtonElement>('.rivet-web-app-modal-button')?.focus();
    } else if (focusedChatComponentId) {
      [...root.querySelectorAll<HTMLTextAreaElement>('[data-rivet-chat-component-id]')]
        .find((textarea) => textarea.dataset.rivetChatComponentId === focusedChatComponentId)
        ?.focus();
    }
  };

  interactionController.subscribe((change) => {
    if (change !== 'state') {
      render();
    }
  });
  window.addEventListener('pagehide', () => interactionController.abortActions());
  render();
}

function readEmbeddedConfig(root: HTMLElement | null): WebAppClientConfig | undefined {
  const serializedConfig = root?.getAttribute('data-rivet-web-app-config');
  if (!serializedConfig) {
    return undefined;
  }
  try {
    return JSON.parse(serializedConfig) as WebAppClientConfig;
  } catch {
    return undefined;
  }
}
