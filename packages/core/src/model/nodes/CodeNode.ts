import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type PortId,
  type NodeOutputDefinition,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { dedent } from 'ts-dedent';
import { type EditorDefinition } from '../EditorDefinition.js';
import { type NodeBodySpec } from '../NodeBodySpec.js';
import { nodeDefinition } from '../NodeDefinition.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { resolveUniqueValueDerivedPortIds } from '../../utils/orderedStringPortIds.js';
import {
  appendCodeNodeSourceUrl,
  buildCodeNodeSourceUrl,
  enrichCodeNodeErrorWithLocation,
} from './codeNodeErrorDiagnostics.js';
import { ALL_CODE_RUNNER_OPTIONS } from '../../integrations/CodeRunner.js';

export type CodeNode = ChartNode<'code', CodeNodeData>;

export type CodeNodeData = {
  code: string;
  inputNames: string | string[];
  outputNames: string | string[];
};

const CODE_RUNTIME_HELPER_MESSAGE =
  'Node execution also provides "require" and "process". Browser execution provides "fetch", "console", and "Rivet".';

export class CodeNodeImpl extends NodeImpl<CodeNode> {
  static create(): CodeNode {
    const chartNode: CodeNode = {
      type: 'code',
      title: 'Code (legacy)',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
      },
      data: {
        code: dedent`
          // This is a Code (legacy) node. Write JavaScript here and it will be executed.
          // Inputs are accessible via an object \`inputs\` and data is typed (i.e. inputs.foo.type, inputs.foo.value)
          // Return an object with named outputs that match the output names specified in the node's config.
          // Output values must be typed as well (e.g. { bar: { type: 'string', value: 'bar' } }
          return {
            output1: {
              type: inputs.input1.type,
              value: inputs.input1.value
            }
          };
        `,
        inputNames: 'input1',
        outputNames: 'output1',
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputNames = this.data.inputNames
      ? Array.isArray(this.data.inputNames)
        ? this.data.inputNames
        : [this.data.inputNames]
      : [];

    return resolveUniqueValueDerivedPortIds(inputNames).map((inputName) => {
      return {
        type: 'any',
        id: inputName.trim() as PortId,
        title: inputName.trim(),
        dataType: 'string',
        required: false,
      };
    });
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputNames = this.data.outputNames
      ? Array.isArray(this.data.outputNames)
        ? this.data.outputNames
        : [this.data.outputNames]
      : [];

    return resolveUniqueValueDerivedPortIds(outputNames).map((outputName) => {
      return {
        id: outputName.trim() as PortId,
        title: outputName.trim(),
        dataType: 'any',
      };
    });
  }

  getEditors(): EditorDefinition<CodeNode>[] {
    return [
      {
        type: 'custom',
        customEditorId: 'CodeNodeAIAssist',
        label: 'AI Assist',
      },
      {
        type: 'code',
        label: '',
        helperMessage: CODE_RUNTIME_HELPER_MESSAGE,
        dataKey: 'code',
        language: 'javascript',
        enableFolding: true,
      },
      {
        type: 'stringList',
        label: 'Inputs',
        dataKey: 'inputNames',
        reorderable: true,
        portBinding: {
          side: 'input',
          identity: 'value-derived',
          valueToPortId: 'sanitize-identifier',
        },
      },
      {
        type: 'stringList',
        label: 'Outputs',
        dataKey: 'outputNames',
        reorderable: true,
        portBinding: {
          side: 'output',
          identity: 'value-derived',
          valueToPortId: 'sanitize-identifier',
        },
      },
    ];
  }

  getBody(): string | NodeBodySpec | undefined {
    const trimmed = this.data.code.split('\n').slice(0, 15).join('\n').trim();

    return {
      type: 'colorized',
      text: trimmed,
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    };
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Executes legacy JavaScript code with manually configured inputs and outputs.
      `,
      infoBoxTitle: 'Code (legacy) Node',
      contextMenuTitle: 'Code (legacy)',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const sourceUrl = buildCodeNodeSourceUrl(this.chartNode.id);
    let outputs: Outputs;

    try {
      outputs = await context.codeRunner.runCode(
        appendCodeNodeSourceUrl(this.data.code, sourceUrl),
        inputs,
        ALL_CODE_RUNNER_OPTIONS,
        context.graphInputNodeValues,
        context.contextValues,
      );
    } catch (error) {
      throw await enrichCodeNodeErrorWithLocation({
        code: this.data.code,
        error,
        locationLabel: 'Code (legacy) node',
        sourceUrl,
      });
    }

    if (outputs == null || typeof outputs !== 'object' || ('then' in outputs && typeof outputs.then === 'function')) {
      throw new Error('Code (legacy) node must return an object with output values.');
    }

    const missingOutputs = this.getOutputDefinitions().filter((output) => !(output.id in outputs));
    if (missingOutputs.length > 0) {
      throw new Error(
        `Code (legacy) node must return an object with output values for all outputs. To not run an output, return { "type": "control-flow-excluded", "value": undefined }. To return undefined, return { "type": "any", "value": undefined }. Missing: ${missingOutputs
          .map((output) => output.id)
          .join(', ')}`,
      );
    }

    return outputs;
  }
}

export const codeNode = nodeDefinition(CodeNodeImpl, 'Code (legacy)');
