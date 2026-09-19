import { nanoid } from 'nanoid/non-secure';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  abbreviate,
  assertClassifierEntry,
  assertClassifierInstructions,
  getCriteriaInputDefinition,
  getInstructionsInputDefinition,
  getInterpolationInputDefinitions,
  getStringInput,
  getStructuredInput,
  interpolateQuestionText,
  requireQuestionId,
  resolveAuthoredClassifierEntry,
  type ClassifierQuestionBaseData,
} from '../classifier/questionHelpers.js';
import type {
  ClassifierChoiceCriterionData,
  ClassifierChoiceQuestionDefinition,
  ClassifierEntry,
  ClassifierEntryEditorType,
  ClassifierNoulQuestionDefinition,
  ClassifierQuestionType,
  ClassifierScoreCriterionData,
  ClassifierScoreQuestionDefinition,
} from '../classifier/types.js';

export type ClassifierQuestionNodeData = ClassifierQuestionBaseData & {
  questionType: ClassifierQuestionType;
  /** One representation shared by all authored criteria for the active question type. */
  criteriaType?: ClassifierEntryEditorType;
  options?: { key: string; value: string }[];
  choiceCriteria?: ClassifierChoiceCriterionData[];
  scoreCriteria?: ClassifierScoreCriterionData[];
  /** @deprecated Compatibility for projects created before structured Score criteria. */
  levels?: string[];
  noulTrueCriteria?: string;
  noulFalseCriteria?: string;
  noulTrueCriteriaLines?: string[];
  noulFalseCriteriaLines?: string[];
  noulTrueCriteriaObjectTemplate?: string;
  noulFalseCriteriaObjectTemplate?: string;
  useNoulTrueCriteriaInput?: boolean;
  useNoulFalseCriteriaInput?: boolean;
  /** @deprecated Compatibility for projects created before named Noul criteria. */
  yesMeans?: string;
  /** @deprecated Compatibility for projects created before named Noul criteria. */
  noMeans?: string;
  /** Complete Choice/Score criteria input, plus legacy Noul object input. */
  useCriteriaInput?: boolean;
};

export type ClassifierQuestionNode = ChartNode<'classifierQuestion', ClassifierQuestionNodeData>;

const defaultOptions = () => [{ key: '', value: '' }, { key: '', value: '' }];
const defaultLevels = () => ['', ''];
const defaultScoreCriteria = (): ClassifierScoreCriterionData[] => [createScoreCriterion(), createScoreCriterion()];
const entryTypeOptions = [
  { value: 'text', label: 'Text' },
  { value: 'lines', label: 'List of lines' },
  { value: 'object', label: 'Object' },
];

function createScoreCriterion(): ClassifierScoreCriterionData {
  return { id: nanoid(), type: 'text', text: '', lines: [''], objectTemplate: '{}' };
}

function createChoiceCriterion(): ClassifierChoiceCriterionData {
  return { id: nanoid(), key: '', text: '', lines: [''], objectTemplate: '{}' };
}

export class ClassifierQuestionNodeImpl extends NodeImpl<ClassifierQuestionNode> {
  static create(): ClassifierQuestionNode {
    return {
      type: 'classifierQuestion',
      title: 'Classifier Question',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 280 },
      data: {
        questionType: 'choice',
        questionId: 'choice',
        instructions: '',
        instructionsType: 'text',
        instructionsLines: [''],
        instructionsObjectTemplate: '{}',
        criteriaType: 'text',
        options: defaultOptions(),
        choiceCriteria: [createChoiceCriterion(), createChoiceCriterion()],
        scoreCriteria: defaultScoreCriteria(),
        noulTrueCriteria: '',
        noulFalseCriteria: '',
        noulTrueCriteriaLines: [''],
        noulFalseCriteriaLines: [''],
        noulTrueCriteriaObjectTemplate: '{}',
        noulFalseCriteriaObjectTemplate: '{}',
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const data = this.data;
    const inputs: NodeInputDefinition[] = [];
    if (data.useInstructionsInput) inputs.push(getInstructionsInputDefinition());
    if (data.useCriteriaInput) {
      inputs.push(getCriteriaInputDefinition(getCriteriaInputTypes(data.questionType)));
    } else if (data.questionType === 'noul') {
      const criteriaType = getCriteriaType(data);
      if (data.useNoulTrueCriteriaInput) inputs.push(getNoulCriteriaInputDefinition('criteriaTrue', 'true', criteriaType));
      if (data.useNoulFalseCriteriaInput) inputs.push(getNoulCriteriaInputDefinition('criteriaFalse', 'false', criteriaType));
    }

    const templates = data.useInstructionsInput ? [] : getEntryTemplates(
      data.instructionsType,
      data.instructions,
      data.instructionsLines,
      data.instructionsObjectTemplate,
    );
    if (!data.useCriteriaInput) {
      if (data.questionType === 'choice') {
        if (getCriteriaType(data) === 'text') templates.push(...(data.options ?? []).map((option) => option.value));
        else {
          for (const criterion of getChoiceCriteria(data)) {
            templates.push(...getEntryTemplates(getCriteriaType(data), criterion.text, criterion.lines, criterion.objectTemplate));
          }
        }
      }
      else if (data.questionType === 'score') {
        for (const criterion of getScoreCriteria(data)) {
          templates.push(
            ...getEntryTemplates(
              data.criteriaType ?? criterion.type,
              criterion.text,
              criterion.lines,
              criterion.objectTemplate,
            ),
          );
        }
      } else {
        if (!data.useNoulTrueCriteriaInput) templates.push(...getNoulCriteriaTemplates(data, 'true'));
        if (!data.useNoulFalseCriteriaInput) templates.push(...getNoulCriteriaTemplates(data, 'false'));
      }
    }
    inputs.push(...getInterpolationInputDefinitions(templates, new Set(inputs.map((input) => input.id))));
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'question' as PortId, title: 'Question', dataType: 'object' }];
  }

  getEditors(): EditorDefinition<ClassifierQuestionNode>[] {
    return [
      {
        type: 'segmented',
        label: 'Question type',
        ariaLabel: 'Question type',
        dataKey: 'questionType',
        options: [
          { value: 'noul', label: 'Noul' },
          { value: 'choice', label: 'Choice' },
          { value: 'score', label: 'Score' },
        ],
        defaultValue: 'choice',
        allowOptionWrap: false,
      },
      { type: 'string', label: 'Question ID', dataKey: 'questionId' },
      {
        type: 'group',
        label: 'Instructions',
        presentation: 'section',
        editors: [
          {
            type: 'dropdown',
            label: '',
            ariaLabel: 'Instructions type',
            dataKey: 'instructionsType',
            options: entryTypeOptions,
            defaultValue: 'text',
          },
          {
            type: 'code',
            label: '',
            dataKey: 'instructions',
            useInputToggleDataKey: 'useInstructionsInput',
            language: 'prompt-interpolation-markdown',
            theme: 'prompt-interpolation',
            height: 100,
            hideIf: (data) => (data.instructionsType ?? 'text') !== 'text',
          },
          {
            type: 'stringList',
            label: '',
            dataKey: 'instructionsLines',
            useInputToggleDataKey: 'useInstructionsInput',
            placeholder: 'Instruction line',
            highlightInterpolationTokens: true,
            inputFontFamily: 'monospace',
            minimumItems: 1,
            reorderable: true,
            hideIf: (data) => data.instructionsType !== 'lines',
          },
          {
            type: 'code',
            label: '',
            dataKey: 'instructionsObjectTemplate',
            useInputToggleDataKey: 'useInstructionsInput',
            language: 'json',
            interpolationSyntax: 'json-template',
            theme: 'prompt-interpolation',
            enableFolding: true,
            defaultValue: '{}',
            height: 200,
            hideIf: (data) => data.instructionsType !== 'object',
          },
        ],
      },
      {
        type: 'group',
        label: 'Criteria',
        presentation: 'section',
        hideIf: (data) => data.questionType === 'noul' && Boolean(data.useCriteriaInput),
        editors: [
          {
            type: 'dropdown',
            label: '',
            ariaLabel: 'Criteria type',
            dataKey: 'criteriaType',
            options: entryTypeOptions,
            defaultValue: 'text',
          },
          {
            type: 'keyValuePair',
            label: '',
            dataKey: 'options',
            useInputToggleDataKey: 'useCriteriaInput',
            keyPlaceholder: 'Name',
            valuePlaceholder: 'Optional description',
            itemLabel: 'criterion',
            reorderable: true,
            highlightInterpolationTokens: true,
            hideIf: (data) => data.questionType !== 'choice' || getCriteriaType(data) !== 'text',
          },
          {
            type: 'custom',
            customEditorId: 'ClassifierChoiceCriteria',
            label: '',
            dataKey: 'choiceCriteria',
            useInputToggleDataKey: 'useCriteriaInput',
            hideIf: (data) => data.questionType !== 'choice' || getCriteriaType(data) === 'text',
          },
          {
            type: 'custom',
            customEditorId: 'ClassifierScoreCriteria',
            label: '',
            dataKey: 'scoreCriteria',
            useInputToggleDataKey: 'useCriteriaInput',
            hideIf: (data) => data.questionType !== 'score',
          },
          {
            type: 'code',
            label: 'true',
            dataKey: 'noulTrueCriteria',
            useInputToggleDataKey: 'useNoulTrueCriteriaInput',
            language: 'prompt-interpolation-markdown',
            theme: 'prompt-interpolation',
            height: 80,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'text',
          },
          {
            type: 'code',
            label: 'false',
            dataKey: 'noulFalseCriteria',
            useInputToggleDataKey: 'useNoulFalseCriteriaInput',
            language: 'prompt-interpolation-markdown',
            theme: 'prompt-interpolation',
            height: 80,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'text',
          },
          {
            type: 'stringList',
            label: 'true',
            dataKey: 'noulTrueCriteriaLines',
            useInputToggleDataKey: 'useNoulTrueCriteriaInput',
            placeholder: 'Criterion line',
            highlightInterpolationTokens: true,
            inputFontFamily: 'monospace',
            minimumItems: 1,
            reorderable: true,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'lines',
          },
          {
            type: 'stringList',
            label: 'false',
            dataKey: 'noulFalseCriteriaLines',
            useInputToggleDataKey: 'useNoulFalseCriteriaInput',
            placeholder: 'Criterion line',
            highlightInterpolationTokens: true,
            inputFontFamily: 'monospace',
            minimumItems: 1,
            reorderable: true,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'lines',
          },
          {
            type: 'code',
            label: 'true',
            dataKey: 'noulTrueCriteriaObjectTemplate',
            useInputToggleDataKey: 'useNoulTrueCriteriaInput',
            language: 'json',
            interpolationSyntax: 'json-template',
            theme: 'prompt-interpolation',
            enableFolding: true,
            defaultValue: '{}',
            height: 200,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'object',
          },
          {
            type: 'code',
            label: 'false',
            dataKey: 'noulFalseCriteriaObjectTemplate',
            useInputToggleDataKey: 'useNoulFalseCriteriaInput',
            language: 'json',
            interpolationSyntax: 'json-template',
            theme: 'prompt-interpolation',
            enableFolding: true,
            defaultValue: '{}',
            height: 200,
            hideIf: (data) => data.questionType !== 'noul' || getCriteriaType(data) !== 'object',
          },
        ],
      },
    ];
  }

  getBody(): string {
    const data = this.data;
    const criteria = data.useCriteriaInput ? 'input' : getCriteriaSummary(data);
    return [
      `ID: ${data.questionId || '(required)'}`,
      `Type: ${getQuestionTypeLabel(data.questionType)}`,
      getInstructionsSummary(data),
      `Criteria: ${criteria}`,
    ].join('\n');
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Classifier Question',
      infoBoxTitle: 'Classifier Question',
      infoBoxBody: 'Builds one typed classifier question without making a network request.',
      group: ['Classifier'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const data = this.data;
    const questionId = requireQuestionId(data.questionId);
    const instructions = data.useInstructionsInput
      ? getStructuredInput(inputs, 'instructions', 'Instructions')
      : resolveAuthoredClassifierEntry({
          type: data.instructionsType,
          text: data.instructions,
          lines: data.instructionsLines,
          objectTemplate: data.instructionsObjectTemplate,
          inputs,
          context,
          label: 'Instructions',
        });
    assertClassifierInstructions(instructions);

    const question = createQuestionDefinition(data, inputs, context, questionId, instructions);
    return { ['question' as PortId]: { type: 'object', value: question } };
  }
}

function getCriteriaInputTypes(questionType: ClassifierQuestionType): NodeInputDefinition['dataType'] {
  return questionType === 'score' ? ['object[]', 'any', 'any[]'] : ['object', 'any'];
}

function getNoulCriteriaInputDefinition(
  id: string,
  title: string,
  criteriaType: ClassifierEntryEditorType,
): NodeInputDefinition {
  return {
    id: id as PortId,
    title,
    dataType: criteriaType === 'text' ? 'string' : ['string', 'object', 'object[]', 'any', 'any[]'],
    required: true,
    splitRunBehavior: criteriaType === 'text' ? undefined : 'preserve-array',
    description: `Description for the Noul ${title} criterion.`,
  };
}

function getQuestionTypeLabel(questionType: ClassifierQuestionType): string {
  return questionType === 'noul' ? 'Noul' : questionType[0]!.toUpperCase() + questionType.slice(1);
}

function getCriteriaSummary(data: ClassifierQuestionNodeData): string {
  if (data.questionType === 'choice') {
    return `${getCriteriaType(data) === 'text' ? (data.options ?? []).length : getChoiceCriteria(data).length} choices`;
  }
  if (data.questionType === 'score') return `${getScoreCriteria(data).length} ordered criteria`;
  const count =
    Number(data.useNoulTrueCriteriaInput || hasAuthoredNoulCriteria(data, 'true')) +
    Number(data.useNoulFalseCriteriaInput || hasAuthoredNoulCriteria(data, 'false'));
  return `${count} descriptions`;
}

function getInstructionsSummary(data: ClassifierQuestionNodeData): string {
  if (data.useInstructionsInput) return 'Instructions: input';
  if (data.instructionsType === 'lines') return `Instructions: ${Math.max(1, data.instructionsLines?.length ?? 0)} lines`;
  if (data.instructionsType === 'object') return 'Instructions: object';
  return abbreviate(data.instructions) || 'Instructions: (required)';
}

function createQuestionDefinition(
  data: ClassifierQuestionNodeData,
  inputs: Inputs,
  context: InternalProcessContext,
  questionId: string,
  instructions: ClassifierEntry,
): ClassifierChoiceQuestionDefinition | ClassifierScoreQuestionDefinition | ClassifierNoulQuestionDefinition {
  if (data.questionType === 'choice') {
    return createChoiceQuestion(data, inputs, context, questionId, instructions);
  }
  if (data.questionType === 'score') {
    return createScoreQuestion(data, inputs, context, questionId, instructions);
  }
  return createNoulQuestion(data, inputs, context, questionId, instructions);
}

function createChoiceQuestion(
  data: ClassifierQuestionNodeData,
  inputs: Inputs,
  context: InternalProcessContext,
  questionId: string,
  instructions: ClassifierEntry,
): ClassifierChoiceQuestionDefinition {
  let criteria: Record<string, ClassifierEntry>;
  if (data.useCriteriaInput) {
    const value = getStructuredInput(inputs, 'criteria', 'Criteria');
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('Choice criteria must be an object.');
    }
    criteria = Object.create(null) as Record<string, ClassifierEntry>;
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(criteria, key, { enumerable: true, value: entry });
    }
  } else {
    const criteriaType = getCriteriaType(data);
    const options = criteriaType === 'text' ? data.options ?? defaultOptions() : getChoiceCriteria(data);
    if (options.length < 2 || options.length > 255) throw new Error('Choice questions require 2 to 255 options.');
    criteria = Object.create(null) as Record<string, ClassifierEntry>;
    for (const option of options) {
      if (option.key.trim() === '') throw new Error('Choice criterion names must not be empty.');
      if (Object.prototype.hasOwnProperty.call(criteria, option.key)) {
        throw new Error(`Choice criterion name '${option.key}' is duplicated.`);
      }
      Object.defineProperty(criteria, option.key, {
        enumerable: true,
        value:
          criteriaType === 'text'
            ? interpolateQuestionText((option as { value: string }).value, inputs, context) || null
            : resolveAuthoredClassifierEntry({
                type: criteriaType,
                text: (option as ClassifierChoiceCriterionData).text,
                lines: (option as ClassifierChoiceCriterionData).lines,
                objectTemplate: (option as ClassifierChoiceCriterionData).objectTemplate,
                inputs,
                context,
                label: `Criteria.${option.key}`,
              }),
      });
    }
  }
  const keys = Object.keys(criteria);
  if (keys.length < 2 || keys.length > 255) throw new Error('Choice questions require 2 to 255 unique options.');
  for (const [key, entry] of Object.entries(criteria)) assertClassifierEntry(entry, `Criteria.${key}`);
  return { questionId, type: 'choice', instructions, criteria };
}

function createScoreQuestion(
  data: ClassifierQuestionNodeData,
  inputs: Inputs,
  context: InternalProcessContext,
  questionId: string,
  instructions: ClassifierEntry,
): ClassifierScoreQuestionDefinition {
  let criteria: ClassifierEntry[];
  if (data.useCriteriaInput) {
    const value = getStructuredInput(inputs, 'criteria', 'Criteria');
    if (!Array.isArray(value)) throw new Error('Score criteria must be an array.');
    criteria = value as ClassifierEntry[];
  } else {
    criteria = getScoreCriteria(data).map((criterion, index) =>
      resolveAuthoredClassifierEntry({
        type: data.criteriaType ?? criterion.type,
        text: criterion.text,
        lines: criterion.lines,
        objectTemplate: criterion.objectTemplate,
        inputs,
        context,
        label: `Criteria[${index}]`,
      }),
    );
  }
  if (criteria.length < 2 || criteria.length > 10) throw new Error('Score questions require 2 to 10 levels.');
  criteria.forEach((entry, index) => assertClassifierEntry(entry, `Criteria[${index}]`));
  return { questionId, type: 'score', instructions, criteria };
}

function createNoulQuestion(
  data: ClassifierQuestionNodeData,
  inputs: Inputs,
  context: InternalProcessContext,
  questionId: string,
  instructions: ClassifierEntry,
): ClassifierNoulQuestionDefinition {
  let criteria: { true: ClassifierEntry; false: ClassifierEntry } | undefined;
  if (data.useCriteriaInput) {
    const value = getStructuredInput(inputs, 'criteria', 'Criteria');
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(value, 'true') ||
      !Object.prototype.hasOwnProperty.call(value, 'false')
    ) {
      throw new Error('Noul criteria must contain both true and false entries.');
    }
    criteria = { true: value.true as ClassifierEntry, false: value.false as ClassifierEntry };
  } else {
    const trueCriteria = resolveNoulCriteria(data, 'true', inputs, context);
    const falseCriteria = resolveNoulCriteria(data, 'false', inputs, context);
    if (hasClassifierCriteriaValue(trueCriteria) || hasClassifierCriteriaValue(falseCriteria)) {
      if (!hasClassifierCriteriaValue(trueCriteria) || !hasClassifierCriteriaValue(falseCriteria)) {
        throw new Error('Provide both true and false criteria, or neither.');
      }
      criteria = {
        true: trueCriteria,
        false: falseCriteria,
      };
    }
  }
  if (criteria) {
    assertClassifierEntry(criteria.true, 'Criteria.true');
    assertClassifierEntry(criteria.false, 'Criteria.false');
  }
  return { questionId, type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
}

function getEntryTemplates(
  type: ClassifierEntryEditorType | undefined,
  text: string | undefined,
  lines: readonly string[] | undefined,
  objectTemplate: string | undefined,
): string[] {
  if (type === 'lines') return [...(lines ?? [])];
  if (type === 'object') return [objectTemplate ?? '{}'];
  return [text ?? ''];
}

function getScoreCriteria(data: ClassifierQuestionNodeData): ClassifierScoreCriterionData[] {
  if (data.scoreCriteria) return data.scoreCriteria;
  return (data.levels ?? defaultLevels()).map((text) => ({ ...createScoreCriterion(), text }));
}

function getChoiceCriteria(data: ClassifierQuestionNodeData): ClassifierChoiceCriterionData[] {
  if (data.choiceCriteria) return data.choiceCriteria;
  return (data.options ?? defaultOptions()).map((option) => ({
    ...createChoiceCriterion(),
    key: option.key,
    text: option.value,
    lines: [option.value],
  }));
}

function getCriteriaType(data: ClassifierQuestionNodeData): ClassifierEntryEditorType {
  return data.criteriaType ?? 'text';
}

function getNoulTrueCriteria(data: ClassifierQuestionNodeData): string {
  return data.noulTrueCriteria ?? data.yesMeans ?? '';
}

function getNoulFalseCriteria(data: ClassifierQuestionNodeData): string {
  return data.noulFalseCriteria ?? data.noMeans ?? '';
}

function getNoulCriteriaTemplates(data: ClassifierQuestionNodeData, truthValue: 'true' | 'false'): string[] {
  const type = getCriteriaType(data);
  return getEntryTemplates(
    type,
    truthValue === 'true' ? getNoulTrueCriteria(data) : getNoulFalseCriteria(data),
    truthValue === 'true' ? data.noulTrueCriteriaLines : data.noulFalseCriteriaLines,
    truthValue === 'true' ? data.noulTrueCriteriaObjectTemplate : data.noulFalseCriteriaObjectTemplate,
  );
}

function hasAuthoredNoulCriteria(data: ClassifierQuestionNodeData, truthValue: 'true' | 'false'): boolean {
  const type = getCriteriaType(data);
  if (type === 'lines') {
    const lines = truthValue === 'true' ? data.noulTrueCriteriaLines : data.noulFalseCriteriaLines;
    return lines?.some((line) => line.trim() !== '') ?? false;
  }
  if (type === 'object') {
    const template = truthValue === 'true' ? data.noulTrueCriteriaObjectTemplate : data.noulFalseCriteriaObjectTemplate;
    const normalizedTemplate = template?.trim();
    return normalizedTemplate !== undefined && normalizedTemplate !== '' && normalizedTemplate !== '{}';
  }
  return (truthValue === 'true' ? getNoulTrueCriteria(data) : getNoulFalseCriteria(data)).trim() !== '';
}

function resolveNoulCriteria(
  data: ClassifierQuestionNodeData,
  truthValue: 'true' | 'false',
  inputs: Inputs,
  context: InternalProcessContext,
): ClassifierEntry {
  const useInput = truthValue === 'true' ? data.useNoulTrueCriteriaInput : data.useNoulFalseCriteriaInput;
  const label = `${truthValue} criteria`;
  if (useInput) {
    return getCriteriaType(data) === 'text'
      ? getStringInput(inputs, `criteria${truthValue === 'true' ? 'True' : 'False'}`, label)
      : getStructuredInput(inputs, `criteria${truthValue === 'true' ? 'True' : 'False'}`, label);
  }
  return resolveAuthoredClassifierEntry({
    type: getCriteriaType(data),
    text: truthValue === 'true' ? getNoulTrueCriteria(data) : getNoulFalseCriteria(data),
    lines: truthValue === 'true' ? data.noulTrueCriteriaLines : data.noulFalseCriteriaLines,
    objectTemplate: truthValue === 'true' ? data.noulTrueCriteriaObjectTemplate : data.noulFalseCriteriaObjectTemplate,
    inputs,
    context,
    label,
  });
}

function hasClassifierCriteriaValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(hasClassifierCriteriaValue);
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return true;
  return Object.keys(value).length > 0;
}

export const classifierQuestionNode = nodeDefinition(ClassifierQuestionNodeImpl, 'Classifier Question');
