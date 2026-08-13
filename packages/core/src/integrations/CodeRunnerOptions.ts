/**
 * The complete capability request used by Code, Code (legacy), and Expression.
 *
 * This deliberately lives apart from the runner implementation: built-in node
 * registration reads this constant during package initialization, while the
 * runner exposes the public `Rivet` namespace at execution time.
 */
export interface CodeRunnerOptions {
  includeRequire: boolean;
  includeFetch: boolean;
  includeRivet: boolean;
  includeProcess: boolean;
  includeConsole: boolean;
}

export const ALL_CODE_RUNNER_OPTIONS: CodeRunnerOptions = Object.freeze({
  includeRequire: true,
  includeFetch: true,
  includeRivet: true,
  includeProcess: true,
  includeConsole: true,
});
