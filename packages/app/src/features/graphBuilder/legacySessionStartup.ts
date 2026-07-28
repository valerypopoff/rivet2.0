import type { GraphBuilderEditorContext } from './editorGateway.js';
import { graphBuilderBaseIdentityMatches, type GraphBuilderBaseIdentity } from './identity.js';

type LegacyGraphBuilderStartupRevalidation =
  | { status: 'abandoned' }
  | { status: 'conflicted'; currentFingerprint: string }
  | { status: 'ready' };

export function revalidateLegacyGraphBuilderStartup(options: {
  abortSignal: AbortSignal;
  base: GraphBuilderBaseIdentity;
  captureContext: () => Pick<GraphBuilderEditorContext, 'base' | 'eligibility'>;
  isCurrent: boolean;
  isMounted: boolean;
}): LegacyGraphBuilderStartupRevalidation {
  if (!options.isCurrent || !options.isMounted || options.abortSignal.aborted) {
    return { status: 'abandoned' };
  }

  const current = options.captureContext();
  if (!current.eligibility.eligible || !graphBuilderBaseIdentityMatches(options.base, current.base)) {
    return {
      status: 'conflicted',
      currentFingerprint: current.base.projectFingerprint,
    };
  }
  return { status: 'ready' };
}
