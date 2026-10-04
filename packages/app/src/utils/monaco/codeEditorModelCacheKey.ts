export type CodeEditorModelCacheKeyParts = {
  projectId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  editorKey?: string | null;
  language?: string | null;
  interpolationSyntax?: string | null;
  scope?: string;
  contentRevision?: number;
};

function encodeCodeEditorModelCachePart(value: string | null | undefined): string {
  return encodeURIComponent(value?.trim() || 'none');
}

export function buildCodeEditorModelCacheKey(parts: CodeEditorModelCacheKeyParts): string | undefined {
  if (!parts.projectId || !parts.graphId || !parts.nodeId || !parts.editorKey) {
    return undefined;
  }

  return [
    `project:${encodeCodeEditorModelCachePart(parts.projectId)}`,
    `graph:${encodeCodeEditorModelCachePart(parts.graphId)}`,
    `node:${encodeCodeEditorModelCachePart(parts.nodeId)}`,
    `editor:${encodeCodeEditorModelCachePart(parts.editorKey)}`,
    `language:${encodeCodeEditorModelCachePart(parts.language)}`,
    `interpolation:${encodeCodeEditorModelCachePart(parts.interpolationSyntax)}`,
    ...(parts.scope ? [`scope:${encodeCodeEditorModelCachePart(parts.scope)}`] : []),
    ...(parts.contentRevision ? [`revision:${parts.contentRevision}`] : []),
  ].join('|');
}
