import { randomUUID } from 'node:crypto';

// Reuse the workflow context's LISTEN connection; this is not a second store or bus.
export const EVALUATION_LIBRARY_INVALIDATION_CHANNEL = 'rivet_evaluation_library_changed';
export const evaluationLibrarySourceInstanceId = randomUUID();
