import path from 'node:path';
import { NodeNativeApi } from '@valerypopoff/rivet2-node';
import type { BaseDir, ReadDirOptions } from '@valerypopoff/rivet2-node';

export function isInsideCatalogRoot(root: string, value: string): boolean {
  const relative = path.relative(root, path.resolve(value));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Owned workflow paths are virtual after cutover. Never fall back to the
 * retained files, including on a missing row or an interrupted API request. */
export class CatalogNativeApi extends NodeNativeApi {
  constructor(
    readonly catalog: {
      root: string;
      readText(path: string): Promise<string>;
      readDirectory(path: string, options: ReadDirOptions): Promise<string[]>;
    },
  ) {
    super();
  }
  override async readTextFile(file: string, baseDir?: BaseDir): Promise<string> {
    return isInsideCatalogRoot(this.catalog.root, file)
      ? this.catalog.readText(path.resolve(file))
      : super.readTextFile(file, baseDir);
  }
  override async readBinaryFile(file: string, baseDir?: BaseDir): Promise<Blob> {
    return isInsideCatalogRoot(this.catalog.root, file)
      ? new Blob([await this.catalog.readText(path.resolve(file))])
      : super.readBinaryFile(file, baseDir);
  }
  override async readdir(directory: string, baseDir?: BaseDir, options: ReadDirOptions = {}): Promise<string[]> {
    return isInsideCatalogRoot(this.catalog.root, directory)
      ? this.catalog.readDirectory(path.resolve(directory), options)
      : super.readdir(directory, baseDir, options);
  }
  override async writeTextFile(file: string, contents: string, baseDir?: BaseDir): Promise<void> {
    if (isInsideCatalogRoot(this.catalog.root, file))
      throw new Error('Workflow catalog paths must be saved through Rivet project operations, not file writes.');
    return super.writeTextFile(file, contents, baseDir);
  }
}
