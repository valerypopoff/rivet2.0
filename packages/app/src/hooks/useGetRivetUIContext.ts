import { type ChartNode, type RivetUIContext, getPluginConfig } from '@valerypopoff/rivet2-core';
import { selectedExecutorState, settingsState } from '../state/settings';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { useDependsOnPlugins } from './useDependsOnPlugins';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import { projectState, referencedProjectsState } from '../state/savedGraphs';
import { graphState } from '../state/graph';
import { useStableCallback } from './useStableCallback';
import { useAtomValue } from 'jotai';
import { TauriNativeApi } from '../model/native/TauriNativeApi';
import { useDatasetProvider, useEnvironmentProvider } from '../providers/ProvidersContext';
import { getChatV2DiscoveredModelOptions } from '../utils/chatV2ModelCatalog.js';

export function useGetRivetUIContext() {
  const datasetProvider = useDatasetProvider();
  const environmentProvider = useEnvironmentProvider();
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const projectNodeRegistry = useProjectNodeRegistry();
  const project = useAtomValue(projectState);
  const graph = useAtomValue(graphState);
  const referencedProjects = useAtomValue(referencedProjectsState);

  return useStableCallback(async ({ node }: { node?: ChartNode }) => {
    const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
      environmentProvider,
    });
    let getPluginConfigFn: RivetUIContext['getPluginConfig'] = () => undefined;
    if (node) {
      const nodePlugin = projectNodeRegistry.getPluginFor(node?.type);
      if (nodePlugin) {
        getPluginConfigFn = (name) => getPluginConfig(nodePlugin, resolvedSettings, name);
      }
    }

    const context = {
      datasetProvider,
      executor: selectedExecutor,
      settings: resolvedSettings,
      project,
      graph,
      node,
      getPluginConfig: getPluginConfigFn,
      getChatModelOptions: (provider: 'openai' | 'anthropic' | 'google' | 'openrouter') =>
        getChatV2DiscoveredModelOptions(provider, {
          settings: resolvedSettings,
          plugins,
        }),
      nativeApi: new TauriNativeApi(),
      referencedProjects,
    };

    return context as RivetUIContext;
  });
}
