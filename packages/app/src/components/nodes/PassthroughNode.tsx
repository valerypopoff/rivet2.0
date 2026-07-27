import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';

/**
 * Ordinary Passthrough nodes have no node-specific settings. Data Bus is now a
 * dedicated topology node rather than a presentation switch on Passthrough.
 */
export const passthroughNodeDescriptor: NodeComponentDescriptor<'passthrough'> = {};
