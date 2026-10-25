import { type ChartNode } from './NodeBase.js';
import { type NodeImplConstructor, type NodeImpl, type PluginNodeImpl, PluginNodeImplClass } from './NodeImpl.js';
import { values } from '../utils/typeSafety.js';
import type { NodeDefinition, PluginNodeDefinition } from './NodeDefinition.js';
import { type RivetPlugin } from './RivetPlugin.js';
import { type RivetUIContext } from './RivetUIContext.js';

type RegisteredNodeInfo<T extends ChartNode> = {
  displayName: string;
  impl: NodeImplConstructor<T>;
  plugin?: RivetPlugin;
  pluginImpl?: PluginNodeImpl<T>;
};

export class NodeRegistration<NodeTypes extends string = never, Nodes extends ChartNode = never> {
  NodesType: Nodes = undefined!;
  NodeTypesType: NodeTypes = undefined!;

  #infos = {} as Record<NodeTypes, RegisteredNodeInfo<ChartNode>>;

  readonly #plugins = [] as RivetPlugin[];

  #implsMap = {} as Record<string, { impl: NodeImplConstructor<ChartNode>; pluginImpl?: PluginNodeImpl<ChartNode> }>;
  readonly #nodeTypes = [] as NodeTypes[];

  #toDynamicConstructor<T extends ChartNode>(impl: NodeImplConstructor<T>): NodeImplConstructor<ChartNode> {
    return impl as unknown as NodeImplConstructor<ChartNode>;
  }

  #toDynamicPluginImpl<T extends ChartNode>(pluginImpl: PluginNodeImpl<T>): PluginNodeImpl<ChartNode> {
    return pluginImpl as unknown as PluginNodeImpl<ChartNode>;
  }

  #getInfo<T extends NodeTypes>(type: T): RegisteredNodeInfo<Extract<Nodes, { type: T }>> {
    const info = this.#infos[type];
    if (!info) {
      throw new Error(`Unknown node type: ${type}`);
    }

    return info as unknown as RegisteredNodeInfo<Extract<Nodes, { type: T }>>;
  }

  register<T extends ChartNode>(
    definition: NodeDefinition<T>,
    plugin?: RivetPlugin,
  ): NodeRegistration<NodeTypes | T['type'], Nodes | T> {
    const newRegistration = this as NodeRegistration<NodeTypes | T['type'], Nodes | T>;

    const typeStr = definition.impl.create(undefined).type as T['type'];

    if (newRegistration.#infos[typeStr]) {
      throw new Error(`Duplicate node type: ${typeStr}`);
    }

    newRegistration.#infos[typeStr] = {
      displayName: definition.displayName,
      impl: definition.impl as unknown as NodeImplConstructor<ChartNode>,
      plugin,
    };

    newRegistration.#implsMap[typeStr] = {
      impl: this.#toDynamicConstructor(definition.impl),
      pluginImpl: undefined,
    };

    newRegistration.#nodeTypes.push(typeStr);

    return newRegistration;
  }

  registerPluginNode<T extends ChartNode>(
    definition: PluginNodeDefinition<T>,
    plugin: RivetPlugin,
  ): NodeRegistration<NodeTypes | T['type'], Nodes | T> {
    const newRegistration = this as NodeRegistration<NodeTypes | T['type'], Nodes | T>;

    const typeStr = definition.impl.create().type as T['type'];

    if (newRegistration.#infos[typeStr]) {
      throw new Error(`Duplicate node type: ${typeStr}`);
    }

    const pluginClass = class extends PluginNodeImplClass<T> {
      constructor(chartNode: T, impl?: PluginNodeImpl<T>) {
        if (!impl) {
          throw new Error(`Missing plugin implementation for node type: ${typeStr}`);
        }

        super(chartNode, impl);
      }

      static create() {
        return definition.impl.create();
      }

      static getUIData(context: RivetUIContext) {
        return definition.impl.getUIData(context);
      }
    };

    newRegistration.#infos[typeStr] = {
      displayName: definition.displayName,
      impl: this.#toDynamicConstructor(pluginClass),
      plugin,
      pluginImpl: this.#toDynamicPluginImpl(definition.impl),
    };

    newRegistration.#implsMap[typeStr] = {
      impl: this.#toDynamicConstructor(pluginClass),
      pluginImpl: this.#toDynamicPluginImpl(definition.impl),
    };

    newRegistration.#nodeTypes.push(typeStr);

    return newRegistration;
  }

  get #dynamicImpls(): Record<
    string,
    { impl: NodeImplConstructor<ChartNode>; pluginImpl?: PluginNodeImpl<ChartNode> }
  > {
    return this.#implsMap;
  }

  registerPlugin(plugin: RivetPlugin) {
    if (plugin.register) {
      plugin.register((definition) => this.registerPluginNode(definition, plugin));
    }
    this.#plugins.push(plugin);
  }

  create<T extends NodeTypes>(type: T): Extract<Nodes, { type: T }> {
    const info = this.#getInfo(type);
    return info.impl.create(info.pluginImpl);
  }

  createDynamic(type: string): ChartNode {
    const implClass = this.#dynamicImpls[type];
    if (!implClass) {
      throw new Error(`Unknown node type: ${type}`);
    }
    return implClass.impl.create(implClass.pluginImpl);
  }

  createImpl<TType extends NodeTypes>(
    node: Extract<Nodes, { type: TType }>,
  ): NodeImpl<Extract<Nodes, { type: TType }>> {
    const info = this.#getInfo(node.type);
    return new info.impl(node, info.pluginImpl);
  }

  createDynamicImpl(node: ChartNode): NodeImpl<ChartNode> {
    const { type } = node;
    const ImplClass = this.#dynamicImpls[type];

    if (!ImplClass) {
      throw new Error(`Unknown node type: ${type}`);
    }

    const impl = new ImplClass.impl(node, ImplClass.pluginImpl);
    if (!impl) {
      throw new Error(`Unknown node type: ${type}`);
    }

    return impl;
  }

  getDisplayName<T extends NodeTypes>(type: T): string {
    return this.#getInfo(type).displayName;
  }

  getDynamicDisplayName(type: string) {
    const displayName = Object.hasOwn(this.#infos, type) ? this.#infos[type as NodeTypes].displayName : undefined;
    if (!displayName) {
      throw new Error(`Unknown node type: ${type}`);
    }

    return displayName;
  }

  isRegistered(type: NodeTypes): boolean {
    return this.#infos[type] !== undefined;
  }

  getNodeTypes(): NodeTypes[] {
    return this.#nodeTypes;
  }

  getNodeConstructors(): NodeImplConstructor<ChartNode>[] {
    return values(this.#dynamicImpls).map((info) => info.impl);
  }

  getPluginFor(type: string): RivetPlugin | undefined {
    const info = this.#infos[type as NodeTypes];

    if (!info) {
      throw new Error(`Unknown node type: ${type}`);
    }

    return info.plugin;
  }

  getPlugins() {
    return this.#plugins;
  }
}
