import type { DataValue } from '../DataValue.js';
import type { Inputs } from '../GraphProcessor.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import type { NodeInputDefinition, PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { extractInterpolationVariableReferences, getInterpolationGlobalValues, interpolate } from '../../utils/interpolation.js';
import { interpolateJsonTemplate } from '../nodes/ObjectNode.js';
import type { ClassifierEntry, ClassifierEntryEditorType } from './types.js';

export type ClassifierQuestionBaseData = {
  questionId: string;
  instructions: string;
  instructionsType?: ClassifierEntryEditorType;
  instructionsLines?: string[];
  instructionsObjectTemplate?: string;
  useInstructionsInput?: boolean;
};

const STRUCTURED_ENTRY_TYPES = ['string', 'object', 'object[]', 'any', 'any[]'] as const;

export function getInstructionsInputDefinition(): NodeInputDefinition {
  return {
    id: 'instructions' as PortId,
    title: 'Instructions',
    dataType: STRUCTURED_ENTRY_TYPES,
    required: true,
    splitRunBehavior: 'preserve-array',
    description: 'String or JSON structure describing the independent question.',
  };
}

export function getCriteriaInputDefinition(dataTypes: NodeInputDefinition['dataType']): NodeInputDefinition {
  return {
    id: 'criteria' as PortId,
    title: 'Criteria',
    dataType: dataTypes,
    required: true,
    splitRunBehavior: 'preserve-array',
    description: 'Complete criteria for this question.',
  };
}

export function getInterpolationInputDefinitions(
  templates: readonly string[],
  reserved: ReadonlySet<string>,
): NodeInputDefinition[] {
  const names = new Set<string>();
  for (const template of templates) {
    for (const { baseName } of extractInterpolationVariableReferences(template)) {
      if (!reserved.has(baseName)) names.add(baseName);
    }
  }

  return [...names].map((interpolationName) =>
    createInterpolationInputDefinition({
      interpolationName,
      dataType: 'any',
      required: false,
      description: `Interpolated value named '${interpolationName}'.`,
    }),
  );
}

function inputValues(inputs: Inputs): Record<string, DataValue | undefined> {
  const values = Object.create(null) as Record<string, DataValue | undefined>;
  for (const [key, value] of Object.entries(inputs)) values[key] = value;
  return values;
}

export function interpolateQuestionText(template: string, inputs: Inputs, context: InternalProcessContext): string {
  return interpolate(template, inputValues(inputs), context.graphInputNodeValues, context.contextValues, {
    globalValues: getInterpolationGlobalValues(template, context.getGlobal),
  });
}

export function resolveAuthoredClassifierEntry({
  type,
  text,
  lines,
  objectTemplate,
  inputs,
  context,
  label,
}: {
  type: ClassifierEntryEditorType | undefined;
  text: string | undefined;
  lines: readonly string[] | undefined;
  objectTemplate: string | undefined;
  inputs: Inputs;
  context: InternalProcessContext;
  label: string;
}): Exclude<ClassifierEntry, null> {
  if (type === 'lines') {
    const resolved = (lines ?? []).map((line) => interpolateQuestionText(line, inputs, context));
    if (resolved.length === 0) throw new Error(`${label} require at least one line.`);
    return resolved;
  }

  if (type === 'object') {
    const template = objectTemplate?.trim() ? objectTemplate : '{}';
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        interpolateJsonTemplate(
          template,
          Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value?.value])),
          context.graphInputNodeValues,
          context.contextValues,
          getInterpolationGlobalValues(template, context.getGlobal),
        ),
      );
    } catch (error) {
      throw new Error(`${label} JSON template is invalid: ${(error as Error).message}`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`${label} JSON template must produce an object.`);
    }
    assertClassifierEntry(parsed, label);
    return parsed;
  }

  return interpolateQuestionText(text ?? '', inputs, context);
}

export function getStringInput(inputs: Inputs, portId: string, label: string): string {
  const value = inputs[portId as PortId]?.value;
  if (typeof value !== 'string') throw new Error(`${label} input must be a string.`);
  return value;
}

export function requireQuestionId(questionId: string): string {
  if (questionId.trim().length === 0) throw new Error('Question ID is required.');
  return questionId;
}

export function getStructuredInput(inputs: Inputs, portId: string, label: string): ClassifierEntry {
  const value = inputs[portId as PortId]?.value;
  if (value === undefined) throw new Error(`${label} input is required.`);
  assertClassifierEntry(value, label);
  return value;
}

export function assertClassifierEntry(value: unknown, label: string): asserts value is ClassifierEntry {
  assertClassifierEntryValue(value, label, new Set<object>(), false);
}

export function assertClassifierInstructions(
  value: unknown,
  label = 'Instructions',
): asserts value is Exclude<ClassifierEntry, null> {
  assertClassifierEntry(value, label);
  if (value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`${label} are required.`);
  }
}

function assertClassifierEntryValue(value: unknown, label: string, seen: Set<object>, nested: boolean): void {
  if (value === null || typeof value === 'string') return;
  if (nested && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) return;
  if (typeof value !== 'object') throw new Error(`${label} must contain only strings, null, objects, and arrays.`);
  if (seen.has(value)) throw new Error(`${label} must not contain circular references.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClassifierEntryValue(item, `${label}[${index}]`, seen, true));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertClassifierEntryValue(item, `${label}.${key}`, seen, true);
    }
  }
  seen.delete(value);
}

export function abbreviate(value: string, maximum = 72): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 3)}...`;
}
