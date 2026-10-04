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
    if [ "$deployment_topology" = "single-host" ]; then
      export RIVET_DEPLOYMENT_TOPOLOGY=single-host
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
  deployment_app_data_root="${RIVET_APP_DATA_ROOT:-}"

  load_optional_dotenv "$@"

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
  export RIVET_APP_DATA_ROOT="$deployment_app_data_root"

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
