import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';

import { type InternalProcessContext } from '../../index.js';

import { MCPError, MCPErrorType, type MCP } from '../../integrations/mcp/MCPProvider.js';

import { getInputOrData } from '../../utils/index.js';
import { getError } from '../../utils/errors.js';
import {
  getMCPBaseBody,
  getMCPBaseInputs,
  getMCPClientEditors,
  getMCPServerEditors,
  interpolateMCPArgumentTemplate,
  requireMCPProvider,
  resolveMCPServer,
  type MCPBaseNodeData,
} from '../../integrations/mcp/MCPBase.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import { dedent } from 'ts-dedent';
import { type EditorDefinition } from '../EditorDefinition.js';

export type MCPToolCallNode = ChartNode<'mcpToolCall', MCPToolCallNodeData>;

export type MCPToolCallNodeData = MCPBaseNodeData & {
  toolName: string;
  toolArguments?: string;
  toolCallId?: string;

  useToolNameInput?: boolean;
  useToolArgumentsInput?: boolean;
  useToolCallIdInput?: boolean;
};

export class MCPToolCallNodeImpl extends NodeImpl<MCPToolCallNode> {
  static create(): MCPToolCallNode {
    const chartNode: MCPToolCallNode = {
      type: 'mcpToolCall',
      title: 'MCP Tool Call',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        name: 'mcp-tool-call-client',
        version: '1.0.0',
        transportType: 'stdio',
        serverUrl: 'http://localhost:8080/mcp',
        serverId: '',
        toolName: '',
        toolArguments: dedent`
        {
          "key": "value"
        }`,
        toolCallId: '',
        useNameInput: false,
        useVersionInput: false,
        useToolNameInput: true,
        useToolArgumentsInput: true,
        useToolCallIdInput: true,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = getMCPBaseInputs(this.data);

    if (this.data.useToolNameInput) {
      inputs.push({
        dataType: 'string',
        id: 'toolName' as PortId,
        title: 'Tool Name',
      });
    }

    if (this.data.useToolArgumentsInput) {
      inputs.push({
        dataType: 'object',
        id: 'toolArguments' as PortId,
        title: 'Tool Arguments',
      });
    }

    if (this.data.useToolCallIdInput) {
      inputs.push({
        dataType: 'object',
        id: 'toolCallId' as PortId,
        title: 'Tool ID',
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputDefinitions: NodeOutputDefinition[] = [];

    outputDefinitions.push({
      id: 'response' as PortId,
      title: 'Response',
      dataType: 'object',
      description: 'Response from the Tool Call',
    });

    outputDefinitions.push({
      id: 'toolCallId' as PortId,
      title: 'Tool ID',
      dataType: 'string',
      description: 'ID associated with the Tool Call',
    });

    return outputDefinitions;
  }

  async getEditors(context: RivetUIContext): Promise<EditorDefinition<MCPToolCallNode>[]> {
    const editors: EditorDefinition<MCPToolCallNode>[] = [
      ...getMCPClientEditors<MCPToolCallNode>(),
      {
        type: 'string',
        label: 'Tool Name',
        dataKey: 'toolName',
        useInputToggleDataKey: 'useToolNameInput',
        helperMessage: 'The name for the MCP Tool Call',
      },
      {
        type: 'code',
        label: 'Tool Arguments',
        dataKey: 'toolArguments',
        language: 'json',
        useInputToggleDataKey: 'useToolArgumentsInput',
        enableFolding: true,
      },
      {
        type: 'string',
        label: 'Tool ID',
        dataKey: 'toolCallId',
        useInputToggleDataKey: 'useToolCallIdInput',
        helperMessage: 'The name for the MCP Tool Call',
      },
    ];

    editors.push(...(await getMCPServerEditors<MCPToolCallNode>(context, this.data)));

    return editors;
  }

  getBody(context: RivetUIContext): string {
    return getMCPBaseBody(this.data, context);
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Connects to an MCP (Model Context Protocol) server and gets a tool call response.
      `,
      infoBoxTitle: 'MCP Tool Call Node',
      contextMenuTitle: 'MCP Tool Call',
      group: ['MCP'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const toolName = getInputOrData(this.data, inputs, 'toolName', 'string');

    const toolCallId = getInputOrData(this.data, inputs, 'toolCallId', 'string');

    let toolArguments;

    if (this.data.useToolArgumentsInput) {
      toolArguments = getInputOrData(this.data, inputs, 'toolArguments', 'object');
      if (toolArguments == null) {
        throw new MCPError(MCPErrorType.INVALID_SCHEMA, 'Cannot parse tool argument with input toggle on');
      }
    } else {
      toolArguments = JSON.parse(interpolateMCPArgumentTemplate(this.data.toolArguments ?? '', inputs));
    }

    const toolCall: MCP.ToolCallRequest = {
      name: toolName,
      arguments: toolArguments,
    };

    let toolResponse: MCP.ToolCallResponse | undefined = undefined;

    try {
      const mcpProvider = requireMCPProvider(context);
      const server = await resolveMCPServer(this.data, inputs, context);

      if (server?.transportType === 'http') {
        toolResponse = await mcpProvider.httpToolCall(server.clientConfig, server.serverUrl, toolCall);
      } else if (server?.transportType === 'stdio') {
        toolResponse = await mcpProvider.stdioToolCall(server.clientConfig, server.serverConfig, toolCall);
      }

      const output: Outputs = {};

      output['response' as PortId] = {
        type: 'object[]',
        value: toolResponse?.content as unknown as Record<string, unknown>[],
      };

      output['toolCallId' as PortId] = {
        type: 'string',
        value: toolCallId,
      };

      return output;
    } catch (err) {
      const { message } = getError(err);
      if (context.executor === 'browser') {
        throw new Error('Failed to create Client without a node executor');
      }
      console.log(message);
      throw err;
    }
  }
}

export const mcpToolCallNode = nodeDefinition(MCPToolCallNodeImpl, 'MCP Tool Call');
