import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Alpine uses its native Chromium/FFmpeg rather than glibc browser downloads.
// Ask the locked Playwright registry for the video tool path: do not hard-code
// its revision or mutate Playwright, and keep video recording enabled.
export function actorVideoExecutable(sourceRoot = process.cwd()) {
  const web = createRequire(path.join(sourceRoot, 'packages/studio-server-web/package.json'));
  const test = createRequire(web.resolve('@playwright/test'));
  const playwright = createRequire(test.resolve('playwright'));
  const {
    registry: { registry },
  } = playwright('playwright-core/lib/coreBundle');
  return registry.findExecutable('ffmpeg').executablePath();
}
export async function prepareActorBrowserTools() {
  assert.equal(process.platform, 'linux');
  const executable = actorVideoExecutable();
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  assert.ok(executable.startsWith(cache + path.sep), 'Unexpected actor browser cache');
  assert.match(path.basename(path.dirname(executable)), /^ffmpeg-[0-9]+$/);
  assert.equal(path.basename(executable), 'ffmpeg-linux');
  execFileSync('/usr/bin/ffmpeg', ['-version'], { stdio: 'pipe' });
  const encoders = execFileSync('/usr/bin/ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(encoders, /\blibvpx\b/, 'Playwright video requires the VP8 encoder');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.symlink('/usr/bin/ffmpeg', executable); // Exclusive: never overwrite a different installation.
  execFileSync(executable, ['-version'], { stdio: 'pipe' });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareActorBrowserTools();
