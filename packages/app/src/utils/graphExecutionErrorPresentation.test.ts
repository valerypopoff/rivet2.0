import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldToastAsyncBranchSafetyError } from './graphExecutionErrorPresentation.js';

test('shows async branch safety violations from Browser execution', () => {
  assert.equal(
    shouldToastAsyncBranchSafetyError(
      new Error(
        'Start Async Branch "Start Async Branch" cannot contain Graph Output node "Graph Output". Async branches are side-effect-only.',
      ),
    ),
    true,
  );
  assert.equal(
    shouldToastAsyncBranchSafetyError(
      new Error(
        'Start Async Branch "Persist status" cannot run "External Call" because it also depends on "LLM Chat" outside the async branch. Assemble all required values before the async trigger.',
      ),
    ),
    true,
  );
  assert.equal(
    shouldToastAsyncBranchSafetyError(
      new Error('Start Async Branch cannot use frozen outputs because replaying it could repeat async side effects.'),
    ),
    true,
  );
});

test('shows async branch safety violations serialized by Node and remote executors', () => {
  assert.equal(
    shouldToastAsyncBranchSafetyError(
      'Error: Error: Start Async Branch "Start Async Branch" cannot contain preloaded node "HTTP Call". Preloading an async descendant would bypass the trigger boundary.',
    ),
    true,
  );
});

test('keeps ordinary graph failures out of the global toast channel', () => {
  assert.equal(shouldToastAsyncBranchSafetyError(new Error('Provider request failed.')), false);
  assert.equal(
    shouldToastAsyncBranchSafetyError(
      new Error('Node child is inside the async branch started by trigger. Run from the Start Async Branch node.'),
    ),
    false,
  );
});
