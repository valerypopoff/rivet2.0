import type { Content } from '@google/genai';
import {
  type ChatCompletionChunk,
  type GoogleModelsDeprecated,
  generativeAiGoogleModels as coreGenerativeAiGoogleModels,
  generativeAiOptions,
  googleModelOptionsDeprecated,
  googleModelsDeprecated,
  streamGenerativeAi,
  type StreamGenerativeAiOptions,
} from '../../../../../core/src/plugins/google/googleGenerativeAi.js';

export {
  type ChatCompletionChunk,
  type GoogleModelsDeprecated,
  type StreamGenerativeAiOptions,
  generativeAiOptions,
  googleModelOptionsDeprecated,
  googleModelsDeprecated,
  streamGenerativeAi,
};

// Hosted legacy Chat nodes historically present these retained models as $0.
// LLM Chat V2 keeps Core's deliberately unpriced versions through google.ts.
export const generativeAiGoogleModels = {
  ...coreGenerativeAiGoogleModels,
  'gemini-1.5-pro': {
    maxTokens: 2097152,
    cost: { prompt: 0, completion: 0 },
    displayName: 'Gemini 1.5 Pro',
  },
  'gemini-1.5-flash': {
    maxTokens: 1048576,
    cost: { prompt: 0, completion: 0 },
    displayName: 'Gemini 1.5 Flash',
  },
};

export type GenerativeAiGoogleModel = keyof typeof generativeAiGoogleModels;

export type ChatCompletionOptions = {
  project: string;
  location: string;
  applicationCredentials: string;
  model: GoogleModelsDeprecated;
  prompt: Content[];
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  signal?: AbortSignal;
};

export async function* streamChatCompletions(_options: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
  throw new Error('Google Vertex AI with application credentials is not supported in the hosted browser wrapper. Configure `googleApiKey` to use the browser-safe Google Generative AI path instead.');
}
