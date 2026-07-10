import type { ChatV2Provider, RivetPlugin, Settings } from '@valerypopoff/rivet2-core';
import {
  getChatV2DiscoveredModelOptionsWithStatus,
  invalidateChatV2DiscoveredModelOptions,
  type ChatModelCatalogContext,
  type ChatModelOption,
} from './chatV2ModelCatalog.js';
import {
  getChatV2ModelRefreshStatus,
  type ChatV2ModelRefreshStatus,
} from './chatV2ModelCatalogStatus.js';

export type ChatV2ModelCatalogSession = {
  options?: ChatModelOption[] | undefined;
  status?: ChatV2ModelRefreshStatus;
};

const EMPTY_SESSION: ChatV2ModelCatalogSession = Object.freeze({});

class ChatV2ModelCatalogService {
  readonly #sessions = new Map<string, ChatV2ModelCatalogSession>();
  readonly #listeners = new Map<string, Set<() => void>>();

  getSnapshot(key: string): ChatV2ModelCatalogSession {
    return this.#sessions.get(key) ?? EMPTY_SESSION;
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  async refresh(options: {
    sessionKey: string;
    provider: Exclude<ChatV2Provider, 'custom'>;
    context: ChatModelCatalogContext;
  }): Promise<ChatV2ModelCatalogSession> {
    this.#set(options.sessionKey, {
      status: { tone: 'warning', message: 'Refreshing model list...' },
    });

    invalidateChatV2DiscoveredModelOptions(options.provider, options.context);
    const result = await getChatV2DiscoveredModelOptionsWithStatus(options.provider, options.context);
    const session = {
      options: result.options,
      status: getChatV2ModelRefreshStatus(
        options.provider,
        result,
        options.context.settings,
        options.context.plugins,
        options.context.apiKey,
      ),
    } satisfies ChatV2ModelCatalogSession;
    this.#set(options.sessionKey, session);
    return session;
  }

  setError(sessionKey: string, error: unknown): void {
    this.#set(sessionKey, {
      status: {
        tone: 'warning',
        message: error instanceof Error ? error.message : 'Failed to refresh model list.',
      },
    });
  }

  clearForTests(): void {
    this.#sessions.clear();
    this.#listeners.clear();
  }

  #set(key: string, session: ChatV2ModelCatalogSession): void {
    this.#sessions.set(key, session);
    for (const listener of this.#listeners.get(key) ?? []) listener();
  }
}

export const chatV2ModelCatalogService = new ChatV2ModelCatalogService();

export function createChatV2ModelCatalogContext(
  settings: Settings,
  plugins: RivetPlugin[],
  apiKey?: string,
): ChatModelCatalogContext {
  return { settings, plugins, apiKey };
}
