import { normalizeGraphProgress } from '@valerypopoff/rivet2-core';

/** Test size before serializing large values. Truncated data is omitted, never replaced by an executable value. */
export function projectDebuggerEnvelope(envelope: Record<string, any>): Record<string, any> {
  if (fits(envelope)) return envelope;
  const source = envelope.data;
  if (!source || typeof source !== 'object')
    return { ...envelope, data: typeof source === 'string' ? source.slice(0, 2048) : {}, diagnosticsIncomplete: true };
  const metadata = (value: any) => ({
    id: value?.id,
    ...(typeof value?.name === 'string' ? { name: value.name.slice(0, 256) } : {}),
    ...(typeof value?.title === 'string' ? { title: value.title.slice(0, 256) } : {}),
  });
  const graph = (value: any) => ({ metadata: metadata(value?.metadata), nodes: [], connections: [] });
  const compactNode = source.node && {
    id: source.node.id,
    type: source.node.type,
    title: String(source.node.title ?? '').slice(0, 256),
    isSplitRun: source.node.isSplitRun,
    data: {},
    visualData: {},
  };
  const authored = {
    ...(source.node ? { node: compactNode } : {}),
    ...(source.graph ? { graph: graph(source.graph) } : {}),
    ...(source.startGraph ? { startGraph: graph(source.startGraph) } : {}),
    ...(source.project ? { project: { metadata: metadata(source.project.metadata), graphs: {}, plugins: [] } } : {}),
  };
  // Recordings keep the project separately; shrinking repeated authored snapshots loses no observed values.
  if (Object.keys(authored).length) {
    const compact = { ...envelope, data: { ...source, ...authored } };
    if (fits(compact)) return compact;
  }
  const data: Record<string, any> = {};
  for (const key of [
    'execution',
    'processId',
    'index',
    'resultOrigin',
    'durationMs',
    'streamingWatchTerminal',
    'successful',
  ])
    if (source[key] !== undefined && fits(source[key], 4096)) data[key] = source[key];
  Object.assign(data, authored);
  for (const key of ['inputs', 'outputs', 'contextValues']) if (key in source) data[key] = {};
  if (source.error !== undefined) data.error = String(source.error).slice(0, 2048);
  if (source.reason !== undefined) data.reason = String(source.reason).slice(0, 2048);
  if (source.progress) data.progress = normalizeGraphProgress(source.progress);
  // Metadata itself may be authored. Do not let it defeat the bounded projection.
  if (!fits(data))
    return {
      message: 'trace',
      requestId: envelope.requestId,
      data: 'Some run details were omitted.',
      diagnosticsIncomplete: true,
    };
  return { ...envelope, data, diagnosticsIncomplete: true };
}

function fits(value: unknown, budget = 48 * 1024): boolean {
  let remaining = budget;
  const seen = new WeakSet<object>();
  function visit(item: unknown, depth: number): boolean {
    if ((remaining -= 8) < 0 || depth > 32) return false;
    if (typeof item === 'string') return (remaining -= item.length * 6) >= 0;
    if (typeof item === 'number') return (remaining -= String(item).length) >= 0;
    if (typeof item !== 'object' || item === null) return true;
    if (Array.isArray(item) && item.length > remaining / 8) return false;
    if (ArrayBuffer.isView(item) && item.byteLength > remaining) return false;
    if (seen.has(item)) return false;
    seen.add(item);
    for (const key of Object.keys(item)) {
      if ((remaining -= key.length * 6) < 0 || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
    }
    seen.delete(item);
    return true;
  }
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}
