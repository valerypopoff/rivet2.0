import fs from 'node:fs';
import path from 'node:path';

export function getRuntimeLibrariesRoot() {
  return process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim() || '/data/runtime-libraries';
}

export function currentDir() {
  return path.join(getRuntimeLibrariesRoot(), 'current');
}

export function currentNodeModulesPath() {
  const nodeModulesPath = path.join(currentDir(), 'node_modules');
  return fs.existsSync(nodeModulesPath) ? nodeModulesPath : null;
}

function manifestPath() {
  return path.join(getRuntimeLibrariesRoot(), 'manifest.json');
}

export function jobsRoot() {
  return path.join(getRuntimeLibrariesRoot(), 'jobs');
}

export function ensureDirectories() {
  fs.mkdirSync(getRuntimeLibrariesRoot(), { recursive: true });
  fs.mkdirSync(jobsRoot(), { recursive: true });
}

export function readManifest() {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      packages: parsed?.packages && typeof parsed.packages === 'object' && !Array.isArray(parsed.packages)
        ? parsed.packages
        : {},
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      ...(typeof parsed?.activeReleaseId === 'string' && parsed.activeReleaseId.trim()
        ? { activeReleaseId: parsed.activeReleaseId.trim() }
        : {}),
    };
  } catch {
    return {
      packages: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

export function writeManifest(manifest) {
  ensureDirectories();
  const nextManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${manifestPath()}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextManifest, null, 2), 'utf8');
  fs.renameSync(tmp, manifestPath());
}

export function removeCurrentRelease() {
  fs.rmSync(currentDir(), { recursive: true, force: true });
}

export function promoteCurrentRelease(candidateDir) {
  const current = currentDir();
  const backup = `${current}.previous`;

  fs.rmSync(backup, { recursive: true, force: true });

  try {
    if (fs.existsSync(current)) {
      fs.renameSync(current, backup);
    }

    fs.renameSync(candidateDir, current);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(current) && fs.existsSync(backup)) {
      try {
        fs.renameSync(backup, current);
      } catch {
        // ignore restoration failure and surface the original error
      }
    }

    throw error;
  }
}
