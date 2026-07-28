/**
 * Local feature boundary for the model-free Graph Builder contracts.
 * Evaluation modules import through this seam instead of reaching across the
 * app source tree with deep relative paths.
 */
export * from '../../domain/graphBuilder/index.js';
