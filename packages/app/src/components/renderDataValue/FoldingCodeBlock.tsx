import { createLazyComponent } from '../createLazyComponent.js';
import { createRetryableModuleLoader } from '../retryableModuleLoader.js';
import type { FoldingCodeBlockProps } from './FoldingCodeBlockContent.js';

// Importing an output renderer must not initialize Monaco. The feature owns its
// loading/error surface; model, worker and search lifetimes stay in the content.
const loader = createRetryableModuleLoader(() => import('./FoldingCodeBlockContent.js'));
export const FoldingCodeBlock = createLazyComponent<FoldingCodeBlockProps>(loader.load, 'output viewer', loader.retry);
