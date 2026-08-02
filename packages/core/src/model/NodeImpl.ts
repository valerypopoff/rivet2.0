import type { Inputs, Outputs } from './GraphProcessor.js';
import {
  IF_PORT,
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from './NodeBase.js';
import type { Project, ProjectId } from './Project.js';
import type { InternalProcessContext } from './ProcessContext.js';
import type { EditorDefinition } from './EditorDefinition.js';
import type { NodeBodySpec } from './NodeBodySpec.js';
import type { RivetUIContext } from './RivetUIContext.js';
import type { GraphBoundary } from './GraphBoundaryCache.js';
import type { GraphId } from './NodeGraph.js';

export type NodeDefinitionContext = {
  getGraphBoundary: (project: Project, graphId: GraphId | undefined) => GraphBoundary | undefined;
};

export interface PluginNodeImpl<T extends ChartNode> {
  getInputDefinitions(
    data: T['data'],
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
  ): NodeInputDefinition[];

  getOutputDefinitions(
    data: T['data'],
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
  ): NodeOutputDefinition[];

  process(data: T['data'], inputData: Inputs, context: InternalProcessContext): Promise<Outputs>;

  getEditors(data: T['data'], context: RivetUIContext): EditorDefinition<T>[] | Promise<EditorDefinition<T>[]>;

  getBody(data: T['data'], context: RivetUIContext): NodeBody | Promise<NodeBody>;

  create(): T;

  getUIData(context: RivetUIContext): NodeUIData | Promise<NodeUIData>;

  /** Optional metadata-only presentation hints for the editor Run Activity view. */
  getRunActivityDescriptor?(data: T['data']): NodeRunActivityDescriptor;
}

export type NodeRunActivityDescriptor = {
  category?: 'generic' | 'model' | 'tool';
  /** Preferred output to preview without changing execution or serialization. */
  primaryOutputPortId?: PortId;
  /** Small context inputs that are useful to label an invocation. */
  contextInputPortIds?: PortId[];
};

export abstract class NodeImpl<T extends ChartNode, Type extends T['type'] = T['type']> {
  readonly chartNode: T;

  constructor(chartNode: T) {
    this.chartNode = chartNode;
  }

  get id(): string {
    return this.chartNode.id;
  }

  get type(): Type {
    return this.chartNode.type as Type;
  }

  get title(): string {
    return this.chartNode.title;
  }

  get visualData(): { x: number; y: number } {
    return this.chartNode.visualData;
  }

  get data(): T['data'] {
    return this.chartNode.data;
  }

  abstract getInputDefinitions(
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeInputDefinition[];

  getInputDefinitionsIncludingBuiltIn(
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeInputDefinition[] {
    const ports = definitionContext
      ? [...this.getInputDefinitions(connections, nodes, project, referencedProjects, definitionContext)]
      : [...this.getInputDefinitions(connections, nodes, project, referencedProjects)];

    if (this.chartNode.isConditional) {
      ports.push(IF_PORT);
    }

    return ports;
  }

  abstract getOutputDefinitions(
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
    referencedProjects: Record<ProjectId, Project>,
    definitionContext?: NodeDefinitionContext,
  ): NodeOutputDefinition[];

  abstract process(inputData: Inputs, context: InternalProcessContext): Promise<Outputs>;

  getEditors(_context: RivetUIContext): EditorDefinition<T>[] | Promise<EditorDefinition<T>[]> {
    return [];
  }

  getBody(_context: RivetUIContext): NodeBody | Promise<NodeBody> {
    return undefined;
  }

  getRunActivityDescriptor(): NodeRunActivityDescriptor | undefined {
    return undefined;
  }
}

export type NodeBody = string | NodeBodySpec | NodeBodySpec[] | undefined;

export class PluginNodeImplClass<T extends ChartNode, Type extends T['type'] = T['type']> extends NodeImpl<T, Type> {
  readonly impl: PluginNodeImpl<T>;

  constructor(chartNode: T, impl: PluginNodeImpl<T>) {
    super(chartNode);
    this.impl = impl;
  }

  getInputDefinitions(
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
    _referencedProjects?: Record<ProjectId, Project>,
    _definitionContext?: NodeDefinitionContext,
  ): NodeInputDefinition[] {
    return this.impl.getInputDefinitions(this.data, connections, nodes, project);
  }

  getOutputDefinitions(
    connections: NodeConnection[],
    nodes: Record<NodeId, ChartNode>,
    project: Project,
    _referencedProjects?: Record<ProjectId, Project>,
    _definitionContext?: NodeDefinitionContext,
  ): NodeOutputDefinition[] {
    return this.impl.getOutputDefinitions(this.data, connections, nodes, project);
  }

  process(inputData: Inputs, context: InternalProcessContext): Promise<Outputs> {
    return this.impl.process(this.data, inputData, context);
  }

  getEditors(context: RivetUIContext): EditorDefinition<T>[] | Promise<EditorDefinition<T>[]> {
    return this.impl.getEditors(this.data, context);
  }

  getBody(context: RivetUIContext): NodeBody | Promise<NodeBody> {
    return this.impl.getBody(this.data, context);
  }

  getRunActivityDescriptor(): NodeRunActivityDescriptor | undefined {
    return this.impl.getRunActivityDescriptor?.(this.data);
  }
}

export type NodeUIData = {
  contextMenuTitle?: string;
  infoBoxTitle?: string;
  infoBoxBody?: string;
  infoBoxImageUri?: string;
  group?: string | string[];
};

export type NodeImplConstructor<T extends ChartNode> = {
  new (chartNode: T, pluginImpl: PluginNodeImpl<T> | undefined): NodeImpl<T>;

  create(pluginImpl?: PluginNodeImpl<T>): T;

  getUIData(context: RivetUIContext): NodeUIData | Promise<NodeUIData>;
};
