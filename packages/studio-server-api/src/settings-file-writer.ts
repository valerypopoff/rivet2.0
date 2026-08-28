import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map<string, Promise<void>>();

function createSettingsTempPath(settingsPath: string): string {
  return `${settingsPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

async function writeJsonSettingsFileNow(settingsPath: string, value: unknown, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });

  const tempPath = createSettingsTempPath(settingsPath);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode,
    });
    await fs.rename(tempPath, settingsPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writeJsonSettingsFile(settingsPath: string, value: unknown, mode = 0o600): Promise<void> {
  const queueKey = path.resolve(settingsPath);
  const previousWrite = writeQueues.get(queueKey) ?? Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(() => writeJsonSettingsFileNow(settingsPath, value, mode));

  writeQueues.set(queueKey, nextWrite);
  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(queueKey) === nextWrite) {
      writeQueues.delete(queueKey);
    }
  }
}

export async function writePrivateJsonSettingsFile(settingsPath: string, value: unknown): Promise<void> {
  await writeJsonSettingsFile(settingsPath, value, 0o600);
}
