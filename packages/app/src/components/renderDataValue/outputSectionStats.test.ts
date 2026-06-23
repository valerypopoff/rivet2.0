import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataRefReader } from '../../providers/ProvidersContext.js';
import { getOutputSectionStatsForValue, shouldShowOutputSectionStats } from './outputSectionStats.js';

const emptyDataRefs: DataRefReader = {
  get: () => undefined,
};

test('output section stats are enabled only for fullscreen output surfaces', () => {
  assert.equal(
    shouldShowOutputSectionStats({ mode: 'expanded-preview', allowLargeStoredValueActions: true }),
    true,
  );
  assert.equal(shouldShowOutputSectionStats({ mode: 'expanded-preview', allowLargeStoredValueActions: false }), false);
  assert.equal(shouldShowOutputSectionStats({ mode: 'full', allowLargeStoredValueActions: true }), false);
  assert.equal(shouldShowOutputSectionStats({ mode: 'compact', allowLargeStoredValueActions: true }), false);
});

test('output section stats count string output words and characters', () => {
  assert.deepEqual(getOutputSectionStatsForValue({ type: 'string', value: 'hello bright modal' }, emptyDataRefs), {
    wordCount: 3,
    characterCount: 18,
  });
});

test('output section stats count object output from displayed JSON text', () => {
  const stats = getOutputSectionStatsForValue(
    { type: 'object', value: { movie: 'Inception', tags: ['dream', 'heist'] } },
    emptyDataRefs,
  );

  assert.equal(stats?.wordCount, 9);
  assert.equal(stats?.characterCount, 68);
});

test('output section stats skip media outputs instead of showing misleading zeroes', () => {
  assert.equal(
    getOutputSectionStatsForValue(
      {
        type: 'image',
        value: {
          mediaType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        },
      },
      emptyDataRefs,
    ),
    undefined,
  );

  assert.equal(
    getOutputSectionStatsForValue(
      {
        type: 'image[]',
        value: [
          {
            mediaType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      emptyDataRefs,
    ),
    undefined,
  );
});
