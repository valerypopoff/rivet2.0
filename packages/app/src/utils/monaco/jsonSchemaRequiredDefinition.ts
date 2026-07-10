import { getActiveInterpolationOffsetRanges, type OffsetRange } from './interpolationDiagnostics.js';

export type JsonSchemaRequiredFieldDefinition = {
  requiredStringEnd: number;
  requiredStringStart: number;
  targetKeyEnd: number;
  targetKeyStart: number;
};

type JsonToken =
  | { type: 'colon' | 'comma' | 'leftBrace' | 'rightBrace' | 'leftBracket' | 'rightBracket'; start: number; end: number }
  | { type: 'interpolation'; start: number; end: number }
  | { type: 'other'; start: number; end: number }
  | { type: 'string'; decoded: string | undefined; start: number; end: number };

type JsonValue =
  | { type: 'array'; elements: JsonValue[]; end: number; start: number }
  | { type: 'object'; end: number; properties: JsonProperty[]; start: number }
  | { type: 'string'; end: number; start: number; token: Extract<JsonToken, { type: 'string' }> }
  | { type: 'other'; end: number; start: number };

type JsonProperty = {
  key: Extract<JsonToken, { type: 'string' }>;
  value: JsonValue;
};

type PunctuationTokenType = Exclude<JsonToken['type'], 'interpolation' | 'other' | 'string'>;

const PUNCTUATION_TOKENS: Record<string, PunctuationTokenType | undefined> = {
  ':': 'colon',
  ',': 'comma',
  '{': 'leftBrace',
  '}': 'rightBrace',
  '[': 'leftBracket',
  ']': 'rightBracket',
};

export function getJsonSchemaRequiredFieldDefinitionAtOffset(
  text: string,
  offset: number,
): JsonSchemaRequiredFieldDefinition | undefined {
  const rootValues = parseJsonLikeDocument(text);
  const definitions: JsonSchemaRequiredFieldDefinition[] = [];

  for (const value of rootValues) {
    collectRequiredFieldDefinitions(value, definitions);
  }

  return definitions.find(
    (definition) => offset >= definition.requiredStringStart && offset <= definition.requiredStringEnd,
  );
}

function parseJsonLikeDocument(text: string): JsonValue[] {
  const parser = new JsonLikeParser(tokenizeJsonLikeText(text));
  const values: JsonValue[] = [];

  while (!parser.isAtEnd()) {
    const value = parser.parseValue();

    if (value) {
      values.push(value);
    } else {
      parser.advance();
    }
  }

  return values;
}

function tokenizeJsonLikeText(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const interpolationRanges = getActiveInterpolationOffsetRanges(text);
  let interpolationIndex = 0;
  let index = 0;

  while (index < text.length) {
    const interpolationRange = getInterpolationRangeAt(interpolationRanges, interpolationIndex, index);

    if (interpolationRange) {
      tokens.push({ type: 'interpolation', start: interpolationRange.start, end: interpolationRange.end });
      index = interpolationRange.end;
      interpolationIndex += 1;
      continue;
    }

    const char = text[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"') {
      const token = readJsonStringToken(text, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    const punctuationType = PUNCTUATION_TOKENS[char];

    if (punctuationType) {
      tokens.push({ type: punctuationType, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    const token = readOtherToken(text, index);
    tokens.push(token);
    index = token.end;
  }

  return tokens;
}

function getInterpolationRangeAt(
  ranges: readonly OffsetRange[],
  interpolationIndex: number,
  offset: number,
): OffsetRange | undefined {
  for (let index = interpolationIndex; index < ranges.length; index += 1) {
    const range = ranges[index]!;

    if (offset < range.start) {
      return undefined;
    }

    if (offset >= range.start && offset < range.end) {
      return range;
    }
  }

  return undefined;
}

function readJsonStringToken(text: string, start: number): Extract<JsonToken, { type: 'string' }> {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index];

    if (char === '\\') {
      index += 2;
      continue;
    }

    if (char === '"') {
      const end = index + 1;

      return {
        type: 'string',
        decoded: decodeJsonStringLiteral(text.slice(start, end)),
        start,
        end,
      };
    }

    index += 1;
  }

  return {
    type: 'string',
    decoded: undefined,
    start,
    end: text.length,
  };
}

function readOtherToken(text: string, start: number): Extract<JsonToken, { type: 'other' }> {
  let index = start + 1;

  while (index < text.length) {
    const char = text[index]!;

    if (char === '"' || /\s/.test(char) || PUNCTUATION_TOKENS[char]) {
      break;
    }

    index += 1;
  }

  return { type: 'other', start, end: index };
}

function decodeJsonStringLiteral(rawLiteral: string): string | undefined {
  try {
    const decoded = JSON.parse(rawLiteral);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

class JsonLikeParser {
  private index = 0;

  constructor(private readonly tokens: readonly JsonToken[]) {}

  isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  advance(): JsonToken | undefined {
    const token = this.peek();

    if (token) {
      this.index += 1;
    }

    return token;
  }

  parseValue(): JsonValue | undefined {
    const token = this.peek();

    if (!token) {
      return undefined;
    }

    if (token.type === 'leftBrace') {
      return this.parseObject();
    }

    if (token.type === 'leftBracket') {
      return this.parseArray();
    }

    if (token.type === 'string') {
      this.advance();
      return { type: 'string', start: token.start, end: token.end, token };
    }

    if (token.type === 'rightBrace' || token.type === 'rightBracket' || token.type === 'comma' || token.type === 'colon') {
      return undefined;
    }

    this.advance();

    return { type: 'other', start: token.start, end: token.end };
  }

  private parseObject(): Extract<JsonValue, { type: 'object' }> {
    const startToken = this.advance()!;
    const properties: JsonProperty[] = [];
    let end = startToken.end;

    while (!this.isAtEnd()) {
      const token = this.peek();

      if (!token) {
        break;
      }

      if (token.type === 'rightBrace') {
        end = this.advance()!.end;
        break;
      }

      if (token.type !== 'string') {
        this.skipToNextObjectEntry();
        continue;
      }

      const key = this.advance() as Extract<JsonToken, { type: 'string' }>;

      if (!this.consume('colon')) {
        this.skipToNextObjectEntry();
        continue;
      }

      const value = this.parseValue() ?? { type: 'other', start: key.end, end: key.end };
      properties.push({ key, value });
      end = value.end;
      this.consume('comma');
    }

    return {
      type: 'object',
      properties,
      start: startToken.start,
      end,
    };
  }

  private parseArray(): Extract<JsonValue, { type: 'array' }> {
    const startToken = this.advance()!;
    const elements: JsonValue[] = [];
    let end = startToken.end;

    while (!this.isAtEnd()) {
      const token = this.peek();

      if (!token) {
        break;
      }

      if (token.type === 'rightBracket') {
        end = this.advance()!.end;
        break;
      }

      const value = this.parseValue();

      if (value) {
        elements.push(value);
        end = value.end;
      } else {
        this.advance();
      }

      this.consume('comma');
    }

    return {
      type: 'array',
      elements,
      start: startToken.start,
      end,
    };
  }

  private consume(type: JsonToken['type']): boolean {
    if (this.peek()?.type !== type) {
      return false;
    }

    this.advance();
    return true;
  }

  private peek(): JsonToken | undefined {
    return this.tokens[this.index];
  }

  private skipToNextObjectEntry(): void {
    while (!this.isAtEnd()) {
      const token = this.peek();

      if (token?.type === 'comma') {
        this.advance();
        return;
      }

      if (token?.type === 'rightBrace') {
        return;
      }

      this.advance();
    }
  }
}

function collectRequiredFieldDefinitions(
  value: JsonValue,
  definitions: JsonSchemaRequiredFieldDefinition[],
): void {
  if (value.type === 'array') {
    for (const element of value.elements) {
      collectRequiredFieldDefinitions(element, definitions);
    }
    return;
  }

  if (value.type !== 'object') {
    return;
  }

  collectObjectRequiredFieldDefinitions(value, definitions);

  for (const property of value.properties) {
    collectRequiredFieldDefinitions(property.value, definitions);
  }
}

function collectObjectRequiredFieldDefinitions(
  objectValue: Extract<JsonValue, { type: 'object' }>,
  definitions: JsonSchemaRequiredFieldDefinition[],
): void {
  const requiredProperty = getFirstProperty(objectValue, 'required');
  const propertiesProperty = getFirstProperty(objectValue, 'properties');

  if (requiredProperty?.value.type !== 'array' || propertiesProperty?.value.type !== 'object') {
    return;
  }

  for (const requiredElement of requiredProperty.value.elements) {
    if (requiredElement.type !== 'string' || requiredElement.token.decoded == null) {
      continue;
    }

    const targetProperty = getFirstProperty(propertiesProperty.value, requiredElement.token.decoded);

    if (!targetProperty) {
      continue;
    }

    definitions.push({
      requiredStringStart: requiredElement.token.start,
      requiredStringEnd: requiredElement.token.end,
      targetKeyStart: targetProperty.key.start,
      targetKeyEnd: targetProperty.key.end,
    });
  }
}

function getFirstProperty(
  objectValue: Extract<JsonValue, { type: 'object' }>,
  decodedKey: string,
): JsonProperty | undefined {
  return objectValue.properties.find((property) => property.key.decoded === decodedKey);
}
