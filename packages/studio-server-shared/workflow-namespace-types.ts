/** Internal authoring protocol; project files and portable bundles are unchanged. */
export type WorkflowNamespaceCommand =
  | { kind: 'move'; itemType: 'project' | 'folder'; relativePath: string; destinationRelativePath: string }
  | { kind: 'rename'; itemType: 'project' | 'folder'; relativePath: string; name: string }
  | { kind: 'delete'; itemType: 'project' | 'folder'; relativePath: string };

export type WorkflowNamespaceMutation = {
  operationId: string;
  /** Admission deadline. Reusing an expired ID never starts another write. */
  expiresAt: string;
  command: WorkflowNamespaceCommand;
  expectedSource: { id: string; revisionId?: string | null };
  /** Required for moves. null identifies the library root, not an unknown folder. */
  expectedDestinationId?: string | null;
};

export type WorkflowMutationReceipt = { operationId: string; expiresAt: string };
