import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldShowMultiNodeAlignmentToolbar } from './MultiNodeAlignmentToolbar.js';

test('shouldShowMultiNodeAlignmentToolbar only shows for editable multi-selection sessions', () => {
  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 1,
      isReadOnlyGraph: false,
    }),
    false,
  );

  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 2,
      isReadOnlyGraph: true,
    }),
    false,
  );

  assert.equal(
    shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: 2,
      isReadOnlyGraph: false,
    }),
    true,
  );
});
