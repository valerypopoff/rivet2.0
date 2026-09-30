type ExecutorEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveHostedExecutorApiUrls(env: ExecutorEnvironment): {
  healthServiceUrl: string;
  executionEnvironmentServiceUrl: string;
} {
  if (env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated') {
    const runtimeConfigUrl = env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL?.trim();
    let config: URL;
    try {
      config = new URL(runtimeConfigUrl ?? '');
    } catch {
      throw new Error('The managed executor requires a valid loopback runtime configuration URL.');
    }
    if (
      config.protocol !== 'http:' ||
      config.hostname !== '127.0.0.1' ||
      config.username ||
      config.password ||
      config.pathname !== '/internal/executor-runtime-config' ||
      config.search ||
      config.hash
    ) {
      throw new Error('The managed executor requires a valid loopback runtime configuration URL.');
    }
    return {
      healthServiceUrl: new URL('/api/workflows/llm-profile-health', config.origin).href,
      executionEnvironmentServiceUrl: new URL('/api/workflows/execution-environment', config.origin).href,
    };
  }

  return {
    healthServiceUrl:
      env.RIVET_LLM_PROFILE_HEALTH_API_URL?.trim() || 'http://127.0.0.1:3100/api/workflows/llm-profile-health',
    executionEnvironmentServiceUrl:
      env.RIVET_EXECUTION_ENVIRONMENT_API_URL?.trim() || 'http://api:80/api/workflows/execution-environment',
  };
}
