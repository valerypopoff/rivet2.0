import type { Inputs } from '../GraphProcessor.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import type { NodeInputDefinition, PortId } from '../NodeBase.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  extractInterpolationVariableReferences,
  getInterpolationGlobalValues,
  interpolate,
} from '../../utils/interpolation.js';
import { interpolateJsonTemplate } from '../nodes/ObjectNode.js';
import type { ClassifierEntry, ClassifierEntryEditorType } from './types.js';
import { assertClassifierEntry, classifierDataProperty } from './json.js';
import type { ClassifierQuestionPreparation } from './preparation.js';
import { checkClassifierJsonWork } from './limits.js';
export { assertClassifierEntry, assertClassifierInstructions } from './json.js';

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

export function interpolateQuestionText(
  template: string,
  inputs: Inputs,
  context: InternalProcessContext,
  preparation?: ClassifierQuestionPreparation,
): string {
  preparation?.capture(template);
  const result = interpolate(template, inputs, context.graphInputNodeValues, context.contextValues, {
    globalValues: getInterpolationGlobalValues(
      template,
      context.getGlobal,
      preparation?.check,
      preparation?.tokenLimit,
    ),
    guard: preparation,
  });
  preparation?.capture(result);
  return result;
}

export function resolveAuthoredClassifierEntry({
  type,
  text,
  lines,
  objectTemplate,
  inputs,
  context,
  label,
  preparation,
}: {
  type: ClassifierEntryEditorType | undefined;
  text: string | undefined;
  lines: readonly string[] | undefined;
  objectTemplate: string | undefined;
  inputs: Inputs;
  context: InternalProcessContext;
  label: string;
  preparation?: ClassifierQuestionPreparation;
}): Exclude<ClassifierEntry, null> {
  if (type === 'lines') {
    preparation?.capture(lines ?? []);
    const resolved: string[] = [];
    for (let index = 0; index < (lines?.length ?? 0); index++) {
      resolved.push(interpolateQuestionText(lines![index]!, inputs, context, preparation));
    }
    if (resolved.length === 0) throw new Error(`${label} require at least one line.`);
    return resolved;
  }

  if (type === 'object') {
    preparation?.capture(objectTemplate ?? '{}');
    const template = objectTemplate?.trim() ? objectTemplate : '{}';
    let parsed: unknown;
    try {
      const json = interpolateJsonTemplate(
        template,
        inputs,
        context.graphInputNodeValues,
        context.contextValues,
        getInterpolationGlobalValues(template, context.getGlobal, preparation?.check, preparation?.tokenLimit),
        preparation,
        true,
      );
      preparation?.capture(json);
      checkClassifierJsonWork(json, preparation?.check ?? (() => {}), 'question template');
      parsed = JSON.parse(json);
    } catch (error) {
      throw new Error(`${label} JSON template is invalid: ${(error as Error).message}`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error(`${label} JSON template must produce an object.`);
    }
    assertClassifierEntry(parsed, label);
    return parsed;
  }

  return interpolateQuestionText(text ?? '', inputs, context, preparation);
}

export function getQuestionInputValue(inputs: Inputs, portId: string, label: string): unknown {
  const input = classifierDataProperty(inputs, portId, label);
  return input && typeof input === 'object' ? classifierDataProperty(input, 'value', label) : undefined;
}

export function getStringInput(inputs: Inputs, portId: string, label: string): string {
  const value = getQuestionInputValue(inputs, portId, label);
  if (typeof value !== 'string') throw new Error(`${label} input must be a string.`);
  return value;
}

export function requireQuestionId(questionId: string): string {
  if (questionId.trim().length === 0) throw new Error('Question ID is required.');
  return questionId;
}

export function getStructuredInput(inputs: Inputs, portId: string, label: string): ClassifierEntry {
  const value = getQuestionInputValue(inputs, portId, label);
  if (value === undefined) throw new Error(`${label} input is required.`);
  assertClassifierEntry(value, label);
  return value;
}

export function abbreviate(value: string, maximum = 72): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 3)}...`;
}
