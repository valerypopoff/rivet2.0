import { existsSync } from 'node:fs';

// Native Git OpenSSL avoids MSYS named-object startup failures on Windows.
// Retain the old location for Git installations without a native executable.
const native = 'C:/Program Files/Git/mingw64/bin/openssl.exe';
export const testOpenSsl =
  process.platform === 'win32' ? (existsSync(native) ? native : 'C:/Program Files/Git/usr/bin/openssl.exe') : 'openssl';
