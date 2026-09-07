import { dedent } from 'ts-dedent';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeInputDefinition, PortId } from '../NodeBase.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { NodeBodySpec } from '../NodeBodySpec.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  buildClonedInputValueAssignments,
  buildJsValueInterpolatedSource,
  buildJsValueInputClonePreamble,
  buildJsValuePreview,
  getJsValueInterpolationCodeRunnerOptions,
  getJsValueInterpolationInputDefinitions,
  getJsValueInterpolationRuntimeContext,
  interpolateJsValuePreviewSource,
  sanitizeGeneratedJsValueError,
  type JsValueInterpolationRuntimeContext,
} from './jsValueInterpolation.js';

const MAX_CALLBACK_PREVIEW_BODY_LINES = 13;
const JS_LIST_CALLBACK_SIGNATURE = '(item, index, array)';
export const JS_LIST_CALLBACK_LOCAL_NAMES: ReadonlySet<string> = new Set(['item', 'index', 'array']);
const JS_LIST_INPUTS_IDENTIFIER = '__jsListInputs';
const JS_LIST_CODE_RUNNER_OPTIONS = {
  includeFetch: false,
  includeRequire: false,
  includeRivet: false,
  includeProcess: false,
  includeConsole: false,
};

function indentLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function assertSynchronousCallbackResult(result: unknown, nodeName: string): void {
  if (
    result &&
    (typeof result === 'object' || typeof result === 'function') &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    throw new Error(`${nodeName} callbacks must be synchronous.`);
  }
}

function getJSListInterpolationContext(callbackBody: string): JsValueInterpolationRuntimeContext {
  return getJsValueInterpolationRuntimeContext(callbackBody, JS_LIST_INPUTS_IDENTIFIER, {
    localIdentifiers: JS_LIST_CALLBACK_LOCAL_NAMES,
  });
}

function buildJSListRuntimePreamble(interpolationContext: JsValueInterpolationRuntimeContext): string {
  return dedent`
    const assertSynchronousCallbackResult = ${assertSynchronousCallbackResult.toString()};
    ${buildJsValueInputClonePreamble({
      cacheIdentifier: interpolationContext.cloneCacheIdentifier,
      contextIdentifier: interpolationContext.contextIdentifier,
      graphInputsIdentifier: interpolationContext.graphInputsIdentifier,
      inputsIdentifier: interpolationContext.inputsIdentifier,
    })}
    const array = cloneJsInputValue(inputs.array?.value, ${interpolationContext.cloneCacheIdentifier});
    ${buildClonedInputValueAssignments(
      interpolationContext.inputNames,
      interpolationContext.inputsIdentifier,
      interpolationContext.cloneCacheIdentifier,
    )}
  `;
}

function buildJSListCallbackRuntimeSource(
  callbackBody: string,
  interpolationContext: JsValueInterpolationRuntimeContext,
): string {
  return buildJsValueInterpolatedSource(callbackBody, interpolationContext, {
    localIdentifiers: JS_LIST_CALLBACK_LOCAL_NAMES,
  });
}

function sanitizeJSListError(error: unknown, callbackBody: string, nodeName: string): Error {
  const interpolationContext = getJSListInterpolationContext(callbackBody);
  const fallbackLabel = `${nodeName} input`;

  return sanitizeGeneratedJsValueError(
    error,
    interpolationContext.inputNames,
    interpolationContext.inputsIdentifier,
    fallbackLabel,
    [
      interpolationContext.cloneCacheIdentifier,
      interpolationContext.contextIdentifier,
      interpolationContext.graphInputsIdentifier,
      interpolationContext.interpolationHelperIdentifier,
    ],
  );
}

export function buildJSFilterWrapper(callbackBody: string): string {
  const interpolationContext = getJSListInterpolationContext(callbackBody);
  const callbackBodySource = buildJSListCallbackRuntimeSource(callbackBody, interpolationContext);

  return dedent`
    ${buildJSListRuntimePreamble(interpolationContext)}

    if (!Array.isArray(array)) {
      throw new Error('JS Filter input "array" must be an array.');
    }

    const callback = (item, index, array) => {
    ${indentLines(callbackBodySource, '  ')}
    };

    const filtered = [];
    const arrayLength = array.length;

    for (let index = 0; index < arrayLength; index++) {
      const item = array[index];
      const result = callback(item, index, array);

      assertSynchronousCallbackResult(result, 'JS Filter');

      if (result) {
        filtered.push(item);
      }
    }

    return {
      filtered: {
        type: 'any[]',
        value: filtered,
      },
    };
  `;
}

export function buildJSMapWrapper(callbackBody: string): string {
  const interpolationContext = getJSListInterpolationContext(callbackBody);
  const callbackBodySource = buildJSListCallbackRuntimeSource(callbackBody, interpolationContext);

  return dedent`
    ${buildJSListRuntimePreamble(interpolationContext)}

    if (!Array.isArray(array)) {
      throw new Error('JS Map input "array" must be an array.');
    }

    const callback = (item, index, array) => {
    ${indentLines(callbackBodySource, '  ')}
    };

    const mapped = [];
    const arrayLength = array.length;

    for (let index = 0; index < arrayLength; index++) {
      const item = array[index];
      const result = callback(item, index, array);

      assertSynchronousCallbackResult(result, 'JS Map');
      mapped.push(result);
    }

    return {
      mapped: {
        type: 'any[]',
        value: mapped,
      },
    };
  `;
}

export function getJSListCallbackInterpolationInputDefinitions(callbackBody: string): NodeInputDefinition[] {
  return getJsValueInterpolationInputDefinitions(callbackBody, {
    localIdentifiers: JS_LIST_CALLBACK_LOCAL_NAMES,
  });
}

export function getJSListInputDefinitions(callbackBody: string): NodeInputDefinition[] {
  return [
    {
      id: 'array' as PortId,
      title: 'Array',
      dataType: 'any[]',
      required: true,
    },
    ...getJSListCallbackInterpolationInputDefinitions(callbackBody),
  ];
}

export function getJSListEditors<T extends ChartNode>(): EditorDefinition<T>[] {
  return [
    {
      type: 'code',
      label: 'Callback Body',
      helperMessage: '(item, index, array) => {',
      postEditorHelperMessage:
        '};\n\n//Use {{var}} to create input ports. {{config.limit.max}} creates only config; {{item.name}} and {{array[0]}} use callback locals.',
      dataKey: 'callbackBody',
      language: 'javascript',
      interpolationSyntax: 'js-value',
      enableFolding: true,
    } as EditorDefinition<T>,
  ];
}

export function interpolateJSListCallbackBody(callbackBody: string, inputs: Inputs): string {
  return interpolateJsValuePreviewSource(callbackBody, inputs, {
    localIdentifiers: JS_LIST_CALLBACK_LOCAL_NAMES,
  });
}

export function getJSListNodeBody(callbackBody: string): NodeBodySpec {
  const previewBody = buildJsValuePreview(callbackBody, MAX_CALLBACK_PREVIEW_BODY_LINES);

  return {
    type: 'colorized',
    text: dedent`
      ${JS_LIST_CALLBACK_SIGNATURE} => {
      ${indentLines(previewBody, '  ')}
      }
    `.trim(),
    language: 'javascript',
    fontSize: 12,
    fontFamily: 'monospace',
  };
}

export function assertJSListNodeOutputs(
  outputs: Outputs,
  outputId: string,
  nodeName: string,
): asserts outputs is Outputs {
  if (outputs == null || typeof outputs !== 'object' || ('then' in outputs && typeof outputs.then === 'function')) {
    throw new Error(`${nodeName} must return an object with output values.`);
  }

  if (!(outputId in outputs)) {
    throw new Error(`${nodeName} must return an object with an "${outputId}" output.`);
  }
}

export async function runJSListNodeCode({
  buildWrapper,
  callbackBody,
  context,
  inputs,
  nodeName,
  outputId,
}: {
  buildWrapper: (callbackBody: string) => string;
  callbackBody: string;
  context: InternalProcessContext;
  inputs: Inputs;
  nodeName: string;
  outputId: string;
}): Promise<Outputs> {
  try {
    const outputs = await context.codeRunner.runCode(
      buildWrapper(callbackBody),
      inputs,
      getJsValueInterpolationCodeRunnerOptions(
        JS_LIST_CODE_RUNNER_OPTIONS,
        getJSListInterpolationContext(callbackBody),
      ),
      context.graphInputNodeValues,
      context.contextValues,
    );

    assertJSListNodeOutputs(outputs, outputId, nodeName);
    return outputs;
  } catch (error) {
    throw sanitizeJSListError(error, callbackBody, nodeName);
  }
}
