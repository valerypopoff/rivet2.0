import { strict as assert } from 'node:assert';
import { it } from 'node:test';

import { uint8ArrayToBase64, uint8ArrayToBase64Sync } from '../../src/utils/base64.js';

it('encodes large byte arrays correctly without Buffer or FileReader, as in browser workers', async () => {
  const bytes = Uint8Array.from({ length: 1_000_001 }, (_, index) => index % 251);
  const expected = Buffer.from(bytes).toString('base64');
  const originalBuffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  Object.defineProperty(globalThis, 'Buffer', { configurable: true, value: undefined });
  try {
    assert.equal(uint8ArrayToBase64Sync(bytes), expected);
    assert.equal(await uint8ArrayToBase64(bytes), expected);
    assert.equal(uint8ArrayToBase64Sync(new Uint8Array()), '');
  } finally {
    if (originalBuffer) {
      Object.defineProperty(globalThis, 'Buffer', originalBuffer);
    } else {
      Reflect.deleteProperty(globalThis, 'Buffer');
    }
  }
});
