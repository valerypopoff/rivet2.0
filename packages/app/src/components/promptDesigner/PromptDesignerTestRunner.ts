import { useAtomValue } from 'jotai';
import { cloneDeep, range, zip } from 'lodash-es';
import { nanoid } from 'nanoid/non-secure';
import {
  ChatNodeImpl,
  GptTokenizerTokenizer,
  GraphProcessor,
  type ChatMessage,
  type ChatNodeConfigData,
  type DataValue,
  type DatasetProvider,
  type GraphId,
  type Inputs,
  type InternalProcessContext,
  type NodeId,
  type NodeTestGroup,
  type PortId,
  coerceType,
  coerceTypeOptional,
  resolveProcessSettings,
} from '@valerypopoff/rivet2-core';
import { TauriNativeApi } from '../../model/native/TauriNativeApi.js';
import { projectState } from '../../state/savedGraphs.js';
import { settingsState } from '../../state/settings.js';
import { useGetAdHocInternalProcessContext } from '../../hooks/useGetAdHocInternalProcessContext';
import { useProjectNodeRegistry } from '../../hooks/useProjectNodeRegistry';
import { useLLMProfileHealthStore } from '../../providers/ProvidersContext.js';
import type { PromptDesignerTestGroupResults } from '../../state/promptDesigner';
import { resolvePromptDesignerEvaluatorGraph } from './promptDesignerTestValidation.js';

export async function runAdHocChat(messages: ChatMessage[], data: ChatNodeConfigData, context: InternalProcessContext) {
  const chatNode = new ChatNodeImpl({
    data: {
      ...data,
      cache: false,
      useFrequencyPenaltyInput: false,
      usePresencePenaltyInput: false,
      useMaxTokensInput: false,
      useStopInput: false,
      useStop: false,
      useTemperatureInput: false,
      useModelInput: false,
      useTopPInput: false,
      useUseTopPInput: false,
    },
    id: nanoid() as NodeId,
    title: 'N/A',
    type: 'chat',
    visualData: {
      x: 0,
      y: 0,
    },
  });

  const result = await chatNode.process(
    {
      ['prompt' as PortId]: {
        type: 'chat-message[]',
        value: messages,
      },
    },
    context,
  );

  return coerceTypeOptional(result['response' as PortId], 'string') ?? '';
}

export function useRunPromptDesignerTestGroup(datasetProvider: DatasetProvider) {
  const project = useAtomValue(projectState);
  const projectNodeRegistry = useProjectNodeRegistry();
  const settings = useAtomValue(settingsState);
  const llmProfileHealthStore = useLLMProfileHealthStore();

  return async (
    testGroup: NodeTestGroup,
    messages: ChatMessage[],
    data: ChatNodeConfigData,
    context: InternalProcessContext,
  ): Promise<PromptDesignerTestGroupResults> => {
    const { graphId } = resolvePromptDesignerEvaluatorGraph(project, testGroup);
    const response = await runAdHocChat(messages, data, context);
    const processor = new GraphProcessor(project, graphId, projectNodeRegistry, true);
    processor.executor = 'browser';

    processor.on('trace', (value) => console.log(value));
    processor.on('nodeFinish', ({ node, outputs }) => {
      if (node.type === 'chat') {
        console.log(outputs['response' as PortId]);
      }
    });

    const outputs = await processor.processGraph(
      {
        nativeApi: new TauriNativeApi(),
        datasetProvider,
        settings: resolveProcessSettings(settings),
        tokenizer: new GptTokenizerTokenizer(),
        llmProfileHealthStore,
      },
      {
        ['conditions' as PortId]: {
          type: 'string[]',
          value: testGroup.tests.map((test) => test.conditionText),
        },
        ['input' as PortId]: {
          type: 'string',
          value: response,
        },
      },
    );

    const output = outputs['output' as PortId];
    if (!output || output.type === 'control-flow-excluded') {
      return {
        groupId: testGroup.id,
        response,
        results: testGroup.tests.map(({ conditionText }): PromptDesignerTestGroupResults['results'][number] => ({
          conditionText,
          pass: false,
        })),
      };
    }

    return {
      response,
      groupId: testGroup.id,
      results: zip(testGroup.tests, coerceType(output, 'boolean[]')).map(
        ([test, passOrFail]): PromptDesignerTestGroupResults['results'][number] => ({
          conditionText: test?.conditionText ?? '',
          pass: passOrFail ?? false,
        }),
      ),
    };
  };
}

export function useRunPromptDesignerTestGroupSampleCount(datasetProvider: DatasetProvider) {
  const runTestGroup = useRunPromptDesignerTestGroup(datasetProvider);
  const getAdHocInternalProcessContext = useGetAdHocInternalProcessContext();

  return async (
    testGroup: NodeTestGroup,
    messages: ChatMessage[],
    sampleCount: number,
    options: {
      onPartialResults?: (data: PromptDesignerTestGroupResults[]) => void;
    } = {},
    data: ChatNodeConfigData,
  ): Promise<PromptDesignerTestGroupResults[]> => {
    const results: PromptDesignerTestGroupResults[] = [];

    await Promise.all(
      range(sampleCount).map(async (sampleIndex) => {
        results[sampleIndex] = {
          response: '',
          groupId: testGroup.id,
          results: [],
        };

        const caseResults = await runTestGroup(
          testGroup,
          messages,
          data,
          await getAdHocInternalProcessContext({
            onPartialResult: (response) => {
              results[sampleIndex]!.response = response;
              options.onPartialResults?.(cloneDeep(results));
            },
          }),
        );

        results[sampleIndex]!.results = caseResults.results;
        options.onPartialResults?.(cloneDeep(results));
      }),
    );

    return results;
  };
}
