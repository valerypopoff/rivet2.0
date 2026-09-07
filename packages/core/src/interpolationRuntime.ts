/**
 * Narrow runtime entrypoint for JavaScript executors. Build tooling can bundle
 * this module into isolated workers without exposing the complete Core API.
 */
export { resolveCodeInterpolationExpression } from './utils/interpolation.js';
