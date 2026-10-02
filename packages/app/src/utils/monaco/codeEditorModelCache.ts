import type * as monaco from 'monaco-editor';

const MAX_CACHED_CODE_EDITOR_MODELS = 12;

type CachedCodeEditorModel = {
  model: monaco.editor.ITextModel;
  lastInputText: string;
  users: number;
  pendingRemoval?: boolean;
};

const modelCache = new Map<string, CachedCodeEditorModel>();
const viewStateCache = new Map<string, monaco.editor.ICodeEditorViewState>();

function encodeCodeEditorModelCachePart(value: string | null | undefined): string {
  return encodeURIComponent(value?.trim() || 'none');
}

function getCodeEditorModelProjectPrefix(projectId: string): string {
  return `project:${encodeCodeEditorModelCachePart(projectId)}|`;
}

export function getCodeEditorModelUri(cacheKey: string): string {
  return `inmemory://rivet/node-editor/${encodeURIComponent(cacheKey)}`;
}

export function getOrCreateCodeEditorModel(params: {
  cacheKey: string | undefined;
  text: string;
  getExistingModel?: () => monaco.editor.ITextModel | null;
  createModel: () => monaco.editor.ITextModel;
  retain?: boolean;
}): {
  model: monaco.editor.ITextModel;
  isCached: boolean;
  release(): void;
} {
  const { cacheKey, text, createModel, getExistingModel, retain = false } = params;

  if (!cacheKey) {
    return {
      model: createModel(),
      isCached: false,
      release: () => {},
    };
  }

  const cached = modelCache.get(cacheKey);
  if (cached) {
    cached.pendingRemoval = false;
    if (retain) cached.users++;
    modelCache.delete(cacheKey);
    modelCache.set(cacheKey, cached);

    if (cached.lastInputText !== text && cached.model.getValue() !== text) {
      cached.model.setValue(text);
      viewStateCache.delete(cacheKey);
    }
    cached.lastInputText = text;

    return {
      model: cached.model,
      isCached: true,
      release: createModelRelease(cacheKey, cached, retain),
    };
  }

  const model = getExistingModel?.() ?? createModel();
  const entry = { model, lastInputText: text, users: retain ? 1 : 0 };
  modelCache.set(cacheKey, entry);
  evictOldModels();

  return {
    model,
    isCached: true,
    release: createModelRelease(cacheKey, entry, retain),
  };
}

function createModelRelease(cacheKey: string, entry: CachedCodeEditorModel, retained: boolean): () => void {
  let released = false;
  return () => {
    if (!retained || released) return;
    released = true;
    entry.users--;
    if (modelCache.get(cacheKey) !== entry) return;
    if (entry.pendingRemoval && entry.users === 0) {
      entry.model.dispose();
      modelCache.delete(cacheKey);
      viewStateCache.delete(cacheKey);
    }
    evictOldModels();
  };
}

export function clearCodeEditorModelCacheForProject(projectId: string): void {
  const prefix = getCodeEditorModelProjectPrefix(projectId);
  for (const [cacheKey, cached] of modelCache) {
    if (cacheKey.startsWith(prefix)) {
      if (cached.users > 0) cached.pendingRemoval = true;
      else {
        cached.model.dispose();
        modelCache.delete(cacheKey);
      }
    }
  }
  for (const cacheKey of viewStateCache.keys()) {
    if (cacheKey.startsWith(prefix)) {
      viewStateCache.delete(cacheKey);
    }
  }
}

// Source acknowledgement is separate from the model buffer: JSON drafts may
// be invalid, and formatting-equivalent input should retain its cursor/undo.
export function acknowledgeCodeEditorModelSource(cacheKey: string | undefined, text: string): void {
  const cached = cacheKey ? modelCache.get(cacheKey) : undefined;
  if (cached) cached.lastInputText = text;
}

export function clearCodeEditorModelCache(): void {
  for (const cached of modelCache.values()) {
    cached.model.dispose();
  }
  modelCache.clear();
  viewStateCache.clear();
}

export function getCachedCodeEditorModelCount(): number {
  return modelCache.size;
}

export function getCodeEditorViewState(cacheKey: string | undefined): monaco.editor.ICodeEditorViewState | undefined {
  return cacheKey ? viewStateCache.get(cacheKey) : undefined;
}

export function saveCodeEditorViewState(
  cacheKey: string | undefined,
  viewState: monaco.editor.ICodeEditorViewState | null,
): void {
  if (!cacheKey) {
    return;
  }

  if (viewState) {
    viewStateCache.set(cacheKey, viewState);
  } else {
    viewStateCache.delete(cacheKey);
  }
}

function evictOldModels(): void {
  while (modelCache.size > MAX_CACHED_CODE_EDITOR_MODELS) {
    // Several node fields can be visible together. Never dispose a model that
    // an attached Monaco editor is using merely to meet the warm-cache limit.
    const oldestKey = [...modelCache].find(([, cached]) => cached.users === 0)?.[0];
    if (!oldestKey) {
      return;
    }

    const oldest = modelCache.get(oldestKey);
    oldest?.model.dispose();
    modelCache.delete(oldestKey);
    viewStateCache.delete(oldestKey);
  }
}
