import fs from 'node:fs/promises';

export const HA_WORKSPACE_MIN_FREE_BYTES = 20 * 1024 ** 3;

export async function assertHaWorkspaceSpace(workspace, { statfs = fs.statfs } = {}) {
  const disk = await statfs(workspace);
  const available = disk.bavail * disk.bsize;
  if (!Number.isSafeInteger(available) || available < HA_WORKSPACE_MIN_FREE_BYTES)
    throw Error(
      `HA rehearsal requires at least 20 GiB free on the workspace drive before any cluster mutation; ${(available / 1024 ** 3).toFixed(1)} GiB available.`,
    );
  return available;
}
