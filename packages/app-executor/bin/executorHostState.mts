import type { GraphId, Project, RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import type { NodeCreateProcessorOptions } from '@valerypopoff/rivet2-node';

export type AppExecutorProcessorOptionsContext = Readonly<{
  graphId: GraphId;
  isWebAppAction: boolean;
  project: Project;
  projectPath?: string;
  requestId: RemoteRunRequestId;
}>;

export type AppExecutorHostOptions = Readonly<{
  /**
   * Adds host-owned processor facilities to every editor run handled by this
   * executor process. Rivet-owned execution identity, graph inputs, debugger,
   * registry, storage snapshot, and event callbacks take precedence over any
   * overlapping values returned here.
   */
  createProcessorOptions?: (
    context: AppExecutorProcessorOptionsContext,
  ) => Partial<NodeCreateProcessorOptions> | Promise<Partial<NodeCreateProcessorOptions>>;
}>;

let hostOptions: AppExecutorHostOptions = {};
let executorModuleLoaded = false;

export function configureAppExecutorHost(options: AppExecutorHostOptions): void {
  hostOptions = options;
}

export function getAppExecutorHostOptions(): AppExecutorHostOptions {
  return hostOptions;
}

export function hasAppExecutorModuleLoaded(): boolean {
  return executorModuleLoaded;
}

export function markAppExecutorModuleLoaded(): void {
  executorModuleLoaded = true;
}
