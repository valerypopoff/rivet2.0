import { jsonValueToDataValue, type LooseDataValue } from '@valerypopoff/rivet2-node';
import { readFile } from 'node:fs/promises';

function isInputRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonInputRecord(text: string, source: string): Record<string, LooseDataValue> {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmedText);
  } catch (error) {
    throw new Error(`${source} must be valid JSON.`, { cause: error });
  }

  if (!isInputRecord(parsed)) {
    throw new Error(`${source} must be a JSON object.`);
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, jsonValueToInputValue(value)]),
  );
}

export function parseKeyValueInputRecord(values: string[], source: string): Record<string, LooseDataValue> {
  return Object.fromEntries(
    values.map((item) => {
      const separatorIndex = item.indexOf('=');

      if (separatorIndex <= 0) {
        throw new Error(`Invalid ${source} value "${item}". Expected key=value.`);
      }

      const key = item.slice(0, separatorIndex).trim();

      if (!key) {
        throw new Error(`Invalid ${source} value "${item}". Expected a non-empty key.`);
      }

      return [key, item.slice(separatorIndex + 1)];
    }),
  );
}

export function parseJsonKeyValueInputRecord(values: string[], source: string): Record<string, LooseDataValue> {
  return Object.fromEntries(
    values.map((item) => {
      const separatorIndex = item.indexOf('=');

      if (separatorIndex <= 0) {
        throw new Error(`Invalid ${source} value "${item}". Expected key=json.`);
      }

      const key = item.slice(0, separatorIndex).trim();

      if (!key) {
        throw new Error(`Invalid ${source} value "${item}". Expected a non-empty key.`);
      }

      const json = item.slice(separatorIndex + 1);

      try {
        return [key, jsonValueToInputValue(JSON.parse(json))];
      } catch (error) {
        throw new Error(`Invalid ${source} value "${item}". Expected valid JSON after "=".`, { cause: error });
      }
    }),
  );
}

export async function parseJsonInputRecordFromFile(filePath: string, source: string): Promise<Record<string, LooseDataValue>> {
  return parseJsonInputRecord(await readFile(filePath, 'utf8'), source);
}

export function throwIfConflictingInputSources(
  sources: Array<{ enabled: boolean; name: string }>,
  sourceKind: string,
): void {
  const enabledSources = sources.filter((source) => source.enabled).map((source) => source.name);

  if (enabledSources.length > 1) {
    throw new Error(`Use only one ${sourceKind} source. Received: ${enabledSources.join(', ')}.`);
  }
}

function jsonValueToInputValue(value: unknown): LooseDataValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return jsonValueToDataValue(value);
}
