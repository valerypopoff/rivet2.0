import type { CustomEditorDefinition, ChartNode } from '@valerypopoff/rivet2-core';

export type ModelOption = {
  value: string;
  label: string;
};

export function getModelOptions(editor: CustomEditorDefinition<ChartNode>): ModelOption[] {
  return ((editor.data as { modelOptions?: ModelOption[] } | undefined)?.modelOptions ?? []) as ModelOption[];
}

export function includeCurrentModelOption(options: ModelOption[], currentModel: unknown): ModelOption[] {
  if (typeof currentModel !== 'string' || currentModel.trim() === '') {
    return options;
  }

  if (options.some((option) => option.value === currentModel)) {
    return options;
  }

  return [{ value: currentModel, label: `${currentModel} (Current)` }, ...options];
}
