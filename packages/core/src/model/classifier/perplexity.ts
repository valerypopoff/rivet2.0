import type { PreparedClassifierEvaluation } from './providers.js';
import { systemOneState, type PreparedClassifierState } from './state.js';
import { inspectClassifierImage } from './images.js';

export const PERPLEXITY_DECISION_MODELS = ['pplx-decider-v1.1-27b', 'pplx-decider-v1-27b'];

/** Native inline image parts; a top-level images field is not accepted. */
export function perplexityDecisionState(state: PreparedClassifierState): unknown {
  if (state.kind === 'json') return state.value;
  if (!state.images.length) return systemOneState({ state: '', stateMessages: state.messages }).state;
  const parts: (string | { type: 'image_url'; image_url: { url: string } })[] = [];
  for (const [messageIndex, message] of state.messages.entries()) {
    if (messageIndex) parts.push('\n\n');
    for (const [partIndex, part] of message.parts.entries()) {
      if (partIndex) parts.push('\n');
      parts.push(part.type === 'text' ? part.text : { type: 'image_url', image_url: { url: part.dataUrl } });
    }
  }
  return parts;
}

/** Provider capability limits, not shared input errors or provider outages. */
export function assertPerplexityDecisionLimits(
  { model, state, questions }: PreparedClassifierEvaluation,
  check: () => void,
): void {
  if (questions.length > 128) throw new Error('Perplexity Decisions supports at most 128 questions per request.');
  for (const question of questions) {
    check();
    if (question.type === 'score' && question.criteria.includes(null))
      throw new Error('Perplexity Decisions Score levels cannot be null.');
  }
  const inspect = ({ width, height, mediaType }: { width: number; height: number; mediaType: string }) => {
    check();
    if (!PERPLEXITY_DECISION_MODELS.includes(model))
      throw new Error('Image support is not known for this Perplexity Decisions model.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType))
      throw new Error('Perplexity Decisions accepts PNG, JPEG and WebP images, not GIF.');
    // Round up conservatively: oversized images can hang until a provider 504.
    if (Math.ceil(width / 32) * Math.ceil(height / 32) > 2048)
      throw new Error(
        'Perplexity Decisions images must contain at most 2,048 tiles of 32 by 32 pixels each. Resize upstream.',
      );
  };
  if (state.kind === 'messages') {
    for (const image of state.images) inspect(image);
    return;
  }
  // The native API also interprets top-level image_url parts in JSON State.
  // Validate that wire shape without traversing arbitrary nested evidence or
  // letting raw parts bypass the ordinary image capability checks.
  let imageCount = 0;
  for (const part of Array.isArray(state.value) ? state.value : [state.value]) {
    check();
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (record.type !== 'image_url') continue;
    if (++imageCount > 128) throw new Error('State must contain at most 128 images.');
    const image = record.image_url;
    const url =
      image && typeof image === 'object' && !Array.isArray(image) ? (image as Record<string, unknown>).url : undefined;
    inspect(inspectClassifierImage(url, check));
  }
}
