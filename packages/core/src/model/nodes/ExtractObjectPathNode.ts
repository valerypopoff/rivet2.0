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
import { expectType } from '../../utils/expectType.js';
import { type EditorDefinition, type InternalProcessContext, type NodeBodySpec } from '../../index.js';
import { dedent } from 'ts-dedent';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { extractInterpolationVariables, getInterpolationGlobalValues, interpolate } from '../../utils/interpolation.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import { evaluateJsonPath } from '../../utils/jsonPath.js';

export type ExtractObjectPathNode = ChartNode<'extractObjectPath', ExtractObjectPathNodeData>;

export type ExtractObjectPathNodeData = {
  path: string;
  usePathInput: boolean;
};

// Keep built-in ports from becoming implicit interpolation variables.
const RESERVED_INPUT_IDS = new Set<PortId>(['object' as PortId]);

export function getExtractObjectPathInterpolationInputNames(path: string): string[] {
  return extractInterpolationVariables(path).filter((inputName) => !RESERVED_INPUT_IDS.has(inputName as PortId));
}

function buildExtractObjectPathInterpolationInputs(
  path: string,
  inputs: Record<PortId, DataValue>,
): Record<string, DataValue | string | undefined> {
  return Object.fromEntries(
    extractInterpolationVariables(path).map((inputName) => [
      inputName,
      RESERVED_INPUT_IDS.has(inputName as PortId) ? '' : inputs[inputName as PortId],
    ]),
  ) as Record<string, DataValue | string | undefined>;
}

export function interpolateExtractObjectPathSource(
  path: string,
  inputs: Record<PortId, DataValue>,
  graphInputValues?: Record<string, DataValue>,
  contextValues?: Record<string, DataValue>,
  globalValues?: Record<string, unknown>,
): string {
  return interpolate(
    path,
    buildExtractObjectPathInterpolationInputs(path, inputs),
    graphInputValues,
    contextValues,
    { globalValues },
  ).trim();
}

export class ExtractObjectPathNodeImpl extends NodeImpl<ExtractObjectPathNode> {
  static create(): ExtractObjectPathNode {
    const chartNode: ExtractObjectPathNode = {
      type: 'extractObjectPath',
      title: 'Extract Object Path',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        path: '$',
        usePathInput: false,
      },
    };

    return chartNode;
  }

  private getInterpolationInputNames(): string[] {
    return getExtractObjectPathInterpolationInputNames(this.chartNode.data.path ?? '');
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const { usePathInput } = this.chartNode.data;
    const inputDefinitions: NodeInputDefinition[] = [
      {
        id: 'object' as PortId,
        title: 'Object',
        dataType: 'object',
        required: true,
      },
    ];

    if (usePathInput) {
      inputDefinitions.push({
        id: 'path' as PortId,
        title: 'Path',
        dataType: 'string',
        required: true,
        coerced: false,
      });
    } else {
      for (const inputName of this.getInterpolationInputNames()) {
        inputDefinitions.push(
          createInterpolationInputDefinition({
            interpolationName: inputName,
            dataType: 'any',
            required: false,
          }),
        );
      }
    }

    return inputDefinitions;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'match' as PortId,
        title: 'Match',
        dataType: 'any',
      },
      {
        id: 'all_matches' as PortId,
        title: 'All Matches',
        dataType: 'any[]',
      },
    ];
  }

  getEditors(): EditorDefinition<ExtractObjectPathNode>[] {
    return [
      {
        type: 'code',
        label: 'Path',
        dataKey: 'path',
        language: 'jsonpath',
        useInputToggleDataKey: 'usePathInput',
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return this.data.usePathInput ? '(Using Input)' : this.data.path;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Extracts the value at the specified path from the input value. The path uses JSONPath notation to navigate through the value.
      `,
      infoBoxTitle: 'Extract Object Path Node',
      contextMenuTitle: 'Extract Object Path',
      group: ['Objects'],
    };
  }

  async process(
    inputs: Record<PortId, DataValue>,
    context: InternalProcessContext,
  ): Promise<Record<PortId, DataValue>> {
    const { usePathInput, path } = this.chartNode.data;
    const inputObject = coerceTypeOptional(inputs['object' as PortId], 'object');
    const rawPath = usePathInput ? expectType(inputs['path' as PortId], 'string') : path;

    if (!rawPath) {
      throw new Error('Path input is not provided');
    }

    const inputPath = usePathInput
      ? rawPath.trim()
      : interpolateExtractObjectPathSource(
          rawPath,
          inputs,
          context.graphInputNodeValues,
          context.contextValues,
          getInterpolationGlobalValues(rawPath, context.getGlobal),
        );

    let matches: unknown[];
    try {
      // Wrap doesn't seem to wrap when the input is undefined or null...
      const match = evaluateJsonPath(inputObject, inputPath, true);
      matches = match == null ? [] : (match as unknown[]);
    } catch (err) {
      matches = [];
    }

    if (matches.length === 0) {
      return {
        ['match' as PortId]: {
          type: 'control-flow-excluded',
          value: undefined,
        },
        ['all_matches' as PortId]: {
          type: 'any[]',
          value: [],
        },
      };
    }

    return {
      ['match' as PortId]: {
        type: 'any',
        value: matches[0],
      },
      ['all_matches' as PortId]: {
        type: 'any[]',
        value: matches,
      },
    };
  }
}

export const extractObjectPathNode = nodeDefinition(ExtractObjectPathNodeImpl, 'Extract Object Path');
