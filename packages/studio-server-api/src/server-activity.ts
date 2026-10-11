export type ServerActivityProbe = { name: string; count(): number | Promise<number> };

/** A maintenance barrier must account for queued as well as dispatched work. */
export async function readServerActivity(
  probes: readonly ServerActivityProbe[],
): Promise<{ ready: boolean; blockers: string[] }> {
  const blockers: string[] = [];
  for (const probe of probes) {
    const count = await probe.count();
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid activity count for ${probe.name}.`);
    if (count > 0) blockers.push(probe.name);
  }
  return { ready: blockers.length === 0, blockers };
}
