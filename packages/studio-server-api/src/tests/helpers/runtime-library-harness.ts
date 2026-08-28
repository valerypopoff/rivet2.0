export async function withScopedEnv<T extends string>(
  keys: readonly T[],
  overrides: Partial<Record<T, string | undefined>>,
  run: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>();

  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, rawValue] of Object.entries(overrides) as Array<[T, string | undefined]>) {
    const value = rawValue;
    if (value != null) {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function withArgv(argv: string[], run: () => Promise<void> | void) {
  const previous = process.argv;
  process.argv = argv;

  try {
    await run();
  } finally {
    process.argv = previous;
  }
}
