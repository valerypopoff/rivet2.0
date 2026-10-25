import type { PreparedClassifierEvaluation } from './providers.js';
import { systemOneState, type PreparedClassifierState } from './state.js';

/** https://docs.subq.ai/using-the-api/models/ (verified 2026-10-24). */
export const SUBQ_DECISION_MODELS = ['subq-snap-1.1'];

/** SubQ separates images from State and requires typed, bare-base64 objects. */
export function subqDecisionState(state: PreparedClassifierState): Record<string, unknown> {
  if (state.kind === 'json') return { state: state.value };
  const wire = systemOneState({ state: '', stateMessages: state.messages });
  return {
    state: wire.state,
    ...(state.images.length
      ? {
          images: state.images.map(({ mediaType, dataUrl }) => ({
            mediaType,
            base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
          })),
        }
      : {}),
  };
}

/** Capability failures allow profile fallback without silently dropping/splitting evidence. */
export function assertSubQDecisionLimits({ state, questions }: PreparedClassifierEvaluation, check: () => void): void {
  if (questions.length > 128) throw new Error('SubQ Snap supports at most 128 questions per request.');
  for (const question of questions) {
    // JSON Schema string lengths count Unicode code points, not UTF-16 units.
    let characters = 0;
    for (const _character of question.questionId) {
      check();
      if (++characters > 100) throw new Error('SubQ Snap question IDs must contain at most 100 characters.');
    }
  }
  if (state.kind !== 'messages') return;
  if (state.images.length > 4) throw new Error('SubQ Snap supports at most 4 images per request.');
  let total = 0;
  for (const { mediaType, dataUrl } of state.images) {
    check();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType))
      throw new Error('SubQ Snap accepts PNG, JPEG and WebP images, not GIF.');
    const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    if (bytes > 4 * 1024 * 1024) throw new Error('SubQ Snap images must not exceed 4 MiB decoded each.');
    total += bytes;
  }
  if (total > 8 * 1024 * 1024) throw new Error('SubQ Snap images must not exceed 8 MiB decoded in total.');
}
