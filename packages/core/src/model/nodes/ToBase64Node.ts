import { nanoid } from 'nanoid/non-secure';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import type { DataValue } from '../DataValue.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { uint8ArrayToBase64 } from '../../utils/base64.js';

export type ToBase64Node = ChartNode<'toBase64', Record<string, never>>;

async function getBytesToEncode(input: DataValue | undefined): Promise<Uint8Array> {
  if (!input) {
    throw new Error('No data to encode as base64');
  }

  if (input.type.startsWith('fn<') || input.type === 'control-flow-excluded') {
    throw new Error(`Cannot encode ${input.type} as base64`);
  }

  const value = input.value;
  if (input.type === 'binary') {
    if (!(value instanceof Uint8Array)) throw new Error('Binary input must contain bytes');
    return value;
  }

  if (input.type === 'image' || input.type === 'audio' || input.type === 'document') {
    const bytes = value && typeof value === 'object' && 'data' in value ? value.data : undefined;
    if (!(bytes instanceof Uint8Array)) throw new Error(`${input.type} input must contain bytes`);
    return bytes;
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }

  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new Error('Non-finite numbers cannot be encoded as JSON');
      }
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
          throw new Error('Non-JSON objects must be converted before base64 encoding');
        }
      }
      return item;
    });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Cannot serialize input as JSON for base64 encoding${detail}`, { cause: error });
  }
  if (json === undefined) {
    throw new Error(`Cannot encode ${input.type} as base64`);
  }
  return new TextEncoder().encode(json);
}

export class ToBase64NodeImpl extends NodeImpl<ToBase64Node> {
  static create(): ToBase64Node {
    return {
      id: nanoid() as NodeId,
      type: 'toBase64',
      title: 'To Base64',
      visualData: { x: 0, y: 0, width: 175 },
      data: {},
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'data' as PortId,
        title: 'Data',
        dataType: 'any',
        required: true,
        coerced: false,
        splitRunBehavior: 'preserve-array',
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'base64' as PortId, title: 'Base64', dataType: 'string' }];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'To Base64',
      group: ['Text', 'Data'],
      infoBoxTitle: 'To Base64 Node',
      infoBoxBody:
        'Encodes bytes directly, text as UTF-8, and other JSON-serializable values as UTF-8 JSON. Outputs raw base64.',
    };
  }

  async process(inputs: Inputs): Promise<Outputs> {
    const bytes = await getBytesToEncode(inputs['data' as PortId]);
    return {
      ['base64' as PortId]: {
        type: 'string',
        value: await uint8ArrayToBase64(bytes),
      },
    };
  }
}

export const toBase64Node = nodeDefinition(ToBase64NodeImpl, 'To Base64');
