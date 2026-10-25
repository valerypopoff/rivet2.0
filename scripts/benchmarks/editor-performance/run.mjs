import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { repoRoot, sourceIdentity, summarize, navigationSummary, interruptOwnedCommand } from './support.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  return at < 0 ? fallback : args[at + 1];
}
const samples = Number(option('--samples', '7'));
if (!Number.isInteger(samples) || samples < 1 || samples > 30) throw new Error('Samples must be between 1 and 30');
const output = path.resolve(
  repoRoot,
  option('--output', `artifacts/benchmarks/editor-performance/${new Date().toISOString().replace(/[:.]/g, '-')}`),
);
if (!output.startsWith(path.join(repoRoot, 'artifacts', 'benchmarks') + path.sep))
  throw new Error('Output must be inside artifacts/benchmarks');
await mkdir(output, { recursive: true });
const lock = await open(path.join(output, 'run.lock'), 'wx');
const here = fileURLToPath(new URL('.', import.meta.url));
const env = {
  ...process.env,
  RIVET_EDITOR_BENCH_OUTPUT: output,
  RIVET_EDITOR_BENCH_SAMPLES: String(samples),
  PLAYWRIGHT_HEADLESS: '1',
  PLAYWRIGHT_SLOW_MO: '0',
  RIVET_ENV_FILE: path.join(output, 'isolated.env'),
};
if (args.includes('--check-loading')) env.RIVET_EDITOR_BENCH_CHECK_LOADING = '1';
async function command(argv) {
  const child = spawn(process.execPath, argv, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    shell: false,
    detached: process.platform !== 'win32',
  });
  const interrupt = () => interruptOwnedCommand(child);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Benchmark command failed (${code})`))));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
try {
  const identity = await sourceIdentity();
  await writeFile(
    path.join(output, 'source.json'),
    JSON.stringify(
      {
        ...identity,
        node: process.version,
        platform: process.platform,
        cpu: os.cpus()[0].model,
        memoryBytes: os.totalmem(),
      },
      null,
      2,
    ),
  );
  await writeFile(env.RIVET_ENV_FILE, '# Isolated synthetic benchmark; no ambient credentials.\n');
  if (args.includes('--dist')) env.RIVET_EDITOR_BENCH_DIST = path.resolve(repoRoot, option('--dist'));
  else {
    env.RIVET_EDITOR_BENCH_DIST = path.join(output, 'dist');
    await command([
      '.yarn/releases/yarn-4.17.1.cjs',
      'workspace',
      '@valerypopoff/rivet-studio-server-web',
      'exec',
      'vite',
      'build',
      '--config',
      path.join(here, 'vite.config.ts'),
    ]);
  }
  const builtIdentity = JSON.parse(
    await readFile(path.join(env.RIVET_EDITOR_BENCH_DIST, 'benchmark-source.json'), 'utf8'),
  );
  await writeFile(path.join(output, 'build-source.json'), JSON.stringify(builtIdentity, null, 2));
  await command([
    '.yarn/releases/yarn-4.17.1.cjs',
    'studio-server:ui:observe',
    '--config',
    path.join(here, 'playwright.config.ts'),
  ]);
  const results = JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8'));
  const summary = Object.fromEntries(
    Object.entries(results.timings).map(([name, values]) => [name, summarize(values)]),
  );
  summary.loading = Object.fromEntries(
    Object.entries(results.resources).map(([name, samples]) => [
      name,
      {
        uniqueDecodedJsBytes: summarize(samples.map((sample) => navigationSummary(sample).unique.decodedBytes)),
        allFramesDecodedJsBytes: summarize(samples.map((sample) => navigationSummary(sample).allFrames.decodedBytes)),
        servedJsBytes: summarize(samples.map((sample) => navigationSummary(sample).servedJsBytes)),
      },
    ]),
  );
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ output, summary }, null, 2));
} finally {
  await lock.close();
}
