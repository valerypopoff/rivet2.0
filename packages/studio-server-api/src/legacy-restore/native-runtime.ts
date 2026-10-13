import fs from 'node:fs/promises';
import path from 'node:path';

export function isNativeExecutableHeader(bytes: Buffer): boolean {
  const magic = bytes.subarray(0, 4).toString('hex');
  return (
    bytes.subarray(0, 2).toString() === 'MZ' ||
    [
      '7f454c46',
      'feedface',
      'cefaedfe',
      'feedfacf',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca',
    ].includes(magic)
  );
}

/** Legacy manifests have no platform attestation. Do not guess whether copied native code is portable. */
export async function assertPortableRuntimeTree(root: string): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await assertPortableRuntimeTree(file);
    else if (entry.isFile()) {
      if (/\.(node|dll|dylib|so)(\.|$)/i.test(entry.name))
        throw new Error('Native runtime libraries require a platform-certified migration.');
      const handle = await fs.open(file, 'r');
      try {
        const bytes = Buffer.alloc(4);
        const { bytesRead } = await handle.read(bytes, 0, 4, 0);
        if (isNativeExecutableHeader(bytes.subarray(0, bytesRead)))
          throw new Error('Native runtime libraries require a platform-certified migration.');
      } finally {
        await handle.close();
      }
    }
    // Archive validation already proves links stay inside this tree; targets are inspected at their real entry.
  }
}
