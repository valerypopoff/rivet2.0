import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NodeMCPProvider, withMcpClient, type NodeMCPProviderDependencies } from '../src/native/NodeMCPProvider.js';

type ClientStubOptions = {
  connectError?: Error;
  operationError?: Error;
  closeError?: Error;
};

function createClientStub(events: string[], name: string, options: ClientStubOptions = {}): Client {
  return {
    async connect() {
      events.push(`${name}:connect`);
      if (options.connectError) throw options.connectError;
    },
    async close() {
      events.push(`${name}:close`);
      if (options.closeError) throw options.closeError;
    },
    async listTools() {
      events.push(`${name}:listTools`);
      if (options.operationError) throw options.operationError;
      return { tools: [{ name: 'tool', description: 'Tool', inputSchema: { type: 'object' } }] };
    },
    async listPrompts() {
      return { prompts: [] };
    },
    async getPrompt() {
      return { messages: [] };
    },
    async callTool() {
      return { content: [] };
    },
  } as unknown as Client;
}

function createDependencies(clients: Client[], transportEvents: string[] = []): NodeMCPProviderDependencies {
  return {
    createClient: () => {
      const client = clients.shift();
      assert.ok(client, 'Unexpected MCP client creation');
      return client;
    },
    createSseTransport: () => {
      transportEvents.push('sse');
      return {} as never;
    },
    createStdioTransport: (parameters) => {
      transportEvents.push(`stdio:${JSON.stringify(parameters)}`);
      return {} as never;
    },
    createStreamableHttpTransport: () => {
      transportEvents.push('streamable');
      return {} as never;
    },
    getDefaultEnvironment: () => ({ PATH: 'inherited', SAFE: 'yes' }),
  };
}

void describe('NodeMCPProvider', () => {
  void it('uses Streamable HTTP without constructing SSE when the first transport connects', async () => {
    const events: string[] = [];
    const transports: string[] = [];
    const provider = new NodeMCPProvider(createDependencies([createClientStub(events, 'streamable')], transports));

    const tools = await provider.getHTTPTools({ name: 'test', version: '1' }, 'https://example.com/mcp');

    assert.equal(tools[0]?.name, 'tool');
    assert.deepEqual(transports, ['streamable']);
    assert.deepEqual(events, ['streamable:connect', 'streamable:listTools', 'streamable:close']);
  });

  void it('closes a failed Streamable HTTP client and retries SSE with a fresh client', async () => {
    const events: string[] = [];
    const transports: string[] = [];
    const provider = new NodeMCPProvider(
      createDependencies(
        [
          createClientStub(events, 'streamable', { connectError: new Error('not streamable') }),
          createClientStub(events, 'sse'),
        ],
        transports,
      ),
    );

    await provider.getHTTPTools({ name: 'test', version: '1' }, 'https://example.com/mcp');

    assert.deepEqual(transports, ['streamable', 'sse']);
    assert.deepEqual(events, ['streamable:connect', 'streamable:close', 'sse:connect', 'sse:listTools', 'sse:close']);
  });

  void it('closes the connected client when an operation fails', async () => {
    const events: string[] = [];
    const operationError = new Error('operation failed');
    const provider = new NodeMCPProvider(createDependencies([createClientStub(events, 'stdio', { operationError })]));

    await assert.rejects(
      provider.getStdioTools(
        { name: 'test', version: '1' },
        { serverId: 'server', config: { command: 'server-command' } },
      ),
      operationError,
    );
    assert.deepEqual(events, ['stdio:connect', 'stdio:listTools', 'stdio:close']);
  });

  void it('merges configured stdio values over the SDK safe inherited environment', async () => {
    const transports: string[] = [];
    const provider = new NodeMCPProvider(createDependencies([createClientStub([], 'stdio')], transports));

    await provider.getStdioTools(
      { name: 'test', version: '1' },
      {
        serverId: 'server',
        config: {
          command: 'server-command',
          args: ['--stdio'],
          env: { SAFE: 'overridden', SECRET: 'configured' },
        },
      },
    );

    assert.deepEqual(JSON.parse(transports[0]!.slice('stdio:'.length)), {
      command: 'server-command',
      args: ['--stdio'],
      env: { PATH: 'inherited', SAFE: 'overridden', SECRET: 'configured' },
    });
  });

  void it('preserves the operation error when closing also fails', async () => {
    const operationError = new Error('operation failed');
    const closeError = new Error('close failed');
    const client = createClientStub([], 'client', { operationError, closeError });

    await assert.rejects(
      withMcpClient(
        async () => client,
        (connected) => connected.listTools(),
      ),
      operationError,
    );
    assert.equal(operationError.cause, closeError);
  });
});
