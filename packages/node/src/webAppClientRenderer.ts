import {
  copyUiGraphText,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphInteractionController,
  downloadUiGraphJsonOutput,
  getUiGraphComponentRenderModel,
  getUiGraphChatDraftStateKey,
  type UiGraphActionComponent,
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

const browserGlobals = globalThis as typeof globalThis & {
  DOMPurify?: DomPurifyApi;
  marked?: MarkedApi;
};

export function mountRivetWebApp(root: HTMLElement, config: WebAppClientConfig): void {
  let revisionMismatch = false;
  let disposeOutputResizeObservers = () => {};
  const interactionController = createUiGraphInteractionController(config.uiGraph, {
    initialState: config.initialState,
  });
  let actionRunner = createHostedActionRunner(config);
  let restoreActionRunnerFromPageCache = false;

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

  const resetApp = (): void => {
    revisionMismatch = false;
    interactionController.reset();
    render();
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
          renderMarkdownElement(
            message.content,
            `rivet-web-app-chat-message rivet-web-app-chat-message-${message.role} rivet-web-app-chat-message-markdown markdown-body`,
          ),
        );
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
    disposeOutputResizeObservers = observeOutputResizeBounds(root);
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
