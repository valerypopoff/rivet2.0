export const RECORDING_INPUT_PATH_HISTORY_KEY = 'rivet.run-recordings.input-path-history.v1';

type HistoryEdit = { path: string; remember: boolean };
// Document-local state survives modal unmounts. Retry edits, not stale snapshots,
// so unrelated changes made in another tab are preserved.
let cachedHistory: string[] = [];
let pendingEdits: HistoryEdit[] = [];

export function normalizeInputPathHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function readInputPathHistory(): string[] {
  let paths = cachedHistory;
  let readable = false;
  try {
    const value = window.localStorage.getItem(RECORDING_INPUT_PATH_HISTORY_KEY);
    readable = true;
    if (value === null) paths = [];
    else {
      try {
        paths = normalizeInputPathHistory(JSON.parse(value));
      } catch {
        // Retain the last readable list; the next edit can repair corrupt JSON.
      }
    }
  } catch {
    // This is an optional convenience, never a prerequisite for searching.
  }
  for (const edit of pendingEdits) {
    paths = paths.filter((path) => path !== edit.path);
    if (edit.remember) paths = [edit.path, ...paths];
  }
  cachedHistory = paths;
  if (readable && pendingEdits.length > 0) {
    try {
      window.localStorage.setItem(RECORDING_INPUT_PATH_HISTORY_KEY, JSON.stringify(paths));
      pendingEdits = [];
    } catch {
      // Retain edits until both reading and writing storage are available.
    }
  }
  return paths;
}

function editInputPathHistory(path: string, remember: boolean): string[] {
  path = path.trim();
  if (path) {
    pendingEdits = [...pendingEdits.filter((edit) => edit.path !== path), { path, remember }];
  }
  return readInputPathHistory();
}

export function rememberInputPath(path: string): string[] {
  return editInputPathHistory(path, true);
}

export function deleteInputPath(path: string): string[] {
  return editInputPathHistory(path, false);
}
