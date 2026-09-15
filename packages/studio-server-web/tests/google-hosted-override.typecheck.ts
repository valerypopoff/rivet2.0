import type { Content as HostedContent, FunctionCall as HostedFunctionCall, Tool as HostedTool } from '@google/genai';
import type {
  ChatCompletionChunk,
  ChatCompletionOptions,
  StreamGenerativeAiOptions,
} from '../overrides/core/plugins/google/google.js';

declare const prompt: HostedContent[];
declare const tools: HostedTool[] | undefined;

// Keep the hosted workspace's older GenAI SDK structurally compatible with the
// Core-owned stream contract. Vite proves the runtime entry separately.
const streamOptions: StreamGenerativeAiOptions = {
  apiKey: 'synthetic-key',
  model: 'gemini-2.5-flash',
  systemPrompt: undefined,
  prompt,
  maxOutputTokens: 1,
  temperature: undefined,
  topP: undefined,
  topK: undefined,
  tools,
};

const hostedVertexOptions = {
  project: 'synthetic-project',
  location: 'synthetic-location',
  applicationCredentials: 'synthetic-credentials',
  model: 'gemini-pro',
  prompt,
  max_output_tokens: 1,
} satisfies ChatCompletionOptions;

const chunk: ChatCompletionChunk = {
  completion: undefined,
  function_calls: undefined,
  finish_reason: undefined,
  model: 'gemini-2.5-flash',
};
const hostedFunctionCalls: HostedFunctionCall[] | undefined = chunk.function_calls;

void streamOptions;
void hostedVertexOptions;
void chunk;
void hostedFunctionCalls;
