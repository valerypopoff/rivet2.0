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

append_proxy_bootstrap_node_options() {
  bootstrap_flag="--import=/app/packages/studio-server-bootstrap/bootstrap.mjs"

  case " ${NODE_OPTIONS:-} " in
    *" ${bootstrap_flag} "*) ;;
    *)
      export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${bootstrap_flag}"
      ;;
  esac
}
