import {
  type ChartNode,
  type NodeId,
  type PortId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { nanoid } from 'nanoid/non-secure';
import {
  type DataRef,
  type EditorDefinition,
  type Inputs,
  type InternalProcessContext,
  type Outputs,
} from '../../index.js';
import { base64ToUint8Array } from '../../utils/base64.js';
import { expectType } from '../../utils/expectType.js';

export type ImageNode = ChartNode<'image', ImageNodeData>;

type ImageNodeData = {
  /** Missing on older projects; treat it as binary for compatibility. */
  sourceType?: 'binary' | 'base64';
  data?: DataRef;
  useDataInput: boolean;
  base64?: string;
  useBase64Input?: boolean;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif';
  useMediaTypeInput: boolean;
};

export class ImageNodeImpl extends NodeImpl<ImageNode> {
  static create(): ImageNode {
    return {
      id: nanoid() as NodeId,
      type: 'image',
      title: 'Image',
      visualData: { x: 0, y: 0, width: 250 },
      data: {
        sourceType: 'binary',
        useDataInput: false,
        base64: '',
        useBase64Input: false,
        mediaType: 'image/png',
        useMediaTypeInput: false,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputDefinitions: NodeInputDefinition[] = [];

    if (this.chartNode.data.sourceType === 'base64' && this.chartNode.data.useBase64Input) {
      inputDefinitions.push({
        id: 'base64' as PortId,
        title: 'Base64',
        dataType: 'string',
        coerced: false,
      });
    } else if (this.chartNode.data.sourceType !== 'base64' && this.chartNode.data.useDataInput) {
      inputDefinitions.push({
        id: 'data' as PortId,
        title: 'Data',
        dataType: 'binary',
        coerced: false,
      });
    }

    if (this.chartNode.data.useMediaTypeInput) {
      inputDefinitions.push({
        id: 'mediaType' as PortId,
        title: 'Media Type',
        dataType: 'string',
      });
    }

    return inputDefinitions;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'image' as PortId,
        title: 'Image',
        dataType: 'image',
      },
    ];
  }

  getEditors(): EditorDefinition<ImageNode>[] {
    return [
      {
        type: 'segmented',
        label: 'Image source',
        dataKey: 'sourceType',
        defaultValue: 'binary',
        options: [
          { value: 'binary', label: 'Binary data' },
          { value: 'base64', label: 'Base64' },
        ],
      },
      {
        type: 'dropdown',
        label: 'Media Type',
        dataKey: 'mediaType',
        options: [
          { value: 'image/png', label: 'PNG' },
          { value: 'image/jpeg', label: 'JPEG' },
          { value: 'image/gif', label: 'GIF' },
        ],
        useInputToggleDataKey: 'useMediaTypeInput',
      },
      {
        type: 'imageBrowser',
        label: 'Image',
        dataKey: 'data',
        useInputToggleDataKey: 'useDataInput',
        mediaTypeDataKey: 'mediaType',
        hideIf: (data) => data.sourceType === 'base64',
      },
      {
        type: 'code',
        label: 'Base64',
        dataKey: 'base64',
        defaultValue: '',
        language: 'plaintext',
        useInputToggleDataKey: 'useBase64Input',
        hideIf: (data) => data.sourceType !== 'base64',
        helperMessage: 'Raw base64-encoded image bytes. The Media Type setting describes the decoded image.',
      },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Image',
      group: 'Data',
      infoBoxTitle: 'Image Node',
      infoBoxBody: 'Defines an image from a file, binary input, or base64 text. Media Type describes the resulting image.',
    };
  }

  async process(inputData: Inputs, context: InternalProcessContext): Promise<Outputs> {
    let data: Uint8Array;

    if (this.chartNode.data.sourceType === 'base64') {
      const encodedData = this.chartNode.data.useBase64Input
        ? expectType(inputData['base64' as PortId], 'string')
        : this.data.base64;
      if (!encodedData?.trim()) {
        throw new Error('No base64 image data');
      }
      data = base64ToUint8Array(encodedData.trim());
    } else if (this.chartNode.data.useDataInput) {
      data = expectType(inputData['data' as PortId], 'binary');
    } else {
      const dataRef = this.data.data?.refId;
      if (!dataRef) {
        throw new Error('No data ref');
      }

      const encodedData = context.project.data?.[dataRef] as string;

      if (!encodedData) {
        throw new Error(`No data at ref ${dataRef}`);
      }

      data = base64ToUint8Array(encodedData);
    }

    const mediaType = this.chartNode.data.useMediaTypeInput
      ? expectType(inputData['mediaType' as PortId], 'string')
      : this.chartNode.data.mediaType;

    return {
      ['image' as PortId]: {
        type: 'image',
        value: { mediaType: mediaType as 'image/png' | 'image/jpeg' | 'image/gif', data },
      },
    };
  }
}

export const imageNode = nodeDefinition(ImageNodeImpl, 'Image');
