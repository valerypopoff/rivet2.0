import {
  GptTokenizerTokenizer,
  type DatasetProvider,
  type RivetLLMProfileHealthStore,
  type RuntimeSettings,
} from '@valerypopoff/rivet2-core';
import { TauriNativeApi } from '../../model/native/TauriNativeApi.js';

/**
 * Builds the host facilities used by Prompt Designer evaluator graphs.
 * Keeping this separate from the React hook makes the runtime contract
 * directly testable without inspecting component source.
 */
export function createPromptDesignerEvaluatorProcessorOptions(params: {
  datasetProvider: DatasetProvider;
  llmProfileHealthStore?: RivetLLMProfileHealthStore;
  settings: RuntimeSettings;
}) {
  return {
    nativeApi: new TauriNativeApi(),
    datasetProvider: params.datasetProvider,
    settings: params.settings,
    tokenizer: new GptTokenizerTokenizer(),
    llmProfileHealthStore: params.llmProfileHealthStore,
  };
}
