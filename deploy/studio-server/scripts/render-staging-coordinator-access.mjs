import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { stagingCoordinatorControlRole } from './lib/staging-coordinator-access.mjs';

const [namespace, output] = process.argv.slice(2);
assert.ok(
  output && process.argv.length === 4,
  'Usage: render-staging-coordinator-access.mjs CONTROL_NAMESPACE OUTPUT.json',
);
await fs.writeFile(output, JSON.stringify(stagingCoordinatorControlRole(namespace), null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log('Rendered staging coordinator Role for administrator review; no access was applied.');
