import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packet.sourceRoot, encoding: 'utf8' }).trim(),
      packet.sourceSha,
    );
    assert.equal(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: packet.sourceRoot,
        encoding: 'utf8',
      }).trim(),
      '',
    );
    for (const tool of [
      ['timeout', '--help'],
      ['helm', 'version', '--short'],
      ['kubectl', 'version', '--client'],
      ['openssl', 'version'],
      ['flock', '--version'],
    ])
      execFileSync(tool[0], tool.slice(1), { stdio: 'pipe' });
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
