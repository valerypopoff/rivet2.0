import { isRivetWebAppRunTerminalEvent, type RivetWebAppRunEvent } from '@valerypopoff/rivet2-core';
import type { RivetWebAppRunStore, RivetWebAppStoredRun } from './webAppSocketGateway.js';

const DEFAULT_MAX_EVENTS_PER_RUN = 256;
const DEFAULT_MAX_STORED_RUNS = 1_000;

export function createInMemoryRivetWebAppRunStore(
  options: { maxEventsPerRun?: number; maxStoredRuns?: number } = {},
): RivetWebAppRunStore {
  const runs = new Map<string, RivetWebAppStoredRun>();
  const runIdByRequest = new Map<string, string>();
  const maxEventsPerRun = readIntegerOption('maxEventsPerRun', options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN, 2);
  const maxStoredRuns = readIntegerOption('maxStoredRuns', options.maxStoredRuns, DEFAULT_MAX_STORED_RUNS, 1);

  const interruptRuns = (predicate: (run: RivetWebAppStoredRun) => boolean, error: string): RivetWebAppStoredRun[] => {
    const interrupted: RivetWebAppStoredRun[] = [];
    for (const run of runs.values()) {
      if (run.status !== 'running' || !predicate(run)) continue;
      const event = {
        type: 'action.interrupted',
        error,
        requestId: run.requestId,
        runId: run.runId,
        sequence: run.lastSequence + 1,
      } satisfies RivetWebAppRunEvent;
      run.events.push(event);
      run.lastSequence = event.sequence;
      compactEvents(run, maxEventsPerRun);
      run.status = 'interrupted';
      run.updatedAt = Date.now();
      interrupted.push(structuredClone(run));
    }
    return interrupted;
  };

  return {
    async appendEvent(runId, leaseId, event) {
      const run = runs.get(runId);
      if (!run || run.status !== 'running' || run.leaseId !== leaseId || run.leaseExpiresAt <= Date.now()) {
        return undefined;
      }
      if (event.runId !== runId || event.requestId !== run.requestId) {
        throw new Error('Web app run event identity does not match its stored run.');
      }

      const storedEvent = structuredClone({ ...event, sequence: run.lastSequence + 1 }) as RivetWebAppRunEvent;
      run.events.push(storedEvent);
      run.lastSequence = storedEvent.sequence;
      compactEvents(run, maxEventsPerRun);
      run.updatedAt = Date.now();
      if (isRivetWebAppRunTerminalEvent(storedEvent)) run.status = terminalStatus(storedEvent);
      return storedEvent;
    },
    async createRun(input) {
      const requestKey = getRequestKey(input.ownerScope, input.requestId);
      const existingId = runIdByRequest.get(requestKey);
      const existing = existingId ? runs.get(existingId) : undefined;
      if (existing) return { created: false, run: structuredClone(existing) };
      if (runs.has(input.runId)) throw new Error(`Web app run ID "${input.runId}" is already in use.`);

      pruneStoredRuns(runs, runIdByRequest, maxStoredRuns - 1);
      if (runs.size >= maxStoredRuns) throw new Error('Web app run store capacity reached.');

      const { leaseDurationMs, ...runInput } = input;
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
        throw new RangeError('leaseDurationMs must be a positive safe integer.');
      }
      const run: RivetWebAppStoredRun = {
        ...runInput,
        events: [],
        lastSequence: 0,
        leaseExpiresAt: Date.now() + leaseDurationMs,
        status: 'running',
        updatedAt: input.createdAt,
      };
      runs.set(run.runId, run);
      runIdByRequest.set(requestKey, run.runId);
      return { created: true, run: structuredClone(run) };
    },
    async getRun(runId) {
      const run = runs.get(runId);
      return run ? structuredClone(run) : undefined;
    },
    async getRunByRequestId(ownerScope, requestId) {
      const runId = runIdByRequest.get(getRequestKey(ownerScope, requestId));
      const run = runId ? runs.get(runId) : undefined;
      return run ? structuredClone(run) : undefined;
    },
    async interruptExpiredRuns(error) {
      const now = Date.now();
      return interruptRuns((run) => run.leaseExpiresAt <= now, error);
    },
    async interruptRunsByLease(leaseId, error) {
      return interruptRuns((run) => run.leaseId === leaseId, error);
    },
    async renewRunLeases(leaseId, runIds, leaseDurationMs) {
      const now = Date.now();
      const leaseExpiresAt = now + leaseDurationMs;
      const renewed: string[] = [];
      for (const runId of runIds) {
        const run = runs.get(runId);
        if (!run || run.status !== 'running' || run.leaseId !== leaseId || run.leaseExpiresAt <= now) continue;
        run.leaseExpiresAt = leaseExpiresAt;
        run.updatedAt = now;
        renewed.push(run.runId);
      }
      return renewed;
    },
  };
}

function terminalStatus(event: RivetWebAppRunEvent): RivetWebAppStoredRun['status'] {
  switch (event.type) {
    case 'action.completed':
      return 'completed';
    case 'action.failed':
      return 'failed';
    case 'action.cancelled':
      return 'cancelled';
    case 'action.interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

function getRequestKey(ownerScope: string, requestId: string): string {
  return JSON.stringify([ownerScope, requestId]);
}

function compactEvents(run: RivetWebAppStoredRun, maxEvents: number): void {
  if (run.events.length <= maxEvents) return;
  const accepted = run.events.find((event) => event.type === 'action.accepted');
  const tail = run.events.filter((event) => event !== accepted).slice(-(accepted ? maxEvents - 1 : maxEvents));
  run.events = accepted ? [accepted, ...tail] : tail;
}

function pruneStoredRuns(
  runs: Map<string, RivetWebAppStoredRun>,
  runIdByRequest: Map<string, string>,
  targetSize: number,
): void {
  if (runs.size <= targetSize) return;
  const removableRuns = [...runs.values()]
    .filter((run) => run.status !== 'running')
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const run of removableRuns) {
    if (runs.size <= targetSize) break;
    runs.delete(run.runId);
    runIdByRequest.delete(getRequestKey(run.ownerScope, run.requestId));
  }
}

function readIntegerOption(name: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return resolved;
}
