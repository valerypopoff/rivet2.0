import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const policies = {
  npm: {
    version: '11.21.1',
    modules: 'node_modules',
    gyp: '12.4.0',
    before: 'd11b1d799a2522bd38a364bc39d36175d9e68225e0e5a36d9fc3a64e1710fbc0',
    after: 'b1818cc85b5942dc664f9883d0305f27dd4d01b0c6ac7d995078dc0811ad192c',
    picomatch: 'tinyglobby/node_modules/picomatch',
    picomatchVersion: '4.0.4',
  },
  pnpm: {
    version: '10.34.8',
    modules: 'dist/node_modules',
    gyp: '11.5.0',
    before: 'fd1969a2097abc1bffa983c56cbeeefc029ac37324fceeccf69a90080aa8c81a',
    after: '5e544714d32005e46be7e3a938f0c8a54622b66fe2ac22cec2dfd42030e65826',
    picomatch: 'picomatch',
    picomatchVersion: '4.0.7',
  },
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));

// Linux image copies only. These pinned node-gyp sources use tinyglobby solely
// in findSolutionFile(), behind `if (win)`. Keep Linux make/native builds intact;
// lazy-load that Windows import, then omit its installed parser and dependency.
export async function removePackageManagerWindowsGlobs(directory, manager) {
  assert.ok(Object.hasOwn(policies, manager), 'Unknown package manager');
  const policy = policies[manager];
  assert.ok((await fs.lstat(directory)).isDirectory(), 'Package-manager copy must be a real directory');
  const root = await fs.realpath(directory);
  const installed = await manifest(root);
  assert.equal(installed.name, manager);
  assert.equal(installed.version, policy.version, 'Review changed package-manager contents');
  const modules = path.join(root, policy.modules);
  const gyp = path.join(modules, 'node-gyp');
  const gypManifest = await manifest(gyp);
  assert.equal(gypManifest.name, 'node-gyp');
  assert.equal(gypManifest.version, policy.gyp, 'Review changed node-gyp contents');
  const file = path.join(gyp, 'lib/build.js');
  const source = await fs.readFile(file, 'utf8');
  for (const target of [file, path.join(gyp, 'package.json')]) {
    assert.ok((await fs.lstat(target)).isFile(), 'node-gyp source must be a regular file');
    const relative = path.relative(root, await fs.realpath(target));
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  const digest = hash(source);
  assert.ok([policy.before, policy.after].includes(digest), 'Review changed node-gyp Windows discovery source');
  const targets = [path.join(modules, 'tinyglobby')];
  if (manager === 'pnpm') targets.push(path.join(modules, 'picomatch'));
  const absent = async (target) => {
    await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
  };
  if (digest === policy.after) {
    assert.equal(gypManifest.dependencies.tinyglobby, undefined);
    for (const target of targets) await absent(target);
  } else {
    assert.equal(gypManifest.dependencies.tinyglobby, '^0.2.12');
    assert.equal((await manifest(targets[0])).version, '0.2.17');
    assert.equal((await manifest(path.join(modules, policy.picomatch))).version, policy.picomatchVersion);
    // Check every removal target before changing any source or metadata.
    for (const target of targets) {
      assert.ok((await fs.lstat(target)).isDirectory(), 'Glob package must be a real directory');
      const relative = path.relative(root, await fs.realpath(target));
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }
    const fixed = source.replace(
      "const { glob } = require('tinyglobby')",
      "const glob = (...args) => require('tinyglobby').glob(...args)",
    );
    assert.equal(hash(fixed), policy.after, 'Windows import change did not produce the reviewed bytes');
    await fs.writeFile(file, fixed);
    delete gypManifest.dependencies.tinyglobby; // The Linux package copy has no such runtime dependency.
    await fs.writeFile(path.join(gyp, 'package.json'), JSON.stringify(gypManifest, null, 2) + '\n');
    for (const target of targets) await fs.rm(target, { recursive: true });
  }
  return {
    manager,
    version: policy.version,
    nodeGyp: policy.gyp,
    vulnerability: 'CVE-2026-112366',
    before: policy.before,
    after: policy.after,
    removed: targets.map((target) => path.relative(root, target).replaceAll(path.sep, '/')),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.platform, 'linux', 'This packaging policy is for Linux images only');
  const receipts = [];
  for (const manager of process.argv.slice(2))
    receipts.push(await removePackageManagerWindowsGlobs(`/usr/local/lib/node_modules/${manager}`, manager));
  assert.ok(receipts.length, 'Select at least one installed package manager');
  await fs.writeFile('/opt/rivet/package-manager-platform.json', JSON.stringify(receipts, null, 2) + '\n');
}
