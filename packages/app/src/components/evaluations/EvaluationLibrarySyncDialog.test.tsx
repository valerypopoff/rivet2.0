import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const dialogSource = readFileSync(fileURLToPath(new URL('./EvaluationLibrarySyncDialog.tsx', import.meta.url)), 'utf8');

test('shared evaluation conflict dialog exposes deliberate server and copy choices', () => {
  assert.match(dialogSource, /Resolve shared evaluation conflict/u);
  assert.match(dialogSource, /Server version/u);
  assert.match(dialogSource, /Your pending version/u);
  assert.match(dialogSource, /Use server version/u);
  assert.match(dialogSource, /Keep mine as copy/u);
});

test('shared evaluation dialog never offers to copy a pending deletion', () => {
  assert.match(dialogSource, /conflict\.local\.value === undefined/u);
  assert.match(dialogSource, /no local value to keep as a copy/u);
});

test('shared evaluation retry dialog remains distinct from a conflict', () => {
  assert.match(dialogSource, /Evaluation library save needs attention/u);
  assert.match(dialogSource, /Retry save/u);
  assert.match(dialogSource, /issue\.kind === 'conflict'/u);
});
