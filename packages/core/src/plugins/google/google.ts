import type { Content } from '@google/genai';
import type { Content as VertexContent } from '@google-cloud/vertexai';
import type { ChatCompletionChunk, GoogleModelsDeprecated } from './googleGenerativeAi.js';

export {
  type ChatCompletionChunk,
  type GenerativeAiGoogleModel,
  type GoogleModelDeprecated,
  type GoogleModelsDeprecated,
  type StreamGenerativeAiOptions,
  generativeAiGoogleModels,
  generativeAiOptions,
  googleModelOptionsDeprecated,
  googleModelsDeprecated,
  streamGenerativeAi,
} from './googleGenerativeAi.js';

export type ChatCompletionOptions = {
  project: string;
  location: string;
  applicationCredentials: string;
  model: GoogleModelsDeprecated;
  systemPrompt?: string;
  prompt: Content[];
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  signal?: AbortSignal;
};

export function getVertexGenerativeModelOptions(
  options: Pick<
    ChatCompletionOptions,
    'model' | 'systemPrompt' | 'max_output_tokens' | 'temperature' | 'top_p' | 'top_k'
  >,
) {
  return {
    model: options.model,
    systemInstruction: options.systemPrompt,
    generationConfig: {
      maxOutputTokens: options.max_output_tokens,
      temperature: options.temperature,
      topP: options.top_p,
      topK: options.top_k,
    },
  };
}

export async function* streamChatCompletions({
  project,
  location,
  applicationCredentials,
  model,
  signal,
  max_output_tokens,
  temperature,
  top_p,
  top_k,
  systemPrompt,
  prompt,
}: ChatCompletionOptions): AsyncGenerator<ChatCompletionChunk> {
  // Dynamic import: the Google auth library fails under static CJS require.
  const { VertexAI } = await import('@google-cloud/vertexai');

  // Keep the credential path on this client. Writing GOOGLE_APPLICATION_CREDENTIALS
  // would let concurrent legacy Vertex runs overwrite each other's identity.
  const vertexAi = new VertexAI({
    project,
    location,
    googleAuthOptions: { keyFilename: applicationCredentials },
  });
  const generativeModel = vertexAi.preview.getGenerativeModel(
    getVertexGenerativeModelOptions({
      model,
      systemPrompt,
      max_output_tokens,
      temperature,
      top_p,
      top_k,
    }),
  );
  const response = await generativeModel.generateContentStream({
    contents: prompt as unknown as VertexContent[],
  });

  let hadChunks = false;

  for await (const chunk of response.stream) {
    hadChunks = true;

    const candidate = chunk.candidates?.[0];
    const completion = candidate?.content.parts[0]?.text;

    if (!signal?.aborted && completion) {
      yield {
        completion,
        finish_reason: candidate.finishReason as ChatCompletionChunk['finish_reason'],
        model,
      };
    } else {
      return;
    }
  }

  if (!hadChunks) {
    throw new Error(`No chunks received.`);
  }
}
