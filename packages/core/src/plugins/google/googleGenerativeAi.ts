import { type Content, type FunctionCall, type Tool } from '@google/genai';

export type GoogleModelDeprecated = {
  maxTokens: number;
  cost: {
    prompt: number;
    completion: number;
  };
  displayName: string;
};

export const googleModelsDeprecated = {
  'gemini-pro': {
    maxTokens: 32760,
    cost: { prompt: NaN, completion: NaN },
    displayName: 'Gemini Pro',
  },
  'gemini-pro-vision': {
    maxTokens: 16384,
    cost: { prompt: NaN, completion: NaN },
    displayName: 'Gemini Pro Vision',
  },
} satisfies Record<string, GoogleModelDeprecated>;

export type GoogleModelsDeprecated = keyof typeof googleModelsDeprecated;

export const generativeAiGoogleModels = {
  'gemini-2.5-pro': {
    maxTokens: 1048576,
    cost: {
      prompt: 1.25 / 1000, // <= 200k tokens, > 200k tokens is 2.5 / 1000
      completion: 10 / 1000, // <= 200k tokens, > 200k tokens is 15 / 1000
    },
    displayName: 'Gemini 2.5 Pro',
  },
  'gemini-2.5-flash': {
    maxTokens: 1048576,
    cost: { prompt: 0.3 / 1000, completion: 2.5 / 1000 },
    displayName: 'Gemini 2.5 Flash',
  },
  'gemini-2.5-flash-lite-preview-06-17': {
    maxTokens: 1000000,
    cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
    displayName: 'Gemini 2.5 Flash Lite Preview',
  },
  'gemini-2.0-flash': {
    maxTokens: 1048576,
    cost: { prompt: 0.1 / 1000, completion: 0.4 / 1000 },
    displayName: 'Gemini 2.0 Flash',
  },
  'gemini-2.0-flash-lite': {
    maxTokens: 1048576,
    cost: { prompt: 0.075 / 1000, completion: 0.3 / 1000 },
    displayName: 'Gemini 2.0 Flash Lite',
  },
  'gemini-1.5-pro': {
    maxTokens: 2097152,
    displayName: 'Gemini 1.5 Pro',
    // The retained legacy model stays selectable, but its old catalog did not
    // carry a reliable token rate. Do not turn that absence into a false $0.
    pricing: 'unpriced' as const,
  },
  'gemini-1.5-flash': {
    maxTokens: 1048576,
    displayName: 'Gemini 1.5 Flash',
    pricing: 'unpriced' as const,
  },
};

export type GenerativeAiGoogleModel = keyof typeof generativeAiGoogleModels;

export const googleModelOptionsDeprecated = Object.entries(googleModelsDeprecated).map(([id, { displayName }]) => ({
  value: id,
  label: displayName,
}));

export const generativeAiOptions = Object.entries(generativeAiGoogleModels).map(([id, { displayName }]) => ({
  value: id,
  label: displayName,
}));

export type ChatCompletionChunk = {
  completion?: string;
  function_calls?: FunctionCall[];
  finish_reason:
    | 'FINISH_REASON_UNSPECIFIED'
    | 'FINISH_REASON_STOP'
    | 'FINISH_REASON_MAX_TOKENS'
    | 'FINISH_REASON_SAFETY'
    | 'FINISH_REASON_RECITATION'
    | 'FINISH_REASON_OTHER'
    | undefined;
  model: string;
};

export type StreamGenerativeAiOptions = {
  apiKey: string;
  model: GenerativeAiGoogleModel;
  systemPrompt: string | undefined;
  prompt: Content[];
  maxOutputTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  signal?: AbortSignal;
  tools: Tool[] | undefined;
  thinkingBudget?: number;
  additionalHeaders?: Record<string, string>;
};

export async function* streamGenerativeAi({
  apiKey,
  model,
  systemPrompt,
  prompt,
  maxOutputTokens,
  temperature,
  topP,
  topK,
  signal,
  tools,
  thinkingBudget,
  additionalHeaders,
}: StreamGenerativeAiOptions): AsyncGenerator<ChatCompletionChunk> {
  const { GoogleGenAI } = await import('@google/genai');
  const genAi = new GoogleGenAI({ apiKey });
  const result = await genAi.models.generateContentStream({
    model,
    contents: prompt,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens,
      temperature,
      topP,
      topK,
      tools,
      abortSignal: signal,
      thinkingConfig: { thinkingBudget },
      httpOptions: { headers: { ...additionalHeaders } },
    },
  });

  for await (const chunk of result) {
    const outChunk: ChatCompletionChunk = {
      completion: undefined,
      finish_reason: undefined,
      function_calls: undefined,
      model,
    };

    const functionCalls = chunk.functionCalls;
    if (functionCalls) {
      outChunk.function_calls = functionCalls;
    }

    if (chunk.candidates) {
      outChunk.completion = chunk.candidates[0]?.content?.parts?.[0]?.text;
      outChunk.finish_reason = chunk.candidates[0]?.finishReason as ChatCompletionChunk['finish_reason'];
    }

    if (outChunk.completion || outChunk.function_calls) {
      yield outChunk;
    }
  }
}
