import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type ManagedSettingsEncryptionKey = {
  id: string;
  value: Buffer;
};

export type ManagedSettingsCiphertext = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
};

export type ManagedSettingsCipherContext = {
  key: string;
  schemaVersion: number;
};

function createCipherAdditionalData(context: ManagedSettingsCipherContext): Buffer {
  return Buffer.from(JSON.stringify([
    'rivet-app-settings',
    1,
    context.key,
    context.schemaVersion,
  ]), 'utf8');
}

export function deriveManagedSettingsEncryptionKey(secret: string): ManagedSettingsEncryptionKey {
  const value = createHash('sha256').update(secret).digest();
  return {
    id: createHash('sha256').update(value).digest('hex').slice(0, 16),
    value,
  };
}

export function encryptManagedSettingsValue(
  context: ManagedSettingsCipherContext,
  value: Record<string, unknown>,
  key: ManagedSettingsEncryptionKey,
): ManagedSettingsCiphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.value, iv);
  cipher.setAAD(createCipherAdditionalData(context));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyId: key.id };
}

export function decryptManagedSettingsValue(
  context: ManagedSettingsCipherContext,
  encrypted: ManagedSettingsCiphertext,
  keys: ReadonlyMap<string, ManagedSettingsEncryptionKey>,
): Record<string, unknown> {
  const key = keys.get(encrypted.keyId);
  if (!key) {
    throw new Error(
      `App setting "${context.key}" was encrypted with unavailable key ${encrypted.keyId}. ` +
      'Restore the previous app-settings encryption key before starting this deployment.',
    );
  }

  const decipher = createDecipheriv('aes-256-gcm', key.value, encrypted.iv);
  decipher.setAAD(createCipherAdditionalData(context));
  decipher.setAuthTag(encrypted.authTag);
  const parsed = JSON.parse(Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`Decrypted app setting "${context.key}" is not an object.`);
  }
  return parsed as Record<string, unknown>;
}