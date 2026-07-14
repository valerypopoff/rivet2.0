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

import { type EditorDefinition, type InternalProcessContext } from '../../index.js';

import { MCPError, MCPErrorType, type MCP } from '../../integrations/mcp/MCPProvider.js';

import { dedent, getInputOrData } from '../../utils/index.js';
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

export type MCPGetPromptNode = ChartNode<'mcpGetPrompt', MCPGetPromptNodeData>;

export type MCPGetPromptNodeData = MCPBaseNodeData & {
  promptName: string;
  promptArguments?: string;

  usePromptNameInput?: boolean;
  usePromptArgumentsInput?: boolean;
};

export class MCPGetPromptNodeImpl extends NodeImpl<MCPGetPromptNode> {
  static create(): MCPGetPromptNode {
    const chartNode: MCPGetPromptNode = {
      type: 'mcpGetPrompt',
      title: 'MCP Get Prompt',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        name: 'mcp-get-prompt-client',
        version: '1.0.0',
        transportType: 'stdio',
        serverUrl: 'http://localhost:8080/mcp',
        serverId: '',
        promptName: '',
        promptArguments: dedent`
        {
          "key": "value"
        }`,
        useNameInput: false,
        useVersionInput: false,
        usePromptNameInput: false,
        usePromptArgumentsInput: false,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = getMCPBaseInputs(this.data);

    if (this.data.usePromptNameInput) {
      inputs.push({
        dataType: 'string',
        id: 'promptName' as PortId,
        title: 'Prompt Name',
      });
    }

    if (this.data.usePromptArgumentsInput) {
      inputs.push({
        dataType: 'object',
        id: 'promptArguments' as PortId,
        title: 'Prompt Arguments',
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputDefinitions: NodeOutputDefinition[] = [];

    outputDefinitions.push({
      id: 'prompt' as PortId,
      title: 'Prompt',
      dataType: 'object',
      description: 'Prompt response result',
    });

    return outputDefinitions;
  }

  async getEditors(context: RivetUIContext): Promise<EditorDefinition<MCPGetPromptNode>[]> {
    const editors: EditorDefinition<MCPGetPromptNode>[] = [
      ...getMCPClientEditors<MCPGetPromptNode>(),
      {
        type: 'string',
        label: 'Prompt Name',
        dataKey: 'promptName',
        useInputToggleDataKey: 'usePromptNameInput',
        helperMessage: 'The name for the MCP prompt',
      },
      {
        type: 'code',
        label: 'Prompt Arguments',
        dataKey: 'promptArguments',
        useInputToggleDataKey: 'usePromptArgumentsInput',
        language: 'json',
        helperMessage: 'Arguments to provide the prompt',
        enableFolding: true,
      },
    ];

    editors.push(...(await getMCPServerEditors<MCPGetPromptNode>(context, this.data)));

    return editors;
  }

  getBody(context: RivetUIContext): string {
    return getMCPBaseBody(this.data, context);
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Connects to an MCP (Model Context Protocol) server and gets a prompt response.
      `,
      infoBoxTitle: 'MCP Get Prompt Node',
      contextMenuTitle: 'MCP Get Prompt',
      group: ['MCP'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const promptName = getInputOrData(this.data, inputs, 'promptName', 'string');

    let promptArguments;

    if (this.data.usePromptArgumentsInput) {
      promptArguments = getInputOrData(this.data, inputs, 'promptArguments', 'object');

      if (promptArguments == null) {
        throw new MCPError(MCPErrorType.INVALID_SCHEMA, 'Cannot parse tool argument with input toggle on');
      }
    } else {
      promptArguments = JSON.parse(interpolateMCPArgumentTemplate(this.data.promptArguments ?? '', inputs));
    }

    const getPromptRequest: MCP.GetPromptRequest = {
      name: promptName,
      arguments: promptArguments,
    };

    let getPromptResponse: MCP.GetPromptResponse | undefined = undefined;

    try {
      const mcpProvider = requireMCPProvider(context);
      const server = await resolveMCPServer(this.data, inputs, context);

      if (server?.transportType === 'http') {
        getPromptResponse = await mcpProvider.getHTTPrompt(server.clientConfig, server.serverUrl, getPromptRequest);
      } else if (server?.transportType === 'stdio') {
        getPromptResponse = await mcpProvider.getStdioPrompt(
          server.clientConfig,
          server.serverConfig,
          getPromptRequest,
        );
      }

      const output: Outputs = {};

      output['prompt' as PortId] = {
        type: 'object',
        value: getPromptResponse as unknown as Record<string, unknown>,
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

export const mcpGetPromptNode = nodeDefinition(MCPGetPromptNodeImpl, 'MCP Get Prompt');
