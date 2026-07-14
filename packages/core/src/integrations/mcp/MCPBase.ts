import type { EditorDefinition } from '../../model/EditorDefinition.js';
import type { Inputs } from '../../model/GraphProcessor.js';
import type { ChartNode, NodeInputDefinition, PortId } from '../../model/NodeBase.js';
import type { InternalProcessContext } from '../../model/ProcessContext.js';
import type { RivetUIContext } from '../../model/RivetUIContext.js';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/inputs.js';
import { interpolate } from '../../utils/interpolation.js';
import { keys } from '../../utils/typeSafety.js';
import { MCPError, MCPErrorType, type MCP, type MCPProvider } from './MCPProvider.js';
import { getServerHelperMessage, getServerOptions, loadMCPConfiguration } from './MCPUtils.js';

export interface MCPBaseNodeData {
  name: string;
  version: string;
  transportType: MCP.TransportType;
  serverUrl?: string;
  serverId?: string;

  // Input toggles
  useNameInput?: boolean;
  useVersionInput?: boolean;
  useServerUrlInput?: boolean;
  useServerIdInput?: boolean;
}

export type MCPResolvedServer =
  | {
      transportType: 'http';
      clientConfig: { name: string; version: string };
      serverUrl: string;
    }
  | {
      transportType: 'stdio';
      clientConfig: { name: string; version: string };
      serverConfig: MCP.ServerConfigWithId;
    };

export const getMCPBaseInputs = (data: MCPBaseNodeData) => {
  const inputs: NodeInputDefinition[] = [];

  if (data.useNameInput) {
    inputs.push({
      dataType: 'string',
      id: 'name' as PortId,
      title: 'Name',
    });
  }

  if (data.useVersionInput) {
    inputs.push({
      dataType: 'string',
      id: 'version' as PortId,
      title: 'Version',
    });
  }

  if (data.transportType === 'http' && data.useServerUrlInput) {
    inputs.push({
      dataType: 'string',
      id: 'serverUrl' as PortId,
      title: 'Server URL',
      description: 'The endpoint URL for the MCP server',
    });
  }

  return inputs;
};

export function getMCPClientEditors<T extends ChartNode<string, MCPBaseNodeData>>(): EditorDefinition<T>[] {
  return [
    {
      type: 'string',
      label: 'Name',
      dataKey: 'name',
      useInputToggleDataKey: 'useNameInput',
      helperMessage: 'The name for the MCP Client',
    },
    {
      type: 'string',
      label: 'Version',
      dataKey: 'version',
      useInputToggleDataKey: 'useVersionInput',
      helperMessage: 'A version for the MCP Client',
    },
    {
      type: 'dropdown',
      label: 'Transport Type',
      dataKey: 'transportType',
      options: [
        { label: 'HTTP', value: 'http' },
        { label: 'STDIO', value: 'stdio' },
      ],
    },
  ] as EditorDefinition<T>[];
}

export async function getMCPServerEditors<T extends ChartNode<string, MCPBaseNodeData>>(
  context: RivetUIContext,
  data: T['data'],
  options: { httpServerUrlHelperMessage?: string } = {},
): Promise<EditorDefinition<T>[]> {
  if (data.transportType === 'http') {
    return [
      {
        type: 'string',
        label: 'Server URL',
        dataKey: 'serverUrl',
        useInputToggleDataKey: 'useServerUrlInput',
        helperMessage: options.httpServerUrlHelperMessage ?? 'The endpoint URL for the MCP server to connect',
      },
    ] as EditorDefinition<T>[];
  }

  if (data.transportType === 'stdio') {
    const serverOptions = await getServerOptions(context);

    return [
      {
        type: 'dropdown',
        label: 'Server ID',
        dataKey: 'serverId',
        helperMessage: getServerHelperMessage(context, serverOptions.length),
        options: serverOptions,
      },
    ] as EditorDefinition<T>[];
  }

  return [];
}

export function getMCPBaseBody(data: MCPBaseNodeData, context: RivetUIContext): string {
  const server =
    data.transportType === 'http'
      ? data.useServerUrlInput
        ? '(Using Server URL Input)'
        : data.serverUrl
      : `Server ID: ${data.serverId || '(None)'}`;
  const parts = [`Name: ${data.name}`, `Version: ${data.version}`, server];

  if (context.executor !== 'nodejs') {
    parts.push('(Requires Node Executor)');
  }

  return parts.join('\n');
}

export function requireMCPProvider(context: InternalProcessContext): MCPProvider {
  if (!context.mcpProvider) {
    throw new Error('MCP Provider not found');
  }

  return context.mcpProvider;
}

export async function resolveMCPServer(
  data: MCPBaseNodeData,
  inputs: Inputs,
  context: InternalProcessContext,
): Promise<MCPResolvedServer | undefined> {
  const clientConfig = {
    name: getInputOrData(data, inputs, 'name', 'string'),
    version: getInputOrData(data, inputs, 'version', 'string'),
  };
  const transportType = getInputOrData(data, inputs, 'transportType', 'string') as MCP.TransportType;

  if (transportType === 'http') {
    const serverUrl = getInputOrData(data, inputs, 'serverUrl', 'string');
    if (!serverUrl || serverUrl === '') {
      throw new MCPError(MCPErrorType.SERVER_NOT_FOUND, 'No server URL was provided');
    }
    if (!serverUrl.includes('/mcp')) {
      throw new MCPError(
        MCPErrorType.SERVER_COMMUNICATION_FAILED,
        'Include /mcp in your server URL. For example: http://localhost:8080/mcp',
      );
    }

    return { transportType, clientConfig, serverUrl };
  }

  if (transportType === 'stdio') {
    const serverId = data.serverId ?? '';
    const mcpConfig = await loadMCPConfiguration(context);
    if (!mcpConfig.mcpServers[serverId]) {
      throw new MCPError(MCPErrorType.SERVER_NOT_FOUND, `Server ${serverId} not found in MCP config`);
    }

    return {
      transportType,
      clientConfig,
      serverConfig: {
        config: mcpConfig.mcpServers[serverId],
        serverId,
      },
    };
  }

  return undefined;
}

export function interpolateMCPArgumentTemplate(template: string, inputs: Inputs): string {
  const values: Record<string, string> = {};

  for (const key of keys(inputs)) {
    if (key.startsWith('input')) {
      values[key.slice('input-'.length)] = coerceTypeOptional(inputs[key], 'string') ?? '';
    }
  }

  return interpolate(template, values);
}
