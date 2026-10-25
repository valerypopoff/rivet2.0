import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Attempt every finalizer for resources retained by this benchmark. A failed
 * evidence write must not prevent browser/socket/server cleanup. */
export async function finalizeBenchmark(actions, primaryError) {
  const settled = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
  const failures = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) {
    throw new AggregateError(
      primaryError === undefined ? failures : [primaryError, ...failures],
      'Benchmark finalization failed',
    );
  }
}

/** The caller retains the live ChildProcess handle; never discover processes by
 * port/name or kill an exited PID. POSIX commands use a dedicated process group. */
export function interruptOwnedCommand(
  child,
  { platform = process.platform, launch = spawn, signal = process.kill } = {},
) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return;
  if (platform === 'win32') {
    launch('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).once(
      'error',
      () => child.kill(),
    );
  } else {
    try {
      signal(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
export function summarize(values) {
  if (!values.length) return null;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid timing sample');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
}
export async function sourceIdentity(root = repoRoot) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sha = git(['rev-parse', 'HEAD']).trim();
  const diff = git(['diff', 'HEAD', '--binary']);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const hash = createHash('sha256').update(diff);
  for (const name of untracked)
    hash
      .update(name)
      .update('\0')
      .update(await readFile(path.join(root, name)))
      .update('\0');
  return { sha, dirty: Boolean(diff || untracked.length), diffDigest: hash.digest('hex') };
}
export function listenLocal(server, port = 0) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', ready);
      reject(error);
    };
    const ready = () => {
      server.off('error', failed);
      resolve(server.address().port);
    };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}
export async function closeLocal(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
export function resourceSummary(entries) {
  return {
    requests: entries.length,
    decodedBytes: entries.reduce((n, e) => n + e.decodedBodySize, 0),
    transferBytes: entries.reduce((n, e) => n + e.transferSize, 0),
  };
}

/** Use emitted module ownership, not a chunk-name/hash convention. Refuse an
 * empty attribution match so a changed build cannot make the guard vacuous. */
export function findModuleAssetRequests(chunks, modulePath, requests) {
  const paths = new Set(
    chunks
      .filter((chunk) => chunk.modules.some((module) => module.id.replaceAll('\\', '/').includes(modulePath)))
      .map((chunk) => new URL(chunk.fileName, 'http://benchmark.invalid/').pathname),
  );
  if (paths.size === 0) throw new Error(`No emitted module attribution for ${modulePath}`);
  return requests.filter((request) => paths.has(new URL(request.url, 'http://benchmark.invalid/').pathname));
}

export function navigationSummary(sample) {
  const entries = [...sample.frames, ...sample.workers]
    .flatMap((frame) => frame.entries)
    .filter((entry) => /\.js(?:$|\?)/.test(entry.name));
  const unique = new Map();
  for (const entry of entries)
    if ((unique.get(entry.name)?.decodedBodySize ?? -1) < entry.decodedBodySize) unique.set(entry.name, entry);
  return {
    unique: resourceSummary([...unique.values()]),
    allFrames: resourceSummary(entries),
    servedJsBytes: sample.servedAssets
      .filter((asset) => /\.js(?:$|\?)/.test(asset.url))
      .reduce((total, asset) => total + asset.bytes, 0),
  };
}
