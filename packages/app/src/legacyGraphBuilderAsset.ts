import legacyGraphCreatorProject from '../graphs/graph-creator.rivet-project?raw';

/**
 * Vite-only raw asset boundary for the temporary legacy Graph Builder path.
 * Keep it separate from portable Graph Builder assets so Node-side catalog and
 * evaluation checks never attempt to load a `.rivet-project` module.
 */
export { legacyGraphCreatorProject };
