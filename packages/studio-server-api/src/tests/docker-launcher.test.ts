import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dockerLauncher = await import(
  new URL('../../../../deploy/studio-server/scripts/lib/docker-launcher.mjs', import.meta.url).href,
) as {
  composeConfigFilesMatch: (configFilesLabel: string | undefined, expectedConfigFiles: string[]) => boolean;
  composeProjectFingerprintMatches: (actualFingerprint: string | undefined, expectedFingerprint: string | undefined) => boolean;
  composeProjectInputFingerprint: (options: { composeConfigFiles: string[]; cwd: string }) => Promise<string>;
};

test('Compose configuration matching is path-platform independent and detects added runtime overlays', () => {
  const expected = [
    'deploy/studio-server/compose/docker-compose.managed-services.yml',
    'deploy/studio-server/compose/docker-compose.dev.yml',
    'deploy/studio-server/compose/docker-compose.runtime-env.yml',
  ];

  assert.equal(
    dockerLauncher.composeConfigFilesMatch(
      'F:\\Programming\\Rivet2.0\\deploy\\studio-server\\compose\\docker-compose.managed-services.yml,F:\\Programming\\Rivet2.0\\deploy\\studio-server\\compose\\docker-compose.dev.yml,F:\\Programming\\Rivet2.0\\deploy\\studio-server\\compose\\docker-compose.runtime-env.yml',
      expected,
    ),
    true,
  );
  assert.equal(
    dockerLauncher.composeConfigFilesMatch(
      '/workspace/deploy/studio-server/compose/docker-compose.dev.yml',
      expected,
    ),
    false,
  );
  assert.equal(dockerLauncher.composeConfigFilesMatch(undefined, expected), false);
});

test('Compose input fingerprint requires a matching launcher label when supplied', () => {
  assert.equal(dockerLauncher.composeProjectFingerprintMatches('current', 'current'), true);
  assert.equal(dockerLauncher.composeProjectFingerprintMatches('stale', 'current'), false);
  assert.equal(dockerLauncher.composeProjectFingerprintMatches(undefined, 'current'), false);
  assert.equal(dockerLauncher.composeProjectFingerprintMatches(undefined, undefined), false);
});

test('Compose input fingerprint changes only with selected Compose source inputs', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rivet-docker-launcher-'));
  const firstConfig = path.join(tempDir, 'first.yml');
  const secondConfig = path.join(tempDir, 'second.yml');

  try {
    await writeFile(firstConfig, 'services:\n  api:\n    image: example/api\n');
    await writeFile(secondConfig, 'services:\n  web:\n    image: example/web\n');

    const initial = await dockerLauncher.composeProjectInputFingerprint({
      composeConfigFiles: ['first.yml', 'second.yml'],
      cwd: tempDir,
    });
    const repeated = await dockerLauncher.composeProjectInputFingerprint({
      composeConfigFiles: ['first.yml', 'second.yml'],
      cwd: tempDir,
    });
    assert.equal(repeated, initial);

    await writeFile(secondConfig, 'services:\n  web:\n    image: example/web-v2\n');
    const changed = await dockerLauncher.composeProjectInputFingerprint({
      composeConfigFiles: ['first.yml', 'second.yml'],
      cwd: tempDir,
    });
    assert.notEqual(changed, initial);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});