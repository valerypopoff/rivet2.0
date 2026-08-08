import {
  clearUiGraphChatSearchMatches,
  applyUiGraphWebAppStorageActionPatch,
  applyUiGraphWebAppStoragePatch,
  copyUiGraphText,
  createUiGraphChatHistoryFlushStatePatch,
  createUiGraphChatMessageRemovalStatePatch,
  createUiGraphChatPinStatePatch,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphInteractionController,
  downloadUiGraphJsonOutput,
  enhanceUiGraphChatJsonCodeBlocks,
  getUiGraphComponentRenderModel,
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagePresentations,
  getUiGraphChatMessagesStateKey,
  getUiGraphChatPersistentState,
  hasUiGraphChatPersistentStateChanged,
  highlightUiGraphChatSearchMatches,
  loadUiGraphChatPersistentState,
  loadUiGraphWebAppStorage,
  revealUiGraphChatElement,
  revealUiGraphChatSearchMatch,
  saveUiGraphChatPersistentState,
  saveUiGraphResponseTrace,
  loadUiGraphResponseTrace,
  pruneUiGraphResponseTraces,
  type AgentResponseTrace,
  type UiGraphActionComponent,
  type UiGraphChatMessageTimestampPresentation,
  type UiGraphComponent,
  type UiGraphInteractionSnapshot,
} from '@valerypopoff/rivet2-core/web-app-runtime';
import {
  captureFocusedTextControl,
  createWebAppElement as createElement,
  createProgressiveJsonOutput,
  observeOutputResizeBounds,
  renderActionProgress,
  restoreFocusedTextControl,
} from './webAppClientDom.js';
import { createHostedActionRunner, HostedActionError } from './webAppClientTransport.js';
import type { WebAppClientConfig } from './webAppClientTypes.js';

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

function createResponseInspectorElement(trace: AgentResponseTrace | null, onClose: () => void): HTMLElement {
  const metric = (label: string, value: string) =>
    createElement('div', {}, [createElement('dt', { text: label }), createElement('dd', { text: value })]);
  const metricGroup = (title: string, metrics: HTMLElement[], description?: string) =>
    createElement('section', { className: 'rivet-agent-response-inspector-metric-group' }, [
      createElement('div', { className: 'rivet-agent-response-inspector-group-heading' }, [
        createElement('h3', { text: title }),
        ...(description ? [createElement('p', { text: description })] : []),
      ]),
      createElement('dl', { className: 'rivet-agent-response-inspector-metrics' }, metrics),
    ]);
  const body =
    trace == null
      ? createElement('div', { className: 'rivet-agent-response-inspector-unavailable' }, [
          createElement('strong', { text: 'Trace unavailable' }),
          createElement('p', {
            text: 'This response was produced by an older host, a replay, or while response inspection was disabled.',
          }),
        ])
      : createElement('div', { className: 'rivet-agent-response-inspector-body' }, [
          metricGroup('Execution', [
            metric('Status', trace.status),
            metric('Total duration', formatTraceDuration(trace.durationMs)),
            metric('Model calls', String(trace.summary.modelCallCount)),
            metric('Tool calls', String(trace.summary.toolCallCount)),
          ]),
          metricGroup(
            'Recovery behavior',
            [
              metric('Provider request retries', String(trace.summary.retryCount)),
              metric('LLM profile fallbacks', String(trace.summary.fallbackCount)),
            ],
            'Provider request retries repeat a failed request. LLM profile fallbacks move to the next configured profile.',
          ),
          metricGroup('Usage and cost', [
            metric('Input tokens', formatTraceTokens(trace.summary.promptTokens)),
            metric('Output tokens', formatTraceTokens(trace.summary.completionTokens)),
            metric('Cached input tokens', formatTraceTokens(trace.summary.cachedTokens)),
            metric('Reasoning tokens', formatTraceTokens(trace.summary.reasoningTokens)),
            metric(
              'Model cost',
              trace.summary.costStatus === 'unknown'
                ? 'Unknown'
                : `$${trace.summary.knownCostUsd.toFixed(6)}${trace.summary.costStatus === 'partial' ? ' (partial)' : ''}`,
            ),
          ]),
          ...(trace.startedAt == null && trace.responseReadyAt == null && !trace.backgroundWorkPending
            ? []
            : [
                createElement('section', { className: 'rivet-agent-response-inspector-metric-group' }, [
                  createElement('div', { className: 'rivet-agent-response-inspector-group-heading' }, [
                    createElement('h3', { text: 'Timing' }),
                  ]),
                  createElement('dl', { className: 'rivet-agent-response-inspector-timing' }, [
                    ...(trace.startedAt == null
                      ? []
                      : [
                          createElement('div', {}, [
                            createElement('dt', { text: 'Started' }),
                            createElement('dd', { text: new Date(trace.startedAt).toLocaleString() }),
                          ]),
                        ]),
                    ...(trace.responseReadyAt == null
                      ? []
                      : [
                          createElement('div', {}, [
                            createElement('dt', { text: 'Response ready' }),
                            createElement('dd', { text: new Date(trace.responseReadyAt).toLocaleString() }),
                          ]),
                        ]),
                    ...(trace.backgroundWorkPending
                      ? [
                          createElement('div', {}, [
                            createElement('dt', { text: 'Async work' }),
                            createElement('dd', { text: 'Still active when this response was delivered' }),
                          ]),
                        ]
                      : []),
                  ]),
                ]),
              ]),
          createTraceDetails(
            'Model calls',
            trace.modelCalls.map((call) =>
              createElement('article', {}, [
                createElement('strong', { text: `${call.provider} · ${call.model}` }),
                createElement('span', {
                  text: `${call.outcome}${call.profileIndex == null ? '' : ` · profile ${call.profileIndex + 1}`} · round ${(call.roundIndex ?? 0) + 1} · attempt ${call.attemptIndex + 1}`,
                }),
                createElement('span', {
                  text: `${formatTraceDuration(call.durationMs)} · ${formatTraceCallUsage(call.usage)} · ${call.pricing.status === 'known' && call.pricing.costUsd != null ? `$${call.pricing.costUsd.toFixed(6)}` : 'cost unknown'}`,
                }),
                ...(call.finishReason ? [createElement('span', { text: `Finish reason: ${call.finishReason}` })] : []),
              ]),
            ),
            trace.omittedModelCallCount,
          ),
          createTraceDetails(
            'Tool calls',
            trace.toolCalls.map((call) =>
              createElement('article', {}, [
                createElement('strong', { text: call.toolName }),
                createElement('span', {
                  text: `${call.outcome} · ${call.handlerKind}${call.handlerName ? ` · ${call.handlerName}` : ''}`,
                }),
                createElement('span', { text: formatTraceDuration(call.durationMs) }),
              ]),
            ),
            trace.omittedToolCallCount,
          ),
        ]);
  return createElement(
    'div',
    {
      className: 'rivet-agent-response-inspector-backdrop',
      onClick: (event: MouseEvent) => event.target === event.currentTarget && onClose(),
    },
    [
      createElement(
        'section',
        {
          'aria-label': 'Response inspector',
          'aria-modal': 'true',
          className: 'rivet-agent-response-inspector',
          role: 'dialog',
        },
        [
          createElement('header', {}, [
            createElement('div', {}, [
              createElement('strong', { text: 'Response inspector' }),
              createElement('span', { text: 'Execution metadata only' }),
            ]),
            createElement('button', {
              'aria-label': 'Close response inspector',
              className: 'rivet-agent-response-inspector-close',
              onClick: onClose,
              text: '×',
              type: 'button',
            }),
          ]),
          body,
        ],
      ),
    ],
  );
}

function createTraceDetails(title: string, rows: HTMLElement[], omitted: number): HTMLElement {
  const details = createElement('details', { className: 'rivet-agent-response-inspector-section' }, [
    createElement('summary', { text: title }),
    createElement(
      'div',
      {},
      rows.length ? rows : [createElement('p', { text: `No ${title.toLowerCase()} recorded.` })],
    ),
    ...(omitted > 0 ? [createElement('p', { text: `${omitted} additional rows omitted by the trace limit.` })] : []),
  ]) as HTMLDetailsElement;
  details.open = true;
  return details;
}

function formatTraceDuration(value: number | undefined): string {
  return value == null ? 'Unavailable' : `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} sec`;
}

function formatTraceTokens(value: number | undefined): string {
  return value == null ? 'Not reported' : new Intl.NumberFormat().format(value);
}

function formatTraceCallUsage(usage: AgentResponseTrace['modelCalls'][number]['usage']): string {
  if (usage == null) return 'usage not reported';
  const parts = [
    usage.promptTokens == null ? undefined : `${formatTraceTokens(usage.promptTokens)} in`,
    usage.completionTokens == null ? undefined : `${formatTraceTokens(usage.completionTokens)} out`,
    usage.cachedTokens == null ? undefined : `${formatTraceTokens(usage.cachedTokens)} cached`,
    usage.reasoningTokens == null ? undefined : `${formatTraceTokens(usage.reasoningTokens)} reasoning`,
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(', ') : 'usage not reported';
}

type ChatPresentationState = {
  activeMatchIndex: number;
  messageMenu?: {
    messageIndex: number;
    x: number;
    y: number;
  };
  readingMessageContent?: string;
  inspectedTrace?: AgentResponseTrace | null;
  isMenuOpen: boolean;
  isPinsOpen: boolean;
  isSearchOpen: boolean;
  query: string;
};

type ChatScrollRenderState = {
  activeSearchMatchIndex: number;
  isRunning: boolean;
  isSearchOpen: boolean;
  messageCount: number;
  messagesState: unknown;
  searchQuery: string;
};

const browserGlobals = globalThis as typeof globalThis & {
  DOMPurify?: DomPurifyApi;
  marked?: MarkedApi;
};

const CHAT_SEARCH_ICON_PATH = 'm20 20-4.05-4.05m0 0a7 7 0 1 0-9.9-9.9 7 7 0 0 0 9.9 9.9z';
const CROSS_ICON_PATH = 'M12 12 6 6m6 6 6 6m-6-6 6-6m-6 6-6 6';
const CHEVRON_LEFT_ICON_PATH = 'm14 7-5 5 5 5';
const CHEVRON_RIGHT_ICON_PATH = 'm10 7 5 5-5 5';
const CHAT_SEND_ICON_PATH = 'M12 19V5m0 0 5 5m-5-5-5 5';
const PIN_ICON_PATH =
  'm4 20 5-5m0 0 3.956 3.956a1 1 0 0 0 1.626-.314l2.255-5.261a1 1 0 0 1 .548-.535l3.207-1.283a1 1 0 0 0 .336-1.635l-6.856-6.856a1 1 0 0 0-1.635.336l-1.283 3.207a1 1 0 0 1-.535.548L5.358 9.418a1 1 0 0 0-.314 1.626L9 15z';
const MORE_MENU_ICON_PATH = 'M5 12h.01M12 12h.01M19 12h.01';

function isChatSearchShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey'>): boolean {
  if (event.altKey || !(event.ctrlKey || event.metaKey)) {
    return false;
  }

  return event.key.toLowerCase() === 'f' || event.code === 'KeyF';
}

function createLineIcon(pathData: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('focusable', 'false');
  icon.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-width', '2');
  icon.append(path);
  return icon;
}

function createChatDateSeparator(presentation: UiGraphChatMessageTimestampPresentation): HTMLDivElement {
  return createElement(
    'div',
    { className: 'rivet-web-app-chat-date-separator', 'data-rivet-chat-search-ignore': 'true', role: 'separator' },
    [createElement('time', { dateTime: presentation.dateTime, text: presentation.label })],
  );
}

export function mountRivetWebApp(root: HTMLElement, config: WebAppClientConfig): void {
  let revisionMismatch = false;
  let disposeOutputResizeObservers = () => {};
  const chatPresentationStates = new Map<string, ChatPresentationState>();
  let chatScrollRenderStates = new Map<string, ChatScrollRenderState>();
  const interactionController = createUiGraphInteractionController(config.uiGraph, {
    initialState: { ...config.initialState, ...loadUiGraphChatPersistentState(config.uiGraph) },
  });
  let actionRunner = createHostedActionRunner(config);
  let nextStorageAction = 0;
  const appliedStorageActionByKey = new Map<string, number>();
  let isRestoringChatState = false;
  let restoreActionRunnerFromPageCache = false;

  const getChatPresentationState = (componentId: string): ChatPresentationState => {
    let state = chatPresentationStates.get(componentId);
    if (!state) {
      state = {
        activeMatchIndex: 0,
        isMenuOpen: false,
        isPinsOpen: false,
        isSearchOpen: false,
        query: '',
      };
      chatPresentationStates.set(componentId, state);
    }
    return state;
  };

  const schedule = (callback: () => void): void => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(callback);
    } else {
      window.setTimeout(callback, 0);
    }
  };

  const focusChatSearchInput = (componentId: string): void => {
    schedule(() => {
      for (const input of root.querySelectorAll<HTMLInputElement>('.rivet-web-app-chat-search-input')) {
        if (input.dataset.rivetFocusComponentId === `chat-search-${componentId}`) {
          input.focus();
          return;
        }
      }
    });
  };

  const focusChatSearchButton = (componentId: string): void => {
    schedule(() => {
      for (const button of root.querySelectorAll<HTMLButtonElement>('.rivet-web-app-chat-search-button')) {
        if (button.dataset.rivetChatSearchComponentId === componentId) {
          button.focus();
          return;
        }
      }
    });
  };

  const focusChatReadingViewCloseButton = (componentId: string): void => {
    schedule(() => {
      for (const button of root.querySelectorAll<HTMLButtonElement>('.rivet-web-app-chat-reading-view-close')) {
        if (button.dataset.rivetChatReadingViewComponentId === componentId) {
          button.focus();
          return;
        }
      }
    });
  };

  root.addEventListener(
    'pointerdown',
    (event) => {
      for (const dropdown of root.querySelectorAll<HTMLElement>('.rivet-web-app-hosted-dropdown.open')) {
        if (!dropdown.contains(event.target as Node)) {
          dropdown.classList.remove('open', 'menu-open-up');
          dropdown.querySelector('.rivet-web-app-hosted-dropdown-menu')?.remove();
          const button = dropdown.querySelector<HTMLButtonElement>('.rivet-web-app-hosted-dropdown-button');
          button?.setAttribute('aria-expanded', 'false');
          button?.removeAttribute('aria-activedescendant');
        }
      }
      for (const menu of root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-menu-anchor')) {
        if (menu.contains(event.target as Node)) continue;
        const componentId = menu.dataset.rivetChatMenuComponentId;
        const chatState = componentId ? chatPresentationStates.get(componentId) : undefined;
        if (chatState?.isMenuOpen) {
          chatState.isMenuOpen = false;
          menu.querySelector('.rivet-web-app-chat-menu')?.remove();
          menu
            .querySelector<HTMLButtonElement>('.rivet-web-app-chat-menu-button')
            ?.setAttribute('aria-expanded', 'false');
        }
      }
      for (const menu of root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-message-context-menu')) {
        if (menu.contains(event.target as Node)) continue;
        const componentId = menu.dataset.rivetChatMessageMenuComponentId;
        const chatState = componentId ? chatPresentationStates.get(componentId) : undefined;
        if (chatState?.messageMenu) {
          chatState.messageMenu = undefined;
          menu.remove();
        }
      }
    },
    true,
  );

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

  const renderMarkdownElement = (value: string, className: string, enhanceJsonBlocks = false): HTMLDivElement => {
    const element = createElement('div', { className });
    element.innerHTML = renderMarkdown(value);
    if (enhanceJsonBlocks) {
      enhanceUiGraphChatJsonCodeBlocks(element, config.uiGraph.name);
    }
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

  const resetApp = (): void => {
    revisionMismatch = false;
    chatPresentationStates.clear();
    chatScrollRenderStates.clear();
    const chatState = getUiGraphChatPersistentState(config.uiGraph, interactionController.getSnapshot().state);
    isRestoringChatState = true;
    interactionController.reset();
    if (Object.keys(chatState).length > 0) {
      interactionController.updateStatePatch(chatState);
    }
    isRestoringChatState = false;
    saveUiGraphChatPersistentState(config.uiGraph, interactionController.getSnapshot().state);
    render();
  };

  const runAction = async (component: UiGraphActionComponent): Promise<void> => {
    revisionMismatch = false;
    await interactionController.runAction(
      component,
      async ({ abortOtherActions, componentId, reportProgress, signal, state }) => {
        const storageAction = ++nextStorageAction;
        try {
          const result = await actionRunner.run({
            componentId,
            onProgress: reportProgress,
            revisionKey: config.revisionKey,
            signal,
            state,
            storage: loadUiGraphWebAppStorage(config.uiGraph),
          });
          signal.throwIfAborted();
          if (result.storagePatch && Object.keys(result.storagePatch).length > 0) {
            applyUiGraphWebAppStorageActionPatch(
              result.storagePatch,
              storageAction,
              appliedStorageActionByKey,
              (applicablePatch) =>
                applyUiGraphWebAppStoragePatch(
                  config.uiGraph,
                  loadUiGraphWebAppStorage(config.uiGraph),
                  applicablePatch,
                ),
            );
          }
          if (component.type === 'chat' && component.allowResponseInspection && result.responseTrace) {
            saveUiGraphResponseTrace(config.uiGraph, component.id, result.responseTrace);
          }
          return { statePatch: result.statePatch, responseTrace: result.responseTrace };
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
          refreshOutputComponents(renderModel.component.stateKey);
        });
        content = createElement('label', { className: 'rivet-web-app-field' }, [
          createElement('span', { text: renderModel.label }),
          control,
        ]);
        break;
      }
      case 'dropdown': {
        const wrapper = createElement('div', {
          className: 'rivet-web-app-dropdown rivet-web-app-hosted-dropdown',
          'data-rivet-dropdown-value': renderModel.value,
        });
        const menuId = `rivet-web-app-dropdown-${renderModel.component.id}`;
        const button = createElement('button', {
          'aria-controls': menuId,
          'aria-expanded': 'false',
          'aria-haspopup': 'listbox',
          'aria-label': renderModel.label,
          className: 'rivet-web-app-hosted-dropdown-button',
          'data-rivet-focus-component-id': renderModel.component.id,
          'data-value': renderModel.value,
          type: 'button',
        }) as HTMLButtonElement;
        const selectedItem = renderModel.items.find((item) => item.value === renderModel.value);
        button.append(
          createElement('span', {
            text: selectedItem?.label ?? (renderModel.items.length === 0 ? 'No options available' : 'Select an option'),
          }),
          createElement('span', { 'aria-hidden': 'true', className: 'rivet-web-app-dropdown-chevron' }),
        );
        button.disabled = renderModel.items.length === 0;
        const menu = createElement('div', {
          'aria-label': renderModel.label,
          className: 'rivet-web-app-hosted-dropdown-menu',
          id: menuId,
          role: 'listbox',
        });
        const selectedIndex = Math.max(
          0,
          renderModel.items.findIndex((item) => item.value === renderModel.value),
        );
        let activeIndex = selectedIndex;
        const optionButtons: HTMLButtonElement[] = [];
        const updateActiveOption = (index: number, focus = false): void => {
          activeIndex = Math.max(0, Math.min(index, optionButtons.length - 1));
          optionButtons.forEach((option, optionIndex) =>
            option.classList.toggle('is-focused', optionIndex === activeIndex),
          );
          button.setAttribute('aria-activedescendant', `${menuId}-option-${activeIndex}`);
          const activeOption = optionButtons[activeIndex];
          if (focus) {
            activeOption?.focus();
          }
          if (typeof activeOption?.scrollIntoView === 'function') {
            activeOption.scrollIntoView({ block: 'nearest' });
          }
        };
        const updatePlacement = (): void => {
          const rect = wrapper.getBoundingClientRect();
          const availableBelow = window.innerHeight - rect.bottom;
          const availableAbove = rect.top;
          const menuHeight = Math.min(220, renderModel.items.length * 30 + 8);
          wrapper.classList.toggle(
            'menu-open-up',
            availableBelow < Math.min(menuHeight, 160) && availableAbove > availableBelow,
          );
        };
        const setOpen = (isOpen: boolean, nextActiveIndex = selectedIndex, focus = false): void => {
          wrapper.classList.toggle('open', isOpen);
          button.setAttribute('aria-expanded', `${isOpen}`);
          if (isOpen) {
            wrapper.append(menu);
            updatePlacement();
            updateActiveOption(nextActiveIndex, focus);
          } else {
            wrapper.classList.remove('menu-open-up');
            button.removeAttribute('aria-activedescendant');
            menu.remove();
          }
        };
        const selectOption = (index: number): void => {
          const item = renderModel.items[index];
          if (!item) return;
          interactionController.updateState(renderModel.component.stateKey, item.value);
          refreshOutputComponents(renderModel.component.stateKey);
          setOpen(false);
          button.focus();
        };
        button.addEventListener('click', () => {
          const wasOpen = wrapper.classList.contains('open');
          setOpen(!wasOpen, activeIndex, !wasOpen);
        });
        button.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true, wrapper.classList.contains('open') ? activeIndex + 1 : selectedIndex + 1, true);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true, wrapper.classList.contains('open') ? activeIndex - 1 : selectedIndex - 1, true);
          } else if (event.key === 'Home') {
            event.preventDefault();
            setOpen(true, 0, true);
          } else if (event.key === 'End') {
            event.preventDefault();
            setOpen(true, optionButtons.length - 1, true);
          } else if (event.key === 'Escape') {
            setOpen(false);
          }
        });
        renderModel.items.forEach((item, index) => {
          const option = createElement('button', {
            'aria-selected': `${item.value === renderModel.value}`,
            className: 'rivet-web-app-hosted-dropdown-option',
            'data-value': item.value,
            id: `${menuId}-option-${index}`,
            role: 'option',
            text: item.label,
            type: 'button',
          });
          option.addEventListener('focus', () => {
            updateActiveOption(index);
          });
          option.addEventListener('mousemove', () => {
            updateActiveOption(index);
          });
          option.addEventListener('click', () => {
            selectOption(index);
          });
          option.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              updateActiveOption(activeIndex + 1, true);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              updateActiveOption(activeIndex - 1, true);
            } else if (event.key === 'Home') {
              event.preventDefault();
              updateActiveOption(0, true);
            } else if (event.key === 'End') {
              event.preventDefault();
              updateActiveOption(optionButtons.length - 1, true);
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectOption(index);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              button.focus();
            }
          });
          optionButtons.push(option);
          menu.append(option);
        });
        wrapper.append(button);
        content = createElement('div', { className: 'rivet-web-app-field' }, [
          createElement('span', { text: renderModel.label }),
          wrapper,
        ]);
        break;
      }
      case 'button': {
        const isLoading = interaction.loadingComponentIds.has(renderModel.component.id);
        const button = createElement(
          'button',
          {
            'aria-busy': isLoading,
            'aria-label': isLoading ? `${renderModel.label} (running)` : undefined,
            className: 'rivet-web-app-button',
            onClick: () => void runAction(renderModel.component),
            text: isLoading ? renderModel.label : undefined,
            type: 'button',
          },
          isLoading
            ? [createElement('span', { 'aria-hidden': 'true', className: 'rivet-web-app-running-indicator' })]
            : [],
        );
        if (!isLoading) {
          button.textContent = renderModel.label;
        }
        (button as HTMLButtonElement).disabled = isLoading;
        const actionChildren: Node[] = [button];
        if (isLoading) {
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
          { className: `rivet-web-app-action-stack${isLoading ? ' rivet-web-app-action-stack-running' : ''}` },
          actionChildren,
        );
        break;
      }
      case 'chat': {
        const componentId = String(renderModel.component.id);
        const isRunning = interaction.runningComponentIds.has(renderModel.component.id);
        const hasMessages = renderModel.messages.length > 0;
        const searchState = getChatPresentationState(componentId);
        if (!hasMessages) {
          searchState.isSearchOpen = false;
          searchState.isPinsOpen = false;
          searchState.messageMenu = undefined;
          searchState.readingMessageContent = undefined;
          searchState.query = '';
          searchState.activeMatchIndex = 0;
        }
        if (renderModel.pins.length === 0) {
          searchState.isPinsOpen = false;
        }
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
        const pinnedMessageIndexes = new Set(renderModel.pins.map((pin) => pin.messageIndex));
        const togglePin = (messageIndex: number) => {
          const statePatch = createUiGraphChatPinStatePatch(
            renderModel.component.id,
            interactionController.getSnapshot().state,
            messageIndex,
          );
          if (statePatch) {
            interactionController.updateStatePatch(statePatch);
            render();
          }
        };
        const openMessageContextMenu = (messageIndex: number, event: MouseEvent) => {
          event.preventDefault();
          searchState.isMenuOpen = false;
          searchState.isSearchOpen = false;
          const margin = 8;
          const menuWidth = 196;
          const menuHeight =
            renderModel.messages[messageIndex]?.role === 'assistant'
              ? renderModel.component.allowResponseInspection
                ? 108
                : 76
              : 44;
          searchState.messageMenu = {
            messageIndex,
            x: Math.min(event.clientX, Math.max(margin, globalThis.innerWidth - menuWidth - margin)),
            y: Math.min(event.clientY, Math.max(margin, globalThis.innerHeight - menuHeight - margin)),
          };
          render();
        };
        const openSelectedMessageInReadingView = () => {
          const messageIndex = searchState.messageMenu?.messageIndex;
          searchState.messageMenu = undefined;
          const message = messageIndex == null ? undefined : renderModel.messages[messageIndex];
          if (message?.role !== 'assistant') return;
          searchState.readingMessageContent = message.content;
          render();
          focusChatReadingViewCloseButton(componentId);
        };
        const closeReadingView = () => {
          searchState.readingMessageContent = undefined;
          render();
        };
        const inspectSelectedResponse = () => {
          const messageIndex = searchState.messageMenu?.messageIndex;
          searchState.messageMenu = undefined;
          const message = messageIndex == null ? undefined : renderModel.messages[messageIndex];
          searchState.inspectedTrace =
            message?.role === 'assistant' && typeof message.responseTraceId === 'string'
              ? loadUiGraphResponseTrace(config.uiGraph, component.id, message.responseTraceId) ?? null
              : null;
          render();
        };
        const closeResponseInspector = () => {
          searchState.inspectedTrace = undefined;
          render();
        };
        const removeSelectedMessage = () => {
          const messageIndex = searchState.messageMenu?.messageIndex;
          searchState.messageMenu = undefined;
          if (messageIndex == null) return;
          const statePatch = createUiGraphChatMessageRemovalStatePatch(
            renderModel.component.id,
            interactionController.getSnapshot().state,
            messageIndex,
          );
          if (statePatch) {
            interactionController.updateStatePatch(statePatch);
          }
          render();
        };
        const messagePresentations = getUiGraphChatMessagePresentations(renderModel.messages);
        const messageNodes = renderModel.messages
          .map((message, messageIndex) => {
            const messagePresentation = messagePresentations[messageIndex];
            const messageContent = renderMarkdownElement(
              message.content,
              'rivet-web-app-chat-message-markdown markdown-body',
              true,
            );
            const messageElement = createElement(
              'div',
              {
                className: `rivet-web-app-chat-message rivet-web-app-chat-message-${message.role}${
                  searchState.messageMenu?.messageIndex === messageIndex
                    ? ' rivet-web-app-chat-message-context-selected'
                    : ''
                }`,
                onContextMenu: (event: MouseEvent) => openMessageContextMenu(messageIndex, event),
              },
              [
                messageContent,
                ...(messagePresentation?.timestamp
                  ? [
                      createElement('time', {
                        className: 'rivet-web-app-chat-message-time',
                        'data-rivet-chat-search-ignore': 'true',
                        dateTime: messagePresentation.timestamp.dateTime,
                        text: messagePresentation.timestamp.label,
                        title: [
                          messagePresentation.timestamp.dateTime,
                          messagePresentation.timestamp.elapsedSincePreviousUserMessage,
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      }),
                    ]
                  : []),
              ],
            );
            if (message.role === 'user') {
              messageElement.dataset.rivetChatMessageIndex = String(messageIndex);
              return messagePresentation?.dateSeparator
                ? [createChatDateSeparator(messagePresentation.dateSeparator), messageElement]
                : [messageElement];
            }

            const pinned = pinnedMessageIndexes.has(messageIndex);
            const pinButton = createElement(
              'button',
              {
                'aria-label': pinned ? 'Unpin response' : 'Pin response',
                'aria-pressed': `${pinned}`,
                className: `rivet-web-app-chat-pin-button${pinned ? ' active' : ''}`,
                onClick: () => togglePin(messageIndex),
                title: pinned ? 'Unpin response' : 'Pin response',
                type: 'button',
              },
              [createLineIcon(PIN_ICON_PATH)],
            );
            const messageRow = createElement(
              'div',
              {
                className: 'rivet-web-app-chat-message-row',
                'data-rivet-chat-message-index': String(messageIndex),
              },
              [messageElement, pinButton],
            );
            return messagePresentation?.dateSeparator
              ? [createChatDateSeparator(messagePresentation.dateSeparator), messageRow]
              : [messageRow];
          })
          .flat();
        if (messageNodes.length === 0) {
          messageNodes.push(
            createElement('div', { className: 'rivet-web-app-chat-empty' }, [
              createElement('strong', { text: 'Start a conversation' }),
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

        const messagesElement = createElement(
          'div',
          {
            'aria-live': 'polite',
            'aria-relevant': 'additions text',
            className: 'rivet-web-app-chat-messages',
            'data-rivet-chat-component-id': componentId,
            role: 'log',
          },
          messageNodes,
        );
        const searchResult = searchState.isSearchOpen
          ? highlightUiGraphChatSearchMatches(messagesElement, searchState.query, searchState.activeMatchIndex)
          : (clearUiGraphChatSearchMatches(messagesElement), { activeIndex: -1, matches: [] as HTMLElement[] });
        searchState.activeMatchIndex = searchResult.activeIndex < 0 ? 0 : searchResult.activeIndex;

        const closeSearch = () => {
          searchState.isSearchOpen = false;
          searchState.query = '';
          searchState.activeMatchIndex = 0;
          render();
          focusChatSearchButton(componentId);
        };
        const openSearch = () => {
          if (!hasMessages) return;
          searchState.isMenuOpen = false;
          searchState.isPinsOpen = false;
          searchState.messageMenu = undefined;
          searchState.isSearchOpen = true;
          searchState.activeMatchIndex = 0;
          render();
          focusChatSearchInput(componentId);
        };
        const togglePins = () => {
          searchState.isMenuOpen = false;
          searchState.messageMenu = undefined;
          searchState.isSearchOpen = false;
          searchState.isPinsOpen = !searchState.isPinsOpen;
          render();
        };
        const toggleMenu = () => {
          searchState.isSearchOpen = false;
          searchState.messageMenu = undefined;
          searchState.isMenuOpen = !searchState.isMenuOpen;
          render();
        };
        const flushChatHistory = () => {
          searchState.isMenuOpen = false;
          searchState.isPinsOpen = false;
          searchState.messageMenu = undefined;
          interactionController.updateStatePatch(createUiGraphChatHistoryFlushStatePatch(renderModel.component.id));
          render();
        };
        const moveSearchMatch = (direction: -1 | 1) => {
          if (searchResult.matches.length === 0) return;
          searchState.activeMatchIndex += direction;
          render();
        };
        const createSearchNavigationButton = (label: string, direction: -1 | 1, iconPath: string) => {
          const button = createElement(
            'button',
            {
              'aria-label': label,
              className: 'rivet-web-app-chat-search-navigation-button',
              onClick: () => moveSearchMatch(direction),
              type: 'button',
            },
            [createLineIcon(iconPath)],
          ) as HTMLButtonElement;
          button.disabled = searchResult.matches.length === 0;
          return button;
        };
        const searchPanel = searchState.isSearchOpen
          ? createElement('div', { className: 'rivet-web-app-chat-search', role: 'search' }, [
              createElement('input', {
                'aria-label': 'Search chat messages',
                className: 'rivet-web-app-chat-search-input',
                'data-rivet-focus-component-id': `chat-search-${componentId}`,
                placeholder: 'Search chat',
                type: 'search',
                value: searchState.query,
              }),
              createElement('span', {
                'aria-live': 'polite',
                className: 'rivet-web-app-chat-search-count',
                text:
                  searchResult.matches.length === 0
                    ? '0\u2009/\u20090'
                    : `${searchResult.activeIndex + 1}\u2009/\u2009${searchResult.matches.length}`,
              }),
              createElement('span', { className: 'rivet-web-app-chat-search-navigation' }, [
                createSearchNavigationButton('Previous chat search result', -1, CHEVRON_LEFT_ICON_PATH),
                createSearchNavigationButton('Next chat search result', 1, CHEVRON_RIGHT_ICON_PATH),
              ]),
              createElement(
                'button',
                {
                  'aria-label': 'Close chat search',
                  className: 'rivet-web-app-chat-search-close-button',
                  onClick: closeSearch,
                  title: 'Close chat search',
                  type: 'button',
                },
                [createLineIcon(CROSS_ICON_PATH)],
              ),
            ])
          : undefined;
        const searchInput = searchPanel?.querySelector<HTMLInputElement>('.rivet-web-app-chat-search-input');
        searchInput?.addEventListener('input', () => {
          searchState.query = searchInput.value;
          searchState.activeMatchIndex = 0;
          render();
        });
        searchInput?.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeSearch();
          } else if (event.key === 'Enter' && searchState.query.trim()) {
            event.preventDefault();
            moveSearchMatch(event.shiftKey ? -1 : 1);
          }
        });

        const pinsPanel = searchState.isPinsOpen
          ? createElement(
              'div',
              { 'aria-label': 'Pinned responses', className: 'rivet-web-app-chat-pins', role: 'region' },
              renderModel.pins.map((pin) => {
                const exchanges: Node[] = [];
                if (pin.prompt) {
                  exchanges.push(
                    createElement('div', { className: 'rivet-web-app-chat-pin-exchange' }, [
                      createElement('strong', { text: 'You asked' }),
                      renderMarkdownElement(pin.prompt.content, 'rivet-web-app-chat-pin-markdown markdown-body'),
                    ]),
                  );
                }
                exchanges.push(
                  createElement('div', { className: 'rivet-web-app-chat-pin-exchange' }, [
                    createElement('strong', { text: 'Response' }),
                    renderMarkdownElement(pin.response.content, 'rivet-web-app-chat-pin-markdown markdown-body'),
                  ]),
                );
                return createElement('div', { className: 'rivet-web-app-chat-pin' }, [
                  createElement('button', {
                    'aria-label': 'Show pinned response in conversation',
                    className: 'rivet-web-app-chat-pin-reveal',
                    onClick: () => {
                      const messageIndex = pin.promptMessageIndex ?? pin.messageIndex;
                      const message = messagesElement.querySelector<HTMLElement>(
                        `[data-rivet-chat-message-index="${messageIndex}"]`,
                      );
                      revealUiGraphChatElement(messagesElement, message ?? undefined, 'start');
                    },
                    title: 'Show pinned response in conversation',
                    type: 'button',
                  }),
                  ...exchanges,
                ]);
              }),
            )
          : undefined;

        const textarea = createElement('textarea', {
          'aria-label': 'Message',
          'data-rivet-chat-component-id': renderModel.component.id,
          'data-rivet-focus-component-id': renderModel.component.id,
          placeholder: renderModel.component.placeholder || 'Message...',
          rows: '1',
        });
        textarea.value = renderModel.draft;
        const sendButton = createElement('button', {
          'aria-label': isRunning ? 'Stop response' : 'Send message',
          className: `rivet-web-app-chat-send${isRunning ? ' rivet-web-app-chat-stop' : ''}`,
          title: isRunning ? 'Stop response' : 'Send message',
          type: isRunning ? 'button' : 'submit',
        });
        if (isRunning) {
          sendButton.append(
            createElement('span', { 'aria-hidden': 'true', className: 'rivet-web-app-chat-stop-icon' }),
          );
          sendButton.addEventListener('click', () => interactionController.cancelAction(renderModel.component.id));
        } else {
          sendButton.append(createLineIcon(CHAT_SEND_ICON_PATH));
          sendButton.disabled = !renderModel.draft.trim();
        }
        textarea.addEventListener('input', () => {
          interactionController.updateState(getUiGraphChatDraftStateKey(renderModel.component.id), textarea.value);
          if (!isRunning) {
            sendButton.disabled = !textarea.value.trim();
          }
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
        const headerActions: Node[] = [];
        if (renderModel.pins.length > 0) {
          headerActions.push(
            createElement(
              'button',
              {
                'aria-label': `${searchState.isPinsOpen ? 'Hide' : 'Show'} ${renderModel.pins.length} pinned ${renderModel.pins.length === 1 ? 'response' : 'responses'}`,
                'aria-pressed': `${searchState.isPinsOpen}`,
                className: 'rivet-web-app-chat-pins-button',
                onClick: togglePins,
                title: searchState.isPinsOpen ? 'Hide pinned responses' : 'Show pinned responses',
                type: 'button',
              },
              [createLineIcon(PIN_ICON_PATH), createElement('span', { text: String(renderModel.pins.length) })],
            ),
          );
        }
        if (hasMessages) {
          headerActions.push(
            createElement(
              'button',
              {
                'aria-label': searchState.isSearchOpen ? 'Close chat search' : 'Search chat',
                'aria-pressed': `${searchState.isSearchOpen}`,
                className: 'rivet-web-app-chat-search-button',
                'data-rivet-chat-search-component-id': componentId,
                onClick: () => (searchState.isSearchOpen ? closeSearch() : openSearch()),
                title: searchState.isSearchOpen ? 'Close chat search' : 'Search chat',
                type: 'button',
              },
              [createLineIcon(CHAT_SEARCH_ICON_PATH)],
            ),
          );
        }
        const readingView =
          searchState.readingMessageContent == null
            ? undefined
            : createElement(
                'div',
                {
                  className: 'rivet-web-app-modal-backdrop rivet-web-app-chat-reading-view-backdrop',
                  onClick: (event: MouseEvent) => {
                    if (event.target === event.currentTarget) closeReadingView();
                  },
                },
                [
                  createElement(
                    'section',
                    {
                      'aria-label': 'Assistant message',
                      'aria-modal': 'true',
                      className: 'rivet-web-app-chat-reading-view',
                      role: 'dialog',
                    },
                    [
                      createElement('header', { className: 'rivet-web-app-chat-reading-view-header' }, [
                        createElement('strong', { text: 'Assistant message' }),
                        createElement(
                          'button',
                          {
                            'aria-label': 'Close reading view',
                            className: 'rivet-web-app-chat-reading-view-close',
                            'data-rivet-chat-reading-view-component-id': componentId,
                            onClick: closeReadingView,
                            title: 'Close reading view',
                            type: 'button',
                          },
                          [createLineIcon(CROSS_ICON_PATH)],
                        ),
                      ]),
                      renderMarkdownElement(
                        searchState.readingMessageContent,
                        'rivet-web-app-chat-message-markdown rivet-web-app-chat-reading-view-markdown markdown-body',
                        true,
                      ),
                    ],
                  ),
                ],
              );
        const chatChildren: Node[] = [
          createElement('div', { className: 'rivet-web-app-chat-header' }, [
            createElement('span', { className: 'rivet-web-app-chat-title' }, [
              createElement('span', { text: 'Chat' }),
              createElement(
                'span',
                {
                  className: 'rivet-web-app-chat-menu-anchor',
                  'data-rivet-chat-menu-component-id': componentId,
                },
                [
                  createElement(
                    'button',
                    {
                      'aria-expanded': `${searchState.isMenuOpen}`,
                      'aria-haspopup': 'menu',
                      'aria-label': 'Chat options',
                      className: 'rivet-web-app-chat-menu-button',
                      onClick: toggleMenu,
                      title: 'Chat options',
                      type: 'button',
                    },
                    [createLineIcon(MORE_MENU_ICON_PATH)],
                  ),
                  ...(searchState.isMenuOpen
                    ? [
                        createElement('span', { className: 'rivet-web-app-chat-menu', role: 'menu' }, [
                          createElement('button', {
                            onClick: flushChatHistory,
                            role: 'menuitem',
                            text: 'Flush chat history',
                            type: 'button',
                          }),
                        ]),
                      ]
                    : []),
                ],
              ),
            ]),
            createElement('span', { className: 'rivet-web-app-chat-header-actions' }, headerActions),
          ]),
          createElement('div', { className: 'rivet-web-app-chat-history' }, [
            ...(pinsPanel ? [pinsPanel] : searchPanel ? [searchPanel] : []),
            messagesElement,
          ]),
          ...(searchState.messageMenu
            ? [
                createElement(
                  'div',
                  {
                    'data-rivet-chat-message-menu-component-id': componentId,
                    className: 'rivet-web-app-chat-message-context-menu',
                    role: 'menu',
                    style: `left: ${searchState.messageMenu.x}px; top: ${searchState.messageMenu.y}px;`,
                  },
                  [
                    ...(renderModel.messages[searchState.messageMenu.messageIndex]?.role === 'assistant'
                      ? [
                          createElement('button', {
                            onClick: openSelectedMessageInReadingView,
                            role: 'menuitem',
                            text: 'Open in reading view',
                            type: 'button',
                          }),
                        ]
                      : []),
                    ...(renderModel.component.allowResponseInspection &&
                    renderModel.messages[searchState.messageMenu.messageIndex]?.role === 'assistant'
                      ? [
                          createElement('button', {
                            onClick: inspectSelectedResponse,
                            role: 'menuitem',
                            text: 'Inspect response',
                            type: 'button',
                          }),
                        ]
                      : []),
                    createElement('button', {
                      onClick: removeSelectedMessage,
                      role: 'menuitem',
                      text: 'Remove message',
                      type: 'button',
                    }),
                  ],
                ),
              ]
            : []),
          ...(readingView ? [readingView] : []),
          ...(searchState.inspectedTrace !== undefined
            ? [createResponseInspectorElement(searchState.inspectedTrace, closeResponseInspector)]
            : []),
        ];
        if (actionError) {
          chatChildren.push(
            createElement('div', { className: 'rivet-web-app-chat-error', role: 'alert', text: actionError }),
          );
        }
        const chatProgress = renderActionProgress(interaction.actionProgress[renderModel.component.id]);
        if (chatProgress) chatChildren.push(chatProgress);
        chatChildren.push(composer);
        const chat = createElement('section', { className: 'rivet-web-app-chat' }, chatChildren);
        chat.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && searchState.inspectedTrace !== undefined) {
            event.preventDefault();
            closeResponseInspector();
            return;
          }
          if (event.key === 'Escape' && searchState.readingMessageContent != null) {
            event.preventDefault();
            closeReadingView();
            return;
          }
          if (event.key === 'Escape' && searchState.messageMenu) {
            event.preventDefault();
            searchState.messageMenu = undefined;
            render();
            return;
          }
          if (event.key === 'Escape' && searchState.isMenuOpen) {
            event.preventDefault();
            searchState.isMenuOpen = false;
            render();
            return;
          }
          if (hasMessages && isChatSearchShortcut(event)) {
            event.preventDefault();
            openSearch();
          }
        });
        content = chat;
        break;
      }
      case 'output': {
        const { output } = renderModel;
        const isCollapsed = output.hasValue && interaction.collapsedOutputComponentIds.has(renderModel.component.id);
        const header = output.hasValue
          ? createElement(
              'button',
              {
                'aria-expanded': `${!isCollapsed}`,
                'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${renderModel.label}`,
                className: 'rivet-web-app-output-header rivet-web-app-output-toggle',
                onClick: () => interactionController.toggleOutputCollapsed(renderModel.component.id),
                title: isCollapsed ? 'Expand output' : 'Collapse output',
                type: 'button',
              },
              [
                createElement('span', { className: 'rivet-web-app-output-title', text: renderModel.label }),
                createElement('span', {
                  'aria-hidden': 'true',
                  className: `rivet-web-app-output-toggle-icon${isCollapsed ? ' collapsed' : ''}`,
                }),
              ],
            )
          : createElement('div', { className: 'rivet-web-app-output-header' }, [
              createElement('div', { className: 'rivet-web-app-output-title', text: renderModel.label }),
            ]);
        const children: Node[] = [header];
        if (output.hasValue && !isCollapsed) {
          const contentActions: Node[] = [
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
          ];
          if (output.jsonDownloadValue != null) {
            contentActions.push(
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
            createElement('div', { className: 'rivet-web-app-output-content' }, [
              createElement('div', { className: 'rivet-web-app-output-content-actions' }, contentActions),
              createElement('div', { className: 'rivet-web-app-output-content-body' }, [
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
                    : output.renderAs === 'json'
                      ? createProgressiveJsonOutput(output.renderedValue)
                      : createElement('pre', { text: output.renderedValue }),
              ]),
            ]),
          );
        }
        content = createElement(
          'section',
          {
            className: `rivet-web-app-card rivet-web-app-output${output.hasValue ? ' rivet-web-app-output-has-value' : ''}${
              isCollapsed ? ' rivet-web-app-output-collapsed' : ''
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
        'data-rivet-web-app-component-id': component.id,
        'data-rivet-web-app-component-type': component.type,
      },
      [content],
    );
  };

  const refreshOutputComponents = (stateKey: string): void => {
    const interaction = interactionController.getSnapshot();
    const frames = [...root.querySelectorAll<HTMLElement>('[data-rivet-web-app-component-id]')];

    for (const component of config.uiGraph.components) {
      if (component.type !== 'output' || component.stateKey !== stateKey) continue;

      const frame = frames.find((candidate) => candidate.dataset.rivetWebAppComponentId === component.id);
      if (frame) {
        frame.replaceWith(renderComponent(component, interaction));
      }
    }

    disposeOutputResizeObservers();
    disposeOutputResizeObservers = observeOutputResizeBounds(root);
  };

  const render = (): void => {
    const focusedControl = captureFocusedTextControl(root);
    const previousChatScrollTops = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-messages').forEach((messages) => {
      const componentId = messages.dataset.rivetChatComponentId;
      if (componentId) previousChatScrollTops.set(componentId, messages.scrollTop);
    });
    const interaction = interactionController.getSnapshot();
    const surface = createElement('main', { className: 'rivet-web-app-surface' }, [
      createElement('div', { className: 'rivet-web-app-toolbar' }, [
        createElement('button', {
          'aria-label': 'Reset app',
          className: 'rivet-web-app-reset-button',
          onClick: resetApp,
          title: 'Reset app',
          type: 'button',
        }),
      ]),
      ...config.uiGraph.components.map((component) => renderComponent(component, interaction)),
      ...renderErrors(),
    ]);
    disposeOutputResizeObservers();
    root.replaceChildren(surface, ...renderRevisionMismatchModal());
    root.querySelector<HTMLButtonElement>('.rivet-agent-response-inspector-close')?.focus();
    disposeOutputResizeObservers = observeOutputResizeBounds(root);
    const chatMessagesByComponentId = new Map<string, HTMLElement>();
    root.querySelectorAll<HTMLElement>('.rivet-web-app-chat-messages').forEach((messages) => {
      const componentId = messages.dataset.rivetChatComponentId;
      if (componentId) chatMessagesByComponentId.set(componentId, messages);
    });
    const nextChatScrollRenderStates = new Map<string, ChatScrollRenderState>();
    for (const component of config.uiGraph.components) {
      if (component.type !== 'chat') continue;

      const componentId = String(component.id);
      const messages = chatMessagesByComponentId.get(componentId);
      if (!messages) continue;

      const renderModel = getUiGraphComponentRenderModel(component, interaction.state);
      if (renderModel.type !== 'chat') continue;

      const searchState = getChatPresentationState(componentId);
      const nextState = {
        activeSearchMatchIndex: searchState.activeMatchIndex,
        isRunning: interaction.runningComponentIds.has(component.id),
        isSearchOpen: searchState.isSearchOpen,
        messageCount: renderModel.messages.length,
        messagesState: interaction.state[getUiGraphChatMessagesStateKey(component.id)],
        searchQuery: searchState.query,
      };
      const previousState = chatScrollRenderStates.get(componentId);
      const searchTargetChanged =
        !previousState ||
        previousState.activeSearchMatchIndex !== nextState.activeSearchMatchIndex ||
        previousState.isSearchOpen !== nextState.isSearchOpen ||
        previousState.messagesState !== nextState.messagesState ||
        previousState.searchQuery !== nextState.searchQuery;
      const shouldFollowLatest =
        !previousState ||
        previousState.isRunning !== nextState.isRunning ||
        previousState.messageCount !== nextState.messageCount;
      if (searchState.isSearchOpen && searchState.query.trim() && searchTargetChanged) {
        revealUiGraphChatSearchMatch(
          messages,
          messages.querySelector<HTMLElement>('.rivet-web-app-chat-search-match-active') ?? undefined,
        );
      } else if (shouldFollowLatest) {
        messages.scrollTop = messages.scrollHeight;
      } else {
        messages.scrollTop = previousChatScrollTops.get(componentId) ?? messages.scrollHeight;
      }
      nextChatScrollRenderStates.set(componentId, nextState);
    }
    chatScrollRenderStates = nextChatScrollRenderStates;
    if (revisionMismatch) {
      root.querySelector<HTMLButtonElement>('.rivet-web-app-modal-button')?.focus();
    } else if (focusedControl) {
      restoreFocusedTextControl(root, focusedControl);
    }
  };

  let persistedChatState = interactionController.getSnapshot().state;
  saveUiGraphChatPersistentState(config.uiGraph, persistedChatState);
  interactionController.subscribe((change) => {
    const nextState = interactionController.getSnapshot().state;
    if (!isRestoringChatState && hasUiGraphChatPersistentStateChanged(config.uiGraph, persistedChatState, nextState)) {
      saveUiGraphChatPersistentState(config.uiGraph, nextState);
      pruneUiGraphResponseTraces(config.uiGraph, nextState);
    }
    persistedChatState = nextState;
    if (change !== 'state') render();
  });
  window.addEventListener('pagehide', (event) => {
    if (actionRunner.survivesPageDetach) {
      interactionController.detachActions();
    } else {
      interactionController.abortActions();
    }
    actionRunner.dispose();
    disposeOutputResizeObservers();
    restoreActionRunnerFromPageCache = event.persisted;
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !restoreActionRunnerFromPageCache) return;
    actionRunner = createHostedActionRunner(config);
    restoreActionRunnerFromPageCache = false;
    disposeOutputResizeObservers = observeOutputResizeBounds(root);
  });
  render();
}

export function readEmbeddedConfig(root: HTMLElement | null): WebAppClientConfig | undefined {
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
