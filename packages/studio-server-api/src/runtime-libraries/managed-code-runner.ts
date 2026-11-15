import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { LRUCache } from 'lru-cache';
import type { CodeRunner, CodeRunnerOptions, DataValue } from '@valerypopoff/rivet2-core';
import {
  createScopedNodeProcess,
  resolveCodeInterpolationExpression,
  type NodeExecutionEnvironment,
} from '@valerypopoff/rivet2-node';

import { prepareRuntimeLibrariesForExecution } from './backend.js';
import type { RuntimeLibrarySnapshot } from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';

type Inputs = Record<string, { type: string; value: unknown } | undefined>;
type Outputs = Record<string, DataValue>;

type PrepareRuntimeLibraries = () => Promise<RuntimeLibrarySnapshot | null>;
type LoadRivetModule = () => Promise<unknown>;
type CompiledCodeFunction = (...args: unknown[]) => Promise<Outputs>;

export interface ManagedCodeRunnerTelemetry {
  calls: number;
  requireCalls: number;
  rivetCalls: number;
  fetchCalls: number;
  processCalls: number;
  consoleCalls: number;
  prepareCalls: number;
  prepareMs: number;
  compileCalls: number;
  compileMs: number;
  executeMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEnabled: boolean;
  forcePrepareEveryCode: boolean;
}

export interface ManagedCodeRunnerTelemetrySnapshot extends ManagedCodeRunnerTelemetry {
  cacheSize: number;
}

interface ManagedCodeRunnerOptions {
  executionEnvironment?: NodeExecutionEnvironment;
  telemetry?: ManagedCodeRunnerTelemetry;
  prepareRuntimeLibraries?: PrepareRuntimeLibraries;
  loadRivet?: LoadRivetModule;
}

const COMPILED_CODE_CACHE_LIMIT = 1000;
const MANAGED_REQUIRE_CACHE_LIMIT = 100;
let compiledCodeCache = createCompiledCodeCache(COMPILED_CODE_CACHE_LIMIT);
const managedRequireCache = new LRUCache<string, NodeRequire>({
  max: MANAGED_REQUIRE_CACHE_LIMIT,
});
let compiledCodeCacheLimit = COMPILED_CODE_CACHE_LIMIT;

function createCompiledCodeCache(limit: number): LRUCache<string, CompiledCodeFunction> {
  return new LRUCache({ max: Math.max(1, limit) });
}

function isEnvFlagEnabled(value: string | undefined, defaultValue = false): boolean {
  if (value == null) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return defaultValue;
}

function isCompiledCodeCacheEnabled(): boolean {
  return !isEnvFlagEnabled(process.env.RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE, false);
}

function shouldForcePrepareEveryCode(): boolean {
  return isEnvFlagEnabled(process.env.RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE, false);
}

export function isManagedCodeRunnerTelemetryEnabled(): boolean {
  return isEnvFlagEnabled(process.env.RIVET_CODE_RUNNER_TELEMETRY, false);
}

export function createManagedCodeRunnerTelemetry(): ManagedCodeRunnerTelemetry {
  return {
    calls: 0,
    requireCalls: 0,
    rivetCalls: 0,
    fetchCalls: 0,
    processCalls: 0,
    consoleCalls: 0,
    prepareCalls: 0,
    prepareMs: 0,
    compileCalls: 0,
    compileMs: 0,
    executeMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cacheEnabled: isCompiledCodeCacheEnabled(),
    forcePrepareEveryCode: shouldForcePrepareEveryCode(),
  };
}

export function getManagedCodeRunnerTelemetrySnapshot(
  telemetry: ManagedCodeRunnerTelemetry,
): ManagedCodeRunnerTelemetrySnapshot {
  return {
    ...telemetry,
    prepareMs: Math.max(0, Math.round(telemetry.prepareMs)),
    compileMs: Math.max(0, Math.round(telemetry.compileMs)),
    executeMs: Math.max(0, Math.round(telemetry.executeMs)),
    cacheSize: compiledCodeCache.size,
  };
}

function getCompiledCodeCacheKey(code: string, argNames: string[]): string {
  return JSON.stringify({
    code,
    args: argNames,
  });
}

function getCachedCompiledCode(cacheKey: string): CompiledCodeFunction | null {
  if (compiledCodeCacheLimit <= 0) {
    return null;
  }

  return compiledCodeCache.get(cacheKey) ?? null;
}

function setCachedCompiledCode(cacheKey: string, fn: CompiledCodeFunction): void {
  if (compiledCodeCacheLimit > 0) {
    compiledCodeCache.set(cacheKey, fn);
  }
}

function createCompiledCodeFunction(code: string, argNames: string[]): CompiledCodeFunction {
  const AsyncFunction = async function () {}.constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<Outputs>;
  return new AsyncFunction(...argNames, code);
}

export function resetManagedCodeRunnerCacheForTests(): void {
  for (const anchor of managedRequireCache.keys()) {
    clearNodeRequireCacheUnder(path.dirname(anchor));
  }

  compiledCodeCacheLimit = COMPILED_CODE_CACHE_LIMIT;
  compiledCodeCache = createCompiledCodeCache(compiledCodeCacheLimit);
  managedRequireCache.clear();
}

export function getManagedCodeRunnerCacheSizeForTests(): number {
  return compiledCodeCache.size;
}

export function getManagedRequireCacheSizeForTests(): number {
  return managedRequireCache.size;
}

export function setManagedCodeRunnerCacheLimitForTests(limit: number): void {
  compiledCodeCacheLimit = Math.max(0, Math.floor(limit));
  compiledCodeCache = createCompiledCodeCache(compiledCodeCacheLimit);
}

function clearNodeRequireCacheUnder(nodeModulesPath: string): void {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const root = normalize(nodeModulesPath) + path.sep;
  const require = createRequire(import.meta.url);
  for (const file of Object.keys(require.cache)) if (normalize(file).startsWith(root)) delete require.cache[file];
}

function getCachedManagedRequire(snapshot: RuntimeLibrarySnapshot): NodeRequire {
  const key = snapshot.requireAnchorPath;
  const cached = managedRequireCache.get(key);
  if (cached) return cached;
  const require = createRequire(key);
  managedRequireCache.set(key, require);
  return require;
}
/**
 * A wrapper-owned CodeRunner that resolves packages from the active managed
 * runtime-library release, pinned on its first successful preparation.
 * Only an explicitly unconfigured runtime uses ambient Node resolution.
 */
export class ManagedCodeRunner implements CodeRunner {
  private readonly prepareRuntimeLibraries: PrepareRuntimeLibraries;
  private readonly loadRivet: LoadRivetModule;
  private readonly telemetry: ManagedCodeRunnerTelemetry | null;
  private readonly executionEnvironment: NodeExecutionEnvironment | undefined;
  private prepareForRequirePromise: Promise<RuntimeLibrarySnapshot | null> | null = null;
  private requireSnapshot: RuntimeLibrarySnapshot | null | undefined;
  private requireFn: NodeRequire | null = null;

  constructor(_runtimeLibrariesRoot: string, options: ManagedCodeRunnerOptions = {}) {
    this.prepareRuntimeLibraries = options.prepareRuntimeLibraries ?? prepareRuntimeLibrariesForExecution;
    this.loadRivet = options.loadRivet ?? (() => import('@valerypopoff/rivet2-node'));
    this.telemetry = options.telemetry ?? null;
    this.executionEnvironment = options.executionEnvironment;
  }

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
    globalValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    this.trackCall(options);

    const argNames: string[] = ['inputs'];
    const args: unknown[] = [inputs];

    if (options.includeConsole) {
      argNames.push('console');
      args.push(console);
    }

    if (options.includeRequire) {
      await this.prepareRuntimeLibrariesForRequire();

      argNames.push('require');
      const requireFn = this.createManagedRequire();
      args.push(requireFn);
    } else if (shouldForcePrepareEveryCode()) {
      await this.prepareRuntimeLibrariesForCode();
    }

    if (options.includeProcess) {
      argNames.push('process');
      args.push(createScopedNodeProcess(this.executionEnvironment));
    }

    if (options.includeFetch) {
      argNames.push('fetch');
      args.push(globalThis.fetch);
    }

    if (options.includeRivet) {
      argNames.push('Rivet');
      // Dynamically import rivet-node so we don't create a hard circular dep
      const rivet = await this.loadRivet();
      args.push(rivet);
    }

    if (graphInputs) {
      argNames.push('graphInputs');
      args.push(graphInputs);
    }

    if (contextValues) {
      argNames.push('context');
      args.push(contextValues);
    }

    if (options.interpolationHelperIdentifier) {
      argNames.push(options.interpolationHelperIdentifier);
      args.push(resolveCodeInterpolationExpression);
    }

    if (options.globalValuesIdentifier) {
      argNames.push(options.globalValuesIdentifier);
      args.push(globalValues ?? Object.create(null));
    }

    const codeFunction = this.getCompiledCodeFunction(code, argNames);
    if (!this.telemetry) {
      return await codeFunction(...args);
    }

    const executionStartedAt = performance.now();

    try {
      return await codeFunction(...args);
    } finally {
      this.recordExecuteMs(performance.now() - executionStartedAt);
    }
  }

  private createManagedRequire(): NodeRequire {
    if (this.requireFn) {
      return this.requireFn;
    }

    if (this.requireSnapshot === undefined) throw new Error('Runtime-library snapshot has not been prepared.');
    this.requireFn = this.requireSnapshot
      ? getCachedManagedRequire(this.requireSnapshot)
      : createRequire(import.meta.url);
    return this.requireFn;
  }

  private async prepareRuntimeLibrariesForRequire(): Promise<void> {
    if (this.requireSnapshot !== undefined) {
      if (shouldForcePrepareEveryCode()) await this.prepareRuntimeLibrariesForCode();
      return;
    }

    this.prepareForRequirePromise ??= this.prepareRuntimeLibrariesForCode();
    try {
      this.requireSnapshot = await this.prepareForRequirePromise;
    } catch (error) {
      this.prepareForRequirePromise = null;
      throw error;
    }
  }

  private async prepareRuntimeLibrariesForCode(): Promise<RuntimeLibrarySnapshot | null> {
    if (this.telemetry) this.telemetry.prepareCalls += 1;
    const startedAt = this.telemetry ? performance.now() : 0;
    try {
      const snapshot = await this.prepareRuntimeLibraries();
      if (
        snapshot === undefined ||
        (snapshot !== null && (snapshot.version !== 1 || !path.isAbsolute(snapshot.requireAnchorPath)))
      )
        throw new Error('Runtime-library preparation did not return a verified snapshot.');
      return snapshot;
    } finally {
      if (this.telemetry) this.recordPrepareMs(performance.now() - startedAt);
    }
  }

  private getCompiledCodeFunction(code: string, argNames: string[]): CompiledCodeFunction {
    const cacheEnabled = isCompiledCodeCacheEnabled();
    if (this.telemetry) {
      this.telemetry.cacheEnabled = cacheEnabled;
      this.telemetry.forcePrepareEveryCode = shouldForcePrepareEveryCode();
    }

    let cacheKey: string | null = null;
    if (cacheEnabled) {
      cacheKey = getCompiledCodeCacheKey(code, argNames);
      const cached = getCachedCompiledCode(cacheKey);
      if (cached) {
        if (this.telemetry) {
          this.telemetry.cacheHits += 1;
        }
        return cached;
      }

      if (this.telemetry) {
        this.telemetry.cacheMisses += 1;
      }
    }

    if (this.telemetry) {
      this.telemetry.compileCalls += 1;
    }
    const compileStartedAt = this.telemetry ? performance.now() : 0;
    let compiled: CompiledCodeFunction;
    try {
      compiled = createCompiledCodeFunction(code, argNames);
    } finally {
      if (this.telemetry) {
        this.recordCompileMs(performance.now() - compileStartedAt);
      }
    }

    if (cacheEnabled && cacheKey) {
      setCachedCompiledCode(cacheKey, compiled);
    }

    return compiled;
  }

  private trackCall(options: CodeRunnerOptions): void {
    if (!this.telemetry) {
      return;
    }

    this.telemetry.calls += 1;
    if (options.includeRequire) {
      this.telemetry.requireCalls += 1;
    }
    if (options.includeRivet) {
      this.telemetry.rivetCalls += 1;
    }
    if (options.includeFetch) {
      this.telemetry.fetchCalls += 1;
    }
    if (options.includeProcess) {
      this.telemetry.processCalls += 1;
    }
    if (options.includeConsole) {
      this.telemetry.consoleCalls += 1;
    }
  }

  private recordPrepareMs(durationMs: number): void {
    if (this.telemetry) {
      this.telemetry.prepareMs += durationMs;
    }
  }

  private recordCompileMs(durationMs: number): void {
    if (this.telemetry) {
      this.telemetry.compileMs += durationMs;
    }
  }

  private recordExecuteMs(durationMs: number): void {
    if (this.telemetry) {
      this.telemetry.executeMs += durationMs;
    }
  }
}
