import {
  coreCreateProcessor,
  deserializeProject,
  NodeRegistration,
  registerBuiltInNodes,
  type ChatV2CallFinishedObserver,
  type RuntimeSettings,
} from '@valerypopoff/rivet2-core';
import { legacyGraphCreatorProject } from '../../legacyGraphBuilderAsset.js';
import { createAiAssistVercelGeneratorChatNodeDefinition } from '../../utils/aiAssistVercelGenerator.js';
import type { ResolvedAiAssistModelSettings } from '../../utils/aiAssistModelSettings.js';
import type { LegacyGraphBuilderAgentExecutor } from './legacyDraftRunner.js';

export type CreateBundledLegacyGraphBuilderAgentExecutorOptions = {
  assistModel: ResolvedAiAssistModelSettings;
  onChatV2CallFinished?: ChatV2CallFinishedObserver;
  runtimeSettings: Readonly<RuntimeSettings>;
};

/**
 * Creates the production binding between the pure legacy draft runner and the
 * checked-in Graph Creator Rivet policy. The factory is non-React so the same
 * path can be used by credentialed evaluation; provider-free tests inject a
 * fake LegacyGraphBuilderAgentExecutor instead.
 */
export function createBundledLegacyGraphBuilderAgentExecutor(
  options: CreateBundledLegacyGraphBuilderAgentExecutorOptions,
): LegacyGraphBuilderAgentExecutor {
  const [helperProject] = deserializeProject(legacyGraphCreatorProject);
  const registry = registerBuiltInNodes(new NodeRegistration());
  registry.register(createAiAssistVercelGeneratorChatNodeDefinition(options.assistModel));

  return async (execution) => {
    const processor = coreCreateProcessor(helperProject, {
      // RuntimeSettings is intentionally open-ended for plugins. Apply it
      // first so an unexpected settings key cannot replace the host-owned
      // graph, inputs, cancellation, tool, registry, or accounting seams.
      ...options.runtimeSettings,
      graph: 'Main',
      inputs: {
        request: execution.request,
        graph: execution.graphProjection,
        model: options.assistModel.model,
        api: options.assistModel.generatorBranch,
      },
      abortSignal: execution.abortSignal,
      externalFunctions: execution.externalFunctions,
      onUserEvent: execution.onUserEvent,
      registry,
      onChatV2CallFinished: options.onChatV2CallFinished,
    });
    await processor.run();
  };
}
