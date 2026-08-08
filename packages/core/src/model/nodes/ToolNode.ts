import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeRunActivityDescriptor, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { dedent } from 'ts-dedent';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type NodeBodySpec } from '../NodeBodySpec.js';
import { extractInterpolationVariables, interpolate } from '../../utils/interpolation.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { keys } from '../../utils/typeSafety.js';
import { coerceTypeOptional, coerceType } from '../../utils/coerceType.js';
import { getInputOrData } from '../../utils/index.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import type { GptFunctionResultHandling } from '../DataValue.js';

export type GptFunctionNode = ChartNode<'gptFunction', GptFunctionNodeData>;

export type GptFunctionNodeData = {
  name: string;
  useNameInput?: boolean;

  description: string;
  useDescriptionInput?: boolean;

  resultHandling?: GptFunctionResultHandling;

  schema: string;
  useSchemaInput?: boolean;

  strict?: boolean;
};

export class GptFunctionNodeImpl extends NodeImpl<GptFunctionNode> {
  static create(): GptFunctionNode {
    const chartNode: GptFunctionNode = {
      type: 'gptFunction',
      title: 'Tool',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        name: 'newTool',
        description: 'No description provided',
        resultHandling: 'continue',
        schema: dedent`
          {
            "type": "object",
            "properties": {}
          }`,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    let inputs: NodeInputDefinition[] = [];

    if (this.data.useNameInput) {
      inputs.push({
        id: 'name' as PortId,
        title: 'Name',
        dataType: 'string',
        description: 'The name of the tool that the LLM will see as available to call',
      });
    }

    if (this.data.useDescriptionInput) {
      inputs.push({
        id: 'description' as PortId,
        title: 'Description',
        dataType: 'string',
        description: 'The description of the tool that the LLM will see as available to call',
      });
    }

    if (this.data.useSchemaInput) {
      inputs.push({
        id: 'schema' as PortId,
        title: 'Schema',
        dataType: 'object',
        description: 'The schema of the tool that the LLM will see as available to call',
      });
    }

    const inputNames = this.data.useSchemaInput ? [] : extractInterpolationVariables(this.data.schema);
    inputs = [
      ...inputs,
      ...(inputNames?.map((inputName): NodeInputDefinition => {
        return createInterpolationInputDefinition({
          id: `input-${inputName}` as PortId,
          interpolationName: inputName,
          dataType: 'string',
          description: `An interpolated value in the schema named '${inputName}'`,
        });
      }) ?? []),
    ];

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'function' as PortId,
        title: 'Function',
        dataType: 'gpt-function',
        description: 'The tool that can be called by the LLM.',
      },
    ];
  }

  getRunActivityDescriptor(): NodeRunActivityDescriptor {
    return {
      category: 'tool',
      primaryOutputPortId: 'function' as PortId,
      fullOutputActionLabel: 'Open tool definition',
    };
  }

  getEditors(): EditorDefinition<GptFunctionNode>[] {
    return [
      {
        type: 'custom',
        customEditorId: 'GptFunctionNodeJsonSchemaAiAssist',
        label: 'AI Assist',
      },
      {
        type: 'string',
        label: 'Name',
        dataKey: 'name',
        useInputToggleDataKey: 'useNameInput',
      },
      {
        type: 'code',
        label: 'Description',
        dataKey: 'description',
        useInputToggleDataKey: 'useDescriptionInput',
        language: 'prompt-interpolation-markdown',
        theme: 'prompt-interpolation',
        height: 100,
      },
      {
        type: 'dropdown',
        label: 'Result handling',
        dataKey: 'resultHandling',
        defaultValue: 'continue',
        options: [
          { label: 'Continue with LLM', value: 'continue' },
          { label: 'Return directly', value: 'return-direct' },
        ],
        helperMessage:
          'Return directly uses the handler output as the final LLM Chat response when it is the only tool call in an auto-continued round.',
      },
      {
        type: 'code',
        label: 'Schema',
        dataKey: 'schema',
        language: 'json',
        interpolationSyntax: 'json-template',
        useInputToggleDataKey: 'useSchemaInput',
        enableFolding: true,
      },
      {
        type: 'toggle',
        label: 'Strict',
        dataKey: 'strict',
        helperMessage:
          "Legacy Chat node only. Sets OpenAI's strict tool/function parameter for Structured Outputs; LLM Chat does not use this setting.",
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return {
      type: 'markdown',
      text: `**${this.data.name}**\n${this.data.description}`,
    };
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Defines a tool, which is a method that the LLM can call in its responses.
      `,
      infoBoxTitle: 'Tool Node',
      contextMenuTitle: 'Tool',
      group: ['AI'],
    };
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const name = getInputOrData(this.data, inputs, 'name');
    const description = getInputOrData(this.data, inputs, 'description');
    const resultHandling: GptFunctionResultHandling =
      this.data.resultHandling === 'return-direct' ? 'return-direct' : 'continue';

    let schema: unknown;
    if (this.data.useSchemaInput) {
      schema = coerceType(inputs['schema' as PortId], 'object');
    } else {
      const inputMap = keys(inputs)
        .filter((key) => key.startsWith('input'))
        .reduce(
          (acc, key) => {
            const stringValue = coerceTypeOptional(inputs[key], 'string') ?? '';

            const interpolationKey = key.slice('input-'.length);
            acc[interpolationKey] = stringValue;
            return acc;
          },
          {} as Record<string, string>,
        );

      const interpolated = interpolate(this.data.schema, inputMap);

      schema = JSON.parse(interpolated);
    }

    return {
      ['function' as PortId]: {
        type: 'gpt-function',
        value: {
          name,
          description,
          parameters: schema as object,
          strict: this.data.strict ?? false,
          resultHandling,
        },
      },
    };
  }
}

export const gptFunctionNode = nodeDefinition(GptFunctionNodeImpl, 'Tool');
