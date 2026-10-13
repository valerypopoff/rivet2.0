import { Unzip, UnzipInflate } from 'fflate';
import {
  PROJECT_BUNDLE_UPLOAD_MAX_BYTES,
  PROJECT_BUNDLE_UPLOAD_MAX_FILES,
  type ProjectBundleUploadFile,
} from '../../studio-server-shared/project-bundle-types';

function safePath(path: string): void {
  if (!path || path.length > 4096 || /[\\:\0]/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Bundle contains an unsafe file path.');
}

const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const ignored = (path: string) => path.split('/').includes('__MACOSX') || path.split('/').at(-1) === '.DS_Store';

/** No archive files are extracted to disk; all actual decoded bytes are bounded. */
export async function readBundleArchive(file: File): Promise<ProjectBundleUploadFile[]> {
  if (file.size > PROJECT_BUNDLE_UPLOAD_MAX_BYTES) throw new Error('Bundle archive exceeds 64 MiB.');
  const result: ProjectBundleUploadFile[] = [];
  const active = new Set<import('fflate').UnzipFile>();
  const paths = new Set<string>();
  let total = 0;
  let count = 0;
  let failure: unknown;
  const zip = new Unzip((entry) => {
    if (++count > PROJECT_BUNDLE_UPLOAD_MAX_FILES * 2) throw new Error('Bundle contains too many archive entries.');
    const directory = entry.name.endsWith('/');
    safePath(directory ? entry.name.slice(0, -1) : entry.name);
    if (directory || ignored(entry.name)) return;
    if (paths.has(entry.name.toLowerCase())) throw new Error('Bundle contains duplicate file paths.');
    paths.add(entry.name.toLowerCase());
    if (paths.size > PROJECT_BUNDLE_UPLOAD_MAX_FILES) throw new Error('Bundle contains too many files.');
    if ((entry.originalSize ?? 0) > PROJECT_BUNDLE_UPLOAD_MAX_BYTES) throw new Error('Bundle expands beyond 64 MiB.');
    active.add(entry);
    const chunks: Uint8Array[] = [];
    let length = 0;
    entry.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        return;
      }
      total += data.length;
      if (total > PROJECT_BUNDLE_UPLOAD_MAX_BYTES) {
        failure = new Error('Bundle expands beyond 64 MiB.');
        return;
      }
      chunks.push(data);
      length += data.length;
      if (final) {
        const bytes = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, position);
          position += chunk.length;
        }
        chunks.length = 0;
        result.push({ path: entry.name, contents: decode(bytes) });
        active.delete(entry);
      }
    };
    entry.start();
  });
  zip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < file.size; offset += 16 * 1024) {
      const bytes = new Uint8Array(await file.slice(offset, offset + 16 * 1024).arrayBuffer());
      zip.push(bytes, offset + bytes.length >= file.size);
      if (failure) throw failure;
      // Yield between bounded input chunks, keeping progress/paint responsive.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (active.size) throw new Error('Bundle archive is incomplete.');
    return normalizeBundleFiles(result);
  } finally {
    for (const entry of active) entry.terminate();
  }
}

export async function readBundleFolder(files: File[]): Promise<ProjectBundleUploadFile[]> {
  if (files.length > PROJECT_BUNDLE_UPLOAD_MAX_FILES * 2) throw new Error('Bundle contains too many files.');
  const result: ProjectBundleUploadFile[] = [];
  let total = 0;
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    safePath(path);
    if (ignored(path)) continue;
    if (result.length >= PROJECT_BUNDLE_UPLOAD_MAX_FILES) throw new Error('Bundle contains too many files.');
    total += file.size;
    if (total > PROJECT_BUNDLE_UPLOAD_MAX_BYTES) throw new Error('Bundle contents exceed 64 MiB.');
    result.push({ path, contents: decode(new Uint8Array(await file.arrayBuffer())) });
  }
  return normalizeBundleFiles(result);
}

export function normalizeBundleFiles(files: ProjectBundleUploadFile[]): ProjectBundleUploadFile[] {
  if (files.length > PROJECT_BUNDLE_UPLOAD_MAX_FILES) throw new Error('Bundle contains too many files.');
  const manifests = files.filter((f) => f.path === 'rivet-bundle.json' || f.path.endsWith('/rivet-bundle.json'));
  if (manifests.length !== 1) throw new Error('Choose one bundle folder or ZIP containing rivet-bundle.json.');
  const prefix = manifests[0]!.path.slice(0, -'rivet-bundle.json'.length);
  const paths = new Set<string>();
  return files.map((file) => {
    safePath(file.path);
    if (!file.path.startsWith(prefix)) throw new Error('Archive contains files outside the bundle folder.');
    const path = file.path.slice(prefix.length);
    safePath(path);
    if (paths.has(path.toLowerCase())) throw new Error('Bundle contains duplicate file paths.');
    paths.add(path.toLowerCase());
    return { path, contents: file.contents };
  });
}
