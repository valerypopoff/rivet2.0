import fs from 'node:fs/promises';
import { chargeLocalSourceBytes, remainingLocalSourceBytes } from '../local-metadata/source-budget.js';

/** Preserve the original UTF-8 text, including a BOM, or block a lossy migration. */
export function decodeMigrationSourceUtf8(bytes: Uint8Array, description: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Migration source is not valid UTF-8: ${description}`);
  }
}

export async function readMigrationSourceUtf8(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Migration source must be a regular file.');
  if (stat.size > (remainingLocalSourceBytes() ?? Infinity))
    throw new Error('Local source bundle exceeds the decoded-memory budget.');
  const handle = await fs.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      chargeLocalSourceBytes((chunk as Buffer).length);
      bytes += (chunk as Buffer).length;
      chunks.push(chunk as Buffer);
    }
    const after = await fs.lstat(filePath);
    if (
      bytes !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Migration source changed while reading.');
    return decodeMigrationSourceUtf8(Buffer.concat(chunks, bytes), filePath);
  } finally {
    await handle.close();
  }
}
