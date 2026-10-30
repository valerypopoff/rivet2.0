import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { actorVideoExecutable } from '../images/qualification/prepare-browser-tools.mjs';

// This uses installed workspace packages; kernel/process ownership tests also
// run in a dependency-free, network-isolated Linux container on Windows.
test('actor video path comes from the actual locked Playwright registry without changing the host cache', () => {
  const executable = actorVideoExecutable(fileURLToPath(new URL('../../../', import.meta.url)));
  assert.ok(path.isAbsolute(executable));
  assert.match(path.basename(path.dirname(executable)), /^ffmpeg-[0-9]+$/);
  assert.equal(
    path.basename(executable),
    process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux',
  );
});
