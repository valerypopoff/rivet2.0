import type { EditorDefinitionGroup } from './EditorDefinition.js';
import type { ChartNode } from './NodeBase.js';

/** Shared settings section for inline configurations and separate profile nodes. */
export function getTokenPricingEditor<T extends ChartNode>(): EditorDefinitionGroup<T> {
  return {
    type: 'group',
    label: 'Token pricing',
    defaultOpen: false,
    editors: [{ type: 'custom', label: 'Token pricing', customEditorId: 'AIProfilePricing' }],
  };
}
