import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { evaluateJsonPath, normalizeJsonPathExpression } from '../../src/utils/jsonPath.js';

describe('JSONPath utilities', () => {
  it('normalizes convenience whitespace around structural separators', () => {
    assert.equal(normalizeJsonPathExpression('  $ . records [ 0 ] . name  '), '$.records[0].name');
    assert.equal(evaluateJsonPath({ records: [{ name: 'Ada' }] }, '$ . records [ 0 ] . name'), 'Ada');
  });

  it('preserves authored filter, quoted, regex, and object-literal contents', () => {
    const path = '$ . items [ ?(@.label == "a . b" && @.pattern =~ /a | b/ && @.meta == {"x": 1}) ] . label';

    assert.equal(
      normalizeJsonPathExpression(path),
      '$.items[?(@.label == "a . b" && @.pattern =~ /a | b/ && @.meta == {"x": 1})].label',
    );
  });

  it('is idempotent for already normalized paths', () => {
    const path = '$.items[?(@.enabled || @.score > 2)].name';

    assert.equal(normalizeJsonPathExpression(normalizeJsonPathExpression(path)), path);
  });
});
