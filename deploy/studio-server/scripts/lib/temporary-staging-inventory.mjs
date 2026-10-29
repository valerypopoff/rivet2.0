import assert from 'node:assert/strict';

/** Complete API discovery, not name-prefix ownership. Fresh namespace UIDs and
 * exact controller references delimit bootstrap garbage collection. Ambiguous
 * Events or unknown custom objects block deletion and are reported privately. */
export async function captureTemporaryBootstrap(api, record) {
  const core = await api.json('GET', '/api/v1'),
    groups = await api.json('GET', '/apis');
  assert.ok(Array.isArray(core?.resources) && Array.isArray(groups?.groups));
  const versions = [['/api/v1', core]];
  for (const group of groups.groups) {
    const version = group.preferredVersion?.groupVersion;
    assert.match(version, /^[a-z0-9.-]+\/v[0-9a-z]+$/);
    const resources = await api.json('GET', `/apis/${version}`);
    assert.ok(Array.isArray(resources?.resources));
    versions.push([`/apis/${version}`, resources]);
  }
  const known = new Set([
      ...record.resources.filter((i) => i.kind === 'kubernetes' && i.identity).map((i) => i.identity.id),
      ...(record.bootstrapChildren ?? []).map((i) => i.uid),
    ]),
    found = [];
  for (const namespace of record.resources.filter(
    (i) =>
      i.kind === 'kubernetes' &&
      i.apiPath.startsWith('/api/v1/namespaces/') &&
      i.apiPath.split('/').length === 5 &&
      !i.absent,
  )) {
    const ns = await api.json('GET', namespace.apiPath);
    assert.equal(ns?.metadata.uid, namespace.identity.id);
    for (const [prefix, list] of versions)
      for (const type of list.resources.filter(
        (r) => r.namespaced && !r.name.includes('/') && r.verbs?.includes('list'),
      )) {
        assert.match(type.name, /^[a-z0-9.-]+$/);
        let continuation;
        const seen = new Set();
        do {
          const resource = `${prefix}/namespaces/${ns.metadata.name}/${type.name}`;
          const page = await api.json(
            'GET',
            resource + (continuation ? `?continue=${encodeURIComponent(continuation)}` : ''),
          );
          assert.ok(Array.isArray(page?.items), 'Incomplete bootstrap inventory');
          for (const item of page.items) {
            assert.ok(item.metadata?.uid && item.metadata.namespace === ns.metadata.name);
            found.push({
              apiPath: `${resource}/${item.metadata.name}`,
              uid: item.metadata.uid,
              namespaceUid: ns.metadata.uid,
              kind: item.kind,
              name: item.metadata.name,
              owners: (item.metadata.ownerReferences ?? []).map((r) => r.uid),
              eventUid: item.regarding?.uid ?? item.involvedObject?.uid,
              defaultAccount: item.kind === 'ServiceAccount' && item.metadata.name === 'default',
              rootCa:
                item.kind === 'ConfigMap' &&
                item.metadata.name === 'kube-root-ca.crt' &&
                item.data?.['ca.crt'] ===
                  Buffer.from(record.resources.find((r) => r.key === 'cluster').identity.ca, 'base64').toString('utf8'),
              fixtureRegistry:
                item.kind === 'ConfigMap' &&
                item.metadata.name === record.plan.operationId &&
                item.metadata.labels?.['rivet.dev/qualification-operation'] === record.plan.operationId &&
                JSON.parse(item.data?.record ?? 'null')?.operation?.inputHash === record.operation?.inputHash,
            });
          }
          continuation = page.metadata?.continue;
          if (continuation) {
            assert.ok(!seen.has(continuation) && seen.size < 100);
            seen.add(continuation);
          }
        } while (continuation);
      }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of found)
      if (
        !known.has(item.uid) &&
        (item.defaultAccount ||
          item.rootCa ||
          item.fixtureRegistry ||
          item.owners.some((uid) => known.has(uid)) ||
          (item.kind === 'Event' && known.has(item.eventUid)))
      ) {
        known.add(item.uid);
        changed = true;
      }
  }
  const unknown = found.filter((item) => !known.has(item.uid));
  if (unknown.length) {
    const error = new Error('Unowned bootstrap objects block cleanup');
    error.resources = unknown.map(({ apiPath, uid, namespaceUid, kind, name }) => ({
      apiPath,
      uid,
      namespaceUid,
      kind,
      name,
    }));
    throw error;
  }
  return found.map(({ apiPath, uid, namespaceUid, kind, name }) => ({ apiPath, uid, namespaceUid, kind, name }));
}
