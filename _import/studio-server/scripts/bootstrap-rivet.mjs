import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const targetDir = path.join(rootDir, 'rivet');
const upstreamRepo = process.env.RIVET_REPO_URL || 'https://github.com/valerypopoff/rivet2.0.git';
const upstreamRef = process.env.RIVET_REPO_REF || process.env.RIVET_BRANCH || 'main';
const metadataFile = '.upstream-version';

function run(command, args, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const stdio = options.stdio ?? 'pipe';

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${exitCode}\n${stderr}`.trim()));
    });
  });
}

function isDirectoryEmpty(dirPath) {
  return fs.readdirSync(dirPath).length === 0;
}

function removeTargetDir() {
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function isCommitSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value).trim());
}

function ensureTargetDirReady(force) {
  if (!fs.existsSync(targetDir)) {
    return;
  }

  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) {
    throw new Error(`Expected ${targetDir} to be a directory.`);
  }

  if (isDirectoryEmpty(targetDir)) {
    return;
  }

  if (!force) {
    throw new Error(`The rivet directory already exists and is not empty. Remove it first or rerun with --force.`);
  }

  removeTargetDir();
}

async function resolveRefCommit() {
  if (isCommitSha(upstreamRef)) {
    return upstreamRef.toLowerCase();
  }

  const { stdout } = await run('git', [
    'ls-remote',
    upstreamRepo,
    upstreamRef,
    `refs/heads/${upstreamRef}`,
    `refs/tags/${upstreamRef}`,
    `refs/tags/${upstreamRef}^{}`,
  ]);
  const entries = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((line) => {
      const [commit, refName] = line.split(/\s+/);
      return { commit, refName };
    });
  const selectedEntry = entries.find((entry) => entry.refName?.endsWith('^{}')) ?? entries[0];
  const commit = selectedEntry?.commit;

  if (!commit) {
    throw new Error(`Could not resolve Rivet ref "${upstreamRef}" from ${upstreamRepo}.`);
  }

  return commit;
}

async function cloneRef(commit) {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-bootstrap-'));
  const tempCloneDir = path.join(tempParent, 'rivet');

  try {
    console.log(`[setup:rivet] Downloading ${upstreamRef} (${commit.slice(0, 7)}) from ${upstreamRepo}...`);
    fs.mkdirSync(tempCloneDir, { recursive: true });
    await run('git', ['init', tempCloneDir], { stdio: 'inherit' });
    await run('git', ['remote', 'add', 'origin', upstreamRepo], { cwd: tempCloneDir, stdio: 'inherit' });
    await run('git', ['fetch', '--depth', '1', 'origin', commit], { cwd: tempCloneDir, stdio: 'inherit' });
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: tempCloneDir, stdio: 'inherit' });

    fs.rmSync(path.join(tempCloneDir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tempCloneDir, metadataFile),
      JSON.stringify({ repo: upstreamRepo, ref: upstreamRef, commit }, null, 2) + '\n',
      'utf8',
    );

    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(tempCloneDir, targetDir, { recursive: true });
  } catch (error) {
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}

async function main() {
  const force = process.argv.includes('--force');

  try {
    await run('git', ['--version']);
  } catch {
    throw new Error('Git is required to download the upstream Rivet source.');
  }

  ensureTargetDirReady(force);

  const commit = await resolveRefCommit();
  console.log(`[setup:rivet] Rivet source ref: ${upstreamRef} (${commit.slice(0, 7)})`);

  await cloneRef(commit);

  console.log(`[setup:rivet] Rivet source downloaded to ${targetDir}`);
  console.log('[setup:rivet] You can now run npm run prod');
}

main().catch((error) => {
  console.error(`[setup:rivet] ${error.message}`);
  process.exit(1);
});
