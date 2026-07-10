import {
  deserializeProject,
  deserializeDatasets,
  coreCreateProcessor,
  type NodeId,
  coerceType,
  InMemoryDatasetProvider,
  type DataValue,
  type ExternalFunction,
  type ExternalFunctionProcessContext,
  registerBuiltInNodes,
  NodeRegistration,
  getError,
} from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import { toast } from 'react-toastify';
import { TauriNativeApi } from '../model/native/TauriNativeApi';
import { fillMissingSettingsFromEnvironmentVariables } from '../utils/tauri';
import { useAtom, useAtomValue } from 'jotai';
import { graphState } from '../state/graph';
import { settingsState } from '../state/settings';
import { useAutoLayoutGraph } from './useAutoLayoutGraph';
import { useCenterViewOnGraph } from './useCenterViewOnGraph';
import { useDependsOnPlugins } from './useDependsOnPlugins';
import graphBuilderProject from '../../graphs/graph-creator.rivet-project?raw';
import graphBuilderData from '../../graphs/graph-creator.rivet-data?raw';
import { referencedProjectsState } from '../state/savedGraphs';
import {
  buildAiGraphBuilderExternalFunctions,
  parseAiGraphBuilderEditNodeArgs,
  resolveAiGraphBuilderNodeDataKey,
  resolveAiGraphBuilderNodeId,
} from './aiGraphBuilderHelpers.js';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import { handleError } from '../utils/errorHandling.js';
import { useClearCurrentGraphHistory } from '../commands/Command.js';
import { useEnvironmentProvider } from '../providers/ProvidersContext.js';
import type { ResolvedAiAssistModelSettings } from '../utils/aiAssistModelSettings.js';
import { createAiAssistVercelGeneratorChatNodeDefinition } from '../utils/aiAssistVercelGenerator.js';

const MAX_LOG_VALUE_LENGTH = 1_600;

function formatLogValue(value: unknown, maxLength = MAX_LOG_VALUE_LENGTH): string {
  let formatted: string;

  try {
    formatted = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  } catch {
    formatted = String(value);
  }

  if (formatted.length <= maxLength) {
    return formatted;
  }

  return `${formatted.slice(0, maxLength)}... [truncated ${formatted.length - maxLength} chars]`;
}

function formatExternalFunctionArgs(args: unknown[]): string {
  if (args.length === 0) {
    return '(no args)';
  }

  return args.map((arg, index) => `arg${index + 1}=${formatLogValue(arg)}`).join(', ');
}

function formatExternalFunctionResult(result: unknown): string {
  if (typeof result === 'object' && result != null && 'type' in result && 'value' in result) {
    const dataValue = result as DataValue;
    return `${dataValue.type}: ${formatLogValue(dataValue.value)}`;
  }

  return formatLogValue(result);
}

function wrapLoggedExternalFunctions(
  functions: Record<string, ExternalFunction>,
  log: (message: string) => void,
): Record<string, ExternalFunction> {
  return Object.fromEntries(
    Object.entries(functions).map(([name, fn]) => [
      name,
      async (context: ExternalFunctionProcessContext, ...args: unknown[]) => {
        log(`CALL ${name} ${formatExternalFunctionArgs(args)}`);

        try {
          const result = await fn(context, ...args);
          log(`OK ${name} -> ${formatExternalFunctionResult(result)}`);
          return result;
        } catch (error) {
          log(`ERROR ${name}: ${getError(error).message}`);
          throw error;
        }
      },
    ]),
  );
}

export function useAiGraphBuilder({ onFeedback }: { onFeedback: (feedback: string) => void }) {
  const [graph, setGraph] = useAtom(graphState);

  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const projectNodeRegistry = useProjectNodeRegistry();

  const centerView = useCenterViewOnGraph();
  const autoLayout = useAutoLayoutGraph();
  const clearCurrentGraphHistory = useClearCurrentGraphHistory();

  const referencedProjects = useAtomValue(referencedProjectsState);

  return async function applyPrompt(
    prompt: string,
    assistModel: ResolvedAiAssistModelSettings,
    abort: AbortSignal,
  ): Promise<boolean> {
    let workingToastId: ReturnType<typeof toast.info> | undefined;

    try {
      let workingGraph = cloneDeep(graph);
      const log = (message: string) => {
        const time = new Date().toLocaleTimeString();
        onFeedback(`[${time}] ${message}`);
      };
      const logGraphState = (message: string) => {
        log(`${message} Graph has ${workingGraph.nodes.length} nodes and ${workingGraph.connections.length} connections.`);
      };

      const [project] = deserializeProject(graphBuilderProject);
      const data = deserializeDatasets(graphBuilderData);

      workingToastId = toast.info('Working...');
      log(`Starting AI graph builder with ${assistModel.displayName}.`);
      log(`Prompt: ${formatLogValue(prompt)}`);
      logGraphState('Initial state.');

      const showChanges = () => {
        const laidOutGraph = {
          ...workingGraph,
          nodes: autoLayout(workingGraph),
        };
        const publishedGraph = cloneDeep(laidOutGraph);
        clearCurrentGraphHistory();
        setGraph(publishedGraph);
        centerView(publishedGraph);
        workingGraph = cloneDeep(publishedGraph);
      };

      const externalFunctions: Record<string, ExternalFunction> = {
        ...buildAiGraphBuilderExternalFunctions({
          project,
          referencedProjects,
          registry: projectNodeRegistry,
          onLog: log,
          showChanges,
          workingGraph: () => workingGraph,
          setWorkingGraph: (nextGraph) => {
            workingGraph = nextGraph;
          },
        }),
        showChanges: async () => ({
          type: 'boolean' as const,
          value: true,
        }),
        editNode: async (_ctx: unknown, rawNodeId: unknown, rawKey: unknown, rawValue: unknown) => {
          const { nodeId, key, value } = parseAiGraphBuilderEditNodeArgs(rawNodeId, rawKey, rawValue);
          const node = workingGraph.nodes.find((node) => node.id === nodeId);

          if (!node) {
            throw new Error(`Node with ID ${nodeId} not found`);
          }

          const data = node.data as Record<string, unknown>;
          const dataKey = resolveAiGraphBuilderNodeDataKey(data, key);
          const updatedData = { ...data, [dataKey]: value };
          log(`Resolved editNode target ${node.id} (${node.type}) ${JSON.stringify(key)} -> data.${dataKey}.`);
          workingGraph = {
            ...workingGraph,
            nodes: workingGraph.nodes.map((candidate) =>
              candidate.id === nodeId ? { ...candidate, data: updatedData } : candidate,
            ),
          };

          showChanges();
          logGraphState(`Edited node ${node.id} (${node.type}) data.${dataKey}.`);

          return {
            type: 'object' as const,
            value: updatedData,
          };
        },
        getNodeData: async (_ctx: unknown, rawNodeId: unknown) => {
          const nodeId = resolveAiGraphBuilderNodeId(rawNodeId);
          const node = workingGraph.nodes.find((node) => node.id === nodeId);

          if (!node) {
            throw new Error(`Node with ID ${nodeId} not found`);
          }
          log(`Reading data for node ${node.id} (${node.type}). Keys: ${Object.keys(node.data ?? {}).join(', ') || '(none)'}.`);

          return {
            type: 'object' as const,
            value: {
              data: node.data as Record<string, unknown>,
              splittingEnabled: node.isSplitRun,
            },
          };
        },
        deleteNode: async (_ctx: unknown, rawNodeId: unknown) => {
          const nodeId = resolveAiGraphBuilderNodeId(rawNodeId);
          const node = workingGraph.nodes.find((node) => node.id === nodeId);

          if (!node) {
            throw new Error(`Node with ID ${nodeId} not found`);
          }

          workingGraph = {
            ...workingGraph,
            nodes: workingGraph.nodes.filter((node) => node.id !== nodeId),
            connections: workingGraph.connections.filter(
              (connection) => connection.inputNodeId !== nodeId && connection.outputNodeId !== nodeId,
            ),
          };

          showChanges();
          logGraphState(`Deleted node ${node.id} (${node.type}).`);

          return {
            type: 'boolean' as const,
            value: true,
          };
        },
        addNodeData: async (_ctx: unknown, rawNodeId: unknown, rawKey: unknown, rawValue: unknown) => {
          const { nodeId, key, value } = parseAiGraphBuilderEditNodeArgs(rawNodeId, rawKey, rawValue);
          const node = workingGraph.nodes.find((node) => node.id === nodeId);

          if (!node) {
            throw new Error(`Node with ID ${nodeId} not found`);
          }

          const updatedData = { ...(node.data as Record<string, unknown>), [key]: value };
          workingGraph = {
            ...workingGraph,
            nodes: workingGraph.nodes.map((candidate) =>
              candidate.id === nodeId ? { ...candidate, data: updatedData } : candidate,
            ),
          };

          showChanges();
          logGraphState(`Added node data ${node.id} (${node.type}) data.${key}.`);

          return {
            type: 'object',
            value: updatedData,
          };
        },
        lintGraph: async () => {
          const warnings: string[] = [];

          for (const connection of workingGraph.connections) {
            const sourceNode = workingGraph.nodes.find((node) => node.id === connection.outputNodeId);
            const destNode = workingGraph.nodes.find((node) => node.id === connection.inputNodeId);

            if (!sourceNode || !destNode) {
              warnings.push(`Node not found for connection: ${JSON.stringify(connection)}`);
              continue;
            }

            const sourceInstance = projectNodeRegistry.createDynamicImpl(sourceNode);
            const destInstance = projectNodeRegistry.createDynamicImpl(destNode);

            const sourceConnections = workingGraph.connections.filter((conn) => conn.outputNodeId === sourceNode.id);

            const destConnections = workingGraph.connections.filter((conn) => conn.inputNodeId === destNode.id);

            const nodesById = Object.fromEntries(workingGraph.nodes.map((node) => [node.id, node]));

            try {
              const sourcePort = sourceInstance
                .getOutputDefinitions(sourceConnections, nodesById, project, referencedProjects)
                .find((port) => port.id === connection.outputId);

              if (!sourcePort) {
                warnings.push(`Port not found for connection: ${JSON.stringify(connection)}`);
                continue;
              }
            } catch (e) {
              warnings.push(`Error getting source port for connection: ${JSON.stringify(connection)}`);
              continue;
            }

            try {
              const destPort = destInstance
                .getInputDefinitions(destConnections, nodesById, project, referencedProjects)
                .find((port) => port.id === connection.inputId);

              if (!destPort) {
                warnings.push(`Port not found for connection: ${JSON.stringify(connection)}`);
                continue;
              }
            } catch (e) {
              warnings.push(`Error getting dest port for connection: ${JSON.stringify(connection)}`);
              continue;
            }
          }

          // Find islands of nodes, i.e. the graph does not form a cohesive unit
          const visited = new Set<NodeId>();
          const islands: NodeId[][] = [];
          const dfs = (nodeId: NodeId, island: NodeId[]) => {
            visited.add(nodeId);
            island.push(nodeId);

            for (const connection of workingGraph.connections) {
              if (connection.outputNodeId === nodeId && !visited.has(connection.inputNodeId)) {
                dfs(connection.inputNodeId, island);
              } else if (connection.inputNodeId === nodeId && !visited.has(connection.outputNodeId)) {
                dfs(connection.outputNodeId, island);
              }
            }
          };
          for (const node of workingGraph.nodes) {
            if (!visited.has(node.id)) {
              const island: NodeId[] = [];
              dfs(node.id, island);
              islands.push(island);
            }
          }
          if (islands.length > 1) {
            warnings.push(`Graph is not connected as one unit. Found ${islands.length} islands.`);
          }

          // Find mismatched data types
          for (const connection of workingGraph.connections) {
            const sourceNode = workingGraph.nodes.find((node) => node.id === connection.outputNodeId);
            const destNode = workingGraph.nodes.find((node) => node.id === connection.inputNodeId);

            if (!sourceNode || !destNode) {
              continue;
            }

            const sourceInstance = projectNodeRegistry.createDynamicImpl(sourceNode);
            const destInstance = projectNodeRegistry.createDynamicImpl(destNode);

            const sourceConnections = workingGraph.connections.filter((conn) => conn.outputNodeId === sourceNode.id);

            const destConnections = workingGraph.connections.filter((conn) => conn.inputNodeId === destNode.id);

            const nodesById = Object.fromEntries(workingGraph.nodes.map((node) => [node.id, node]));

            try {
              const sourcePort = sourceInstance
                .getOutputDefinitions(sourceConnections, nodesById, project, referencedProjects)
                .find((port) => port.id === connection.outputId);

              if (!sourcePort) {
                continue;
              }

              const destPort = destInstance
                .getInputDefinitions(destConnections, nodesById, project, referencedProjects)
                .find((port) => port.id === connection.inputId);

              if (!destPort) {
                continue;
              }

              const sourceType = sourceNode.isSplitRun ? `${sourcePort.dataType}[]` : sourcePort.dataType;
              const destType = destNode.isSplitRun ? `${destPort.dataType}[]` : destPort.dataType;

              const coerced = destPort.coerced ?? true;

              const isAny =
                sourceType === 'any' || destType === 'any' || sourceType === 'any[]' || destType === 'any[]';

              if (sourceType !== destType && !coerced && !isAny) {
                warnings.push(
                  `Data type mismatch: ${sourceType} -> ${destType} for connection: ${JSON.stringify(connection)}`,
                );
              } else if (sourceType !== destType && coerced && !isAny) {
                warnings.push(
                  `Minor: Coerced data type mismatch: ${sourceType} -> ${destType} for connection: ${JSON.stringify(connection)}. Data will be coerced to ${destType} successfully, but this may not be what you want.`,
                );
              }
            } catch (e) {
              continue;
            }
          }

          // Find nodes with no connections
          for (const node of workingGraph.nodes) {
            const connections = workingGraph.connections.filter(
              (connection) => connection.inputNodeId === node.id || connection.outputNodeId === node.id,
            );

            if (connections.length === 0) {
              warnings.push(`Node ${node.id} has no connections.`);
            }
          }

          return {
            type: 'string[]' as const,
            value: warnings,
          };
        },
        toggleSplitting: async (_ctx: unknown, rawNodeId: unknown, enabled: unknown, maxSplitAmount: unknown) => {
          const rawOptions =
            typeof rawNodeId === 'object' && rawNodeId != null && !Array.isArray(rawNodeId)
              ? (rawNodeId as Record<string, unknown>)
              : undefined;
          const nodeId = resolveAiGraphBuilderNodeId(rawOptions ?? rawNodeId);
          const resolvedEnabled = rawOptions?.enabled ?? enabled;
          const resolvedMaxSplitAmount = rawOptions?.maxSplitAmount ?? maxSplitAmount;
          const enabledBoolean =
            typeof resolvedEnabled === 'boolean' ? resolvedEnabled : String(resolvedEnabled).toLowerCase() === 'true';
          const maxSplitAmountNumber =
            typeof resolvedMaxSplitAmount === 'number' ? resolvedMaxSplitAmount : Number(resolvedMaxSplitAmount);
          const node = workingGraph.nodes.find((node) => node.id === nodeId);

          if (!node) {
            throw new Error(`Node with ID ${nodeId} not found`);
          }

          if (!Number.isFinite(maxSplitAmountNumber) || maxSplitAmountNumber <= 0) {
            throw new Error(`Max split amount must be greater than 0. Recommended is 100.`);
          }

          workingGraph = {
            ...workingGraph,
            nodes: workingGraph.nodes.map((candidate) =>
              candidate.id === nodeId
                ? { ...candidate, isSplitRun: enabledBoolean, splitRunMax: maxSplitAmountNumber }
                : candidate,
            ),
          };

          showChanges();
          logGraphState(`Set splitting for node ${node.id} (${node.type}) to ${enabledBoolean}.`);
          return {
            type: 'boolean' as const,
            value: true,
          };
        },
      };

      const loggedExternalFunctions = wrapLoggedExternalFunctions(externalFunctions, log);

      const onUserEvent: { [key: string]: (data: DataValue | undefined) => void } = {
        runningCommands: (data) => {
          const functionName = coerceType(data, 'object').name;

          if (functionName !== 'updateUser') {
            log(`MODEL requested command ${functionName}. Event payload: ${formatLogValue(data)}`);
          }
        },
        finalMessage: (data) => {
          const message = coerceType(data, 'string');
          log(`FINAL ${message}`);
          toast.info(message);
        },
        updateUser: (data) => {
          const message = coerceType(data, 'string');
          log(`UPDATE ${message}`);
        },
      };

      const registry = registerBuiltInNodes(new NodeRegistration());
      registry.register(createAiAssistVercelGeneratorChatNodeDefinition(assistModel));

      const processor = coreCreateProcessor(project, {
        graph: 'Main',
        inputs: {
          request: prompt,
          graph: JSON.stringify(workingGraph, null, 2),
          model: assistModel.model,
          api: assistModel.generatorBranch,
        },
        abortSignal: abort,
        context: {
          allNodeTypes: {
            type: 'string[]',
            value: projectNodeRegistry.getNodeTypes(),
          },
        },
        externalFunctions: loggedExternalFunctions,
        onUserEvent,
        nativeApi: new TauriNativeApi(),
        datasetProvider: new InMemoryDatasetProvider(data),
        registry,
        ...(await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
          environmentProvider,
        })),
      });

      const { cost } = await processor.run();

      if (abort.aborted) {
        log('Canceled after processor run completed.');
        return false;
      }

      logGraphState(`Finished AI graph builder. Cost: ${coerceType(cost, 'number')}.`);
      console.log(`Cost: ${coerceType(cost, 'number')}`);
      return true;
    } catch (err) {
      if (abort.aborted) {
        onFeedback(`[${new Date().toLocaleTimeString()}] Canceled.`);
        return false;
      }

      onFeedback(`[${new Date().toLocaleTimeString()}] FAILED ${getError(err).message}`);
      handleError(err, 'AI graph builder failed', {
        metadata: {
          model: assistModel.displayName,
          promptLength: prompt.length,
        },
      });
      return false;
    } finally {
      if (workingToastId != null) {
        toast.dismiss(workingToastId);
      }
    }
  };
}
