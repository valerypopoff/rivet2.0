import type { DataValue, GraphId, Project, UiGraph } from '@valerypopoff/rivet2-node';
import type { ExecutionSessionResult } from '../../routes/workflows/execution-session.js';

/** Local Gate A protocol. It is deliberately not a serving configuration/API. */
export type PrototypeDefinition = {
  project: Project;
  projectPath: string;
  runtimeLibrariesRoot: string;
  executionEnvironment: Record<string, string>;
};

export type PrototypeRequest = {
  /** Exclusive external request bytes, never a buffer backing shared graph data. */
  inputJson?: ArrayBuffer;
  inputs?: Record<string, DataValue>;
  context?: Record<string, DataValue>;
  executionEnvironment?: Record<string, string>;
  graph?: GraphId;
  recording?: boolean;
  observeNodes?: boolean;
  action?: {
    uiGraph: UiGraph;
    componentId: string;
    state: Record<string, unknown>;
    storage?: Record<string, unknown>;
  };
};

export type PrototypeFailure = { name: string; message: string; stack?: string };
export type PrototypeResult = {
  status: ExecutionSessionResult['status'];
  durationMs: number;
  cost?: ExecutionSessionResult['cost'];
  recording?: string;
  captureError?: PrototypeFailure;
  failure?: PrototypeFailure;
};

export type PrototypeEvent =
  | { kind: 'started' }
  | { kind: 'prepared' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'foreground'; json: string | undefined };

export type ParentMessage =
  | { kind: 'run'; id: number; request: PrototypeRequest; hostStore: boolean }
  | { kind: 'abort'; id: number };

export type WorkerMessage =
  | { kind: 'ready' }
  | { kind: 'event'; id: number; event: PrototypeEvent }
  | { kind: 'settled'; id: number; result: PrototypeResult }
  | { kind: 'fatal'; id: number; error: PrototypeFailure };

export function prototypeFailure(error: unknown): PrototypeFailure {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'Error', message: String(error) };
}
