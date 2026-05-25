import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { prepareRuntimeLibrariesForExecution } from './backend.js';

interface CodeRunnerOptions {
  includeFetch: boolean;
  includeRequire: boolean;
  includeRivet: boolean;
  includeProcess: boolean;
  includeConsole: boolean;
}

interface DataValue {
  type: string;
  value: unknown;
}

type Inputs = Record<string, DataValue>;
type Outputs = Record<string, DataValue>;

type PrepareRuntimeLibraries = () => Promise<void>;
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
  telemetry?: ManagedCodeRunnerTelemetry;
  prepareRuntimeLibraries?: PrepareRuntimeLibraries;
  loadRivet?: LoadRivetModule;
}

interface CompiledCodeCacheEntry {
  fn: CompiledCodeFunction;
  lastUsed: number;
}

interface ManagedRequireSnapshot {
  cacheKey: string;
  groupKey: string;
  nodeModulesPath: string;
}

const COMPILED_CODE_CACHE_LIMIT = 1000;
const MANAGED_REQUIRE_CACHE_LIMIT = 100;
const compiledCodeCache = new Map<string, CompiledCodeCacheEntry>();
const managedRequireCache = new Map<string, NodeRequire>();
const managedRequireGroupKeys = new Map<string, string>();
const managedRequireNodeModulesPaths = new Set<string>();
let compiledCodeCacheLimit = COMPILED_CODE_CACHE_LIMIT;
let compiledCodeCacheUseCounter = 0;

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
  const entry = compiledCodeCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  entry.lastUsed = ++compiledCodeCacheUseCounter;
  return entry.fn;
}

function setCachedCompiledCode(cacheKey: string, fn: CompiledCodeFunction): void {
  compiledCodeCache.set(cacheKey, {
    fn,
    lastUsed: ++compiledCodeCacheUseCounter,
  });

  trimCompiledCodeCache();
}

function trimCompiledCodeCache(): void {
  while (compiledCodeCache.size > compiledCodeCacheLimit) {
    const oldestKey = getOldestCompiledCodeCacheKey();
    if (oldestKey == null) {
      return;
    }

    compiledCodeCache.delete(oldestKey);
  }
}

function getOldestCompiledCodeCacheKey(): string | null {
  let oldestKey: string | null = null;
  let oldestUsed = Number.POSITIVE_INFINITY;

  for (const [key, entry] of compiledCodeCache.entries()) {
    if (entry.lastUsed < oldestUsed) {
      oldestKey = key;
      oldestUsed = entry.lastUsed;
    }
  }

  return oldestKey;
}

function createCompiledCodeFunction(code: string, argNames: string[]): CompiledCodeFunction {
  const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: unknown[]) => Promise<Outputs>;
  return new AsyncFunction(...argNames, code);
}

export function resetManagedCodeRunnerCacheForTests(): void {
  for (const nodeModulesPath of managedRequireNodeModulesPaths) {
    clearNodeRequireCacheUnder(nodeModulesPath);
  }

  compiledCodeCache.clear();
  managedRequireCache.clear();
  managedRequireGroupKeys.clear();
  managedRequireNodeModulesPaths.clear();
  compiledCodeCacheUseCounter = 0;
  compiledCodeCacheLimit = COMPILED_CODE_CACHE_LIMIT;
}

export function getManagedCodeRunnerCacheSizeForTests(): number {
  return compiledCodeCache.size;
}

export function getManagedRequireCacheSizeForTests(): number {
  return managedRequireCache.size;
}

export function setManagedCodeRunnerCacheLimitForTests(limit: number): void {
  compiledCodeCacheLimit = Math.max(0, Math.floor(limit));
  trimCompiledCodeCache();
}

function readRuntimeLibrariesSnapshotId(runtimeLibrariesRoot: string, nodeModulesPath: string): string {
  try {
    const manifestPath = path.join(runtimeLibrariesRoot, 'manifest.json');
    const rawManifest = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(rawManifest) as { activeReleaseId?: unknown; updatedAt?: unknown };
    if (typeof manifest.activeReleaseId === 'string' && manifest.activeReleaseId.trim()) {
      return `release:${manifest.activeReleaseId.trim()}`;
    }

    if (typeof manifest.updatedAt === 'string' && manifest.updatedAt.trim()) {
      return `updated:${manifest.updatedAt.trim()}`;
    }
  } catch {
    // Missing or invalid manifests fall back to the active package tree timestamp.
  }

  try {
    const nodeModulesStat = fs.statSync(nodeModulesPath);
    return `node-modules:${nodeModulesStat.mtimeMs}`;
  } catch {
    // If there is no package tree yet, the path-only snapshot is the safest available fallback.
  }

  return 'unversioned';
}

function getManagedRequireSnapshot(runtimeLibrariesRoot: string, nodeModulesPath: string): ManagedRequireSnapshot {
  const resolvedRoot = path.resolve(runtimeLibrariesRoot);
  const resolvedNodeModulesPath = path.resolve(nodeModulesPath);
  const snapshotId = readRuntimeLibrariesSnapshotId(runtimeLibrariesRoot, resolvedNodeModulesPath);
  const groupKey = `${resolvedRoot}\0${resolvedNodeModulesPath}`;

  return {
    cacheKey: `${groupKey}\0${snapshotId}`,
    groupKey,
    nodeModulesPath: resolvedNodeModulesPath,
  };
}

function trimManagedRequireCache(): void {
  while (managedRequireCache.size > MANAGED_REQUIRE_CACHE_LIMIT) {
    const oldestKey = managedRequireCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }

    managedRequireCache.delete(oldestKey);
  }
}

function clearNodeRequireCacheUnder(nodeModulesPath: string): void {
  const normalizedNodeModulesPath = normalizeCachePathForComparison(nodeModulesPath);
  const root = `${normalizedNodeModulesPath}${path.sep}`;
  const moduleRequire = createRequire(import.meta.url);

  for (const cachePath of Object.keys(moduleRequire.cache)) {
    const normalizedCachePath = normalizeCachePathForComparison(cachePath);
    if (normalizedCachePath === normalizedNodeModulesPath || normalizedCachePath.startsWith(root)) {
      delete moduleRequire.cache[cachePath];
    }
  }
}

function normalizeCachePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function invalidateManagedRequireCacheIfReleaseChanged(snapshot: ManagedRequireSnapshot): void {
  const previousCacheKey = managedRequireGroupKeys.get(snapshot.groupKey);
  if (previousCacheKey === snapshot.cacheKey) {
    return;
  }

  if (previousCacheKey) {
    managedRequireCache.delete(previousCacheKey);
    clearNodeRequireCacheUnder(snapshot.nodeModulesPath);
  }

  managedRequireGroupKeys.set(snapshot.groupKey, snapshot.cacheKey);
}

function getCachedManagedRequire(snapshot: ManagedRequireSnapshot): NodeRequire {
  invalidateManagedRequireCacheIfReleaseChanged(snapshot);
  managedRequireNodeModulesPaths.add(snapshot.nodeModulesPath);

  const cached = managedRequireCache.get(snapshot.cacheKey);
  if (cached) {
    managedRequireCache.delete(snapshot.cacheKey);
    managedRequireCache.set(snapshot.cacheKey, cached);
    return cached;
  }

  const virtualEntry = path.join(snapshot.nodeModulesPath, '__virtual.cjs');
  const requireFn = createRequire(virtualEntry);
  managedRequireCache.set(snapshot.cacheKey, requireFn);
  trimManagedRequireCache();
  return requireFn;
}

/**
 * A wrapper-owned CodeRunner that resolves packages from the active managed
 * runtime-library release. Falls back to standard Node module resolution
 * (NODE_PATH) when no managed release exists.
 *
 * Implements the CodeRunner interface from @valerypopoff/rivet2-core without
 * importing it directly, since the API depends on @valerypopoff/rivet2-node
 * which re-exports everything.
 */
export class ManagedCodeRunner {
  private readonly prepareRuntimeLibraries: PrepareRuntimeLibraries;
  private readonly loadRivet: LoadRivetModule;
  private readonly telemetry: ManagedCodeRunnerTelemetry | null;
  private prepareForRequirePromise: Promise<void> | null = null;
  private requireSnapshot: ManagedRequireSnapshot | null = null;
  private requireFn: NodeRequire | null = null;

  constructor(
    private readonly runtimeLibrariesRoot: string,
    options: ManagedCodeRunnerOptions = {},
  ) {
    this.prepareRuntimeLibraries = options.prepareRuntimeLibraries ?? prepareRuntimeLibrariesForExecution;
    this.loadRivet = options.loadRivet ?? (() => import('@valerypopoff/rivet2-node'));
    this.telemetry = options.telemetry ?? null;
  }

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
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
      args.push(process);
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

    const nodeModulesPath = this.currentNodeModulesPath();
    if (nodeModulesPath) {
      this.requireSnapshot ??= getManagedRequireSnapshot(this.runtimeLibrariesRoot, nodeModulesPath);
      this.requireFn = getCachedManagedRequire(this.requireSnapshot);
      return this.requireFn;
    }

    // Fallback: standard require using NODE_PATH
    return createRequire(import.meta.url);
  }

  private currentNodeModulesPath(): string | null {
    const nodeModulesPath = path.join(this.runtimeLibrariesRoot, 'current', 'node_modules');
    return fs.existsSync(nodeModulesPath) ? nodeModulesPath : null;
  }

  private async prepareRuntimeLibrariesForRequire(): Promise<void> {
    if (shouldForcePrepareEveryCode()) {
      await this.prepareRuntimeLibrariesForCode();
      this.requireSnapshot = null;
      this.requireFn = null;
      return;
    }

    this.prepareForRequirePromise ??= this.prepareRuntimeLibrariesForCode();
    await this.prepareForRequirePromise;
  }

  private async prepareRuntimeLibrariesForCode(): Promise<void> {
    if (!this.telemetry) {
      await this.prepareRuntimeLibraries();
      return;
    }

    this.telemetry.prepareCalls += 1;
    const startedAt = performance.now();
    try {
      await this.prepareRuntimeLibraries();
    } finally {
      this.recordPrepareMs(performance.now() - startedAt);
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
