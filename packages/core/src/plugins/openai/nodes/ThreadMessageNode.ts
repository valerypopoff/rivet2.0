import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type EditorDefinition,
  type PluginNodeImpl,
} from '../../../index.js';
import { newId, coerceTypeOptional, getInputOrData } from '../../../utils/index.js';
import { extractInterpolationVariableReferences, interpolate } from '../../../utils/interpolation.js';
import { pluginNodeDefinition } from '../../../model/NodeDefinition.js';
import type { CreateMessageBody } from '../../../utils/openai.js';
import { createInterpolationInputDefinition } from '../../../model/interpolationInputDefinition.js';

export type ThreadMessageNode = ChartNode<'threadMessage', ThreadMessageNodeData>;

export type ThreadMessageNodeData = {
  text: string;

  fileIds?: string[];
  useFileIdsInput?: boolean;

  metadata: { key: string; value: string }[];
  useMetadataInput?: boolean;
};

export const ThreadMessageNodeImpl: PluginNodeImpl<ThreadMessageNode> = {
  create() {
    return {
      id: newId<NodeId>(),
      type: 'threadMessage',
      data: {
        text: '{{input}}',
        fileIds: [],
        useFileIdsInput: false,
        metadata: [],
        useMetadataInput: false,
      },
      title: 'Thread Message',
      visualData: {
        x: 0,
        y: 0,
        width: 225,
      },
    };
  },

  getUIData() {
    return {
      group: 'OpenAI',
      contextMenuTitle: 'Thread Message',
      infoBoxTitle: 'Thread Message Node',
      infoBoxBody: 'Create a new message for a thread.',
    };
  },

  getInputDefinitions(data) {
    let inputs: NodeInputDefinition[] = [];

    if (data.useFileIdsInput) {
      inputs.push({
        id: 'fileIds' as PortId,
        dataType: 'string[]',
        title: 'File IDs',
        coerced: true,
        defaultValue: [],
        description: 'The IDs of the files to attach to the message.',
        required: false,
      });
    }

    if (data.useMetadataInput) {
      inputs.push({
        id: 'metadata' as PortId,
        dataType: 'object',
        title: 'Metadata',
        coerced: true,
        defaultValue: {},
        description: 'Metadata to attach to the message.',
        required: false,
      });
    }

    const inputReferences = extractInterpolationVariableReferences(data.text);
    const fixedInputIds = new Set(inputs.map((input) => input.id));
    inputs = [
      ...inputs,
      ...inputReferences
        .filter(({ baseName }) => !fixedInputIds.has(baseName as PortId))
        .map(({ baseName, hasPath }): NodeInputDefinition => {
          return createInterpolationInputDefinition({
            interpolationName: baseName,
            dataType: hasPath ? 'any' : 'string',
            required: false,
          });
        }),
    ];

    return inputs;
  },

  getOutputDefinitions() {
    return [
      {
        id: 'message' as PortId,
        dataType: 'object',
        title: 'Message',
        description: 'The created message.',
      },
    ];
  },

  getEditors(): EditorDefinition<ThreadMessageNode>[] {
    return [
      {
        type: 'code',
        label: 'Text',
        dataKey: 'text',
        language: 'prompt-interpolation-markdown',
        theme: 'prompt-interpolation',
      },
      {
        type: 'keyValuePair',
        dataKey: 'metadata',
        useInputToggleDataKey: 'useMetadataInput',
        label: 'Metadata',
        keyPlaceholder: 'Key',
        valuePlaceholder: 'Value',
      },
      {
        type: 'stringList',
        dataKey: 'fileIds',
        useInputToggleDataKey: 'useFileIdsInput',
        label: 'File IDs',
        placeholder: 'File ID',
      },
    ];
  },

  getBody(data) {
    return {
      type: 'colorized',
      text: data.text.split('\n').slice(0, 15).join('\n').trim(),
      language: 'prompt-interpolation-markdown',
      theme: 'prompt-interpolation',
    };
  },

  async process(data, inputData, context?) {
    const text = getInputOrData(data, inputData, 'text', 'string');
    const fileIds = getInputOrData(data, inputData, 'fileIds', 'string[]') ?? [];

    let metadata: Record<string, string> = data.metadata.reduce(
      (acc, { key, value }) => {
        acc[key] = value;
        return acc;
      },
      {} as Record<string, string>,
    );

    if (data.useMetadataInput && inputData['metadata' as PortId]) {
      metadata = coerceTypeOptional(inputData['metadata' as PortId], 'object') as Record<string, string>;
    }

    const interpolated = interpolate(text, inputData, context?.graphInputNodeValues, context?.contextValues, {
      coerceBareVariableDataValues: true,
    });

    // Here you would typically make a call to an API to create the message
    // For the sake of this example, we'll just return the data as is

    return {
      ['message' as PortId]: {
        type: 'object',
        value: {
          role: 'user',
          content: interpolated,
          file_ids: fileIds,
          metadata,
        } satisfies CreateMessageBody,
      },
    };
  },
};

export const threadMessageNode = pluginNodeDefinition(ThreadMessageNodeImpl, 'Thread Message');
