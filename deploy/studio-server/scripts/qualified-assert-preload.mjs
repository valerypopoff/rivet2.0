import assert from 'node:assert/strict';

// Supplied only to the verified legacy production CLI process, not its children.
// These are the actual strict assertions; no source or integrity check is skipped.
globalThis.assert = assert;
