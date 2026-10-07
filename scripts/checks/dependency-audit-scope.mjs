export const normalizeAuditLocator = (locator) => locator.replace(/@virtual:[^#]+#npm:/, '@npm:');

/** Resolve Yarn why's deduplicated references before walking workspace ancestry. */
export function workspaceOwnersForDependent(rows, dependent) {
  const edges = new Map();
  function collect(node) {
    if (!node || typeof node !== 'object') throw new Error('Invalid dependency ancestry report.');
    const locator = typeof node.value === 'string' ? node.value : node.value?.locator;
    if (
      typeof locator !== 'string' ||
      !node.children ||
      typeof node.children !== 'object' ||
      Array.isArray(node.children)
    )
      throw new Error('Invalid dependency ancestry report.');
    const key = normalizeAuditLocator(locator);
    const targets = edges.get(key) ?? new Set();
    edges.set(key, targets);
    for (const child of Object.values(node.children)) targets.add(collect(child));
    return key;
  }
  const roots = [...new Set(rows.map(collect))];
  const target = normalizeAuditLocator(dependent);
  return roots
    .filter((root) => {
      if (!root.includes('@workspace:')) throw new Error('Dependency ancestry root is not a workspace.');
      const pending = [root];
      const visited = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (current === target) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        pending.push(...(edges.get(current) ?? []));
      }
      return false;
    })
    .sort();
}
