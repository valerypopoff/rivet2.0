#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

deployment_managed_workflow_schema_mode="${RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MODE:-}"
deployment_managed_workflow_schema_min_version="${RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION:-}"
deployment_managed_workflow_schema_max_version="${RIVET_DEPLOYMENT_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION:-}"
deployment_health_refresh_seconds="${RIVET_DEPLOYMENT_HEALTH_REFRESH_SECONDS:-}"
deployment_health_check_timeout_seconds="${RIVET_DEPLOYMENT_HEALTH_CHECK_TIMEOUT_SECONDS:-}"
deployment_health_stale_after_seconds="${RIVET_DEPLOYMENT_HEALTH_STALE_AFTER_SECONDS:-}"
deployment_shutdown_grace_seconds="${RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS:-}"
deployment_published_execution_admission_mode="${RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_ADMISSION_MODE:-}"
deployment_published_execution_max_active_runs="${RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS:-}"
deployment_published_execution_retry_after_seconds="${RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS:-}"
deployment_metrics_enabled="${RIVET_DEPLOYMENT_METRICS_ENABLED:-}"
load_optional_dotenv /vault/dotenv
append_proxy_bootstrap_node_options

# Kubernetes sets this deployment-owned policy separately from user/Vault env.
# Apply it after dotenv loading so API replicas remain verify-only even if a
# stale secret contains the public schema mode variable.
if [ -n "$deployment_managed_workflow_schema_mode" ]; then
  export RIVET_MANAGED_WORKFLOW_SCHEMA_MODE="$deployment_managed_workflow_schema_mode"
fi
if [ -n "$deployment_managed_workflow_schema_min_version" ]; then
  export RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION="$deployment_managed_workflow_schema_min_version"
fi
if [ -n "$deployment_managed_workflow_schema_max_version" ]; then
  export RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION="$deployment_managed_workflow_schema_max_version"
fi

apply_deployment_owned_value() {
  target_name="$1"
  value="$2"
  if [ -n "$value" ]; then
    export "$target_name=$value"
  fi
}

apply_deployment_owned_value RIVET_HEALTH_REFRESH_SECONDS "$deployment_health_refresh_seconds"
apply_deployment_owned_value RIVET_HEALTH_CHECK_TIMEOUT_SECONDS "$deployment_health_check_timeout_seconds"
apply_deployment_owned_value RIVET_HEALTH_STALE_AFTER_SECONDS "$deployment_health_stale_after_seconds"
apply_deployment_owned_value RIVET_SHUTDOWN_GRACE_SECONDS "$deployment_shutdown_grace_seconds"
apply_deployment_owned_value RIVET_PUBLISHED_EXECUTION_ADMISSION_MODE "$deployment_published_execution_admission_mode"
apply_deployment_owned_value RIVET_PUBLISHED_EXECUTION_MAX_ACTIVE_RUNS "$deployment_published_execution_max_active_runs"
apply_deployment_owned_value RIVET_PUBLISHED_EXECUTION_RETRY_AFTER_SECONDS "$deployment_published_execution_retry_after_seconds"
apply_deployment_owned_value RIVET_METRICS_ENABLED "$deployment_metrics_enabled"

export PORT="${PORT:-8080}"
export RIVET_WORKSPACE_ROOT="${RIVET_WORKSPACE_ROOT:-/workspace}"
export RIVET_WORKFLOWS_ROOT="${RIVET_WORKFLOWS_ROOT:-/workflows}"
export RIVET_APP_DATA_ROOT="${RIVET_APP_DATA_ROOT:-/data/rivet-app}"
export RIVET_RUNTIME_LIBRARIES_ROOT="${RIVET_RUNTIME_LIBRARIES_ROOT:-/data/runtime-libraries}"
export RIVET_RUNTIME_PROCESS_ROLE="${RIVET_RUNTIME_PROCESS_ROLE:-api}"

exec node /app/packages/studio-server-api/dist/studio-server-api/src/server.js
