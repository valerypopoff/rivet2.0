import type { DataValue } from '../DataValue.js';
import { classifierImageFromText, nativeClassifierImage, assertClassifierImages } from './images.js';
import { assertClassifierJson, classifierArrayValues, classifierDataProperty } from './json.js';
import { assertClassifierResourceLimits, CLASSIFIER_LIMITS, type ClassifierPreparationCheck } from './limits.js';

export type ClassifierStatePart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };
export type ClassifierStateMessage = { parts: ClassifierStatePart[] };
export type ClassifierState = {
  state: string | Record<string, unknown> | unknown[];
  stateMessages?: ClassifierStateMessage[];
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nativeImage = (value: unknown) =>
  record(value) &&
  (classifierDataProperty(value, 'type') === 'image' ||
    ('mediaType' in value && classifierDataProperty(value, 'data') instanceof Uint8Array));
const message = (value: unknown): value is Record<string, unknown> =>
  record(value) && 'type' in value && 'message' in value;
const imageText = (value: unknown, check?: ClassifierPreparationCheck) =>
  typeof value === 'string' && classifierImageFromText(value, check) !== undefined;
const hasContent = (value: unknown, check?: ClassifierPreparationCheck) =>
  nativeImage(value) || message(value) || imageText(value, check);
function arrayHasContent(value: unknown[], check?: ClassifierPreparationCheck): boolean {
  for (const item of classifierArrayValues(value, 'State')) {
    check?.();
    if (hasContent(item, check)) return true;
  }
  return false;
}

/** Object/object[] inputs are explicitly structured, not content containers. */
export function normalizeClassifierState(
  input: DataValue | undefined,
  check?: ClassifierPreparationCheck,
  maxBytes?: number,
): ClassifierState {
  if (input === undefined) return { state: '' };
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('State input must contain a Rivet data value.');
  const type = classifierDataProperty(input, 'type');
  const value = classifierDataProperty(input, 'value');
  if (typeof type !== 'string') throw new Error('State input type must be a string.');
  assertClassifierResourceLimits(value, check, maxBytes);
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
  const contentType = ['image', 'image[]', 'string[]', 'chat-message', 'chat-message[]'].includes(type);
  const inferredContent =
    (type === 'any' || type === 'any[]') &&
    (hasContent(value, check) || (Array.isArray(value) && arrayHasContent(value, check)));
  if (contentType || inferredContent || (type === 'string' && imageText(value, check))) {
    const values = type.endsWith('[]') || Array.isArray(value) ? value : [value];
    if (!Array.isArray(values)) throw new Error('State array input must contain an array.');
    if (type === 'image[]' && values.length > 128) throw new Error('State must contain at most 128 images.');
    const messages: ClassifierStateMessage[] = [];
    let imageCount = 0;
    let partCount = 0;
    const imagePart = (encode: () => string): ClassifierStatePart => {
      if (++imageCount > 128) throw new Error('State must contain at most 128 images.');
      return { type: 'image', dataUrl: encode() };
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
      check?.();
      if (++partCount > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
      if (typeof item === 'string') {
        const dataUrl = classifierImageFromText(item, check);
        return dataUrl ? imagePart(() => dataUrl) : { type: 'text', text: item };
      }
      if (nativeImage(item)) return imagePart(() => nativeClassifierImage(item, check));
      throw new Error('Multimodal State accepts only text, native images, image data URLs, and user messages.');
    };
    for (const item of classifierArrayValues(values, 'State')) {
      check?.();
      if (type === 'image' || type === 'image[]') {
        if (++partCount > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
        parts.push(imagePart(() => nativeClassifierImage(item, check)));
        continue;
      }
      if (type === 'string[]' && typeof item !== 'string')
        throw new Error('State string array must contain only strings.');
      if (message(item)) {
        if (classifierDataProperty(item, 'type') !== 'user' || 'function_call' in item || 'function_calls' in item)
          throw new Error(
            'Classifier State supports only user messages, not system, developer, assistant, or tool messages.',
          );
        flush();
        if (messages.length >= CLASSIFIER_LIMITS.messages) throw new Error('State has too many messages.');
        const messageContent = classifierDataProperty(item, 'message');
        const content = Array.isArray(messageContent) ? messageContent : [messageContent];
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
    assertClassifierStateMessages(messages, check);
    return messages.length ? { state: '', stateMessages: messages } : { state: '' };
  }
  if (typeof value !== 'string' && !record(value) && !Array.isArray(value))
    throw new Error('State must be text, a JSON object/array, images, or user messages.');
  assertClassifierJson(value, 'State', false, check);
  return { state: value };
}

export function assertClassifierStateMessages(
  messages: unknown,
  check?: ClassifierPreparationCheck,
): asserts messages is ClassifierStateMessage[] {
  assertClassifierJson(messages, 'State', false, check);
  if (!Array.isArray(messages)) throw new Error('State messages must be an array.');
  if (messages.length > CLASSIFIER_LIMITS.messages) throw new Error('State has too many messages.');
  const images: string[] = [];
  let parts = 0;
  for (const message of messages) {
    if (!record(message) || !Array.isArray(message.parts)) throw new Error('State message parts must be an array.');
    for (const part of message.parts) {
      check?.();
      if (++parts > CLASSIFIER_LIMITS.parts) throw new Error('State has too many content parts.');
      if (!record(part)) throw new Error('Invalid State content part.');
      if (part.type === 'image' && typeof part.dataUrl === 'string') images.push(part.dataUrl);
      else if (part.type !== 'text' || typeof part.text !== 'string') throw new Error('Invalid State content part.');
    }
  }
  assertClassifierImages(images, check);
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
