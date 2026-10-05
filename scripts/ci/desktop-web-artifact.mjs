import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function inventory(directory, prefix = '') {
  assert.ok((await fs.lstat(directory)).isDirectory(), 'Desktop frontend root must be a real directory.');
  const records = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) records.push(...(await inventory(absolute, `${relative}/`)));
    else {
      assert.ok(entry.isFile(), `Desktop frontend contains a non-regular file: ${relative}`);
      const bytes = await fs.readFile(absolute);
      records.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function desktopWebArtifact(appRoot, commit) {
  assert.match(commit ?? '', /^[a-f\d]{40}$/i, 'Desktop artifact needs a full source commit SHA.');
  const files = await inventory(path.join(appRoot, 'dist'));
  assert.ok(
    files.some((file) => file.path === 'index.html' && file.bytes > 0),
    'Desktop frontend entrypoint is missing.',
  );
  assert.ok(
    files.some((file) => file.path.endsWith('.js') && file.bytes > 0),
    'Desktop frontend JavaScript is missing.',
  );
  return { version: 1, commit, files };
}

export async function verifyDesktopWebArtifact(appRoot, commit) {
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, 'desktop-web-artifact.json'), 'utf8'));
  // Compare the complete actual inventory. No manifest path is used for reads;
  // missing, extra, altered and symlinked files all fail before native packaging.
  assert.deepEqual(
    manifest,
    await desktopWebArtifact(appRoot, commit),
    'Desktop frontend artifact is stale or damaged.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = fileURLToPath(new URL('../../packages/app/', import.meta.url));
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['create', 'verify'].includes(mode)) {
    throw new Error('Usage: desktop-web-artifact.mjs <create|verify>');
  }
  if (mode === 'create') {
    await fs.writeFile(
      path.join(appRoot, 'desktop-web-artifact.json'),
      JSON.stringify(await desktopWebArtifact(appRoot, process.env.GITHUB_SHA)),
    );
  } else await verifyDesktopWebArtifact(appRoot, process.env.GITHUB_SHA);
  console.log(`[desktop-web-artifact] ${mode} completed for ${process.env.GITHUB_SHA}.`);
}
