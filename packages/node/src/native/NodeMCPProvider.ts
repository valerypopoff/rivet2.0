import { type MCP, type MCPProvider } from '@valerypopoff/rivet2-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type ClientConfig = { name: string; version: string };
type ClientTransport = Parameters<Client['connect']>[0];

export interface NodeMCPProviderDependencies {
  createClient(config: ClientConfig): Client;
  createSseTransport(url: URL): ClientTransport;
  createStdioTransport(parameters: StdioServerParameters): ClientTransport;
  createStreamableHttpTransport(url: URL): ClientTransport;
  getDefaultEnvironment(): Record<string, string>;
}

const defaultDependencies: NodeMCPProviderDependencies = {
  createClient: (config) => new Client(config),
  createSseTransport: (url) => new SSEClientTransport(url),
  createStdioTransport: (parameters) => new StdioClientTransport(parameters),
  createStreamableHttpTransport: (url) => new StreamableHTTPClientTransport(url),
  getDefaultEnvironment,
};

function attachCloseError(operationError: unknown, closeError: unknown): void {
  if (!(operationError instanceof Error) || operationError.cause !== undefined) {
    return;
  }

  Object.defineProperty(operationError, 'cause', {
    configurable: true,
    value: closeError,
  });
}

async function closeAfterFailedConnect(client: Client, connectError: unknown): Promise<void> {
  try {
    await client.close();
  } catch (closeError) {
    attachCloseError(connectError, closeError);
  }
}

export async function withMcpClient<T>(createClient: () => Promise<Client>, operation: (client: Client) => Promise<T>) {
  const client = await createClient();
  let operationError: unknown;

  try {
    return await operation(client);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      if (operationError === undefined) {
        throw closeError;
      }
      attachCloseError(operationError, closeError);
    }
  }
}

export class NodeMCPProvider implements MCPProvider {
  readonly #dependencies: NodeMCPProviderDependencies;

  constructor(dependencies: Partial<NodeMCPProviderDependencies> = {}) {
    this.#dependencies = { ...defaultDependencies, ...dependencies };
  }

  async #createHTTPClient(clientConfig: ClientConfig, serverUrl: string): Promise<Client> {
    const url = new URL(serverUrl);
    const streamableClient = this.#dependencies.createClient(clientConfig);

    try {
      await streamableClient.connect(this.#dependencies.createStreamableHttpTransport(url));
      return streamableClient;
    } catch (streamableError) {
      await closeAfterFailedConnect(streamableClient, streamableError);
    }

    const sseClient = this.#dependencies.createClient(clientConfig);
    try {
      await sseClient.connect(this.#dependencies.createSseTransport(url));
      return sseClient;
    } catch (sseError) {
      await closeAfterFailedConnect(sseClient, sseError);
      throw sseError;
    }
  }

  async #createStdioClient(clientConfig: ClientConfig, serverConfig: MCP.ServerConfigWithId): Promise<Client> {
    const client = this.#dependencies.createClient(clientConfig);
    const configuredEnvironment = serverConfig.config.env;
    const transport = this.#dependencies.createStdioTransport({
      command: serverConfig.config.command,
      args: serverConfig.config.args ?? [],
      env: configuredEnvironment
        ? { ...this.#dependencies.getDefaultEnvironment(), ...configuredEnvironment }
        : undefined,
    });

    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      await closeAfterFailedConnect(client, error);
      throw error;
    }
  }

  httpToolCall(
    clientConfig: ClientConfig,
    serverUrl: string,
    toolCall: MCP.ToolCallRequest,
  ): Promise<MCP.ToolCallResponse> {
    return withMcpClient(
      () => this.#createHTTPClient(clientConfig, serverUrl),
      async (client) => {
        const response = await client.callTool(toolCall);
        return { content: response.content, isError: response.isError } as MCP.ToolCallResponse;
      },
    );
  }

  getHTTPTools(clientConfig: ClientConfig, serverUrl: string): Promise<MCP.Tool[]> {
    return withMcpClient(() => this.#createHTTPClient(clientConfig, serverUrl), listTools);
  }

  getHTTPPrompts(clientConfig: ClientConfig, serverUrl: string): Promise<MCP.Prompt[]> {
    return withMcpClient(() => this.#createHTTPClient(clientConfig, serverUrl), listPrompts);
  }

  getHTTPrompt(
    clientConfig: ClientConfig,
    serverUrl: string,
    request: MCP.GetPromptRequest,
  ): Promise<MCP.GetPromptResponse> {
    return withMcpClient(
      () => this.#createHTTPClient(clientConfig, serverUrl),
      (client) => getPrompt(client, request),
    );
  }

  stdioToolCall(
    clientConfig: ClientConfig,
    serverConfig: MCP.ServerConfigWithId,
    toolCall: MCP.ToolCallRequest,
  ): Promise<MCP.ToolCallResponse> {
    return withMcpClient(
      () => this.#createStdioClient(clientConfig, serverConfig),
      async (client) => {
        const response = await client.callTool(toolCall);
        return { content: response.content, isError: response.isError } as MCP.ToolCallResponse;
      },
    );
  }

  getStdioTools(clientConfig: ClientConfig, serverConfig: MCP.ServerConfigWithId): Promise<MCP.Tool[]> {
    return withMcpClient(() => this.#createStdioClient(clientConfig, serverConfig), listTools);
  }

  getStdioPrompts(clientConfig: ClientConfig, serverConfig: MCP.ServerConfigWithId): Promise<MCP.Prompt[]> {
    return withMcpClient(() => this.#createStdioClient(clientConfig, serverConfig), listPrompts);
  }

  getStdioPrompt(
    clientConfig: ClientConfig,
    serverConfig: MCP.ServerConfigWithId,
    request: MCP.GetPromptRequest,
  ): Promise<MCP.GetPromptResponse> {
    return withMcpClient(
      () => this.#createStdioClient(clientConfig, serverConfig),
      (client) => getPrompt(client, request),
    );
  }
}

async function listPrompts(client: Client): Promise<MCP.Prompt[]> {
  const result = await client.listPrompts();
  return result.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    arugments: prompt.arguments,
  }));
}

async function getPrompt(client: Client, request: MCP.GetPromptRequest): Promise<MCP.GetPromptResponse> {
  const result = await client.getPrompt(request);
  return { description: result.description, messages: result.messages } as MCP.GetPromptResponse;
}

async function listTools(client: Client): Promise<MCP.Tool[]> {
  const result = await client.listTools();
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}
