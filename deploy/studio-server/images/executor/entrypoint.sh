#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

deployment_executor_runtime_config_url="${RIVET_EXECUTOR_RUNTIME_CONFIG_URL:-}"
deployment_executor_port="${RIVET_EXECUTOR_PORT:-}"
deployment_executor_host="${RIVET_EXECUTOR_HOST:-}"
deployment_runtime_libraries_replica_tier="${RIVET_RUNTIME_LIBRARIES_REPLICA_TIER:-}"
deployment_llm_profile_health_api_url="${RIVET_LLM_PROFILE_HEALTH_API_URL:-}"
deployment_execution_environment_api_url="${RIVET_EXECUTION_ENVIRONMENT_API_URL:-}"
load_optional_dotenv_preserving_deployment_storage /vault/dotenv
if [ -n "$deployment_executor_runtime_config_url" ]; then
  export RIVET_EXECUTOR_RUNTIME_CONFIG_URL="$deployment_executor_runtime_config_url"
fi
if [ -n "$deployment_executor_port" ]; then
  export RIVET_EXECUTOR_PORT="$deployment_executor_port"
fi
if [ -n "$deployment_executor_host" ]; then
  export RIVET_EXECUTOR_HOST="$deployment_executor_host"
fi
if [ -n "$deployment_runtime_libraries_replica_tier" ]; then
  export RIVET_RUNTIME_LIBRARIES_REPLICA_TIER="$deployment_runtime_libraries_replica_tier"
fi
if [ -n "$deployment_llm_profile_health_api_url" ]; then
  export RIVET_LLM_PROFILE_HEALTH_API_URL="$deployment_llm_profile_health_api_url"
fi
if [ -n "$deployment_execution_environment_api_url" ]; then
  export RIVET_EXECUTION_ENVIRONMENT_API_URL="$deployment_execution_environment_api_url"
fi
append_proxy_bootstrap_node_options

export RIVET_EXECUTOR_PORT="${RIVET_EXECUTOR_PORT:-21889}"
export RIVET_EXECUTOR_HOST="${RIVET_EXECUTOR_HOST:-0.0.0.0}"
export HOME="${HOME:-/home/rivet}"
export RIVET_RUNTIME_LIBRARIES_ROOT="${RIVET_RUNTIME_LIBRARIES_ROOT:-/data/runtime-libraries}"
export RIVET_RUNTIME_PROCESS_ROLE=executor
export RIVET_CODE_RUNNER_REQUIRE_ROOT="${RIVET_CODE_RUNNER_REQUIRE_ROOT:-${RIVET_RUNTIME_LIBRARIES_ROOT}/current/node_modules}"

exec node /app/executor-bundle.cjs --host "${RIVET_EXECUTOR_HOST}" --port "${RIVET_EXECUTOR_PORT}"
