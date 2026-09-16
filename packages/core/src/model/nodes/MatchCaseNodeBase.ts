import { type DataValue } from '../DataValue.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type Inputs, type Outputs } from '../GraphProcessor.js';
import { NodeImpl } from '../NodeImpl.js';
import {
  type ChartNode,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { coerceType } from '../../utils/coerceType.js';
import { resolveStoredOrderedPortIds } from '../../utils/orderedStringPortIds.js';

/** Shared saved routing and custom-value settings for Match case node variants. */
export type MatchCaseRoutingData = {
  cases: string[];
  casePortIds?: string[];

  /** Missing values preserve the original one-shared-value behavior. */
  valueInputMode?: 'shared' | 'per-output';

  /** If true, only the first matching branch will run. */
  exclusive?: boolean;
};

export type MatchCaseReturnValueMode = 'true' | 'testValue' | 'custom';

/**
 * Shared ports, custom-value routing, and case-output handling for the current
 * Match case node and the regex-only compatibility node. Each subclass owns
 * only its matching semantics and editor wording.
 */
export abstract class MatchCaseNodeBase<T extends ChartNode<string, MatchCaseRoutingData>> extends NodeImpl<T> {
  protected abstract readonly caseEditorLabel: string;
  protected abstract readonly caseEditorPlaceholder: string;
  protected readonly casesEditorPlacement: 'before-trigger' | 'after-custom-values' = 'after-custom-values';
  protected readonly customCaseValuesEditorLabel: string = 'Custom case values';
  protected readonly defaultExclusive: boolean = false;
  protected readonly firstMatchingBodyValue: string = 'First matching case only';
  protected readonly inputTitle: string = 'Test';
  protected readonly matchingCasesToTriggerOptions: Array<{ value: boolean; label: string }> = [
    { value: false, label: 'Trigger all matching cases' },
    { value: true, label: 'Trigger first only' },
  ];
  protected readonly sharedCustomValueInputTitle: string = 'Custom value';
  protected readonly triggerEditorLabel: string = 'Matching cases to trigger';

  protected abstract matchesCase(input: string, caseValue: string): boolean;
  protected abstract describeCaseMatch(caseValue: string): string;
  protected abstract describeNoCaseMatches(): string;

  protected getReturnValueMode(): MatchCaseReturnValueMode {
    return 'custom';
  }

  protected getEditorsAfterTrigger(): EditorDefinition<T>[] {
    return [];
  }

  protected shouldHideCustomCaseValues(_data: T['data']): boolean {
    return false;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      {
        id: 'input' as PortId,
        title: this.inputTitle,
        dataType: 'string',
        required: true,
        description: `The ${this.inputTitle} value tested against each case.`,
      },
    ];

    if (this.getReturnValueMode() !== 'custom') {
      return inputs;
    }

    if (this.getValueInputMode() === 'shared') {
      inputs.push({
        id: 'value' as PortId,
        title: this.sharedCustomValueInputTitle,
        dataType: 'any',
        description: `The optional value passed through to every matching output. If unconnected, the ${this.inputTitle} value is passed through.`,
      });
    } else {
      const portIds = this.getCasePortIds();

      this.data.cases.forEach((caseValue, index) => {
        inputs.push({
          id: this.getCaseValueInputId(portIds[index]!) as PortId,
          title: this.getCaseTitle(caseValue, index),
          dataType: 'any',
          description: `The optional custom value emitted when ${this.describeCaseMatch(caseValue)}. If unconnected, ${this.inputTitle} is passed through.`,
        });
      });

      inputs.push({
        id: 'value-unmatched' as PortId,
        title: 'Unmatched',
        dataType: 'any',
        description: `The optional custom value emitted when ${this.describeNoCaseMatches()}. If unconnected, ${this.inputTitle} is passed through.`,
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];
    const portIds = this.getCasePortIds();
    const returnValueMode = this.getReturnValueMode();
    const dataType = returnValueMode === 'true' ? 'boolean' : returnValueMode === 'testValue' ? 'string' : 'any';

    for (let index = 0; index < this.data.cases.length; index++) {
      const caseValue = this.data.cases[index]!;
      const title = this.getCaseTitle(caseValue, index);
      outputs.push({
        id: portIds[index]! as PortId,
        title,
        dataType,
        description: this.getMatchingOutputDescription(caseValue, title),
      });
    }

    outputs.push({
      id: 'unmatched' as PortId,
      title: 'Unmatched',
      dataType,
      description: this.getUnmatchedOutputDescription(),
    });

    return outputs;
  }

  getBody(): string {
    return this.getExclusive() ? `Trigger: ${this.firstMatchingBodyValue}` : 'Trigger: All matching cases';
  }

  getEditors(): EditorDefinition<T>[] {
    const casesEditor = {
      type: 'stringList',
      dataKey: 'cases',
      label: this.caseEditorLabel,
      placeholder: this.caseEditorPlaceholder,
      reorderable: true,
      portBinding: {
        side: 'output',
        identity: 'stored-stable-id',
        idDataKey: 'casePortIds',
        legacyPortIdPattern: {
          kind: 'prefix',
          prefix: 'case',
          startIndex: 1,
        },
        companionBindings: [{ side: 'input', prefix: 'value-' }],
      },
    };

    return [
      ...(this.casesEditorPlacement === 'before-trigger' ? [casesEditor] : []),
      {
        type: 'segmented',
        label: this.triggerEditorLabel,
        dataKey: 'exclusive',
        defaultValue: this.defaultExclusive,
        options: this.matchingCasesToTriggerOptions,
      },
      ...this.getEditorsAfterTrigger(),
      {
        type: 'segmented',
        label: this.customCaseValuesEditorLabel,
        ariaLabel: 'Custom case values',
        dataKey: 'valueInputMode',
        defaultValue: 'shared',
        hideIf: (data) => this.shouldHideCustomCaseValues(data),
        options: [
          { value: 'shared', label: 'One shared custom value' },
          { value: 'per-output', label: 'Custom values per case' },
        ],
      },
      ...(this.casesEditorPlacement === 'after-custom-values' ? [casesEditor] : []),
    ] as EditorDefinition<T>[];
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const inputValue = inputs['input' as PortId];
    const inputString = inputValue?.value == null ? undefined : coerceType(inputValue, 'string');
    const portIds = this.getCasePortIds();
    const sharedValue = inputs['value' as PortId];
    const returnValueMode = this.getReturnValueMode();

    const getInputOutputValue = (): DataValue =>
      ({
        type: 'string',
        value: inputString,
      }) as DataValue;
    const getSharedOutputValue = (): DataValue => sharedValue ?? getInputOutputValue();
    const getConfiguredOutputValue = (customValueInputId: PortId): DataValue => {
      if (returnValueMode === 'true') {
        return { type: 'boolean', value: true };
      }

      if (returnValueMode === 'testValue') {
        return getInputOutputValue();
      }

      return this.getValueInputMode() === 'shared'
        ? getSharedOutputValue()
        : inputs[customValueInputId] ?? getInputOutputValue();
    };
    const getOutputValue = (portId: string): DataValue =>
      getConfiguredOutputValue(this.getCaseValueInputId(portId) as PortId);
    const getUnmatchedOutputValue = (): DataValue => getConfiguredOutputValue('value-unmatched' as PortId);

    let matched = false;
    const output: Outputs = {};

    for (let index = 0; index < this.data.cases.length; index++) {
      const caseValue = this.data.cases[index]!;
      const matches = inputString !== undefined && this.matchesCase(inputString, caseValue);
      const canMatch = !this.getExclusive() || !matched;
      const portId = portIds[index]!;

      if (matches && canMatch) {
        matched = true;
        output[portId as PortId] = getOutputValue(portId);
      } else {
        output[portId as PortId] = {
          type: 'control-flow-excluded',
          value: undefined,
        };
      }
    }

    output['unmatched' as PortId] = matched
      ? {
          type: 'control-flow-excluded',
          value: undefined,
        }
      : getUnmatchedOutputValue();

    return output;
  }

  protected getValueInputMode(): 'shared' | 'per-output' {
    return this.data.valueInputMode === 'per-output' ? 'per-output' : 'shared';
  }

  protected getExclusive(): boolean {
    return this.data.exclusive ?? this.defaultExclusive;
  }

  private getMatchingOutputDescription(caseValue: string, title: string): string {
    const condition = this.describeCaseMatch(caseValue);

    if (this.getReturnValueMode() === 'true') {
      return `True if ${condition}.`;
    }

    if (this.getReturnValueMode() === 'testValue') {
      return `The ${this.inputTitle} value passed through if ${condition}.`;
    }

    return this.getValueInputMode() === 'shared'
      ? `The shared ${this.sharedCustomValueInputTitle} (or ${this.inputTitle} if it is unconnected) passed through if ${condition}.`
      : `The corresponding ${title} custom value (or ${this.inputTitle} if it is unconnected) passed through if ${condition}.`;
  }

  private getUnmatchedOutputDescription(): string {
    const condition = this.describeNoCaseMatches();

    if (this.getReturnValueMode() === 'true') {
      return `True if ${condition}.`;
    }

    if (this.getReturnValueMode() === 'testValue') {
      return `The ${this.inputTitle} value passed through if ${condition}.`;
    }

    return this.getValueInputMode() === 'shared'
      ? `The shared ${this.sharedCustomValueInputTitle} (or ${this.inputTitle} if it is unconnected) passed through if ${condition}.`
      : `The Unmatched custom value (or ${this.inputTitle} if it is unconnected) passed through if ${condition}.`;
  }

  private getCasePortIds(): string[] {
    return resolveStoredOrderedPortIds(this.data.cases.length, this.data.casePortIds, {
      kind: 'prefix',
      prefix: 'case',
      startIndex: 1,
    });
  }

  private getCaseTitle(caseValue: string | undefined, index: number): string {
    return caseValue?.trim() ? caseValue : `Case ${index + 1}`;
  }

  private getCaseValueInputId(portId: string): string {
    return `value-${portId}`;
  }
}
