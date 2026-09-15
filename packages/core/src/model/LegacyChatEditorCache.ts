import CryptoJS from 'crypto-js';
import stableStringify from 'safe-stable-stringify';
import type { Outputs } from './GraphProcessor.js';
import type { InternalProcessContext } from './ProcessContext.js';
import { cloneExecutionOutputs } from './ExecutionOutputClone.js';

type LegacyChatEditorCacheKeyParts = {
  graphId: string | undefined;
  nodeId: string;
  nodeType: string;
  providerIdentity: unknown;
  request: unknown;
};

export type LegacyChatEditorCache = {
  cache: Map<string, unknown>;
  cacheKey: string;
};

/**
 * Builds an opaque cache key for a legacy chat request.
 *
 * Legacy chat nodes may receive credentials and request headers from settings,
 * neither of which belongs in a process-global key (or in clear text in any
 * cache key). The digest scopes entries to the graph/node and all effective
 * request/provider inputs without retaining those values in the Map key.
 */
export function buildLegacyChatEditorCacheKey(parts: LegacyChatEditorCacheKeyParts): string {
  const serialized = stableStringify({ cacheVersion: 1, ...parts }) ?? '';
  return `legacy-chat:v1:sha256:${CryptoJS.SHA256(serialized).toString(CryptoJS.enc.Hex)}`;
}

/**
 * Resolves the existing host-owned editor cache for a legacy chat request.
 * Programmatic callers that do not supply an editor cache remain isolated to
 * their GraphProcessor's execution cache instead of sharing process state.
 */
export function resolveLegacyChatEditorCache(params: {
  context: InternalProcessContext;
  enabled: boolean;
  providerIdentity: unknown;
  request: unknown;
}): { cache: LegacyChatEditorCache | undefined; cachedOutputs: Outputs | undefined } {
  if (!params.enabled) {
    return { cache: undefined, cachedOutputs: undefined };
  }

  const cache = params.context.editorExecutionCache ?? params.context.executionCache;
  if (cache == null) {
    // Lightweight direct plugin callers historically provide only the process
    // fields they need. Caching is optional, so an absent host cache must not
    // make that invocation fail.
    return { cache: undefined, cachedOutputs: undefined };
  }

  const cacheKey = buildLegacyChatEditorCacheKey({
    graphId: params.context.execution?.graphId,
    nodeId: params.context.node.id,
    nodeType: params.context.node.type,
    providerIdentity: params.providerIdentity,
    request: params.request,
  });
  const cached = cache.get(cacheKey);

  return {
    cache: { cache, cacheKey },
    cachedOutputs: cached == null ? undefined : cloneExecutionOutputs(cached as Outputs),
  };
}

/** Stores a private snapshot so downstream execution cannot mutate a cache entry. */
export function writeLegacyChatEditorCache(cache: LegacyChatEditorCache | undefined, outputs: Outputs): void {
  if (cache != null) {
    cache.cache.set(cache.cacheKey, cloneExecutionOutputs(outputs));
  }
}
