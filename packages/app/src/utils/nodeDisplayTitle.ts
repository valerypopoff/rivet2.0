import type { ChartNode } from '@valerypopoff/rivet2-core';

/** Display aliases only; never migrate saved titles or replace authored names. */
export function getNodeDisplayTitle(node: Pick<ChartNode, 'type' | 'title'>): string {
  if (node.type === 'classifierEvaluate' && node.title === 'Classifier Evaluate') return 'Decision AI run';
  if (node.type === 'classifierProfile' && node.title === 'Classifier Profile') return 'Decision AI Profile';
  if (node.type === 'classifierQuestion' && node.title === 'Classifier Question') return 'Decision AI Question';
  return node.title;
}
