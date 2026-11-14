import fs from 'node:fs';
import path from 'node:path';
import { readRuntimeCacheManifest } from './runtime-release-cache.mjs';

export function getRuntimeLibrariesRoot() {
  return process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim() || '/data/runtime-libraries';
}

export function jobsRoot() {
  return path.join(getRuntimeLibrariesRoot(), 'jobs');
}

export function ensureDirectories() {
  fs.mkdirSync(getRuntimeLibrariesRoot(), { recursive: true });
  fs.mkdirSync(jobsRoot(), { recursive: true });
}

export function readManifest() {
  return readRuntimeCacheManifest(getRuntimeLibrariesRoot());
}
