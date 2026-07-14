import {
  copyUiGraphText,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphInteractionController,
  downloadUiGraphJsonOutput,
  getUiGraphComponentRenderModel,
  getUiGraphChatDraftStateKey,
  parseRivetWebAppServerMessage,
  RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
  type GraphProgress,
  type RivetMarkdownSanitizerPolicy,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphComponent,
  type UiGraphInteractionSnapshot,
} from '@valerypopoff/rivet2-core/web-app-runtime';

type WebAppClientConfig = {
  actionPath?: string;
  actionTransport?: { type: 'http'; actionPath: string } | { type: 'websocket'; socketPath: string };
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

type HostedActionRunner = {
  survivesPageDetach: boolean;
  dispose(): void;
  run(options: {
    componentId: string;
    onProgress(progress: GraphProgress): void;
    revisionKey?: string;
    signal: AbortSignal;
    state: Record<string, unknown>;
  }): Promise<{ statePatch?: Record<string, unknown> }>;
};

class HostedActionError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const getActionFailureMessage = (response: Pick<Response, 'status' | 'statusText'>): string =>
  `${response.status} ${response.statusText || 'Action failed'}`;

const isWebAppActionResponse = (value: unknown): value is WebAppActionResponse =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readHostedActionResponse(response: Response): Promise<WebAppActionResponse> {
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
}

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
  const actionRunner = createHostedActionRunner(config);

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
    await interactionController.runAction(
      component,
      async ({ abortOtherActions, componentId, reportProgress, signal, state }) => {
        try {
          return await actionRunner.run({
            componentId,
            onProgress: reportProgress,
            revisionKey: config.revisionKey,
            signal,
            state,
          });
        } catch (error) {
          if (error instanceof HostedActionError && error.code === 'revision_mismatch') {
            revisionMismatch = true;
            abortOtherActions();
            return {};
          }
          throw error;
        }
      },
    );
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
          'data-rivet-focus-component-id': renderModel.component.id,
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
        const button = createElement(
          'button',
          {
            'aria-busy': isRunning,
            'aria-label': isRunning ? `${renderModel.label} (running)` : undefined,
            className: 'rivet-web-app-button',
            onClick: () => void runAction(renderModel.component),
            text: isRunning ? renderModel.label : undefined,
            type: 'button',
          },
          isRunning
            ? [createElement('span', { 'aria-hidden': 'true', className: 'rivet-web-app-running-indicator' })]
            : [],
        );
        if (!isRunning) {
          button.textContent = renderModel.label;
        }
        (button as HTMLButtonElement).disabled = isRunning;
        const actionChildren: Node[] = [button];
        if (isRunning) {
          actionChildren.push(
            createElement('button', {
              className: 'rivet-web-app-abort-button',
              onClick: () => interactionController.cancelAction(renderModel.component.id),
              text: 'Abort',
              type: 'button',
            }),
          );
        }
        const progress = interaction.actionProgress[renderModel.component.id];
        const progressElement = renderActionProgress(progress);
        if (progressElement) actionChildren.push(progressElement);
        content = createElement(
          'div',
          { className: `rivet-web-app-action-stack${isRunning ? ' rivet-web-app-action-stack-running' : ''}` },
          actionChildren,
        );
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
          'data-rivet-focus-component-id': renderModel.component.id,
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
        const headerActions: Node[] = [
          createElement('span', {
            className: 'rivet-web-app-chat-status',
            text: isRunning ? 'Responding' : 'Ready',
          }),
        ];
        if (isRunning) {
          headerActions.push(
            createElement('button', {
              className: 'rivet-web-app-abort-button',
              onClick: () => interactionController.cancelAction(renderModel.component.id),
              text: 'Abort',
              type: 'button',
            }),
          );
        }
        const chatChildren: Node[] = [
          createElement('div', { className: 'rivet-web-app-chat-header' }, [
            createElement('span', { text: 'Chat' }),
            createElement('span', { className: 'rivet-web-app-chat-header-actions' }, headerActions),
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
        ];
        if (actionError) {
          chatChildren.push(
            createElement('div', { className: 'rivet-web-app-chat-error', role: 'alert', text: actionError }),
          );
        }
        const chatProgress = renderActionProgress(interaction.actionProgress[renderModel.component.id]);
        if (chatProgress) chatChildren.push(chatProgress);
        chatChildren.push(composer);
        content = createElement('section', { className: 'rivet-web-app-chat' }, chatChildren);
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
    const focusedControl = captureFocusedTextControl(root);
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
    } else if (focusedControl) {
      restoreFocusedTextControl(root, focusedControl);
    }
  };

  interactionController.subscribe((change) => {
    if (change !== 'state') {
      render();
    }
  });
  window.addEventListener('pagehide', () => {
    if (actionRunner.survivesPageDetach) {
      interactionController.detachActions();
    } else {
      interactionController.abortActions();
    }
    actionRunner.dispose();
  });
  render();
}

function createHostedActionRunner(config: WebAppClientConfig): HostedActionRunner {
  const transport =
    config.actionTransport ??
    (config.actionPath ? { type: 'http' as const, actionPath: config.actionPath } : undefined);
  if (!transport) {
    return {
      survivesPageDetach: false,
      dispose: () => undefined,
      run: async () => {
        throw new Error('Rivet web app action transport is not configured.');
      },
    };
  }
  return transport.type === 'websocket'
    ? createWebSocketActionRunner(transport.socketPath)
    : createHttpActionRunner(transport.actionPath);
}

function createHttpActionRunner(actionPath: string): HostedActionRunner {
  return {
    survivesPageDetach: false,
    dispose: () => undefined,
    async run({ componentId, revisionKey, signal, state }) {
      const response = await fetch(actionPath, {
        body: JSON.stringify({ componentId, revisionKey, state }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal,
      });
      const result = await readHostedActionResponse(response);
      if (!response.ok) {
        throw new HostedActionError(result.error || 'Action failed.', result.code);
      }
      return { statePatch: result.statePatch };
    },
  };
}

function createWebSocketActionRunner(socketPath: string): HostedActionRunner {
  type PendingAction = {
    abortListener: () => void;
    lastSequence: number;
    message: {
      type: 'action.start';
      requestId: string;
      componentId: string;
      revisionKey?: string;
      state: Record<string, unknown>;
    };
    onProgress(progress: GraphProgress): void;
    reject(error: unknown): void;
    resolve(result: { statePatch?: Record<string, unknown> }): void;
    runId?: string;
    signal: AbortSignal;
    startSent: boolean;
  };

  const pendingByRequestId = new Map<string, PendingAction>();
  const pendingByRunId = new Map<string, PendingAction>();
  let socket: WebSocket | undefined;
  let protocolReady = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const sendRaw = (message: unknown): boolean => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };
  const send = (message: unknown): boolean => protocolReady && sendRaw(message);
  const sendPending = (pending: PendingAction): void => {
    if (pending.runId) {
      send({ type: 'run.resume', runId: pending.runId, lastSequence: pending.lastSequence });
      if (pending.signal.aborted) send({ type: 'action.cancel', runId: pending.runId });
    } else if (!pending.signal.aborted || pending.startSent) {
      pending.startSent = send(pending.message) || pending.startSent;
    }
  };
  const connect = (): void => {
    if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    try {
      const url = new URL(socketPath, window.location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      else if (url.protocol === 'https:') url.protocol = 'wss:';
      else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error(`Unsupported web app WebSocket protocol: ${url.protocol}`);
      }
      socket = new WebSocket(url);
      protocolReady = false;
    } catch (error) {
      for (const pending of [...pendingByRequestId.values()]) {
        settlePending(pending, () => pending.reject(error));
      }
      return;
    }
    socket.addEventListener('open', () => {
      sendRaw({ type: 'client.hello', protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION });
    });
    socket.addEventListener('message', (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const message = parseRivetWebAppServerMessage(value);
      if (!message) return;
      if (message.type === 'server.ready') {
        protocolReady = true;
        reconnectAttempt = 0;
        for (const pending of pendingByRequestId.values()) sendPending(pending);
        return;
      }
      if (message.type === 'server.draining') return;
      if (message.type === 'action.rejected') {
        const pending = pendingByRequestId.get(message.requestId);
        if (pending) settlePending(pending, () => pending.reject(new HostedActionError(message.error, message.code)));
        return;
      }
      if (message.type === 'run.rejected') {
        const pending = pendingByRunId.get(message.runId);
        if (pending) settlePending(pending, () => pending.reject(new HostedActionError(message.error, message.code)));
        return;
      }

      const pending = pendingByRunId.get(message.runId) ?? pendingByRequestId.get(message.requestId);
      if (!pending || message.sequence <= pending.lastSequence) return;
      pending.lastSequence = message.sequence;
      if (message.type === 'action.accepted') {
        pending.runId = message.runId;
        pendingByRunId.set(message.runId, pending);
        if (pending.signal.aborted) send({ type: 'action.cancel', runId: message.runId });
      } else if (message.type === 'action.progress') {
        pending.onProgress(message.progress);
      } else if (message.type === 'action.completed') {
        settlePending(pending, () => pending.resolve({ statePatch: message.statePatch }));
      } else if (message.type === 'action.failed') {
        settlePending(pending, () => pending.reject(new HostedActionError(message.error, message.code)));
      } else if (message.type === 'action.cancelled') {
        settlePending(pending, () => pending.reject(new DOMException('The action was cancelled.', 'AbortError')));
      } else if (message.type === 'action.interrupted') {
        settlePending(pending, () => pending.reject(new HostedActionError(message.error, 'action_interrupted')));
      }
    });
    socket.addEventListener('close', (event) => {
      socket = undefined;
      protocolReady = false;
      if (isNonRetryableWebSocketClose(event.code)) {
        const message = event.reason.trim() || `Web app action connection closed (${event.code}).`;
        for (const pending of [...pendingByRequestId.values()]) {
          settlePending(pending, () => pending.reject(new HostedActionError(message, 'websocket_closed')));
        }
        return;
      }
      if (!disposed && pendingByRequestId.size > 0) scheduleReconnect();
    });
  };
  const scheduleReconnect = (): void => {
    if (reconnectTimer || disposed) return;
    const delay = Math.min(10_000, 250 * 2 ** reconnectAttempt) + Math.floor(Math.random() * 200);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };
  const settlePending = (pending: PendingAction, settle: () => void): void => {
    pending.signal.removeEventListener('abort', pending.abortListener);
    pendingByRequestId.delete(pending.message.requestId);
    if (pending.runId) pendingByRunId.delete(pending.runId);
    settle();
  };

  return {
    survivesPageDetach: true,
    dispose() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, 'Page detached');
      socket = undefined;
      const error = new DOMException('The page detached from the action.', 'AbortError');
      for (const pending of [...pendingByRequestId.values()]) {
        settlePending(pending, () => pending.reject(error));
      }
    },
    run({ componentId, onProgress, revisionKey, signal, state }) {
      if (disposed) return Promise.reject(new Error('The web app action transport is closed.'));
      signal.throwIfAborted();
      const requestId = globalThis.crypto?.randomUUID?.() ?? `rivet-${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        const pending: PendingAction = {
          abortListener: () => {
            if (pending.runId) {
              send({ type: 'action.cancel', runId: pending.runId });
            } else if (!pending.startSent) {
              settlePending(pending, () => reject(signal.reason));
            }
          },
          lastSequence: 0,
          message: {
            type: 'action.start',
            requestId,
            componentId,
            state,
            ...(revisionKey == null ? {} : { revisionKey }),
          },
          onProgress,
          reject,
          resolve,
          signal,
          startSent: false,
        };
        pendingByRequestId.set(requestId, pending);
        signal.addEventListener('abort', pending.abortListener, { once: true });
        connect();
        sendPending(pending);
      });
    },
  };
}

function isNonRetryableWebSocketClose(code: number): boolean {
  return code === 1002 || code === 1003 || code === 1007 || code === 1008 || code === 1009;
}

type FocusedTextControl = {
  componentId: string;
  scrollLeft: number;
  scrollTop: number;
  selectionDirection: 'backward' | 'forward' | 'none';
  selectionEnd: number;
  selectionStart: number;
};

function captureFocusedTextControl(root: HTMLElement): FocusedTextControl | undefined {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) ||
    !root.contains(activeElement)
  ) {
    return undefined;
  }
  const componentId = activeElement.dataset.rivetFocusComponentId;
  if (!componentId) return undefined;

  return {
    componentId,
    scrollLeft: activeElement.scrollLeft,
    scrollTop: activeElement.scrollTop,
    selectionDirection: activeElement.selectionDirection ?? 'none',
    selectionEnd: activeElement.selectionEnd ?? activeElement.value.length,
    selectionStart: activeElement.selectionStart ?? activeElement.value.length,
  };
}

function restoreFocusedTextControl(root: HTMLElement, focused: FocusedTextControl): void {
  const control = [
    ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-rivet-focus-component-id]'),
  ].find((candidate) => candidate.dataset.rivetFocusComponentId === focused.componentId);
  if (!control) return;

  control.focus();
  control.setSelectionRange(focused.selectionStart, focused.selectionEnd, focused.selectionDirection);
  control.scrollLeft = focused.scrollLeft;
  control.scrollTop = focused.scrollTop;
}

function renderActionProgress(progress: GraphProgress | undefined): HTMLElement | undefined {
  if (!progress) return undefined;
  const children: Node[] = [];
  if (progress.message) children.push(createStandaloneElement('span', { text: progress.message }));
  if (progress.percent != null) {
    children.push(
      createStandaloneElement('progress', { 'aria-label': 'Action progress', max: '100', value: progress.percent }),
    );
  }
  return createStandaloneElement('div', { 'aria-live': 'polite', className: 'rivet-web-app-progress' }, children);
}

function createStandaloneElement<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  attributes: Record<string, unknown> = {},
  children: Node[] = [],
): HTMLElementTagNameMap[TagName] {
  const element = document.createElement(tagName);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') element.className = String(value ?? '');
    else if (key === 'text') element.textContent = String(value ?? '');
    else if (value != null) element.setAttribute(key, String(value));
  }
  element.append(...children);
  return element;
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
