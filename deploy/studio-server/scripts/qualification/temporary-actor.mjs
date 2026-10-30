import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyActorSource } from '../../images/qualification/verify-source.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const base = '/qualification/private';
async function input() {
  const chunks = [];
  let n = 0;
  for await (const c of process.stdin) {
    assert.ok((n += c.length) < 32 * 1024 * 1024);
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks));
}
export async function actorMain(mode) {
  assert.equal(process.platform, 'linux');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  const packet = await input();
  if (mode === 'preflight') {
    await verifyActorSource(packet.sourceRoot, packet.sourceSha);
    for (const tool of [
      ['timeout', '--help'],
      ['helm', 'version', '--short'],
      ['kubectl', 'version', '--client'],
      ['openssl', 'version'],
      ['flock', '--version'],
      ['ffmpeg', '-version'],
    ])
      execFileSync(tool[0], tool.slice(1), { stdio: 'pipe' });
    try {
      execFileSync(
        process.execPath,
        ['.yarn/releases/yarn-4.17.1.cjs', 'studio-server:ui:observe', 'runtime-control-fixture-contract.spec.ts'],
        {
          cwd: packet.sourceRoot,
          stdio: 'pipe',
          timeout: 180000,
          env: { ...process.env, PLAYWRIGHT_HEADLESS: '1', PLAYWRIGHT_SLOW_MO: '0' },
        },
      );
    } catch (error) {
      // This command runs only the synthetic offline fixture; preserve readable
      // bounded failures for the external private preflight diagnostic owner.
      process.stderr.write(
        Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]).subarray(-49152),
      );
      throw error;
    }
    const results = path.join(
      process.env.RIVET_QUALIFICATION_BROWSER_ARTIFACTS ?? path.join(packet.sourceRoot, 'artifacts/playwright'),
      'test-results',
    );
    const videos = (await fs.readdir(results, { recursive: true })).filter((file) => file.endsWith('video.webm'));
    assert.ok(videos.length > 0, 'Offline browser preflight must retain video recording');
    for (const file of videos) assert.ok((await fs.stat(path.join(results, file))).size > 0, 'Empty browser video');
    return { sourceSha: packet.sourceSha, offlineFixturePassed: true };
  }
  assert.match(packet.operationId, /^rivet-q-[1-9][0-9]*-[1-9][0-9]*$/);
  const directory = path.join(base, packet.operationId);
  if (mode === 'install') {
    assert.ok(process.env.POD_NAME && process.env.POD_UID);
    assert.ok(packet.files && Object.keys(packet.files).length <= 32);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    for (const [name, value] of Object.entries(packet.files)) {
      assert.match(name, /^[a-zA-Z0-9.-]+$/);
      const bytes = Buffer.from(value.bytes, 'base64');
      assert.equal(sha(bytes), value.hash);
      await fs.writeFile(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    await fs.mkdir(path.join(directory, 'results'), { mode: 0o700 });
    return { installed: true, files: Object.fromEntries(Object.entries(packet.files).map(([n, v]) => [n, v.hash])) };
  }
  if (mode === 'export') {
    const output = [];
    let total = 0;
    const walk = async (dir, relative = '') => {
      for (const name of (await fs.readdir(dir)).sort()) {
        const filename = path.join(dir, name),
          stat = await fs.lstat(filename),
          key = path.posix.join(relative, name);
        assert.ok(!stat.isSymbolicLink());
        if (stat.isDirectory()) await walk(filename, key);
        else {
          assert.ok(stat.isFile());
          assert.ok(output.length < 10000);
          // The authoritative phase receipts live in the external journal.
          // Large videos/trace archives are not cleanup authority and must not
          // make cleanup depend on buffering an unbounded archive in memory.
          if (
            !/\.(?:mjs|json|log|txt|yaml)$/.test(name) ||
            stat.size > 2 * 1024 * 1024 ||
            total + stat.size > 16 * 1024 * 1024
          ) {
            output.push({ name: key, size: stat.size, omitted: 'bounded-diagnostics' });
            continue;
          }
          total += stat.size;
          const bytes = await fs.readFile(filename);
          output.push({ name: key, hash: sha(bytes), bytes: bytes.toString('base64') });
        }
      }
    };
    await walk(directory);
    return { files: output };
  }
  throw Error('Unsupported actor command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname))
  process.stdout.write(JSON.stringify(await actorMain(process.argv[2])));
