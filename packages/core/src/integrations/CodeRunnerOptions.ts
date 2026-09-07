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
  /**
   * The collision-safe name of the narrow interpolation resolver injected for
   * generated Code-family wrappers. Runners only add the resolver when this
   * is present, so ordinary authored code keeps its established argument
   * shape and capability cost. A runner that accepts this option must inject
   * a resolver compatible with `resolveCodeInterpolationExpression`; paths
   * and @graphInputs/@context references depend on that contract.
   */
  interpolationHelperIdentifier?: string;
}

export const ALL_CODE_RUNNER_OPTIONS: CodeRunnerOptions = Object.freeze({
  includeRequire: true,
  includeFetch: true,
  includeRivet: true,
  includeProcess: true,
  includeConsole: true,
});
