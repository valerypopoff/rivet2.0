const processShim = {
  env: {},
  browser: true,
  versions: {},
  cwd: () => '/',
  emitWarning: (...args: unknown[]) => {
    console.warn(...args);
  },
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
    queueMicrotask(() => callback(...args));
  },
  on: () => processShim,
  off: () => processShim,
  once: () => processShim,
  removeListener: () => processShim,
  stdout: {
    fd: 1,
    isTTY: false,
    write: (...args: unknown[]) => {
      console.log(...args);
      return true;
    },
  },
  stderr: {
    fd: 2,
    isTTY: false,
    write: (...args: unknown[]) => {
      console.warn(...args);
      return true;
    },
  },
};

const globalScope = globalThis as typeof globalThis & {
  global?: typeof globalThis;
  process?: unknown;
};

if (!('global' in globalScope)) {
  globalScope.global = globalThis;
}

if (!('process' in globalScope)) {
  globalScope.process = processShim;
}

export {};
