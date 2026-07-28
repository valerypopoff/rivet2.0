import {
  compileDataBusTopology,
  NODE_PREFAB_INSTANCE_TYPE,
  resolveNodePrefabInstance,
  type ChartNode,
  type GraphId,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type NodeRegistration,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import deepEqual from 'fast-deep-equal';
import { cloneDeep } from 'lodash-es';
import {
  type GraphBuilderAuthoringProject,
  type GraphBuilderAuthoringSemantics,
  type GraphBuilderResolvedNodePorts,
  type GraphBuilderTouchedScope,
  type GraphDiagnostic,
  type GraphValidationResult,
  compareGraphBuilderStrings,
  graphBuilderStringTupleKey,
  type PortableJsonObject,
  toBoundedGraphBuilderIdentifier,
} from '../../domain/graphBuilder/index.js';
import { getAsyncBranchTopologyViolation } from '../../domain/graphEditing/connectionValidation.js';
import { getPortCompatibilityStatus } from '../../domain/graphEditing/portCompatibility.js';
import type { GraphBuilderAuthoringCatalogSnapshot } from './authoringCatalog.js';
import { layoutGraphBuilderCreatedNodes } from './deterministicGraphLayout.js';

const RULES_VERSION = 'graph-builder-authoring-v1';

export type CreateGraphBuilderAuthoringSemanticsOptions = {
  registry: NodeRegistration<any, any>;
  catalog: GraphBuilderAuthoringCatalogSnapshot;
  referencedProjects: Record<ProjectId, Project>;
  /**
   * Graphs where Graph Builder may add new inputs or outputs while preserving
   * every boundary node captured in the base project.
   */
  additiveBoundaryGraphIds?: readonly GraphId[];
  /**
   * Graphs that were captured as transient empty canvases may author their
   * initial boundary over several patch batches, including revising a boundary
   * added earlier in the same private draft.
   */
  mutableBoundaryGraphIds?: readonly GraphId[];
};

type RichResolvedNodePorts = {
  inputs: readonly NodeInputDefinition[];
  outputs: readonly NodeOutputDefinition[];
};

function diagnostic(input: {
  key: string;
  ruleId: string;
  message: string;
  graphId?: string;
  nodeId?: string;
  portId?: string;
  verification?: 'verified' | 'unverified';
}): GraphDiagnostic {
  return {
    diagnosticKey: toBoundedGraphBuilderIdentifier(input.key),
    ruleId: input.ruleId,
    rulesVersion: RULES_VERSION,
    severity: 'error',
    verification: input.verification ?? 'verified',
    message: input.message.slice(0, 2_000),
    ...(input.graphId ? { graphId: input.graphId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.portId ? { portId: input.portId } : {}),
  };
}

function validation(
  diagnostics: readonly GraphDiagnostic[],
  completeness: GraphValidationResult['completeness'] = 'complete',
): GraphValidationResult {
  const bounded = [...diagnostics].slice(0, 256);
  return {
    completeness,
    diagnostics: bounded,
    blockingDiagnosticKeys: bounded.filter((entry) => entry.severity === 'error').map((entry) => entry.diagnosticKey),
  };
}

function mergeValidationResults(results: readonly GraphValidationResult[]): GraphValidationResult {
  const diagnostics = results.flatMap((result) => result.diagnostics).slice(0, 256);
  return {
    completeness: results.every((result) => result.completeness === 'complete') ? 'complete' : 'incomplete',
    diagnostics,
    blockingDiagnosticKeys: diagnostics
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.diagnosticKey),
  };
}

function toNodesById(nodes: readonly ChartNode[]): Record<NodeId, ChartNode> {
  const result = Object.create(null) as Record<NodeId, ChartNode>;
  for (const node of nodes) {
    result[node.id] = node;
  }
  return result;
}

function getEffectiveNode(project: GraphBuilderAuthoringProject, node: ChartNode): ChartNode {
  if (node.type !== NODE_PREFAB_INSTANCE_TYPE) {
    return node;
  }
  const resolved = resolveNodePrefabInstance(project as Project, node);
  if (resolved.type === NODE_PREFAB_INSTANCE_TYPE) {
    throw new Error(`Linked library node "${node.id}" has no usable source.`);
  }
  return resolved;
}

function getEffectiveNodesById(
  project: GraphBuilderAuthoringProject,
  nodes: readonly ChartNode[],
): Record<NodeId, ChartNode> {
  const result = Object.create(null) as Record<NodeId, ChartNode>;
  for (const node of nodes) {
    try {
      result[node.id] = getEffectiveNode(project, node);
    } catch {
      result[node.id] = node;
    }
  }
  return result;
}

function sameEndpoint(left: NodeConnection, right: NodeConnection): boolean {
  return (
    left.outputNodeId === right.outputNodeId &&
    left.outputId === right.outputId &&
    left.inputNodeId === right.inputNodeId &&
    left.inputId === right.inputId
  );
}

function boundaryIdentity(node: ChartNode | undefined): { type: string; id: unknown; dataType: unknown } | undefined {
  if (!node || (node.type !== 'graphInput' && node.type !== 'graphOutput')) {
    return undefined;
  }
  const data = node.data as { id?: unknown; dataType?: unknown } | undefined;
  return {
    type: node.type,
    id: data?.id,
    dataType: data?.dataType,
  };
}

export class AppGraphBuilderAuthoringSemantics implements GraphBuilderAuthoringSemantics {
  readonly #registry: NodeRegistration<any, any>;
  readonly #catalog: GraphBuilderAuthoringCatalogSnapshot;
  readonly #referencedProjects: Record<ProjectId, Project>;
  readonly #additiveBoundaryGraphIds: ReadonlySet<GraphId>;
  readonly #mutableBoundaryGraphIds: ReadonlySet<GraphId>;

  constructor(options: CreateGraphBuilderAuthoringSemanticsOptions) {
    this.#registry = options.registry;
    this.#catalog = options.catalog;
    this.#referencedProjects = cloneDeep(options.referencedProjects);
    this.#additiveBoundaryGraphIds = new Set(options.additiveBoundaryGraphIds ?? []);
    this.#mutableBoundaryGraphIds = new Set(options.mutableBoundaryGraphIds ?? []);
  }

  createNodeFromAuthoringChoice(input: {
    operation: {
      authoringChoiceId: string;
      settings?: PortableJsonObject;
    };
    allocatedNodeId: NodeId;
    project: GraphBuilderAuthoringProject;
  }): ChartNode {
    return this.#catalog.createNode({
      authoringChoiceId: input.operation.authoringChoiceId,
      allocatedNodeId: input.allocatedNodeId,
      project: input.project,
      settings: input.operation.settings,
    });
  }

  applyNodeSettings(input: {
    operation: { settings: PortableJsonObject };
    node: ChartNode;
    project: GraphBuilderAuthoringProject;
  }): ChartNode {
    return this.#catalog.applyNodeSettings({
      node: input.node,
      project: input.project,
      settings: input.operation.settings,
    });
  }

  resolvePorts(input: {
    graphId: GraphId;
    nodeId: NodeId;
    project: GraphBuilderAuthoringProject;
  }): GraphBuilderResolvedNodePorts {
    const ports = this.#resolveRichPorts(input);
    return {
      inputs: ports.inputs.map((port) => ({
        id: port.id,
        dataType: port.dataType,
        allowsMultipleConnections: false,
      })),
      outputs: ports.outputs.map((port) => ({ id: port.id, dataType: port.dataType })),
    };
  }

  validateConnection(input: {
    graphId: GraphId;
    connection: NodeConnection;
    project: GraphBuilderAuthoringProject;
    touchedScope: GraphBuilderTouchedScope;
  }): GraphValidationResult {
    const graph = input.project.graphs[input.graphId];
    if (!graph) {
      return validation([
        diagnostic({
          key: `connection:missing-graph:${input.graphId}`,
          ruleId: 'graph-existence',
          graphId: input.graphId,
          message: 'The graph containing the proposed connection does not exist.',
        }),
      ]);
    }

    const result = this.#validateConnectionWithoutTopology(input.graphId, input.connection, input.project);
    const topologyViolation = getAsyncBranchTopologyViolation({
      connections: graph.connections,
      nodesById: getEffectiveNodesById(input.project, graph.nodes),
    });
    if (!topologyViolation) {
      return result;
    }

    return mergeValidationResults([
      result,
      validation([
        diagnostic({
          key: `async-topology:${topologyViolation.kind}:${topologyViolation.triggerNodeId}:${topologyViolation.nodeId}`,
          ruleId: `async-branch-${topologyViolation.kind}`,
          graphId: input.graphId,
          nodeId: topologyViolation.nodeId,
          message: topologyViolation.message,
        }),
      ]),
    ]);
  }

  normalizeCandidate(input: {
    base: GraphBuilderAuthoringProject;
    project: GraphBuilderAuthoringProject;
    createdNodeIds: readonly NodeId[];
    touchedScope: GraphBuilderTouchedScope;
  }): { project: GraphBuilderAuthoringProject } {
    if (input.createdNodeIds.length === 0) {
      return { project: cloneDeep(input.project) };
    }
    let project = cloneDeep(input.project);
    for (const graphId of [...new Set(input.touchedScope.graphIds)].sort()) {
      project = layoutGraphBuilderCreatedNodes({
        base: input.base,
        project,
        graphId: graphId as GraphId,
        createdNodeIds: input.createdNodeIds,
      });
    }
    return {
      project,
    };
  }

  validateCandidate(input: {
    base: GraphBuilderAuthoringProject;
    candidate: GraphBuilderAuthoringProject;
    touchedScope: GraphBuilderTouchedScope;
  }): GraphValidationResult {
    const diagnostics: GraphDiagnostic[] = [];
    let complete = true;

    if (
      !deepEqual(input.base.metadata, input.candidate.metadata) ||
      !deepEqual(input.base.plugins, input.candidate.plugins) ||
      !deepEqual(input.base.references, input.candidate.references) ||
      !deepEqual(input.base.nodePrefabs, input.candidate.nodePrefabs) ||
      !deepEqual(input.base.uiGraphs, input.candidate.uiGraphs) ||
      graphBuilderStringTupleKey(...Object.keys(input.base.graphs).sort(compareGraphBuilderStrings)) !==
        graphBuilderStringTupleKey(...Object.keys(input.candidate.graphs).sort(compareGraphBuilderStrings))
    ) {
      diagnostics.push(
        diagnostic({
          key: 'candidate:project-boundary-changed',
          ruleId: 'project-shell-identity',
          message:
            'Graph Builder may mutate graph contents only; project resources and graph identities must remain unchanged.',
        }),
      );
    }

    const touchedGraphIds = [...new Set(input.touchedScope.graphIds)].sort();
    for (const graphIdValue of touchedGraphIds) {
      const graphId = graphIdValue as GraphId;
      const graph = input.candidate.graphs[graphId];
      const baseGraph = input.base.graphs[graphId];
      if (!graph || !baseGraph) {
        diagnostics.push(
          diagnostic({
            key: `candidate:missing-graph:${graphId}`,
            ruleId: 'graph-existence',
            graphId,
            message: 'The touched graph must exist in both the base and candidate projects.',
          }),
        );
        continue;
      }

      if (!deepEqual(graph.metadata, baseGraph.metadata)) {
        diagnostics.push(
          diagnostic({
            key: `candidate:graph-metadata:${graphId}`,
            ruleId: 'graph-boundary-identity',
            graphId,
            message: 'Graph metadata and boundary identity cannot be changed by Plan B patches.',
          }),
        );
      }

      const baseNodesById = toNodesById(baseGraph.nodes);
      const candidateNodesById = toNodesById(graph.nodes);
      const boundaryIsMutable = this.#mutableBoundaryGraphIds.has(graphId);
      if (!boundaryIsMutable) {
        for (const baseNode of baseGraph.nodes) {
          const identity = boundaryIdentity(baseNode);
          if (!identity) {
            continue;
          }
          const candidateIdentity = boundaryIdentity(candidateNodesById[baseNode.id]!);
          if (!candidateIdentity || !deepEqual(identity, candidateIdentity)) {
            diagnostics.push(
              diagnostic({
                key: `candidate:existing-boundary:${graphId}:${baseNode.id}`,
                ruleId: 'graph-boundary-identity',
                graphId,
                nodeId: baseNode.id,
                message:
                  'Existing Graph Input and Graph Output nodes cannot be deleted, retagged, or have their ID/data type changed by Plan B.',
              }),
            );
          }
        }
      }
      if (!boundaryIsMutable && !this.#additiveBoundaryGraphIds.has(graphId)) {
        for (const candidateNode of graph.nodes) {
          if (boundaryIdentity(candidateNode) && !baseNodesById[candidateNode.id]) {
            diagnostics.push(
              diagnostic({
                key: `candidate:new-boundary:${graphId}:${candidateNode.id}`,
                ruleId: 'graph-boundary-identity',
                graphId,
                nodeId: candidateNode.id,
                message: 'Graph boundary nodes can only be created on the captured transient empty canvas.',
              }),
            );
          }
        }
      }

      const nodesById = toNodesById(graph.nodes);
      const effectiveNodesById = getEffectiveNodesById(input.candidate, graph.nodes);
      if (Object.keys(nodesById).length !== graph.nodes.length) {
        diagnostics.push(
          diagnostic({
            key: `candidate:duplicate-node-id:${graphId}`,
            ruleId: 'node-id-uniqueness',
            graphId,
            message: 'Node IDs must be unique within the graph.',
          }),
        );
      }

      for (const node of graph.nodes) {
        const baseNode = baseNodesById[node.id];
        const directMutationRejection = this.#catalog.getDirectNodeMutationRejectionReason(baseNode, node);
        if (directMutationRejection) {
          diagnostics.push(
            diagnostic({
              key: `candidate:protected-node-mutation:${graphId}:${node.id}`,
              ruleId: 'protected-node-mutation',
              graphId,
              nodeId: node.id,
              message: directMutationRejection,
            }),
          );
        }
        const configurationChanged = !baseNode || !deepEqual(baseNode.data, node.data);
        const identityChanged = !baseNode || baseNode.type !== node.type;
        if (identityChanged && !this.#catalog.getNodeAuthoringChoiceId(node)) {
          diagnostics.push(
            diagnostic({
              key: `candidate:unsupported-node-type:${graphId}:${node.id}`,
              ruleId: 'captured-node-authoring',
              graphId,
              nodeId: node.id,
              message: `Node type "${node.type}" is unavailable from the captured project authoring catalog.`,
            }),
          );
        }
        if (configurationChanged) {
          let effectiveType = node.type;
          try {
            effectiveType = getEffectiveNode(input.candidate, node).type;
          } catch {
            // Missing prefab sources are reported through the captured
            // authoring capability check below.
          }
          if (!this.#catalog.canResolveNodeType(effectiveType)) {
            diagnostics.push(
              diagnostic({
                key: `candidate:unsupported-node-settings:${graphId}:${node.id}`,
                ruleId: 'captured-node-authoring',
                graphId,
                nodeId: node.id,
                message: `Node "${node.title || node.id}" cannot be created or reconfigured because its type has no captured pure authoring adapter.`,
              }),
            );
          } else {
            try {
              this.#resolveRichPorts({
                graphId,
                nodeId: node.id,
                project: input.candidate,
              });
            } catch {
              complete = false;
              diagnostics.push(
                diagnostic({
                  key: `candidate:unresolved-node-configuration:${graphId}:${node.id}`,
                  ruleId: 'captured-node-authoring',
                  graphId,
                  nodeId: node.id,
                  message: `Node "${node.title || node.id}" could not be resolved through its captured authoring adapter after the configuration change.`,
                  verification: 'unverified',
                }),
              );
            }
          }
        }
        if (!configurationChanged) {
          continue;
        }

        if (node.type === 'llmChatV2') {
          const data = node.data as {
            autoContinueToolCalls?: unknown;
            maxToolRounds?: unknown;
            parallelToolCalls?: unknown;
            useToolCalling?: unknown;
          };
          if (
            data.useToolCalling !== true &&
            (data.autoContinueToolCalls === true || data.parallelToolCalls === true)
          ) {
            diagnostics.push(
              diagnostic({
                key: `tool-config:disabled:${graphId}:${node.id}`,
                ruleId: 'tool-delegate-mismatch',
                graphId,
                nodeId: node.id,
                message:
                  'LLM Chat must enable tool calling before automatic continuation or parallel tool calls can be enabled.',
              }),
            );
          }
          if (
            data.autoContinueToolCalls === true &&
            (typeof data.maxToolRounds !== 'number' ||
              !Number.isSafeInteger(data.maxToolRounds) ||
              data.maxToolRounds < 1)
          ) {
            diagnostics.push(
              diagnostic({
                key: `tool-config:round-limit:${graphId}:${node.id}`,
                ruleId: 'tool-delegate-mismatch',
                graphId,
                nodeId: node.id,
                message: 'Auto-continuing LLM Chat requires maxToolRounds to be a positive safe integer.',
              }),
            );
          }
        }

        if (node.type === 'loopUntil') {
          const data = node.data as {
            conditionType?: unknown;
            inputToCheck?: unknown;
            maxIterations?: unknown;
            targetGraph?: unknown;
          };
          if (
            typeof data.targetGraph !== 'string' ||
            !Object.hasOwn(input.candidate.graphs, data.targetGraph as GraphId)
          ) {
            diagnostics.push(
              diagnostic({
                key: `loop-config:target:${graphId}:${node.id}`,
                ruleId: 'loop-target-graph',
                graphId,
                nodeId: node.id,
                message: 'Graph Builder-authored Loop Until nodes require an existing target graph.',
              }),
            );
          } else if (data.targetGraph === graphId) {
            diagnostics.push(
              diagnostic({
                key: `loop-config:self-target:${graphId}:${node.id}`,
                ruleId: 'loop-target-graph',
                graphId,
                nodeId: node.id,
                message:
                  'Loop Until cannot target the graph that contains it because that would recurse before its iteration limit can apply.',
              }),
            );
          }
          if (
            typeof data.maxIterations !== 'number' ||
            !Number.isSafeInteger(data.maxIterations) ||
            data.maxIterations < 1
          ) {
            diagnostics.push(
              diagnostic({
                key: `loop-config:iteration-limit:${graphId}:${node.id}`,
                ruleId: 'loop-iteration-limit',
                graphId,
                nodeId: node.id,
                message: 'Graph Builder-authored Loop Until nodes require a positive safe-integer maxIterations.',
              }),
            );
          }
          if (
            data.conditionType === 'inputEqual' &&
            (typeof data.inputToCheck !== 'string' || data.inputToCheck.trim().length === 0)
          ) {
            diagnostics.push(
              diagnostic({
                key: `loop-config:input-equal:${graphId}:${node.id}`,
                ruleId: 'loop-stop-condition',
                graphId,
                nodeId: node.id,
                message: 'Loop Until inputEqual requires a non-empty inputToCheck output name.',
              }),
            );
          }
        }
      }

      const seenConnections: NodeConnection[] = [];
      const occupiedInputs = new Set<string>();
      graph.connections.forEach((connection, index) => {
        if (seenConnections.some((candidate) => sameEndpoint(candidate, connection))) {
          diagnostics.push(
            diagnostic({
              key: `candidate:duplicate-connection:${graphId}:${index}`,
              ruleId: 'connection-uniqueness',
              graphId,
              message: 'Duplicate connection endpoint tuples are not allowed.',
            }),
          );
        }
        seenConnections.push(connection);

        const inputKey = graphBuilderStringTupleKey(connection.inputNodeId, connection.inputId);
        if (occupiedInputs.has(inputKey)) {
          diagnostics.push(
            diagnostic({
              key: `candidate:occupied-input:${graphId}:${index}`,
              ruleId: 'single-input-occupancy',
              graphId,
              nodeId: connection.inputNodeId,
              portId: connection.inputId,
              message: 'An input port cannot have more than one incoming connection.',
            }),
          );
        }
        occupiedInputs.add(inputKey);

        const connectionValidation = this.#validateConnectionWithoutTopology(graphId, connection, input.candidate);
        diagnostics.push(...connectionValidation.diagnostics);
        complete &&= connectionValidation.completeness === 'complete';
      });

      for (const node of graph.nodes) {
        if (
          node.type !== 'llmChatV2' ||
          node.disabled ||
          node.isSplitRun ||
          (node.data as { useToolCalling?: unknown }).useToolCalling !== true ||
          (node.data as { autoContinueToolCalls?: unknown }).autoContinueToolCalls !== true
        ) {
          continue;
        }

        const delegates = graph.connections.filter((connection) => {
          if (
            connection.outputNodeId !== node.id ||
            connection.outputId !== 'function-calls' ||
            connection.inputId !== 'function-call'
          ) {
            return false;
          }
          const delegate = nodesById[connection.inputNodeId];
          return delegate?.type === 'delegateFunctionCall' && !delegate.disabled;
        });
        if (delegates.length > 1) {
          diagnostics.push(
            diagnostic({
              key: `tool-config:ambiguous-delegate:${graphId}:${node.id}`,
              ruleId: 'tool-delegate-mismatch',
              graphId,
              nodeId: node.id,
              message:
                'An auto-continuing LLM Chat may have at most one active Tool Calls connection to Delegate Tool Call.',
            }),
          );
        }
      }

      const topologyViolation = getAsyncBranchTopologyViolation({
        connections: graph.connections,
        nodesById: effectiveNodesById,
      });
      if (topologyViolation) {
        diagnostics.push(
          diagnostic({
            key: `candidate:async:${graphId}:${topologyViolation.kind}:${topologyViolation.nodeId}`,
            ruleId: `async-branch-${topologyViolation.kind}`,
            graphId,
            nodeId: topologyViolation.nodeId,
            message: topologyViolation.message,
          }),
        );
      }

      // Data Buses are not ordinary runtime nodes: their authored channels
      // become direct execution edges only after topology compilation. Raw
      // port validation above cannot see relay cycles or effective-provider
      // conflicts, so validate the same compiled topology that execution uses
      // before the draft is accepted.
      try {
        compileDataBusTopology({
          connections: graph.connections,
          graphNodes: graph.nodes.map((node) => effectiveNodesById[node.id] ?? node),
        });
      } catch (error) {
        diagnostics.push(
          diagnostic({
            key: `candidate:data-bus-topology:${graphId}`,
            ruleId: 'data-bus-topology',
            graphId,
            message:
              error instanceof Error
                ? `Data Bus topology cannot be compiled: ${error.message}`
                : 'Data Bus topology cannot be compiled.',
          }),
        );
      }

      const boundaryIds = new Map<string, NodeId>();
      for (const node of graph.nodes) {
        if (node.type !== 'graphInput' && node.type !== 'graphOutput') {
          continue;
        }
        const boundaryId = (node.data as { id?: unknown } | undefined)?.id;
        if (typeof boundaryId !== 'string' || boundaryId.length === 0) {
          diagnostics.push(
            diagnostic({
              key: `candidate:boundary-id:${graphId}:${node.id}`,
              ruleId: 'graph-boundary-id',
              graphId,
              nodeId: node.id,
              message: 'Graph Input and Graph Output nodes require a non-empty boundary ID.',
            }),
          );
          continue;
        }
        const key = graphBuilderStringTupleKey(node.type, boundaryId);
        const previous = boundaryIds.get(key);
        if (previous) {
          diagnostics.push(
            diagnostic({
              key: `candidate:duplicate-boundary:${graphId}:${node.type}:${boundaryId}`,
              ruleId: 'graph-boundary-id-uniqueness',
              graphId,
              nodeId: node.id,
              message: `${node.type === 'graphInput' ? 'Graph Input' : 'Graph Output'} ID "${boundaryId}" is duplicated.`,
            }),
          );
        } else {
          boundaryIds.set(key, node.id);
        }
      }
    }

    const bounded = diagnostics.slice(0, 256);
    return {
      completeness: complete ? 'complete' : 'incomplete',
      diagnostics: bounded,
      blockingDiagnosticKeys: bounded.map((entry) => entry.diagnosticKey),
    };
  }

  #resolveRichPorts(input: {
    graphId: GraphId;
    nodeId: NodeId;
    project: GraphBuilderAuthoringProject;
  }): RichResolvedNodePorts {
    const graph = input.project.graphs[input.graphId];
    if (!graph) {
      throw new Error(`Graph "${input.graphId}" does not exist.`);
    }
    const storedNode = graph.nodes.find((node) => node.id === input.nodeId);
    if (!storedNode) {
      throw new Error(`Node "${input.nodeId}" does not exist in graph "${input.graphId}".`);
    }

    const effectiveNode = getEffectiveNode(input.project, storedNode);
    if (!this.#catalog.canResolveNodeType(effectiveNode.type)) {
      throw new Error(`Node type "${effectiveNode.type}" has no captured pure port adapter.`);
    }

    const nodesById = getEffectiveNodesById(input.project, graph.nodes);
    nodesById[input.nodeId] = effectiveNode;
    const incidentConnections = graph.connections.filter(
      (connection) => connection.inputNodeId === input.nodeId || connection.outputNodeId === input.nodeId,
    );
    const instance = this.#registry.createDynamicImpl(effectiveNode);
    return {
      inputs: instance.getInputDefinitionsIncludingBuiltIn(
        incidentConnections,
        nodesById,
        input.project as Project,
        this.#referencedProjects,
      ),
      outputs: instance.getOutputDefinitions(
        incidentConnections,
        nodesById,
        input.project as Project,
        this.#referencedProjects,
      ),
    };
  }

  #validateConnectionWithoutTopology(
    graphId: GraphId,
    connection: NodeConnection,
    project: GraphBuilderAuthoringProject,
  ): GraphValidationResult {
    const graph = project.graphs[graphId];
    if (!graph) {
      return validation([
        diagnostic({
          key: `connection:missing-graph:${graphId}`,
          ruleId: 'graph-existence',
          graphId,
          message: 'The graph containing this connection does not exist.',
        }),
      ]);
    }

    const nodesById = toNodesById(graph.nodes);
    const outputNode = nodesById[connection.outputNodeId];
    const inputNode = nodesById[connection.inputNodeId];
    if (!outputNode || !inputNode) {
      return validation([
        diagnostic({
          key: `connection:missing-node:${graphId}:${connection.outputNodeId}:${connection.inputNodeId}`,
          ruleId: 'connection-node-existence',
          graphId,
          message: 'Both connection endpoints must reference existing nodes.',
        }),
      ]);
    }

    let outputPorts: RichResolvedNodePorts;
    let inputPorts: RichResolvedNodePorts;
    try {
      outputPorts = this.#resolveRichPorts({ graphId, nodeId: outputNode.id, project });
      inputPorts = this.#resolveRichPorts({ graphId, nodeId: inputNode.id, project });
    } catch {
      return validation(
        [
          diagnostic({
            key: `connection:unresolved-ports:${graphId}:${outputNode.id}:${inputNode.id}`,
            ruleId: 'captured-port-resolution',
            graphId,
            message: 'A connection endpoint could not be resolved through its captured pure port adapter.',
            verification: 'unverified',
          }),
        ],
        'incomplete',
      );
    }

    const outputPort = outputPorts.outputs.find((port) => port.id === connection.outputId);
    const inputPort = inputPorts.inputs.find((port) => port.id === connection.inputId);
    if (!outputPort || !inputPort) {
      return validation([
        diagnostic({
          key: `connection:missing-port:${graphId}:${outputNode.id}:${inputNode.id}`,
          ruleId: 'connection-port-existence',
          graphId,
          nodeId: outputPort ? inputNode.id : outputNode.id,
          portId: outputPort ? connection.inputId : connection.outputId,
          message: 'A connection endpoint is absent from the current dynamic port definitions.',
        }),
      ]);
    }

    const compatibility = getPortCompatibilityStatus({
      draggingDataType: outputPort.dataType,
      portDataType: inputPort.dataType,
      canCoerce: inputPort.coerced === true,
      isInput: true,
    });
    if (compatibility === 'compatible' || compatibility === 'coerced') {
      return validation([]);
    }
    return validation([
      diagnostic({
        key: `connection:type:${graphId}:${outputNode.id}:${inputNode.id}`,
        ruleId: 'connection-data-type',
        graphId,
        nodeId: inputNode.id,
        portId: inputPort.id,
        message: `Output type ${JSON.stringify(outputPort.dataType)} is incompatible with input type ${JSON.stringify(inputPort.dataType)}.`,
      }),
    ]);
  }
}

export function createAppGraphBuilderAuthoringSemantics(
  options: CreateGraphBuilderAuthoringSemanticsOptions,
): AppGraphBuilderAuthoringSemantics {
  return new AppGraphBuilderAuthoringSemantics(options);
}
