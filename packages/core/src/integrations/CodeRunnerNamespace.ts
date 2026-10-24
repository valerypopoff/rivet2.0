import type * as PublicNamespace from '../exports.js';

/** Installed by the public package entrypoint, not by the execution engine. */
export type CodeRunnerNamespace = typeof PublicNamespace;

let namespace: CodeRunnerNamespace | undefined;

export function installCodeRunnerNamespace(value: CodeRunnerNamespace): void {
  namespace = value;
}

export function getCodeRunnerNamespace(): CodeRunnerNamespace {
  if (!namespace) {
    throw new Error(
      'The Rivet code namespace is unavailable. Import the public core entrypoint or supply a code runner.',
    );
  }
  return namespace;
}
