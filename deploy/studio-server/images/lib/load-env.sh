#!/bin/sh
set -eu

load_optional_dotenv() {
  dotenv_path="${1:-/vault/dotenv}"
  dotenv_file_name="${RIVET_VAULT_DOTENV_FILE_NAME:-dotenv}"

  if [ ! -f "$dotenv_path" ] && [ -f "/vault/secrets/${dotenv_file_name}" ]; then
    dotenv_path="/vault/secrets/${dotenv_file_name}"
  fi

  if [ ! -f "$dotenv_path" ]; then
    return
  fi

  set -a
  # shellcheck disable=SC1090
  . "$dotenv_path"
  set +a
}

load_optional_dotenv_preserving_deployment_storage() {
  # Preserve only an explicitly mounted export root. Standalone dotenv remains
  # configurable, and older deployments without this mount keep their fallback.
  deployment_bundle_scratch_root="${RIVET_PROJECT_BUNDLE_SCRATCH_ROOT:-}"
  retirement_protocol="${RIVET_ROLLING_RETIREMENT_PROTOCOL:-}"
  retirement_token="${RIVET_ROLLING_RETIREMENT_TOKEN:-}"
  retirement_incarnation="${RIVET_PROCESS_INCARNATION:-}"
  ha_protocol="${RIVET_HA_PROTOCOL:-}"
  ha_pod_name="${RIVET_POD_NAME:-}"
  ha_headless_service="${RIVET_HA_HEADLESS_SERVICE:-}"
  ha_backend_name="${RIVET_HA_BACKEND_NAME:-}"
  ha_api_port="${RIVET_BACKEND_API_PORT:-}"
  ha_executor_port="${RIVET_BACKEND_EXECUTOR_PORT:-}"
  ha_deployment="${RIVET_HA_DEPLOYMENT:-}"
  ha_maintenance="${RIVET_HA_MAINTENANCE:-}"
  ha_api_only="${RIVET_HA_API_ONLY:-}"
  ha_peer_limit="${RIVET_HA_PEER_LIMIT:-}"
  ha_maintenance_url="${RIVET_HA_MAINTENANCE_URL:-}"
  if [ "${RIVET_DEPLOYMENT_TOPOLOGY:-}" != "replicated" ]; then
    deployment_topology="${RIVET_DEPLOYMENT_TOPOLOGY:-}"
    # The combined supervisor owns this selection and private capability. A
    # stale dotenv cannot override an already selected UI-managed generation.
    preserve_local_selection="${RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE:-${RIVET_LOCAL_METADATA_SUPERVISED:-}}"
    local_control_root="${RIVET_LOCAL_METADATA_CONTROL_ROOT:-}"
    local_encryption_key="${RIVET_LOCAL_METADATA_ENCRYPTION_KEY:-}"
    local_upgrade_enabled="${RIVET_LOCAL_METADATA_UPGRADE_ENABLED:-}"
    local_supervised="${RIVET_LOCAL_METADATA_SUPERVISED:-}"
    local_boot_generation="${RIVET_LOCAL_METADATA_BOOT_GENERATION:-}"
    local_boot_revision="${RIVET_LOCAL_METADATA_BOOT_REVISION:-}"
    local_supervisor_token="${RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN:-}"
    local_prepare_available="${RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE:-}"
    local_restart_available="${RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE:-}"
    load_optional_dotenv "$@"
    export RIVET_ROLLING_RETIREMENT_PROTOCOL="$retirement_protocol"
    export RIVET_ROLLING_RETIREMENT_TOKEN="$retirement_token"
    export RIVET_PROCESS_INCARNATION="$retirement_incarnation"
    export RIVET_HA_PROTOCOL="$ha_protocol"
    export RIVET_POD_NAME="$ha_pod_name"
    export RIVET_HA_HEADLESS_SERVICE="$ha_headless_service"
    export RIVET_HA_BACKEND_NAME="$ha_backend_name"
    export RIVET_BACKEND_API_PORT="$ha_api_port"
    export RIVET_BACKEND_EXECUTOR_PORT="$ha_executor_port"
    export RIVET_HA_DEPLOYMENT="$ha_deployment" RIVET_HA_MAINTENANCE="$ha_maintenance" RIVET_HA_API_ONLY="$ha_api_only"
    export RIVET_HA_PEER_LIMIT="$ha_peer_limit" RIVET_HA_MAINTENANCE_URL="$ha_maintenance_url"
    if [ "$deployment_topology" = "single-host" ]; then
      export RIVET_DEPLOYMENT_TOPOLOGY=single-host
      if [ -n "$deployment_bundle_scratch_root" ]; then
        export RIVET_PROJECT_BUNDLE_SCRATCH_ROOT="$deployment_bundle_scratch_root"
      fi
      if [ "$preserve_local_selection" = "1" ]; then
        export RIVET_LOCAL_METADATA_CONTROL_ROOT="$local_control_root"
        export RIVET_LOCAL_METADATA_ENCRYPTION_KEY="$local_encryption_key"
        export RIVET_LOCAL_METADATA_UPGRADE_ENABLED="$local_upgrade_enabled"
        export RIVET_LOCAL_METADATA_SUPERVISED="$local_supervised"
        export RIVET_LOCAL_METADATA_BOOT_GENERATION="$local_boot_generation"
        export RIVET_LOCAL_METADATA_BOOT_REVISION="$local_boot_revision"
        export RIVET_LOCAL_METADATA_SUPERVISOR_TOKEN="$local_supervisor_token"
        export RIVET_LOCAL_METADATA_UI_PREPARE_AVAILABLE="$local_prepare_available"
        export RIVET_LOCAL_METADATA_UI_RESTART_AVAILABLE="$local_restart_available"
      fi
      set_bounded_scratch_env
    fi
    return
  fi

  # Helm owns these values. Vault supplies credentials, but a stale dotenv
  # must not redirect workflow objects or PostgreSQL, change the pool budget,
  # or disable managed storage.
  deployment_storage_mode="${RIVET_DEPLOYMENT_STORAGE_MODE:-}"
  deployment_database_mode="${RIVET_DEPLOYMENT_DATABASE_MODE:-}"
  deployment_database_ssl_mode="${RIVET_DEPLOYMENT_DATABASE_SSL_MODE:-}"
  deployment_database_pool_max="${RIVET_DEPLOYMENT_DATABASE_POOL_MAX:-}"
  deployment_database_connection_string="${RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING:-}"
  deployment_database_host="${RIVET_DEPLOYMENT_DATABASE_HOST:-}"
  deployment_database_port="${RIVET_DEPLOYMENT_DATABASE_PORT:-}"
  deployment_database_name="${RIVET_DEPLOYMENT_DATABASE_NAME:-}"
  deployment_database_username="${RIVET_DEPLOYMENT_DATABASE_USERNAME:-}"
  deployment_storage_bucket="${RIVET_DEPLOYMENT_STORAGE_BUCKET:-}"
  deployment_storage_region="${RIVET_DEPLOYMENT_STORAGE_REGION:-}"
  deployment_storage_endpoint="${RIVET_DEPLOYMENT_STORAGE_ENDPOINT:-}"
  deployment_storage_prefix="${RIVET_DEPLOYMENT_STORAGE_PREFIX:-}"
  deployment_storage_force_path_style="${RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE:-}"
  deployment_app_settings_backend="${RIVET_APP_SETTINGS_BACKEND:-}"
  deployment_app_settings_database_url="${RIVET_APP_SETTINGS_DATABASE_URL:-}"
  deployment_app_data_root="${RIVET_APP_DATA_ROOT:-}"
  deployment_release_maintenance="${RIVET_RELEASE_MAINTENANCE:-}"
  deployment_schema_migration_release="${RIVET_SCHEMA_MIGRATION_RELEASE:-}"
  deployment_managed_maintenance_enabled="${RIVET_MANAGED_MAINTENANCE_ENABLED:-}"
  deployment_restore_enabled="${RIVET_LEGACY_RESTORE_ENABLED:-}"
  deployment_restore_root="${RIVET_LEGACY_RESTORE_ROOT:-}"
  deployment_restore_token="${RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN:-}"
  deployment_restore_installation="${RIVET_LEGACY_RESTORE_INSTALLATION:-}"
  deployment_restore_execution_ready="${RIVET_LEGACY_RESTORE_EXECUTION_READY_URL:-}"
  deployment_restore_evaluation_ready="${RIVET_LEGACY_RESTORE_EVALUATION_READY_URL:-}"

  load_optional_dotenv "$@"

  export RIVET_ROLLING_RETIREMENT_PROTOCOL="$retirement_protocol"
  export RIVET_ROLLING_RETIREMENT_TOKEN="$retirement_token"
  export RIVET_PROCESS_INCARNATION="$retirement_incarnation"
  export RIVET_HA_PROTOCOL="$ha_protocol"
  export RIVET_POD_NAME="$ha_pod_name"
  export RIVET_HA_HEADLESS_SERVICE="$ha_headless_service"
  export RIVET_HA_BACKEND_NAME="$ha_backend_name"
  export RIVET_BACKEND_API_PORT="$ha_api_port"
  export RIVET_BACKEND_EXECUTOR_PORT="$ha_executor_port"
  export RIVET_HA_DEPLOYMENT="$ha_deployment" RIVET_HA_MAINTENANCE="$ha_maintenance" RIVET_HA_API_ONLY="$ha_api_only"
  export RIVET_HA_PEER_LIMIT="$ha_peer_limit" RIVET_HA_MAINTENANCE_URL="$ha_maintenance_url"

  export RIVET_DEPLOYMENT_TOPOLOGY=replicated
  export RIVET_DEPLOYMENT_STORAGE_MODE="$deployment_storage_mode"
  export RIVET_DEPLOYMENT_DATABASE_MODE="$deployment_database_mode"
  export RIVET_DEPLOYMENT_DATABASE_SSL_MODE="$deployment_database_ssl_mode"
  export RIVET_DEPLOYMENT_DATABASE_POOL_MAX="$deployment_database_pool_max"
  export RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING="$deployment_database_connection_string"
  export RIVET_DEPLOYMENT_DATABASE_HOST="$deployment_database_host"
  export RIVET_DEPLOYMENT_DATABASE_PORT="$deployment_database_port"
  export RIVET_DEPLOYMENT_DATABASE_NAME="$deployment_database_name"
  export RIVET_DEPLOYMENT_DATABASE_USERNAME="$deployment_database_username"
  export RIVET_DEPLOYMENT_STORAGE_BUCKET="$deployment_storage_bucket"
  export RIVET_DEPLOYMENT_STORAGE_REGION="$deployment_storage_region"
  export RIVET_DEPLOYMENT_STORAGE_ENDPOINT="$deployment_storage_endpoint"
  export RIVET_DEPLOYMENT_STORAGE_PREFIX="$deployment_storage_prefix"
  export RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE="$deployment_storage_force_path_style"
  export RIVET_APP_SETTINGS_BACKEND="$deployment_app_settings_backend"
  if [ -n "$deployment_app_settings_database_url" ]; then
    export RIVET_APP_SETTINGS_DATABASE_URL="$deployment_app_settings_database_url"
  fi
  export RIVET_APP_DATA_ROOT="$deployment_app_data_root"
  export RIVET_LEGACY_RESTORE_ENABLED="$deployment_restore_enabled"
  export RIVET_LEGACY_RESTORE_ROOT="$deployment_restore_root"
  export RIVET_LEGACY_RESTORE_SUPERVISOR_TOKEN="$deployment_restore_token"
  export RIVET_LEGACY_RESTORE_INSTALLATION="$deployment_restore_installation"
  export RIVET_LEGACY_RESTORE_EXECUTION_READY_URL="$deployment_restore_execution_ready"
  export RIVET_LEGACY_RESTORE_EVALUATION_READY_URL="$deployment_restore_evaluation_ready"
  # Release admission and reader ownership cannot be changed by stale Vault env.
  if [ -n "$deployment_release_maintenance" ]; then
    export RIVET_RELEASE_MAINTENANCE="$deployment_release_maintenance"
  fi
  if [ -n "$deployment_schema_migration_release" ]; then
    export RIVET_SCHEMA_MIGRATION_RELEASE="$deployment_schema_migration_release"
  fi
  if [ -n "$deployment_managed_maintenance_enabled" ]; then
    export RIVET_MANAGED_MAINTENANCE_ENABLED="$deployment_managed_maintenance_enabled"
  fi
  if [ -n "$deployment_bundle_scratch_root" ]; then
    export RIVET_PROJECT_BUNDLE_SCRATCH_ROOT="$deployment_bundle_scratch_root"
  fi

  set_bounded_scratch_env
}

set_bounded_scratch_env() {
  # Compose and Helm own these scratch mounts. Dotenv values must not redirect
  # temporary files to the writable image layer or a durable app-data volume.
  # npm prefers the uppercase cache variable over npm_config_cache.
  export TMPDIR=/tmp
  export npm_config_cache=/tmp/npm-cache
  export XDG_CACHE_HOME=/tmp/cache
  unset NPM_CONFIG_CACHE
}

append_proxy_bootstrap_node_options() {
  bootstrap_flag="--import=/app/packages/studio-server-bootstrap/bootstrap.mjs"

  case " ${NODE_OPTIONS:-} " in
    *" ${bootstrap_flag} "*) ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${bootstrap_flag}"
      ;;
  esac
}
