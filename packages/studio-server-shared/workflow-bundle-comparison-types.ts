/** Comparison is transient; real Newer projects keep their normal save bindings. */
export type BundleComparisonProject = {
  projectId: string;
  name: string;
  relativePath: string;
  revisionId: string;
  publishedRevisionId: string | null;
};
export type BundleComparisonCatalog = {
  bundleId: string;
  name: string;
  relativePath: string;
  folders: string[];
  projects: BundleComparisonProject[];
};
export type BundleComparisonManifest = {
  older: BundleComparisonCatalog;
  newer: BundleComparisonCatalog;
  capturedAt: string;
};
export type BundleComparisonPair = { olderId: string | null; newerId: string | null };
export type BundleComparisonReference = { bundleId: string; projectId: string; revisionId: string };
export type BundleComparisonCurrent = { bundleId: string; projectId: string };
export type BundleComparisonPairRequest = {
  older: BundleComparisonReference | null;
  newer: BundleComparisonCurrent | null;
};
export type BundleComparisonPairResult = {
  older: (BundleComparisonReference & { contents: string }) | null;
  newer: (BundleComparisonCurrent & { path: string }) | null;
};
export type BundleComparisonOwner = { sessionId: string; generation: number };
export type BundleComparisonIntent = BundleComparisonOwner & {
  preferredGraphId?: string;
  pair: BundleComparisonPairRequest;
  /** Complete, user-confirmed correspondence, including one-sided members. */
  pairs: BundleComparisonPair[];
  labels: { referenceLabel: string; currentLabel: string };
  referenceCatalog: BundleComparisonCatalog;
};
export type BundleComparisonEditorState = {
  owner: BundleComparisonOwner | null;
  projectId: string | null;
  error?: string;
  /** A native selection superseded this request; end its transient UI too. */
  cancelled?: true;
};
export type BundleComparisonAction =
  | { action: 'open'; intent: BundleComparisonIntent }
  | { action: 'stop'; owner: BundleComparisonOwner }
  | { action: 'state'; owner: BundleComparisonOwner };
export type BundleComparisonCommand = { type: 'bundle-comparison'; requestId: string } & BundleComparisonAction;
export type BundleComparisonSend = (action: BundleComparisonAction) => Promise<BundleComparisonEditorState | null>;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isBundleComparisonOwner = (v: unknown): v is BundleComparisonOwner & Record<string, unknown> =>
  record(v) && text(v.sessionId, 128) && Number.isSafeInteger(v.generation) && Number(v.generation) >= 0;
export function isBundleComparisonEditorState(v: unknown): v is BundleComparisonEditorState {
  return (
    record(v) &&
    (v.owner === null || isBundleComparisonOwner(v.owner)) &&
    (v.projectId === null || text(v.projectId)) &&
    (v.error === undefined || text(v.error, 4096)) &&
    (v.cancelled === undefined || v.cancelled === true)
  );
}
export function isBundleComparisonCommand(v: unknown): v is BundleComparisonCommand {
  if (!record(v) || v.type !== 'bundle-comparison' || !text(v.requestId)) return false;
  if (v.action === 'stop' || v.action === 'state') return isBundleComparisonOwner(v.owner);
  if (v.action !== 'open' || !record(v.intent) || !isBundleComparisonOwner(v.intent)) return false;
  const i = v.intent;
  if (i.preferredGraphId !== undefined && !text(i.preferredGraphId)) return false;
  const member = (m: unknown, reference = false) =>
    record(m) && text(m.bundleId) && text(m.projectId) && (!reference || text(m.revisionId));
  if (
    !record(i.pair) ||
    !(i.pair.older === null || member(i.pair.older, true)) ||
    !(i.pair.newer === null || member(i.pair.newer)) ||
    (!i.pair.older && !i.pair.newer)
  )
    return false;
  if (!record(i.labels) || !text(i.labels.referenceLabel, 1024) || !text(i.labels.currentLabel, 1024)) return false;
  if (!Array.isArray(i.pairs) || i.pairs.length > 512) return false;
  const seenBefore = new Set<string>(),
    seenAfter = new Set<string>();
  for (const p of i.pairs) {
    if (
      !record(p) ||
      !(p.olderId === null || text(p.olderId)) ||
      !(p.newerId === null || text(p.newerId)) ||
      (!p.olderId && !p.newerId)
    )
      return false;
    if (typeof p.olderId === 'string') {
      if (seenBefore.has(p.olderId)) return false;
      seenBefore.add(p.olderId);
    }
    if (typeof p.newerId === 'string') {
      if (seenAfter.has(p.newerId)) return false;
      seenAfter.add(p.newerId);
    }
  }
  const c = i.referenceCatalog;
  if (
    !(
      record(c) &&
      text(c.bundleId) &&
      text(c.name, 1024) &&
      typeof c.relativePath === 'string' &&
      c.relativePath.length <= 4096 &&
      Array.isArray(c.folders) &&
      c.folders.length <= 512 &&
      c.folders.every((p) => text(p, 4096)) &&
      Array.isArray(c.projects) &&
      c.projects.length <= 256 &&
      c.projects.every(
        (p) =>
          record(p) &&
          text(p.projectId) &&
          text(p.name, 1024) &&
          text(p.relativePath, 4096) &&
          text(p.revisionId) &&
          (p.publishedRevisionId === null || text(p.publishedRevisionId)),
      )
    )
  )
    return false;
  const projects = c.projects as BundleComparisonProject[];
  if (
    seenBefore.size !== projects.length ||
    new Set(projects.map((p) => p.projectId)).size !== projects.length ||
    projects.some((p) => !seenBefore.has(p.projectId)) ||
    seenAfter.size > 256
  )
    return false;
  const pair = i.pair as BundleComparisonPairRequest;
  if (
    pair.older &&
    (pair.older.bundleId !== c.bundleId ||
      !projects.some((p) => p.projectId === pair.older!.projectId && p.revisionId === pair.older!.revisionId))
  )
    return false;
  if (pair.newer?.bundleId === c.bundleId) return false;
  return (i.pairs as BundleComparisonPair[]).some(
    (p) => p.olderId === (pair.older?.projectId ?? null) && p.newerId === (pair.newer?.projectId ?? null),
  );
}

/** Undefined is unresolved; null is an explicit absent counterpart. */
export type BundleComparisonChoices = Record<string, string | null | undefined>;

export function suggestBundleComparison(manifest: BundleComparisonManifest): BundleComparisonChoices {
  const result: BundleComparisonChoices = Object.fromEntries(
    manifest.older.projects.map((p) => [p.projectId, undefined]),
  );
  const claimed = new Set<string>();
  const ambiguous = new Set<string>();
  for (const field of ['relativePath', 'name'] as const) {
    const proposals = new Map<string, string[]>();
    const counts = new Map<string, number>();
    for (const source of manifest.older.projects) {
      if (result[source.projectId] !== undefined || ambiguous.has(source.projectId)) continue;
      const targets = manifest.newer.projects.filter((p) => !claimed.has(p.projectId) && p[field] === source[field]);
      proposals.set(
        source.projectId,
        targets.map((p) => p.projectId),
      );
      for (const p of targets) counts.set(p.projectId, (counts.get(p.projectId) ?? 0) + 1);
    }
    for (const [id, targets] of proposals) {
      if (targets.length === 1 && counts.get(targets[0]!) === 1) {
        result[id] = targets[0]!;
        claimed.add(targets[0]!);
      } else if (targets.length) ambiguous.add(id);
    }
  }
  for (const p of manifest.older.projects)
    if (result[p.projectId] === undefined && !ambiguous.has(p.projectId)) result[p.projectId] = null;
  return result;
}

export function buildBundleComparisonPairs(
  manifest: BundleComparisonManifest,
  choices: BundleComparisonChoices,
): BundleComparisonPair[] {
  const allowed = new Set(manifest.newer.projects.map((p) => p.projectId));
  const used = new Set<string>();
  const pairs = manifest.older.projects.map((p) => {
    const target = Object.hasOwn(choices, p.projectId) ? choices[p.projectId] : undefined;
    if (target === undefined) throw new Error('Choose a counterpart or No corresponding project for every row.');
    if (target !== null) {
      if (!allowed.has(target) || used.has(target))
        throw new Error('Each counterpart must be a distinct project in the Newer bundle.');
      used.add(target);
    }
    return { olderId: p.projectId, newerId: target };
  });
  return [
    ...pairs,
    ...manifest.newer.projects
      .filter((p) => !used.has(p.projectId))
      .map((p) => ({ olderId: null, newerId: p.projectId })),
  ];
}

export const bundleComparisonPairKey = (pair: BundleComparisonPair) => JSON.stringify([pair.olderId, pair.newerId]);
