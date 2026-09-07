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
import { type EditorDefinition, type NodeBodySpec } from '../../index.js';
import { dedent } from 'ts-dedent';
import { coerceTypeOptional } from '../../utils/coerceType.js';
import { resolveStoredOrderedPortIds } from '../../utils/orderedStringPortIds.js';
import { evaluateJsonPath } from '../../utils/jsonPath.js';

export type DestructureNode = ChartNode<'destructure', DestructureNodeData>;

export type DestructureNodeData = {
  paths: string[];
  pathPortIds?: string[];
};

export class DestructureNodeImpl extends NodeImpl<DestructureNode> {
  static create(): DestructureNode {
    const chartNode: DestructureNode = {
      type: 'destructure',
      title: 'Destructure',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 250,
      },
      data: {
        paths: ['$.value'],
        pathPortIds: [nanoid()],
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'object' as PortId,
        title: 'Object',
        dataType: 'object',
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const portIds = resolveStoredOrderedPortIds(this.data.paths.length, this.data.pathPortIds, {
      kind: 'prefix',
      prefix: 'match_',
      startIndex: 0,
    });

    return this.data.paths.map((path, index) => ({
      id: portIds[index]! as PortId,
      title: path,
      dataType: 'any',
    }));
  }

  getEditors(): EditorDefinition<DestructureNode>[] {
    return [
      {
        type: 'stringList',
        label: 'Paths',
        dataKey: 'paths',
        newItemDefault: '$.',
        reorderable: true,
        portBinding: {
          side: 'output',
          identity: 'stored-stable-id',
          idDataKey: 'pathPortIds',
          legacyPortIdPattern: {
            kind: 'prefix',
            prefix: 'match_',
            startIndex: 0,
          },
        },
        helperMessage:
          'One or more JSONPath expressions. Each expression will correspond to an output port of the node.',
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    return '';
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Destructures the input value by extracting values at the specified paths. The paths use JSONPath notation to navigate through the value.
      `,
      infoBoxTitle: 'Destructure Node',
      contextMenuTitle: 'Destructure',
      group: ['Objects'],
    };
  }

  async process(inputs: Record<PortId, DataValue>): Promise<Record<PortId, DataValue>> {
    const inputObject = coerceTypeOptional(inputs['object' as PortId], 'object');
    const portIds = resolveStoredOrderedPortIds(this.data.paths.length, this.data.pathPortIds, {
      kind: 'prefix',
      prefix: 'match_',
      startIndex: 0,
    });

    const output: Record<PortId, DataValue> = {};

    this.data.paths.forEach((path, index) => {
      let match: unknown;
      try {
        match = evaluateJsonPath(inputObject, path, false);
      } catch (err) {
        match = undefined;
      }

      output[portIds[index]! as PortId] = {
        type: 'any',
        value: match,
      };
    });

    return output;
  }
}

export const destructureNode = nodeDefinition(DestructureNodeImpl, 'Destructure');
