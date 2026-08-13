import type { CodeRunner, CodeRunnerOptions, DataValue, Inputs, Outputs } from '@valerypopoff/rivet2-core';
import { createCodeRunnerRequire } from './codeRunnerRequire.js';
import {
  buildNodeCodeRunnerInvocationArgs,
  compileNodeCodeRunnerFunction,
  createNodeCodeRunnerInvocationPlan,
  type NodeExecutionEnvironment,
  type NodeCodeRunnerFunction,
  type NodeCodeRunnerInvocationPlan,
} from './nodeCodeRunnerInvocation.js';

const DEFAULT_MAX_ENTRIES = 1_000;

type CacheEntry = {
  argShape: string;
  code: string;
  codeFunction: NodeCodeRunnerFunction;
};

export type CachedNodeCodeRunnerOptions = {
  executionEnvironment?: NodeExecutionEnvironment;
  maxEntries?: number;
};

export type CachedNodeCodeRunnerStats = {
  entries: number;
  hits: number;
  misses: number;
};

function normalizeMaxEntries(maxEntries: number | undefined): number {
  if (maxEntries == null) {
    return DEFAULT_MAX_ENTRIES;
  }

  if (!Number.isFinite(maxEntries)) {
    return DEFAULT_MAX_ENTRIES;
  }

  return Math.max(0, Math.floor(maxEntries));
}

export class CachedNodeCodeRunner implements CodeRunner {
  private readonly cacheByCode = new Map<string, Map<string, CacheEntry>>();
  private readonly invocationPlans = new Map<number, NodeCodeRunnerInvocationPlan>();
  private readonly lruEntries = new Set<CacheEntry>();
  private readonly maxEntries: number;
  private readonly runtimeRequire = createCodeRunnerRequire();
  private readonly executionEnvironment: NodeExecutionEnvironment | undefined;
  private hits = 0;
  private misses = 0;
  private rivetModulePromise: Promise<unknown> | undefined;

  constructor(options: CachedNodeCodeRunnerOptions = {}) {
    this.maxEntries = normalizeMaxEntries(options.maxEntries);
    this.executionEnvironment = options.executionEnvironment;
  }

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    const invocationPlan = this.getInvocationPlan(options, graphInputs != null, contextValues != null);
    const args = await buildNodeCodeRunnerInvocationArgs({
      contextValues,
      executionEnvironment: this.executionEnvironment,
      graphInputs,
      inputs,
      loadRivet: () => this.loadRivet(),
      options,
      runtimeRequire: this.runtimeRequire,
    });
    const codeFunction = this.getCodeFunction(invocationPlan, code);

    return await codeFunction(...args);
  }

  clearCache(): void {
    this.cacheByCode.clear();
    this.lruEntries.clear();
    this.invocationPlans.clear();
  }

  getCacheStats(): CachedNodeCodeRunnerStats {
    return {
      entries: this.lruEntries.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  private getCodeFunction({ argNames, argShape }: NodeCodeRunnerInvocationPlan, code: string): NodeCodeRunnerFunction {
    const cached = this.cacheByCode.get(code)?.get(argShape);

    if (cached) {
      this.hits += 1;
      this.lruEntries.delete(cached);
      this.lruEntries.add(cached);
      return cached.codeFunction;
    }

    this.misses += 1;
    const codeFunction = compileNodeCodeRunnerFunction(argNames, code);

    if (this.maxEntries > 0) {
      this.storeCodeFunction(code, argShape, codeFunction);
      this.evictOldestEntries();
    }

    return codeFunction;
  }

  private getInvocationPlan(
    options: CodeRunnerOptions,
    hasGraphInputs: boolean,
    hasContextValues: boolean,
  ): NodeCodeRunnerInvocationPlan {
    const cacheKey = getInvocationPlanCacheKey(options, hasGraphInputs, hasContextValues);
    let plan = this.invocationPlans.get(cacheKey);
    if (!plan) {
      plan = createNodeCodeRunnerInvocationPlan(options, hasGraphInputs, hasContextValues);
      this.invocationPlans.set(cacheKey, plan);
    }

    return plan;
  }

  private storeCodeFunction(code: string, argShape: string, codeFunction: NodeCodeRunnerFunction): void {
    const entry: CacheEntry = {
      argShape,
      code,
      codeFunction,
    };
    let entriesByShape = this.cacheByCode.get(code);
    if (!entriesByShape) {
      entriesByShape = new Map<string, CacheEntry>();
      this.cacheByCode.set(code, entriesByShape);
    }

    entriesByShape.set(argShape, entry);
    this.lruEntries.add(entry);
  }

  private evictOldestEntries(): void {
    while (this.lruEntries.size > this.maxEntries) {
      const oldestEntry = this.lruEntries.values().next().value;
      if (!oldestEntry) {
        return;
      }
      this.lruEntries.delete(oldestEntry);
      const entriesByShape = this.cacheByCode.get(oldestEntry.code);
      entriesByShape?.delete(oldestEntry.argShape);
      if (entriesByShape?.size === 0) {
        this.cacheByCode.delete(oldestEntry.code);
      }
    }
  }

  private async loadRivet(): Promise<unknown> {
    const promise = this.rivetModulePromise ?? import('@valerypopoff/rivet2-node');
    this.rivetModulePromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.rivetModulePromise === promise) {
        this.rivetModulePromise = undefined;
      }
      throw error;
    }
  }
}

function getInvocationPlanCacheKey(
  options: CodeRunnerOptions,
  hasGraphInputs: boolean,
  hasContextValues: boolean,
): number {
  let key = 0;
  if (options.includeConsole) {
    key |= 1 << 0;
  }
  if (options.includeRequire) {
    key |= 1 << 1;
  }
  if (options.includeProcess) {
    key |= 1 << 2;
  }
  if (options.includeFetch) {
    key |= 1 << 3;
  }
  if (options.includeRivet) {
    key |= 1 << 4;
  }
  if (hasGraphInputs) {
    key |= 1 << 5;
  }
  if (hasContextValues) {
    key |= 1 << 6;
  }

  return key;
}
