import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  getMCPBaseBody,
  getMCPClientEditors,
  getMCPServerEditors,
  interpolateMCPArgumentTemplate,
  requireMCPProvider,
  resolveMCPServer,
  type MCPBaseNodeData,
} from '../../../src/integrations/mcp/MCPBase.js';
import { MCPError, MCPErrorType, type MCPProvider } from '../../../src/integrations/mcp/MCPProvider.js';
import { mcpDiscoveryNode } from '../../../src/index.js';
import type { Inputs } from '../../../src/model/GraphProcessor.js';
import type { ChartNode } from '../../../src/model/NodeBase.js';
import { MCPGetPromptNodeImpl } from '../../../src/model/nodes/MCPGetPromptNode.js';
import { MCPToolCallNodeImpl } from '../../../src/model/nodes/MCPToolCallNode.js';
import type { InternalProcessContext } from '../../../src/model/ProcessContext.js';
import type { RivetUIContext } from '../../../src/model/RivetUIContext.js';

type MCPTestNode = ChartNode<'mcpTest', MCPBaseNodeData>;

function createData(overrides: Partial<MCPBaseNodeData> = {}): MCPBaseNodeData {
  return {
    name: 'saved-client',
    version: '1.0.0',
    transportType: 'http',
    serverUrl: 'http://localhost:8080/mcp',
    serverId: 'local-server',
    ...overrides,
  };
}

function createContext(mcpServers: Record<string, { command: string }> = {}): InternalProcessContext {
  return {
    executor: 'nodejs',
    project: {
      metadata: {
        mcpServer: { mcpServers },
      },
    },
  } as InternalProcessContext;
}

function editorDataKeys(editors: Awaited<ReturnType<typeof getMCPServerEditors<MCPTestNode>>>): string[] {
  return editors.flatMap((editor) => ('dataKey' in editor ? [editor.dataKey] : []));
}

function createProvider(overrides: Partial<MCPProvider> = {}): MCPProvider {
  return {
    getHTTPTools: async () => [],
    getStdioTools: async () => [],
    getHTTPPrompts: async () => [],
    getStdioPrompts: async () => [],
    httpToolCall: async () => ({ content: [] }),
    stdioToolCall: async () => ({ content: [] }),
    getHTTPrompt: async () => ({ messages: [] }),
    getStdioPrompt: async () => ({ messages: [] }),
    ...overrides,
  };
}

void describe('MCP base behavior', () => {
  void it('keeps the shared client editor order and transport-specific server editor', async () => {
    const clientEditors = getMCPClientEditors<MCPTestNode>();
    assert.deepEqual(editorDataKeys(clientEditors), ['name', 'version', 'transportType']);

    const httpEditors = await getMCPServerEditors<MCPTestNode>({} as RivetUIContext, createData(), {
      httpServerUrlHelperMessage: 'Custom MCP endpoint help',
    });
    assert.deepEqual(editorDataKeys(httpEditors), ['serverUrl']);
    assert.equal(httpEditors[0]?.helperMessage, 'Custom MCP endpoint help');

    const defaultHttpEditors = await getMCPServerEditors<MCPTestNode>({} as RivetUIContext, createData());
    assert.equal(defaultHttpEditors[0]?.helperMessage, 'The endpoint URL for the MCP server to connect');

    const stdioEditors = await getMCPServerEditors<MCPTestNode>(
      { executor: 'browser' } as RivetUIContext,
      createData({ transportType: 'stdio' }),
    );
    assert.deepEqual(editorDataKeys(stdioEditors), ['serverId']);
    assert.equal(stdioEditors[0]?.helperMessage, 'MCP nodes require Node Executor');
  });

  void it('renders the shared node body without changing transport or executor wording', () => {
    assert.equal(
      getMCPBaseBody(createData(), { executor: 'nodejs' } as RivetUIContext),
      'Name: saved-client\nVersion: 1.0.0\nhttp://localhost:8080/mcp',
    );
    assert.equal(
      getMCPBaseBody(createData({ transportType: 'http', useServerUrlInput: true }), {
        executor: 'browser',
      } as RivetUIContext),
      'Name: saved-client\nVersion: 1.0.0\n(Using Server URL Input)\n(Requires Node Executor)',
    );
  });

  void it('resolves HTTP configuration from the same inputs and validates the MCP endpoint', async () => {
    const data = createData({ useNameInput: true, useVersionInput: true, useServerUrlInput: true });
    const inputs = {
      name: { type: 'string', value: 'input-client' },
      version: { type: 'string', value: '2.0.0' },
      serverUrl: { type: 'string', value: 'https://example.test/mcp' },
    } as Inputs;

    assert.deepEqual(await resolveMCPServer(data, inputs, createContext()), {
      transportType: 'http',
      clientConfig: { name: 'input-client', version: '2.0.0' },
      serverUrl: 'https://example.test/mcp',
    });

    await assert.rejects(
      () => resolveMCPServer(createData({ serverUrl: 'https://example.test' }), {} as Inputs, createContext()),
      (error: unknown) =>
        error instanceof MCPError &&
        error.type === MCPErrorType.SERVER_COMMUNICATION_FAILED &&
        error.message.includes('Include /mcp'),
    );

    assert.equal(
      await resolveMCPServer(
        createData({ transportType: 'invalid' as MCPBaseNodeData['transportType'] }),
        {} as Inputs,
        createContext(),
      ),
      undefined,
    );
  });

  void it('resolves STDIO configuration and preserves missing-provider behavior', async () => {
    const context = createContext({ 'local-server': { command: 'node' } });
    assert.deepEqual(await resolveMCPServer(createData({ transportType: 'stdio' }), {} as Inputs, context), {
      transportType: 'stdio',
      clientConfig: { name: 'saved-client', version: '1.0.0' },
      serverConfig: {
        serverId: 'local-server',
        config: { command: 'node' },
      },
    });

    const provider = {} as MCPProvider;
    assert.equal(requireMCPProvider({ ...context, mcpProvider: provider }), provider);
    assert.throws(() => requireMCPProvider(context), /MCP Provider not found/);
  });

  void it('interpolates JSON templates from dynamic MCP input ports', () => {
    const result = interpolateMCPArgumentTemplate('{"greeting":"Hello {{name}}"}', {
      'input-name': { type: 'string', value: 'Rivet' },
      ignored: { type: 'string', value: 'unused' },
    } as Inputs);

    assert.equal(result, '{"greeting":"Hello Rivet"}');
  });

  void it('keeps MCP Tool Call on the shared HTTP resolver', async () => {
    let invocation: unknown;
    const provider = createProvider({
      httpToolCall: async (clientConfig, serverUrl, toolCall) => {
        invocation = { clientConfig, serverUrl, toolCall };
        return { content: [] };
      },
    });
    const node = MCPToolCallNodeImpl.create();
    Object.assign(node.data, {
      transportType: 'http',
      serverUrl: 'https://example.test/mcp',
      toolName: 'echo',
      toolArguments: '{"message":"{{message}}"}',
      toolCallId: 'call-1',
      useToolNameInput: false,
      useToolArgumentsInput: false,
      useToolCallIdInput: false,
    });

    await new MCPToolCallNodeImpl(node).process({ 'input-message': { type: 'string', value: 'Hello' } } as Inputs, {
      ...createContext(),
      mcpProvider: provider,
    });

    assert.deepEqual(invocation, {
      clientConfig: { name: 'mcp-tool-call-client', version: '1.0.0' },
      serverUrl: 'https://example.test/mcp',
      toolCall: { name: 'echo', arguments: { message: 'Hello' } },
    });
  });

  void it('keeps MCP Get Prompt on the shared STDIO resolver', async () => {
    let invocation: unknown;
    const provider = createProvider({
      getStdioPrompt: async (clientConfig, serverConfig, request) => {
        invocation = { clientConfig, serverConfig, request };
        return { messages: [] };
      },
    });
    const node = MCPGetPromptNodeImpl.create();
    Object.assign(node.data, {
      transportType: 'stdio',
      serverId: 'local-server',
      promptName: 'summarize',
      promptArguments: '{"subject":"{{subject}}"}',
      usePromptNameInput: false,
      usePromptArgumentsInput: false,
    });

    await new MCPGetPromptNodeImpl(node).process({ 'input-subject': { type: 'string', value: 'Rivet' } } as Inputs, {
      ...createContext({ 'local-server': { command: 'node' } }),
      mcpProvider: provider,
    });

    assert.deepEqual(invocation, {
      clientConfig: { name: 'mcp-get-prompt-client', version: '1.0.0' },
      serverConfig: { serverId: 'local-server', config: { command: 'node' } },
      request: { name: 'summarize', arguments: { subject: 'Rivet' } },
    });
  });

  void it('keeps MCP Discovery on the shared HTTP resolver', async () => {
    const calls: string[] = [];
    const provider = createProvider({
      getHTTPTools: async (clientConfig, serverUrl) => {
        calls.push(`tools:${clientConfig.name}:${serverUrl}`);
        return [];
      },
      getHTTPPrompts: async (clientConfig, serverUrl) => {
        calls.push(`prompts:${clientConfig.name}:${serverUrl}`);
        return [];
      },
    });
    const node = mcpDiscoveryNode.impl.create();
    Object.assign(node.data, {
      transportType: 'http',
      serverUrl: 'https://example.test/mcp',
      useToolsOutput: true,
      usePromptsOutput: true,
    });

    await new mcpDiscoveryNode.impl(node).process({} as Inputs, { ...createContext(), mcpProvider: provider });

    assert.deepEqual(calls, [
      'tools:mcp-client:https://example.test/mcp',
      'prompts:mcp-client:https://example.test/mcp',
    ]);
  });
});
