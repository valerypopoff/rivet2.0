import fs from 'node:fs/promises';
import path from 'node:path';
import type { ResourceSource } from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';

export interface ResourceCounters {
  cpuMicros: number;
  memoryBytes: number;
  workingSetBytes: number | null;
  lifetimeMemoryPeakBytes: number | null;
  cpuLimitMillicores: number | null;
  memoryLimitBytes: number | null;
}
export interface ResourceCounterReader {
  source: ResourceSource;
  read(): Promise<ResourceCounters>;
}
type ReadText = (file: string) => Promise<string>;
const readText: ReadText = (file) => fs.readFile(file, 'utf8');
const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const number = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};
const fields = (text: string) =>
  Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/)),
  );

/** Resolve membership against its controller mount, never a guessed host root. */
export function resolveCgroupPaths(membership: string, mounts: string) {
  const result: { version: 1 | 2; cpu: string; memory: string; quota: string | null }[] = [];
  const groups = membership
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match = /^\d+:([^:]*):(\/.*)$/.exec(line);
      return match ? [{ controllers: match[1]!.split(','), group: match[2]! }] : [];
    });
  const resolved = new Map<string, string>();
  for (const line of mounts.trim().split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const before = left.split(' '),
      after = right.split(' ');
    if (!['cgroup', 'cgroup2'].includes(after[0]!)) continue;
    const root = unescapeMount(before[3] ?? ''),
      mount = unescapeMount(before[4] ?? '');
    const controllers = after[0] === 'cgroup2' ? ['v2'] : (after[2] ?? '').split(',');
    const group = groups.find((g) =>
      after[0] === 'cgroup2' ? g.controllers.join('') === '' : controllers.some((c) => g.controllers.includes(c)),
    );
    if (!group || !root.startsWith('/') || !mount.startsWith('/')) continue;
    // Dot segments can denote an inaccessible ancestor in a cgroup namespace.
    if ([root, mount, group.group].some((p) => p.split('/').includes('..'))) continue;
    let relative: string;
    if (group.group === '/') relative = '';
    else if (root === '/') relative = group.group.slice(1);
    else if (group.group === root) relative = '';
    else if (group.group.startsWith(root + '/')) relative = group.group.slice(root.length + 1);
    else continue;
    const target = path.posix.join(mount, relative);
    if (target !== mount && !target.startsWith(mount + '/')) continue;
    for (const controller of controllers) resolved.set(controller, target);
  }
  if (resolved.has('v2'))
    result.push({ version: 2, cpu: resolved.get('v2')!, memory: resolved.get('v2')!, quota: resolved.get('v2')! });
  if (resolved.has('cpuacct') && resolved.has('memory'))
    result.push({
      version: 1,
      cpu: resolved.get('cpuacct')!,
      memory: resolved.get('memory')!,
      quota: resolved.get('cpu') ?? null,
    });
  return result;
}

async function optional(read: ReadText, file: string): Promise<string | null> {
  try {
    return await read(file);
  } catch {
    return null;
  }
}

export async function createResourceCounterReader(
  options: {
    containerized?: boolean;
    platform?: NodeJS.Platform;
    read?: ReadText;
    processCounters?: () => { cpuMicros: number; memoryBytes: number };
  } = {},
): Promise<ResourceCounterReader> {
  const read = options.read ?? readText;
  if ((options.platform ?? process.platform) === 'linux' && options.containerized) {
    try {
      const locations = resolveCgroupPaths(await read('/proc/self/cgroup'), await read('/proc/self/mountinfo'));
      for (const location of locations) {
        const reader: ResourceCounterReader = {
          source: location.version === 2 ? 'cgroup-v2' : 'cgroup-v1',
          async read() {
            const cpuFile = location.version === 2 ? 'cpu.stat' : 'cpuacct.usage';
            const memoryFile = location.version === 2 ? 'memory.current' : 'memory.usage_in_bytes';
            const [cpuText, memoryText, statText, peakText, quotaText, periodText, limitText] = await Promise.all([
              read(`${location.cpu}/${cpuFile}`),
              read(`${location.memory}/${memoryFile}`),
              optional(read, `${location.memory}/memory.stat`),
              optional(
                read,
                `${location.memory}/${location.version === 2 ? 'memory.peak' : 'memory.max_usage_in_bytes'}`,
              ),
              location.quota
                ? optional(read, `${location.quota}/${location.version === 2 ? 'cpu.max' : 'cpu.cfs_quota_us'}`)
                : null,
              location.version === 1 && location.quota ? optional(read, `${location.quota}/cpu.cfs_period_us`) : null,
              optional(read, `${location.memory}/${location.version === 2 ? 'memory.max' : 'memory.limit_in_bytes'}`),
            ]);
            const cpu =
              location.version === 2
                ? number(fields(cpuText).usage_usec)
                : /^\d+$/.test(cpuText.trim())
                  ? Number(BigInt(cpuText.trim()) / 1000n)
                  : null;
            const memoryBytes = number(memoryText);
            if (cpu === null || !Number.isSafeInteger(cpu) || memoryBytes === null)
              throw Error('Container counters unavailable');
            const stat = statText ? fields(statText) : {};
            const inactive = number(stat[location.version === 2 ? 'inactive_file' : 'total_inactive_file']);
            const quotaParts = quotaText?.trim().split(/\s+/);
            const quota = number(quotaParts?.[0]);
            const period = number(location.version === 2 ? quotaParts?.[1] : periodText ?? undefined);
            const limit = number(limitText ?? undefined);
            return {
              cpuMicros: cpu,
              memoryBytes,
              workingSetBytes: inactive === null ? null : Math.max(0, memoryBytes - inactive),
              lifetimeMemoryPeakBytes: number(peakText ?? undefined),
              cpuLimitMillicores: quota !== null && period ? (quota / period) * 1000 : null,
              // v1's effectively unlimited sentinel can exceed safe integer/physical range.
              memoryLimitBytes: limit !== null && limit < 2 ** 60 ? limit : null,
            };
          },
        };
        try {
          await reader.read();
          return reader;
        } catch {
          /* Try another compatible controller. */
        }
      }
    } catch {
      /* Non-container or unavailable controllers use labelled process measurements. */
    }
  }
  return {
    source: 'node-process',
    async read() {
      const counters =
        options.processCounters?.() ??
        (() => {
          const cpu = process.cpuUsage();
          return { cpuMicros: cpu.user + cpu.system, memoryBytes: process.memoryUsage.rss() };
        })();
      return {
        ...counters,
        workingSetBytes: null,
        lifetimeMemoryPeakBytes: null,
        cpuLimitMillicores: null,
        memoryLimitBytes: null,
      };
    },
  };
}
