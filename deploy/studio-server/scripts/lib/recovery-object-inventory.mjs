import assert from 'node:assert/strict';
import { readConcurrently } from './read-concurrently.mjs';

function groupReference(groups, name, base) {
  let count = 0,
    prefix = base;
  for (const point of name.slice(base.length)) {
    prefix += point;
    if (++count === 2) break;
  }
  const exact = count < 2,
    key = JSON.stringify([prefix, exact]);
  if (!groups.has(key)) groups.set(key, { prefix, exact, names: new Set() });
  groups.get(key).names.add(name);
}

/** Read current metadata for every snapshot reference. Prefix partitions are
 * derived from the actual names, never a guessed hexadecimal naming contract.
 * Each page chain stays ordered; at most four independent partitions run at once.
 * No object contents or source writes are needed. */
export async function inventoryRecoveryObjects({ references, prefixes, listPage, getObject }) {
  const wanted = new Set(references);
  assert.equal(wanted.size, references.length, 'Duplicate snapshot object reference');
  assert.ok(prefixes.length && prefixes.every((prefix) => typeof prefix === 'string' && prefix));
  const groups = new Map();
  for (const name of references) {
    assert.equal(typeof name, 'string');
    const roots = prefixes.filter((prefix) => name.startsWith(prefix));
    assert.equal(roots.length, 1, 'Snapshot object is outside the recovery prefixes');
    groupReference(groups, name, roots[0]);
  }
  // Unusual key alphabets must not turn a valid checkpoint into an unbounded
  // fan-out or a new qualification failure. Keep the original root-listing path.
  const partitions =
    groups.size <= 1024
      ? [...groups.values()]
      : prefixes
          .map((prefix) => ({
            prefix,
            exact: false,
            names: new Set(references.filter((name) => name.startsWith(prefix))),
          }))
          .filter((group) => group.names.size);
  // Keys often share a long directory or workflow prefix. Fixed two-character
  // sharding alone would leave such a bucket effectively serial. Refine large
  // groups at their actual next differing character, within the same task cap.
  const pending = [...partitions];
  partitions.length = 0;
  while (pending.length) {
    const group = pending.shift();
    if (!group.exact && group.names.size > 1000) {
      let common = group.names.values().next().value;
      for (const name of group.names) {
        let i = 0;
        while (i < common.length && i < name.length && common[i] === name[i]) i++;
        if (i && common.charCodeAt(i - 1) >= 0xd800 && common.charCodeAt(i - 1) <= 0xdbff) i--;
        common = common.slice(0, i);
      }
      const children = new Map();
      for (const name of group.names) groupReference(children, name, common);
      if (children.size > 1 && pending.length + partitions.length + children.size <= 1024) {
        pending.push(...children.values());
        continue;
      }
    }
    partitions.push(group);
  }
  const inventory = new Map();
  let pages = 0,
    metadataReads = 0;
  const accept = (object, names) => {
    if (!names.has(object.name)) return;
    assert.ok(!inventory.has(object.name), 'Duplicate current object generation');
    assert.match(object.generation, /^[1-9][0-9]*$/);
    assert.match(object.size, /^(0|[1-9][0-9]*)$/);
    assert.ok(Number.isSafeInteger(Number(object.size)) && object.md5Hash && object.crc32c);
    inventory.set(object.name, object);
  };
  await readConcurrently(
    partitions.map(({ prefix, exact, names }) => async () => {
      if (exact) {
        metadataReads++;
        const object = await getObject(prefix);
        assert.equal(object.name, prefix, 'Recovery metadata identity changed');
        accept(object, names);
        return;
      }
      let pageToken;
      const tokens = new Set();
      do {
        const page = await listPage({ prefix, pageToken });
        pages++;
        assert.ok(Array.isArray(page.items ?? []), 'Invalid recovery object inventory');
        for (const object of page.items ?? []) accept(object, names);
        pageToken = page.nextPageToken === '' || page.nextPageToken === null ? undefined : page.nextPageToken;
        if (pageToken !== undefined) {
          assert.ok(
            typeof pageToken === 'string' && pageToken && !tokens.has(pageToken),
            'Invalid recovery page token',
          );
          tokens.add(pageToken);
        }
      } while (pageToken);
    }),
  );
  assert.equal(inventory.size, wanted.size, 'Snapshot references are not all currently protected');
  return {
    objects: references.map((name) => inventory.get(name)),
    partitions: partitions.length,
    pages,
    metadataReads,
  };
}
