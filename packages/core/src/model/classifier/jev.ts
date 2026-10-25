import type { PreparedClassifierImage } from './images.js';
import type { ClassifierStateMessage } from './state.js';
import type { PreparedClassifierEvaluation } from './providers.js';
import { createQuestionMap } from './questions.js';

/** Experimental image contract, verified 2026-10-24: https://docs.typesafe.ai/images */
export const JEV_IMAGE_MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0', 'jev-1.14.0'];
/** https://docs.typesafe.ai/primitives/box — Box requires Jev 1.14, not 1.13. */
export const JEV_BOX_MODELS = ['jev-latest', 'jev-preview', 'jev-1.14.0'];

export function assertJevImageLimits(images: readonly PreparedClassifierImage[], check: () => void): void {
  for (const { dataUrl, mediaType, width, height } of images) {
    check();
    if (mediaType !== 'image/png' && mediaType !== 'image/jpeg')
      throw new Error('Jev images must be still PNG or JPEG. Convert other formats upstream.');
    if (Math.min(width, height) < 280 || Math.max(width, height) > 1568)
      throw new Error('Jev image width and height must each be between 280 and 1568 pixels. Resize upstream.');
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    if (bytes > 16 * 1024 * 1024) throw new Error('Jev image files must not exceed 16 MiB decoded.');
  }
}

/** Jev substitutes opaque asset references, not Liquid's numbered image placeholders. */
export function createJevDecisionRequest({
  model,
  state,
  questions,
}: PreparedClassifierEvaluation): Record<string, unknown> {
  const references = new Map<string, string>();
  const assets: Record<string, { type: 'image'; format: 'png' | 'jpg'; data_base64: string }> = {};
  const messagesText = (messages: readonly ClassifierStateMessage[]) =>
    messages
      .map(({ parts }) =>
        parts
          .map((part) => {
            if (part.type === 'text') return part.text;
            let reference = references.get(part.dataUrl);
            if (!reference) {
              reference = globalThis.crypto.randomUUID();
              references.set(part.dataUrl, reference);
              assets[reference] = {
                type: 'image',
                format: part.dataUrl.startsWith('data:image/png;') ? 'png' : 'jpg',
                data_base64: part.dataUrl.slice(part.dataUrl.indexOf(',') + 1),
              };
            }
            return reference;
          })
          .join('\n'),
      )
      .join('\n\n');
  const value = state.kind === 'json' ? state.value : messagesText(state.messages);
  const questionMap = createQuestionMap(questions, (question) =>
    question.instructionsMessages ? messagesText(question.instructionsMessages) : question.instructions,
  );
  return { model, state: value, questions: questionMap, ...(references.size ? { assets } : {}) };
}
