import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';

/** Observe fixture reads through both named and default Node filesystem exports. */
export function observeFileReads(t: TestContext): unknown[] {
  const readFile = fs.readFile;
  const reads: unknown[] = [];
  const spy = t.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
    reads.push(args[0]);
    return Reflect.apply(readFile, fs, args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  return reads;
}
