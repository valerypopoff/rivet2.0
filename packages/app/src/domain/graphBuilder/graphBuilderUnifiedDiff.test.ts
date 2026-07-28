import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphBuilderUnifiedDiffError,
  parseGraphBuilderTransactionalDecision,
  parseGraphBuilderUnifiedDiff,
} from './index.js';

const validDiff = ['--- a/graphs/active.yaml', '+++ b/graphs/active.yaml', '@@ -1 +1 @@', '-before', '+after'].join(
  '\n',
);

function parseDecision(unifiedDiff: string) {
  return parseGraphBuilderTransactionalDecision({
    type: 'apply-patch',
    baseRevision: 0,
    unifiedDiff,
  });
}

test('shared unified-diff parser accepts the exact model-facing dialect', () => {
  const parsed = parseGraphBuilderUnifiedDiff(validDiff.replace(/\n/g, '\r\n'));
  assert.equal(parsed.path, 'graphs/active.yaml');
  assert.deepEqual(parsed.hunks, [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [
        { kind: 'delete', text: 'before', noNewline: false },
        { kind: 'add', text: 'after', noNewline: false },
      ],
    },
  ]);
  assert.equal(parseDecision(validDiff).type, 'apply-patch');
});

test('decision schema and workspace parser reject the same malformed diff corpus', () => {
  const malformed = [
    validDiff.replaceAll('graphs/active.yaml', 'graphs/active.yaml\t2026-07-26'),
    validDiff.replace('@@ -1 +1 @@', '@@ -999999999999999999999999 +1 @@'),
    validDiff.replace('@@ -1 +1 @@', '@@ -0,1 +1 @@'),
    validDiff.replace('-before', '\\ No newline at end of file\n-before'),
    validDiff.replace('-before', '-before\n\\ No newline at end of file\n\\ No newline at end of file'),
    validDiff.replace('+++ b/graphs/active.yaml\n', '+++ b/graphs/active.yaml\r\n').replace('-before', '-be\rfore'),
  ];

  for (const unifiedDiff of malformed) {
    assert.throws(
      () => parseGraphBuilderUnifiedDiff(unifiedDiff),
      (error) => error instanceof GraphBuilderUnifiedDiffError,
    );
    assert.throws(() => parseDecision(unifiedDiff));
  }
});

test('unified-diff byte limits agree with the provider decision envelope for non-ASCII text', () => {
  const oversized = [
    '--- a/graphs/active.yaml',
    '+++ b/graphs/active.yaml',
    '@@ -1 +1 @@',
    '-before',
    `+${'é'.repeat(140 * 1024)}`,
  ].join('\n');
  assert.ok(Buffer.byteLength(oversized, 'utf8') > 256 * 1024);
  assert.throws(
    () => parseGraphBuilderUnifiedDiff(oversized),
    (error) => error instanceof GraphBuilderUnifiedDiffError && /no larger than/iu.test(error.message),
  );
  assert.throws(() => parseDecision(oversized));
});
