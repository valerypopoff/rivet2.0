/**
 * Semantic output boundaries used by fullscreen-output keyboard navigation.
 * Renderers mark a complete response, output port, or structured section;
 * the fullscreen modal chooses the visible leaf boundaries at runtime.
 */
export const OUTPUT_NAVIGATION_ITEM_ATTRIBUTE = 'data-rivet-output-navigation-item';
export const OUTPUT_NAVIGATION_ITEM_SELECTOR = `[${OUTPUT_NAVIGATION_ITEM_ATTRIBUTE}]`;
