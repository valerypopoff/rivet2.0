import { type UiComponentId, type UiGraph } from '@valerypopoff/rivet2-core';
import { getUiGraphComponentDataKeys } from './componentDescriptors.js';

export type UiGraphDataKeyUsage = {
  componentId: UiComponentId;
  key: string;
  outputIndex?: number;
};

export function collectUiGraphDataKeyUsages(uiGraph: UiGraph): UiGraphDataKeyUsage[] {
  const usages: UiGraphDataKeyUsage[] = [];

  for (const component of uiGraph.components) {
    for (const write of getUiGraphComponentDataKeys(component).writes) {
      if (write.key) {
        usages.push({ componentId: component.id, ...write });
      }
    }
  }

  return usages;
}

export function getUniqueDataKeyOptions(usages: readonly UiGraphDataKeyUsage[]): string[] {
  return Array.from(new Set(usages.map((usage) => usage.key)));
}

export function isDataKeyAlreadyUsedEarlier(
  usages: readonly UiGraphDataKeyUsage[],
  key: string,
  currentUsage: { componentId: UiComponentId; outputIndex?: number },
): boolean {
  if (!key) {
    return false;
  }

  const currentIndex = usages.findIndex(
    (usage) => usage.componentId === currentUsage.componentId && usage.outputIndex === currentUsage.outputIndex,
  );
  const searchableUsages = currentIndex >= 0 ? usages.slice(0, currentIndex) : usages;

  return searchableUsages.some((usage) => usage.key === key);
}
