import type { PreparedClassifierEvaluation } from './providers.js';
import type { PreparedClassifierState } from './state.js';
import { inspectClassifierImage } from './images.js';

/** Native Model API slugs, not Hugging Face or gateway IDs. Verified 2026-10-30. */
export const BASETEN_DECISION_MODELS = [
  'decision-models/baseten-elephant-9b-latest',
  'decision-models/baseten-mammoth-27b-latest',
  'decision-models/baseten-joey-2b-latest',
] as const;

/** Baseten uses inline user-message image parts, never top-level images/placeholders. */
export function basetenDecisionState(state: PreparedClassifierState): unknown {
  if (state.kind === 'json') return state.value;
  return {
    messages: state.messages.map(({ parts }) => ({
      role: 'user',
      content: parts.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: { url: part.dataUrl } },
      ),
    })),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** https://docs.baseten.co/reference/inference-api/system-one */
export function assertBasetenDecisionLimits(
  { model, state, questions }: PreparedClassifierEvaluation,
  check: () => void,
): void {
  let options = 0;
  for (const question of questions) {
    check();
    options += question.type === 'noul' ? 2 : Object.keys(question.criteria ?? {}).length;
  }
  if (options > 512) throw new Error('Baseten supports at most 512 options across all questions; Noul counts as two.');
  const wire = basetenDecisionState(state);
  let characters = 0,
    images = 0;
  const text = (value: string) => {
    for (const _character of value) {
      check();
      if (++characters > 50000) throw new Error('Baseten rendered State must fit within 50,000 characters.');
    }
  };
  if (!record(wire) || !Array.isArray(wire.messages)) {
    text(typeof wire === 'string' ? wire : JSON.stringify(wire));
    return;
  }
  // Explicit JSON conversation State is interpreted natively by Baseten too.
  // Inspect it as well, so JSON cannot bypass the same model/image limits.
  for (const message of wire.messages) {
    check();
    if (!record(message) || (message.role !== 'user' && message.role !== 'assistant'))
      throw new Error('Baseten State messages must have user or assistant roles.');
    if (typeof message.content === 'string') {
      text(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) throw new Error('Baseten message content must be text or content parts.');
    for (const part of message.content) {
      check();
      if (!record(part)) throw new Error('Invalid Baseten State content part.');
      if (part.type === 'text' && typeof part.text === 'string') {
        text(part.text);
        continue;
      }
      if (part.type !== 'image_url' || !record(part.image_url))
        throw new Error('Baseten State supports text and image_url parts only.');
      if (message.role !== 'user') throw new Error('Baseten accepts images in user messages only.');
      if (!BASETEN_DECISION_MODELS.some((id) => id === model))
        throw new Error('Image support is not known for this Baseten model.');
      if (++images > 4) throw new Error('Baseten supports at most four images per request.');
      if (part.image_url.detail !== undefined && part.image_url.detail !== 'auto')
        throw new Error('Baseten image detail must be auto or omitted.');
      const image = inspectClassifierImage(part.image_url.url, check);
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType))
        throw new Error('Baseten accepts PNG, JPEG and WebP images, not GIF.');
    }
  }
}
