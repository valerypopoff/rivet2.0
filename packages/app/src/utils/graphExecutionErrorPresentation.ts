import { getError } from '@valerypopoff/rivet2-core';

const ASYNC_BRANCH_ERROR_PREFIX = 'Start Async Branch ';

/**
 * Whether an execution error is an actionable Start Async Branch safety
 * violation that needs an editor toast in addition to the failed node/run UI.
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
