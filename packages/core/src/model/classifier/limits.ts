/** Core safety limits, not provider capacity claims. Stricter provider limits still apply. */
export const CLASSIFIER_LIMITS = {
  requestBytes: 32 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  depth: 64,
  values: 100_000,
  questions: 1000,
  messages: 1024,
  parts: 4096,
} as const;

export type ClassifierPreparationCheck = () => void;

export class ClassifierResourceLimitError extends Error {}

/** Receipt failed before JSON decoding/validation, rather than malformed evidence. */
export class ClassifierResponseReadError extends Error {}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;

/** A plain view uses real byte geometry and cannot execute authored byte accessors/methods. */
export function classifierByteView(value: Uint8Array): Uint8Array {
  return new Uint8Array(byteBuffer.call(value), byteOffset.call(value), byteLength.call(value));
}

export function classifierPreparationCheck(
  signal: AbortSignal,
  deadline: number,
  timeoutMs?: number,
): ClassifierPreparationCheck {
  return () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error(
        `Classifier preparation/request timed out${timeoutMs === undefined ? '' : ` after ${timeoutMs} ms`}.`,
      );
  };
}

/** Bound expanded work before JSON serialization or image encoding, without reading getters. */
export function assertClassifierResourceLimits(
  value: unknown,
  check: ClassifierPreparationCheck = () => {},
  maxBytes: number = CLASSIFIER_LIMITS.requestBytes,
): number {
  return new ClassifierValueBudget(check, maxBytes).inspect(value).bytes;
}

/** One traversal can account, validate plain JSON, and detach it before IO. */
export class ClassifierValueBudget {
  private bytes = 0;
  private values = 0;
  private readonly maxBytes: number;

  constructor(
    readonly check: ClassifierPreparationCheck = () => {},
    maxBytes: number = CLASSIFIER_LIMITS.requestBytes,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new ClassifierResourceLimitError('Classifier byte limit must be a positive safe integer.');
    this.maxBytes = Math.min(maxBytes, CLASSIFIER_LIMITS.requestBytes);
  }

  get remainingBytes(): number {
    return this.maxBytes - this.bytes;
  }

  private add(count: number): void {
    this.bytes += count;
    if (this.bytes > this.maxBytes) {
      const maxBytes = this.maxBytes;
      const size =
        maxBytes >= 1_000_000
          ? maxBytes % (1024 * 1024) === 0
            ? `${maxBytes / (1024 * 1024)} MiB`
            : `${maxBytes / 1_000_000} MB`
          : `${maxBytes}-byte`;
      throw new ClassifierResourceLimitError(
        `Classifier input exceeds the ${size} resource limit. Reduce input content or image size.`,
      );
    }
  }

  private string(text: string): void {
    // Every UTF-16 unit occupies at least one JSON byte; reject before scanning huge strings.
    this.add(text.length + 2);
    for (let i = 0; i < text.length; i++) {
      if ((i & 4095) === 0) this.check();
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92) this.add(1);
      else if (code < 32) this.add([8, 9, 10, 12, 13].includes(code) ? 1 : 5);
      else if (code < 128) continue;
      else if (code < 2048) this.add(1);
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = text.charCodeAt(i + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          this.add(2);
          i++;
        } else this.add(5); // JSON.stringify escapes lone surrogates.
      } else this.add(2);
    }
  }

  private value(depth: number): void {
    this.check();
    if (++this.values > CLASSIFIER_LIMITS.values)
      throw new ClassifierResourceLimitError('Classifier input has too many expanded values.');
    if (depth > CLASSIFIER_LIMITS.depth)
      throw new ClassifierResourceLimitError('Classifier input exceeds the maximum nesting depth of 64.');
  }

  inspect(
    value: unknown,
    json?: { label: string; allowUndefinedProperties?: boolean; copy?: boolean },
  ): { value: unknown; bytes: number } {
    const startBytes = this.bytes;
    const path = new Set<object>();
    const invalid = () =>
      new Error(`${json!.label} is not JSON-compatible: use own data properties, not accessors or sparse arrays.`);
    const visit = (item: unknown, depth: number): unknown => {
      this.value(depth);
      if (typeof item === 'string') {
        this.string(item);
        return item;
      }
      if (!json && item instanceof Uint8Array) {
        this.add(4 * Math.ceil(classifierByteView(item).byteLength / 3) + 40);
        return item;
      }
      if (item === null || typeof item !== 'object') {
        if (json && item !== null && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item)))
          throw new Error(`${json.label} is not JSON-compatible.`);
        this.add(typeof item === 'number' ? String(item).length : 5);
        return item;
      }
      if (json) {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== (Array.isArray(item) ? Array.prototype : Object.prototype) && prototype !== null)
          throw new Error(`${json.label} must contain plain JSON objects.`);
        const hook =
          Object.getOwnPropertyDescriptor(item, 'toJSON') ??
          (prototype && Object.getOwnPropertyDescriptor(prototype, 'toJSON'));
        if (hook && (!('value' in hook) || typeof hook.value === 'function'))
          throw new Error(`${json.label} must not contain JSON serialization hooks.`);
      }
      if (path.has(item)) throw new Error('Classifier input contains a circular reference.');
      path.add(item);
      this.add(2);
      const copy = json?.copy ? (Array.isArray(item) ? [] : {}) : undefined;
      if (Array.isArray(item)) {
        if (item.length > CLASSIFIER_LIMITS.values)
          throw new ClassifierResourceLimitError('Classifier input has too many expanded values.');
        for (let i = 0; i < item.length; i++) {
          if (i > 0) this.add(1);
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !('value' in descriptor)) {
            if (json) throw invalid();
            visit(undefined, depth + 1);
            continue;
          }
          const entry = visit(descriptor.value, depth + 1);
          if (copy) (copy as unknown[]).push(entry);
        }
      } else {
        const keys = Object.keys(item);
        if (keys.length > CLASSIFIER_LIMITS.values)
          throw new ClassifierResourceLimitError('Classifier input has too many expanded values.');
        let index = 0;
        for (const key of keys) {
          // Omitted wire fields still cost preparation work and snapshot memory.
          this.string(key);
          this.add(index++ === 0 ? 1 : 2);
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor)) {
            if (json) throw invalid();
            visit(undefined, depth + 1);
            continue;
          }
          let entry: unknown;
          if (descriptor.value === undefined && json) {
            if (!(depth === 0 && json.allowUndefinedProperties)) throw invalid();
            this.value(depth + 1);
            this.add(5);
            // Typed template values distinguish a missing value from an absent property.
            // JSON.stringify will still omit optional undefined fields on the wire.
          } else {
            entry = visit(descriptor.value, depth + 1);
          }
          if (copy)
            Object.defineProperty(copy, key, { enumerable: true, writable: true, configurable: true, value: entry });
        }
      }
      path.delete(item);
      return copy ?? item;
    };
    const result = visit(value, 0);
    this.check();
    return { value: result, bytes: this.bytes - startBytes };
  }
}

/** Bound parser allocation without interpreting brackets or separators inside strings. */
export function checkClassifierJsonWork(text: string, check: ClassifierPreparationCheck, label = 'response'): void {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let separators = 0;
  for (let i = 0; i < text.length; i++) {
    if ((i & 4095) === 0) check();
    const character = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      if (++depth > CLASSIFIER_LIMITS.depth)
        throw new ClassifierResourceLimitError(`Classifier ${label} exceeds the maximum nesting depth of 64.`);
      separators++;
    } else if (character === '}' || character === ']') depth--;
    else if (character === ',' || character === ':') separators++;
    // A conservative token guard bounds JSON.parse allocation. The exact
    // expanded-value guard runs on the parsed object afterward.
    if (separators > CLASSIFIER_LIMITS.values * 2)
      throw new ClassifierResourceLimitError(`Classifier ${label} has too many values.`);
  }
}

/** Consume decoded response bytes incrementally; Content-Length is not trusted. */
export async function readClassifierResponse(
  response: Response,
  signal: AbortSignal,
  check: ClassifierPreparationCheck = () => signal.throwIfAborted(),
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > CLASSIFIER_LIMITS.responseBytes)
    throw new ClassifierResourceLimitError('Classifier response exceeds the 8 MiB response limit.');
  if (!response.body) return JSON.parse('');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const text: string[] = [];
  let pending = '';
  let bytes = 0;
  try {
    for (;;) {
      check();
      const { done, value } = await reader.read().catch((cause: unknown) => {
        throw new ClassifierResponseReadError('Classifier response body could not be read.', { cause });
      });
      check();
      if (done) break;
      const chunk = classifierByteView(value);
      bytes += chunk.byteLength;
      if (bytes > CLASSIFIER_LIMITS.responseBytes)
        throw new ClassifierResourceLimitError('Classifier response exceeds the 8 MiB response limit.');
      pending += decoder.decode(chunk, { stream: true });
      if (pending.length >= 64 * 1024) {
        text.push(pending);
        pending = '';
      }
    }
    text.push(pending + decoder.decode());
    check();
    const json = text.join('');
    checkClassifierJsonWork(json, check);
    const body: unknown = JSON.parse(json);
    assertClassifierResourceLimits(body, check, CLASSIFIER_LIMITS.responseBytes);
    return body;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
