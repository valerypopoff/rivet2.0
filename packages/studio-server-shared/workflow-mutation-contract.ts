/** Internal authoring metadata only; never serialized into project files. */
export type StructuralMutation = {
  operationId: string;
  expiresAt: string;
  expectedSource?: { id: string; revisionId?: string | null; publicationVersion?: string };
  expectedDestinationId?: string | null;
  /** Save As may create a missing chain below this verified existing ancestor. */
  expectedDestinationPath?: string;
};

export type StructuralCommand =
  | { operation: 'create-folder'; input: { name: string; parentRelativePath: string } }
  | { operation: 'create-project'; input: { name: string; parentRelativePath: string } }
  | { operation: 'copy-project'; input: { relativePath: string; version: 'live' | 'published' } }
  | { operation: 'upload-project'; input: { parentRelativePath: string; fileName: string; contents: string } }
  | { operation: 'create-bundle'; input: { name: string; parentRelativePath: string } }
  | { operation: 'bundle-kind'; input: { relativePath: string; enabled: boolean; namespaceId: string } }
  | { operation: 'delete-bundle'; input: { bundleId: string; name: string; relativePath: string } }
  | { operation: 'copy-bundle'; input: { bundleId: string; automatic: true; relativePath: string } }
  | {
      operation: 'import-bundle';
      input: { parentRelativePath: string; files: Array<{ path: string; contents: string }> };
    };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/** Identical bytes for Node SHA-256 and browser WebCrypto; recovery is payload-free. */
export const mutationRequestText = (receipt: unknown, payload: unknown): string =>
  JSON.stringify(canonical({ receipt, payload }));
