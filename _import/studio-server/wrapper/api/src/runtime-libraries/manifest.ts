import fs from 'node:fs';
import path from 'node:path';

import type { RuntimeLibraryEntry } from '../../../shared/runtime-library-types.js';

export type { RuntimeLibraryEntry };

export interface RuntimeLibraryManifest {
  packages: Record<string, RuntimeLibraryEntry>;
  updatedAt: string;
  activeReleaseId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getRuntimeLibrariesRoot(): string {
  return process.env.RIVET_RUNTIME_LIBRARIES_ROOT ?? '/data/runtime-libraries';
}

export function getRootPath(): string {
  return getRuntimeLibrariesRoot();
}

function manifestPath(): string {
  return path.join(getRuntimeLibrariesRoot(), 'manifest.json');
}

export function currentDir(): string {
  return path.join(getRuntimeLibrariesRoot(), 'current');
}

export function stagingDir(): string {
  return path.join(getRuntimeLibrariesRoot(), 'staging');
}

export function ensureDirectories(): void {
  const root = getRuntimeLibrariesRoot();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'staging'), { recursive: true });
}

export function emptyManifest(): RuntimeLibraryManifest {
  return {
    packages: {},
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeManifest(value: unknown): RuntimeLibraryManifest {
  const defaults = emptyManifest();
  if (!isRecord(value)) {
    return defaults;
  }

  const rawPackages = isRecord(value.packages) ? value.packages : {};
  const packages = Object.fromEntries(
    Object.entries(rawPackages)
      .map(([packageName, entry]) => {
        if (!packageName || !isRecord(entry) || typeof entry.version !== 'string' || !entry.version.trim()) {
          return null;
        }

        return [
          packageName,
          {
            name: packageName,
            version: entry.version,
            ...(typeof entry.installedAt === 'string' ? { installedAt: entry.installedAt } : {}),
          } satisfies RuntimeLibraryEntry,
        ] as const;
      })
      .filter((entry): entry is readonly [string, RuntimeLibraryEntry] => entry != null),
  );

  return {
    packages,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : defaults.updatedAt,
    ...(typeof value.activeReleaseId === 'string' && value.activeReleaseId.trim()
      ? { activeReleaseId: value.activeReleaseId.trim() }
      : {}),
  };
}

export function readManifest(): RuntimeLibraryManifest {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf8');
    return normalizeManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return emptyManifest();
    }

    throw error;
  }
}

export function writeManifest(manifest: RuntimeLibraryManifest): void {
  ensureDirectories();
  const nextManifest: RuntimeLibraryManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${manifestPath()}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextManifest, null, 2), 'utf8');
  fs.renameSync(tmp, manifestPath());
}

export function currentNodeModulesPath(): string | null {
  const nodeModulesPath = path.join(currentDir(), 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return null;
  }

  return nodeModulesPath;
}
