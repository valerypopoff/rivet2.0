import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import { nodeDefinition } from '../NodeDefinition.js';
import { type NodeUIData } from '../NodeImpl.js';
import { type ChartNode, type NodeId, type NodeInputDefinition, type PortId } from '../NodeBase.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type Inputs } from '../GraphProcessor.js';
import { type InternalProcessContext } from '../ProcessContext.js';
import { type DataValue } from '../DataValue.js';
import {
  extractInterpolationVariableReferences,
  getInterpolationGlobalValues,
  interpolate,
  type InterpolationVariableReference,
} from '../../utils/interpolation.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import {
  MatchCaseNodeBase,
  type MatchCaseReturnValueMode,
  type MatchCaseRoutingData,
} from './MatchCaseNodeBase.js';

export type MatchCaseMode = 'plainText' | 'regex';
export type MatchCaseReturnValue = MatchCaseReturnValueMode;

export type MatchCaseNodeData = MatchCaseRoutingData & {
  /** Missing values on Match case nodes mean exact plain-text matching. */
  matchMode?: MatchCaseMode;

  /** Plain-text matching is case-sensitive unless this is explicitly false. */
  caseSensitive?: boolean;

  /** Missing values return boolean true from the active branch. */
  returnValue?: MatchCaseReturnValue;
};

export type MatchCaseNode = ChartNode<'matchCase', MatchCaseNodeData>;

const MATCH_CASE_INTERPOLATION_INPUT_PREFIX = 'input-';

/**
 * Discovers case-template inputs without joining case strings, so an incomplete
 * token at one row boundary can never become a token in a neighboring row.
 */
function getMatchCaseInterpolationVariableReferences(cases: readonly string[]): InterpolationVariableReference[] {
  const references = new Map<string, InterpolationVariableReference>();

  for (const caseValue of cases) {
    for (const reference of extractInterpolationVariableReferences(caseValue)) {
      const existing = references.get(reference.baseName);
      if (existing) {
        existing.hasPath ||= reference.hasPath;
      } else {
        references.set(reference.baseName, { ...reference });
      }
    }
  }

  return Array.from(references.values(), (reference) => ({ ...reference }));
}

function getMatchCaseInterpolationInputId(name: string): PortId {
  return `${MATCH_CASE_INTERPOLATION_INPUT_PREFIX}${name}` as PortId;
}

function getMatchCaseInterpolationInputs(
  references: readonly InterpolationVariableReference[],
  inputs: Inputs,
): Record<string, DataValue | undefined> {
  return Object.fromEntries(
    references.map(({ baseName }) => [baseName, inputs[getMatchCaseInterpolationInputId(baseName)]]),
  );
}

/** Match case is the current routing node; legacy `match` remains regex-only. */
export class MatchCaseNodeImpl extends MatchCaseNodeBase<MatchCaseNode> {
  protected readonly caseEditorLabel = 'Cases';
  protected readonly caseEditorPlaceholder = 'Case';
  protected readonly caseEditorHighlightsInterpolation = true;
  protected readonly caseEditorInputFontFamily = 'monospace' as const;
  protected readonly caseEditorBoxed = true;
  protected readonly casesEditorPlacement = 'before-trigger';
  protected readonly customCaseValuesEditorLabel = '';
  protected readonly defaultExclusive = true;
  protected readonly firstMatchingBodyValue = 'First matching case';
  protected readonly inputTitle = 'Input';
  protected readonly matchingCasesToTriggerOptions = [
    { value: true, label: 'First matching case' },
    { value: false, label: 'All matching cases' },
  ];
  protected readonly sharedCustomValueInputTitle = 'Output value';
  protected readonly triggerEditorLabel = 'Trigger';

  static create(): MatchCaseNode {
    return {
      type: 'matchCase',
      title: 'Match case',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        cases: ['YES', 'NO'],
        casePortIds: [nanoid(), nanoid()],
        valueInputMode: 'shared',
        matchMode: 'plainText',
        caseSensitive: true,
        exclusive: true,
        returnValue: 'true',
      },
    };
  }

  protected matchesCase(input: string, caseValue: string): boolean {
    if (this.getMatchMode() === 'regex') {
      return new RegExp(caseValue).test(input);
    }

    if (this.getCaseSensitive()) {
      return input === caseValue;
    }

    return input.toLowerCase() === caseValue.toLowerCase();
  }

  protected describeCaseMatch(caseValue: string): string {
    return this.getMatchMode() === 'plainText'
      ? this.getCaseSensitive()
        ? `the Input value exactly equals ${JSON.stringify(caseValue)}`
        : `the Input value equals ${JSON.stringify(caseValue)} without regard to case`
      : `/${caseValue}/ matches the Input value`;
  }

  protected describeNoCaseMatches(): string {
    if (this.getMatchMode() === 'regex') {
      return 'no regular expression matches the Input value';
    }

    return this.getCaseSensitive()
      ? 'no case exactly equals the Input value'
      : 'no case equals the Input value without regard to case';
  }

  protected getReturnValueMode(): MatchCaseReturnValue {
    return this.data.returnValue === 'testValue' || this.data.returnValue === 'custom'
      ? this.data.returnValue
      : 'true';
  }

  protected getEditorsAfterTrigger(): EditorDefinition<MatchCaseNode>[] {
    return [
      {
        type: 'segmented',
        label: 'Output value',
        dataKey: 'returnValue',
        defaultValue: 'true',
        options: [
          { value: 'true', label: 'True' },
          { value: 'testValue', label: 'Input value' },
          { value: 'custom', label: 'Custom' },
        ],
      },
    ];
  }

  protected shouldHideCustomCaseValues(data: MatchCaseNodeData): boolean {
    return (data.returnValue ?? 'true') !== 'custom';
  }

  protected getInterpolationInputDefinitions(): NodeInputDefinition[] {
    return getMatchCaseInterpolationVariableReferences(this.data.cases).map(({ baseName, hasPath }) =>
      createInterpolationInputDefinition({
        id: getMatchCaseInterpolationInputId(baseName),
        interpolationName: baseName,
        dataType: hasPath ? 'any' : 'string',
        required: false,
        description: `The value substituted for {{${baseName}}} in Cases.`,
      }),
    );
  }

  protected resolveCaseValues(inputs: Inputs, context?: InternalProcessContext): readonly string[] {
    const references = getMatchCaseInterpolationVariableReferences(this.data.cases);
    if (references.length === 0 && !this.data.cases.some((caseValue) => caseValue.includes('{{'))) {
      return this.data.cases;
    }

    const globalValueCache = new Map<string, unknown>();
    const missingGlobalIds = new Set<string>();
    const getCachedGlobal = (id: string) => {
      if (globalValueCache.has(id)) {
        return globalValueCache.get(id);
      }
      if (missingGlobalIds.has(id)) {
        return undefined;
      }

      const value = context?.getGlobal?.(id);
      if (value === undefined) {
        missingGlobalIds.add(id);
      } else {
        globalValueCache.set(id, value);
      }
      return value;
    };

    const interpolationInputs = getMatchCaseInterpolationInputs(references, inputs);

    return this.data.cases.map((caseValue) =>
      interpolate(caseValue, interpolationInputs, context?.graphInputNodeValues, context?.contextValues, {
        coerceBareVariableDataValues: true,
        globalValues: getInterpolationGlobalValues(caseValue, getCachedGlobal),
      }),
    );
  }

  getEditors(): EditorDefinition<MatchCaseNode>[] {
    return [
      {
        type: 'segmented',
        label: 'Match mode',
        dataKey: 'matchMode',
        layout: 'inline',
        allowOptionWrap: false,
        defaultValue: 'plainText',
        options: [
          { value: 'plainText', label: 'Plain text' },
          { value: 'regex', label: 'Regular expression' },
        ],
      },
      {
        type: 'toggle',
        label: 'Case sensitive',
        dataKey: 'caseSensitive',
        layout: 'inline',
        defaultValue: true,
        hideIf: (data) => data.matchMode === 'regex',
      },
      ...super.getEditors(),
    ] as EditorDefinition<MatchCaseNode>[];
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Routes an Input value to matching case outputs. Plain text cases use exact, case-sensitive equality by default; turn off Case sensitive to ignore letter case. Choose Regular expression to use the existing JavaScript RegExp pattern behavior; the Case sensitive switch does not apply in that mode. Cases support {{variable}} interpolation, JSONPath, and the @graphInputs, @context, and @globals runtime roots; ordinary variables create optional inputs.

        Choose First matching case to trigger only the first matching output, or All matching cases to trigger every matching output. Active outputs return True by default. They can instead return the Input value, or a custom value supplied through one shared Output value input or separate Output values inputs for every case and Unmatched.
      `,
      infoBoxTitle: 'Match case Node',
      contextMenuTitle: 'Match case',
      group: ['Logic'],
    };
  }

  private getMatchMode(): MatchCaseMode {
    return this.data.matchMode === 'regex' ? 'regex' : 'plainText';
  }

  private getCaseSensitive(): boolean {
    return this.data.caseSensitive !== false;
  }
}

export const matchCaseNode = nodeDefinition(MatchCaseNodeImpl, 'Match case');
