// Override for rivet/packages/app/src/model/native/TauriNativeApi.ts
// HostedNativeApi: routes all operations through /api/native/* endpoints

import { type BaseDir, type NativeApi, type ReadDirOptions } from '@valerypopoff/rivet2-core';
import { RIVET_API_BASE_URL } from '../../../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

export class TauriNativeApi implements NativeApi {
  async readdir(path: string, baseDir?: BaseDir, options: ReadDirOptions = {}): Promise<string[]> {
    const resp = await fetch(`${API}/native/readdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        baseDir,
        options: {
          recursive: options.recursive ?? false,
          includeDirectories: options.includeDirectories ?? false,
          filterGlobs: options.filterGlobs ?? [],
          relative: options.relative ?? false,
          ignores: options.ignores ?? [],
        },
      }),
    });
    if (!resp.ok) throw new Error(`readdir failed: ${resp.statusText}`);
    return resp.json();
  }

  async readTextFile(path: string, baseDir?: BaseDir): Promise<string> {
    const resp = await fetch(`${API}/native/read-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, baseDir }),
    });
    if (!resp.ok) throw new Error(`readTextFile failed: ${resp.statusText}`);
    const data = await resp.json();
    return data.contents;
  }

  async readBinaryFile(path: string, baseDir?: BaseDir): Promise<Blob> {
    const resp = await fetch(`${API}/native/read-binary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, baseDir }),
    });
    if (!resp.ok) throw new Error(`readBinaryFile failed: ${resp.statusText}`);
    const data = await resp.json();
    const binary = atob(data.contents);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes]);
  }

  async writeTextFile(path: string, data: string, baseDir?: BaseDir): Promise<void> {
    const resp = await fetch(`${API}/native/write-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, contents: data, baseDir }),
    });
    if (!resp.ok) throw new Error(`writeTextFile failed: ${resp.statusText}`);
  }

  async exec(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
    const resp = await fetch(`${API}/shell/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: command, args, options }),
    });
    if (!resp.ok) throw new Error(`exec failed: ${resp.statusText}`);
  }
}
