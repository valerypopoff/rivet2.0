// Shim for @tauri-apps/api/path
// appLocalDataDir() -> GET /api/path/app-local-data-dir
// join() -> POSIX path join polyfill

import { RIVET_API_BASE_URL } from '../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

export async function appLocalDataDir(): Promise<string> {
  const resp = await fetch(`${API}/path/app-local-data-dir`);
  if (!resp.ok) throw new Error(`appLocalDataDir failed: ${resp.statusText}`);
  const data = await resp.json();
  return data.path;
}

export async function appLogDir(): Promise<string> {
  const resp = await fetch(`${API}/path/app-log-dir`);
  if (!resp.ok) throw new Error(`appLogDir failed: ${resp.statusText}`);
  const data = await resp.json();
  return data.path;
}

export async function appDataDir(): Promise<string> {
  return appLocalDataDir();
}

export async function appConfigDir(): Promise<string> {
  return appLocalDataDir();
}

export async function appCacheDir(): Promise<string> {
  return appLocalDataDir();
}

// POSIX path join polyfill
export async function join(...parts: string[]): Promise<string> {
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    // Split on both / and \
    const subParts = part.split(/[/\\]/);
    for (const sub of subParts) {
      if (sub === '' || sub === '.') continue;
      if (sub === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
      } else {
        segments.push(sub);
      }
    }
  }

  // Preserve leading / if first part had one
  const firstPart = parts[0] ?? '';
  const prefix = firstPart.startsWith('/') ? '/' : '';
  return prefix + segments.join('/');
}

export async function resolve(...parts: string[]): Promise<string> {
  return join(...parts);
}

export async function basename(path: string, ext?: string): Promise<string> {
  const base = path.split(/[/\\]/).pop() ?? '';
  if (ext && base.endsWith(ext)) {
    return base.slice(0, -ext.length);
  }
  return base;
}

export async function dirname(path: string): Promise<string> {
  const parts = path.split(/[/\\]/);
  parts.pop();
  return parts.join('/') || '/';
}

export async function extname(path: string): Promise<string> {
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

export const sep = '/';
export const delimiter = ':';
