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
    load_optional_dotenv "$@"
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
