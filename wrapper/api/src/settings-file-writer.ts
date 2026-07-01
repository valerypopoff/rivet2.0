import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const writeQueues = new Map<string, Promise<void>>();

function createSettingsTempPath(settingsPath: string): string {
  return `${settingsPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
}

async function writePrivateJsonSettingsFileNow(settingsPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });

  const tempPath = createSettingsTempPath(settingsPath);
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, settingsPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function writePrivateJsonSettingsFile(settingsPath: string, value: unknown): Promise<void> {
  const queueKey = path.resolve(settingsPath);
  const previousWrite = writeQueues.get(queueKey) ?? Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(() => writePrivateJsonSettingsFileNow(settingsPath, value));

  writeQueues.set(queueKey, nextWrite);
  try {
    await nextWrite;
  } finally {
    if (writeQueues.get(queueKey) === nextWrite) {
      writeQueues.delete(queueKey);
    }
  }
}
