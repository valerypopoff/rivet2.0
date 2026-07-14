import { nanoid } from 'nanoid';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { NodeImpl } from '../NodeImpl.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import {
  type GptFunction,
  type Inputs,
  type InternalProcessContext,
  type NodeUIData,
  type Outputs,
} from '../../index.js';

import { type MCP } from '../../integrations/mcp/MCPProvider.js';

import { dedent } from '../../utils/index.js';
import { nodeDefinition } from '../NodeDefinition.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import {
  getMCPBaseBody,
  getMCPBaseInputs,
  getMCPClientEditors,
  getMCPServerEditors,
  requireMCPProvider,
  resolveMCPServer,
  type MCPBaseNodeData,
} from '../../integrations/mcp/MCPBase.js';

type MCPDiscoveryNode = ChartNode<'mcpDiscovery', MCPDiscoveryNodeData>;

export type MCPDiscoveryNodeData = MCPBaseNodeData & { useToolsOutput?: boolean; usePromptsOutput?: boolean };

class MCPDiscoveryNodeImpl extends NodeImpl<MCPDiscoveryNode> {
  static create(): MCPDiscoveryNode {
    const chartNode: MCPDiscoveryNode = {
      type: 'mcpDiscovery',
      title: 'MCP Discovery',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        name: 'mcp-client',
        version: '1.0.0',
        transportType: 'stdio',
        serverUrl: 'http://localhost:8080/mcp',
        serverId: '',
        useNameInput: false,
        useVersionInput: false,
        useToolsOutput: true,
        usePromptsOutput: true,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return getMCPBaseInputs(this.data);
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputDefinitions: NodeOutputDefinition[] = [];

    if (this.data.useToolsOutput) {
      outputDefinitions.push({
        id: 'tools' as PortId,
        title: 'Tools',
        dataType: 'object[]',
        description: 'Tools returned from the MCP server',
      });
    }

    if (this.data.usePromptsOutput) {
      outputDefinitions.push({
        id: 'prompts' as PortId,
        title: 'Prompts',
        dataType: 'object[]',
        description: 'Prompts returned from the MCP server',
      });
    }
    return outputDefinitions;
  }

  async getEditors(context: RivetUIContext): Promise<EditorDefinition<MCPDiscoveryNode>[]> {
    const editors: EditorDefinition<MCPDiscoveryNode>[] = [
      {
        type: 'toggle',
        label: 'Output Tools',
        dataKey: 'useToolsOutput',
        helperMessage: 'Toggle on if you want to get a Tools output',
      },
      {
        type: 'toggle',
        label: 'Output Prompts',
        dataKey: 'usePromptsOutput',
        helperMessage: 'Toggle on if you want to get a Prompts output',
      },
      ...getMCPClientEditors<MCPDiscoveryNode>(),
    ];

    editors.push(
      ...(await getMCPServerEditors<MCPDiscoveryNode>(context, this.data, {
        httpServerUrlHelperMessage: 'The base URL endpoint for the MCP server with `/mcp`',
      })),
    );
    return editors;
  }

  getBody(context: RivetUIContext): string {
    return getMCPBaseBody(this.data, context);
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Connects to an MCP (Model Context Protocol) server to discover capabilities like tools and prompts.
      `,
      infoBoxTitle: 'MCP Discovery Node',
      contextMenuTitle: 'MCP Discovery',
      group: ['MCP'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    let tools: MCP.Tool[] = [];
    let prompts: MCP.Prompt[] = [];

    try {
      const mcpProvider = requireMCPProvider(context);
      const server = await resolveMCPServer(this.data, inputs, context);

      if (server?.transportType === 'http') {
        tools = this.data.useToolsOutput ? await mcpProvider.getHTTPTools(server.clientConfig, server.serverUrl) : [];
        prompts = this.data.usePromptsOutput
          ? await mcpProvider.getHTTPPrompts(server.clientConfig, server.serverUrl)
          : [];
      } else if (server?.transportType === 'stdio') {
        tools = this.data.useToolsOutput
          ? await mcpProvider.getStdioTools(server.clientConfig, server.serverConfig)
          : [];
        prompts = this.data.usePromptsOutput
          ? await mcpProvider.getStdioPrompts(server.clientConfig, server.serverConfig)
          : [];
      }

      const output: Outputs = {};

      const gptFunctions: GptFunction[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        strict: false,
      }));

      if (this.data.useToolsOutput) {
        output['tools' as PortId] = {
          type: 'gpt-function[]',
          value: gptFunctions,
        };
      }

      if (this.data.usePromptsOutput) {
        output['prompts' as PortId] = {
          type: 'object[]',
          value: prompts.map((prompt) => ({
            name: prompt.name,
            description: prompt.description,
            arguments: prompt.arugments,
          })),
        };
      }

      return output;
    } catch (err) {
      if (context.executor === 'browser') {
        throw new Error('Failed to create Client without Node Executor');
      }

      throw err;
    }
  }
}

export const mcpDiscoveryNode = nodeDefinition(MCPDiscoveryNodeImpl, 'MCP Discovery');
