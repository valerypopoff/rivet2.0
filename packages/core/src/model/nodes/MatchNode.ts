import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { type DataValue } from '../DataValue.js';
import { type EditorDefinition, type Inputs, type NodeBody, type Outputs } from '../../index.js';
import { dedent } from 'ts-dedent';
import { coerceType } from '../../utils/coerceType.js';
import { resolveStoredOrderedPortIds } from '../../utils/orderedStringPortIds.js';

export type MatchNode = ChartNode<'match', MatchNodeData>;

export type MatchNodeData = {
  cases: string[];
  casePortIds?: string[];

  /** Missing values are legacy Shared mode. */
  valueInputMode?: 'shared' | 'per-output';

  /** If true, only the first matching branch will be ran. */
  exclusive?: boolean;
};

export class MatchNodeImpl extends NodeImpl<MatchNode> {
  static create(): MatchNode {
    const chartNode: MatchNode = {
      type: 'match',
      title: 'Regex Match',
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
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      {
        id: 'input' as PortId,
        title: 'Test',
        dataType: 'string',
        required: true,
        description: 'The value that will be tested against each of the cases.',
      },
    ];

    if (this.getValueInputMode() === 'shared') {
      inputs.push({
        id: 'value' as PortId,
        title: 'Custom value',
        dataType: 'any',
        description:
          'The optional value passed through to every matching output. If unconnected, the Test value is passed through.',
      });
    } else {
      const portIds = this.getCasePortIds();

      this.data.cases.forEach((caseValue, index) => {
        inputs.push({
          id: this.getCaseValueInputId(portIds[index]!) as PortId,
          title: this.getCaseTitle(caseValue, index),
          dataType: 'any',
          description: `The optional custom value emitted when /${caseValue}/ matches the Test value. If unconnected, Test is passed through.`,
        });
      });

      inputs.push({
        id: 'value-unmatched' as PortId,
        title: 'Unmatched',
        dataType: 'any',
        description:
          'The optional custom value emitted when no regular expression matches the Test value. If unconnected, Test is passed through.',
      });
    }

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];
    const portIds = this.getCasePortIds();

    for (let i = 0; i < this.data.cases.length; i++) {
      outputs.push({
        id: portIds[i]! as PortId,
        title: this.getCaseTitle(this.data.cases[i], i),
        dataType: 'any',
        description:
          this.getValueInputMode() === 'shared'
            ? `The shared Custom value (or Test if Custom value is unconnected) passed through if the test value matches /${this.data.cases[i]!}/.`
            : `The corresponding ${this.getCaseTitle(this.data.cases[i], i)} custom value (or Test if it is unconnected) passed through if the test value matches /${this.data.cases[i]!}/.`,
      });
    }

    outputs.push({
      id: 'unmatched' as PortId,
      title: 'Unmatched',
      dataType: 'any',
      description:
        this.getValueInputMode() === 'shared'
          ? 'The shared Custom value (or Test if Custom value is unconnected) passed through if no regexes match.'
          : 'The Unmatched custom value (or Test if it is unconnected) passed through if no regexes match.',
    });

    return outputs;
  }

  getBody(): NodeBody {
    return this.data.exclusive ? 'Trigger the first matching case only' : 'Trigger all matching cases';
  }

  getEditors(): EditorDefinition<MatchNode>[] {
    return [
      {
        type: 'segmented',
        label: 'Matching cases to trigger',
        dataKey: 'exclusive',
        defaultValue: false,
        options: [
          { value: false, label: 'Trigger all matching cases' },
          { value: true, label: 'Trigger first only' },
        ],
      },
      {
        type: 'segmented',
        label: 'Custom case values',
        dataKey: 'valueInputMode',
        defaultValue: 'shared',
        options: [
          { value: 'shared', label: 'One shared custom value' },
          { value: 'per-output', label: 'Custom values per case' },
        ],
      },
      {
        type: 'stringList',
        dataKey: 'cases',
        label: 'Cases (regular expressions)',
        placeholder: 'Case (regular expression)',
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
      },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Configure any number of regular expressions, each corresponding to an output. Trigger all matched outputs by default, or choose Trigger first matching case. One shared custom value passes one optional value to every active output, while Custom values per case gives each case and Unmatched output its own optional custom value input.
      `,
      infoBoxTitle: 'Regex Match Node',
      contextMenuTitle: 'Regex Match',
      group: ['Logic'],
    };
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const inputValue = inputs['input' as PortId];
    const inputString = inputValue?.value == null ? undefined : coerceType(inputValue, 'string');
    const portIds = this.getCasePortIds();
    const sharedValue = inputs['value' as PortId];

    const getTestOutputValue = (): DataValue =>
      ({
        type: 'string',
        value: inputString,
      }) as DataValue;
    const getSharedOutputValue = (): DataValue => sharedValue ?? getTestOutputValue();
    const getOutputValue = (portId: string): DataValue =>
      this.getValueInputMode() === 'shared'
        ? getSharedOutputValue()
        : inputs[this.getCaseValueInputId(portId) as PortId] ?? getTestOutputValue();
    const getUnmatchedOutputValue = (): DataValue =>
      this.getValueInputMode() === 'shared'
        ? getSharedOutputValue()
        : inputs['value-unmatched' as PortId] ?? getTestOutputValue();

    const cases = this.data.cases;
    let matched = false;
    const output: Outputs = {};

    for (let i = 0; i < cases.length; i++) {
      const match = inputString !== undefined && new RegExp(cases[i]!).test(inputString);

      const canMatch = !this.data.exclusive || !matched;
      if (match && canMatch) {
        matched = true;
        output[portIds[i]! as PortId] = getOutputValue(portIds[i]!);
      } else {
        output[portIds[i]! as PortId] = {
          type: 'control-flow-excluded',
          value: undefined,
        };
      }
    }

    if (!matched) {
      output['unmatched' as PortId] = getUnmatchedOutputValue();
    } else {
      output['unmatched' as PortId] = {
        type: 'control-flow-excluded',
        value: undefined,
      };
    }

    return output;
  }

  private getValueInputMode(): 'shared' | 'per-output' {
    return this.data.valueInputMode === 'per-output' ? 'per-output' : 'shared';
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

export const matchNode = nodeDefinition(MatchNodeImpl, 'Regex Match');
