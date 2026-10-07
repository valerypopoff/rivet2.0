import type { DataValue } from '../DataValue.js';
import {
  prepareClassifierImageText,
  prepareNativeClassifierImage,
  inspectClassifierImage,
  type PreparedClassifierImage,
} from './images.js';
import { snapshotClassifierJson, classifierArrayValues, classifierDataProperty } from './json.js';
import { ClassifierValueBudget, CLASSIFIER_LIMITS, type ClassifierPreparationCheck } from './limits.js';

export type ClassifierStatePart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };
export type ClassifierStateMessage = { parts: ClassifierStatePart[] };
/** Compatibility input/output used by direct provider callers and normalization helpers. */
export type ClassifierState = {
  state: string | Record<string, unknown> | unknown[];
  stateMessages?: ClassifierStateMessage[];
};
export type PreparedClassifierState =
  | { kind: 'json'; value: ClassifierState['state'] }
  | { kind: 'messages'; messages: ClassifierStateMessage[]; images: PreparedClassifierImage[] };

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nativeImage = (value: unknown) =>
  record(value) &&
  (classifierDataProperty(value, 'type') === 'image' ||
    ('mediaType' in value && classifierDataProperty(value, 'data') instanceof Uint8Array));
const message = (value: unknown): value is Record<string, unknown> =>
  record(value) && 'type' in value && 'message' in value;

/** Graph and direct provider calls converge here; no caller can bypass preparation. */
export function prepareClassifierState(
  input: ClassifierState & { stateInput?: DataValue },
  budget: ClassifierValueBudget,
): PreparedClassifierState {
  if (input.stateInput !== undefined) {
    if (input.state !== '' || input.stateMessages !== undefined)
      throw new Error('Rivet State input and provider State cannot be supplied together.');
    return prepareRivetState(input.stateInput, budget);
  }
  if (input.stateMessages === undefined)
    return { kind: 'json', value: snapshotClassifierJson(input.state, 'State', budget) as ClassifierState['state'] };
  if (input.state !== '')
    throw new Error('Structured State and multimodal State messages cannot be supplied together.');
  const messages = snapshotClassifierJson(input.stateMessages, 'State', budget);
  const images = inspectStateMessages(messages, budget.check);
  return { kind: 'messages', messages: messages as ClassifierStateMessage[], images };
}

/** Standalone compatibility helper uses the same preparation, not a separate validator. */
export function normalizeClassifierState(
  input: DataValue | undefined,
  check?: ClassifierPreparationCheck,
  maxBytes?: number,
): ClassifierState {
  const state =
    input === undefined
      ? { kind: 'json' as const, value: '' }
      : prepareRivetState(input, new ClassifierValueBudget(check, maxBytes));
  return state.kind === 'json' ? { state: state.value } : { state: '', stateMessages: state.messages };
}

function prepareRivetState(input: DataValue, budget: ClassifierValueBudget): PreparedClassifierState {
  const check = budget.check;
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('State input must contain a Rivet data value.');
  const type = classifierDataProperty(input, 'type');
  const value = classifierDataProperty(input, 'value');
  if (typeof type !== 'string') throw new Error('State input type must be a string.');
  if (
    ![
      'string',
      'string[]',
      'image',
      'image[]',
      'chat-message',
      'chat-message[]',
      'object',
      'object[]',
      'any',
      'any[]',
    ].includes(type)
  )
    throw new Error(`Unsupported State input type '${type}'.`);
  if (type.endsWith('[]') && !Array.isArray(value)) throw new Error('State array input must contain an array.');
  if (type === 'string' && typeof value !== 'string') throw new Error('State string input must contain a string.');
  if (type === 'object' && !record(value) && !Array.isArray(value))
    throw new Error('State object input must contain a JSON object or array.');
  if ((type === 'image' || type === 'chat-message') && Array.isArray(value))
    throw new Error('State scalar input must not contain an array.');
  // Explicit structured evidence needs just one validating/copying traversal.
  if (type === 'object' || type === 'object[]')
    return { kind: 'json', value: snapshotClassifierJson(value, 'State', budget) as ClassifierState['state'] };

  // Ambiguous/multimodal inputs must be bounded before image inspection/encoding.
  budget.inspect(value);
  const imageTexts = new Map<string, PreparedClassifierImage>();
  const textImage = (text: string) => {
    const image = imageTexts.get(text) ?? prepareClassifierImageText(text, check);
    if (image) imageTexts.set(text, image);
    return image;
  };
  const hasContent = (item: unknown) =>
    nativeImage(item) || message(item) || (typeof item === 'string' && textImage(item) !== undefined);
  const arrayHasContent = () => {
    for (const item of classifierArrayValues(value as unknown[], 'State')) {
      check();
      if (hasContent(item)) return true;
    }
    return false;
  };
  const contentType = ['image', 'image[]', 'string[]', 'chat-message', 'chat-message[]'].includes(type);
  const inferredContent =
    (type === 'any' || type === 'any[]') && (hasContent(value) || (Array.isArray(value) && arrayHasContent()));
  if (!(contentType || inferredContent || (type === 'string' && textImage(value as string)))) {
    if (typeof value !== 'string' && !record(value) && !Array.isArray(value))
      throw new Error('State must be text, a JSON object/array, images, or user messages.');
    // Text is already detached. Ambiguous JSON additionally needs plain-data validation.
    return {
      kind: 'json',
      value:
        typeof value === 'string'
          ? value
          : (snapshotClassifierJson(value, 'State', new ClassifierValueBudget(check)) as ClassifierState['state']),
    };
  }

  const values = Array.isArray(value) ? value : [value];
  if (type === 'image[]' && values.length > 128) throw new Error('State must contain at most 128 images.');
  const messages: ClassifierStateMessage[] = [];
  const images: PreparedClassifierImage[] = [];
  let partCount = 0;
  const imagePart = (prepare: () => PreparedClassifierImage): ClassifierStatePart => {
    if (images.length >= 128) throw new Error('State must contain at most 128 images.');
    const image = prepare();
    images.push(image);
    return { type: 'image', dataUrl: image.dataUrl };
  };
  let parts: ClassifierStatePart[] = [];
  const flush = () => {
    if (parts.length) {
      if (messages.length >= CLASSIFIER_LIMITS.messages) throw new Error('State has too many messages.');
      messages.push({ parts });
      parts = [];
    }
  };
  const part = (item: unknown): ClassifierStatePart => {
    check();
    if (++partCount > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
    if (typeof item === 'string') {
      const image = textImage(item);
      return image ? imagePart(() => image) : { type: 'text', text: item };
    }
    if (nativeImage(item)) return imagePart(() => prepareNativeClassifierImage(item, check));
    throw new Error('Multimodal State accepts only text, native images, image data URLs, and user messages.');
  };
  for (const item of classifierArrayValues(values, 'State')) {
    check();
    if (type === 'image' || type === 'image[]') {
      if (++partCount > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
      parts.push(imagePart(() => prepareNativeClassifierImage(item, check)));
    } else if (type === 'string[]' && typeof item !== 'string') {
      throw new Error('State string array must contain only strings.');
    } else if (message(item)) {
      if (classifierDataProperty(item, 'type') !== 'user' || 'function_call' in item || 'function_calls' in item)
        throw new Error(
          'Classifier State supports only user messages, not system, developer, assistant, or tool messages.',
        );
      flush();
      if (messages.length >= CLASSIFIER_LIMITS.messages) throw new Error('State has too many messages.');
      const contentValue = classifierDataProperty(item, 'message');
      const content = Array.isArray(contentValue) ? contentValue : [contentValue];
      messages.push({
        parts: content.length
          ? Array.from(classifierArrayValues(content, 'State'), part)
          : [{ type: 'text', text: '' }],
      });
    } else {
      if (type === 'chat-message' || type === 'chat-message[]')
        throw new Error('State must contain valid user messages.');
      parts.push(part(item));
    }
  }
  flush();
  return messages.length ? { kind: 'messages', messages, images } : { kind: 'json', value: '' };
}

function inspectStateMessages(messages: unknown, check: ClassifierPreparationCheck): PreparedClassifierImage[] {
  if (!Array.isArray(messages)) throw new Error('State messages must be an array.');
  if (messages.length > CLASSIFIER_LIMITS.messages) throw new Error('State has too many messages.');
  const images: PreparedClassifierImage[] = [];
  let parts = 0;
  for (const message of messages) {
    if (!record(message) || !Array.isArray(message.parts)) throw new Error('State message parts must be an array.');
    for (const part of message.parts) {
      check();
      if (++parts > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
      if (!record(part)) throw new Error('Invalid State content part.');
      if (part.type === 'image' && typeof part.dataUrl === 'string') {
        if (images.length >= 128) throw new Error('State must contain at most 128 images.');
        images.push({ ...inspectClassifierImage(part.dataUrl, check), dataUrl: part.dataUrl });
      } else if (part.type !== 'text' || typeof part.text !== 'string') throw new Error('Invalid State content part.');
    }
  }
  return images;
}

/** System One separates images; numbered placeholders retain caption/image associations. */
export function systemOneState(input: ClassifierState): { state: ClassifierState['state']; images?: string[] } {
  if (!input.stateMessages) return { state: input.state };
  const images: string[] = [];
  const state = input.stateMessages
    .map(({ parts }) =>
      parts
        .map((part) => {
          if (part.type === 'text') return part.text;
          images.push(part.dataUrl);
          return `[Image ${images.length}]`;
        })
        .join('\n'),
    )
    .join('\n\n');
  return { state, ...(images.length ? { images } : {}) };
}
