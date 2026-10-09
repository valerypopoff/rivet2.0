import { getError } from '@valerypopoff/rivet2-core';

const ASYNC_BRANCH_ERROR_PREFIX = 'Start Async Branch ';

/**
 * Whether a node-local error is an actionable Start Async Branch safety
 * violation needing an early editor toast. Terminal root failures always toast
 * independently; ordinary/caught node errors stay local to their node.
 *
 * Browser execution keeps Error.message, while the Node and remote executor
 * transports serialize errors using Error#toString(). Strip one or more
 * transport-added Error: prefixes so both paths present the same
 * designer-facing validation failures.
 */
export function shouldToastAsyncBranchSafetyError(error: unknown): boolean {
  const message = getError(error)
    .message.trim()
    .replace(/^(?:Error:\s*)+/, '');
  return message.startsWith(ASYNC_BRANCH_ERROR_PREFIX);
}
