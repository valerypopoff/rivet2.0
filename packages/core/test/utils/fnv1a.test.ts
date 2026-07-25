import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fnv1a from '../../src/vendor/fnv1a.js';

void describe('vendored FNV-1a compatibility', () => {
  void it('keeps the persisted 32-bit recording hashes stable', () => {
    assert.equal(fnv1a('', { size: 32 }), 2_166_136_261n);
    assert.equal(fnv1a('hello', { size: 32 }), 1_335_831_723n);
    assert.equal(fnv1a('Привет, Rivet!', { size: 32 }), 2_424_365_392n);
    assert.equal(fnv1a('\uD800', { size: 32 }), 55_024_714n);
    assert.equal(fnv1a(new Uint8Array([0, 1, 2, 255]), { size: 32 }), 1_873_502_325n);
  });

  void it('produces the same hash when strings are encoded through a small reusable buffer', () => {
    const value = 'Unicode: Привет 👋';

    assert.equal(fnv1a(value, { size: 32, utf8Buffer: new Uint8Array(4) }), fnv1a(value, { size: 32 }));
  });
});
