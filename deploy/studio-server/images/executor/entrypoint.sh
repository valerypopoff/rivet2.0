#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

load_optional_dotenv /vault/dotenv
append_proxy_bootstrap_node_options

export RIVET_EXECUTOR_PORT="${RIVET_EXECUTOR_PORT:-21889}"
export RIVET_EXECUTOR_HOST="${RIVET_EXECUTOR_HOST:-0.0.0.0}"
export HOME="${HOME:-/home/rivet}"
export RIVET_RUNTIME_LIBRARIES_ROOT="${RIVET_RUNTIME_LIBRARIES_ROOT:-/data/runtime-libraries}"
export RIVET_RUNTIME_PROCESS_ROLE="${RIVET_RUNTIME_PROCESS_ROLE:-executor}"
export RIVET_CODE_RUNNER_REQUIRE_ROOT="${RIVET_CODE_RUNNER_REQUIRE_ROOT:-${RIVET_RUNTIME_LIBRARIES_ROOT}/current/node_modules}"

exec node /app/executor-bundle.cjs --host "${RIVET_EXECUTOR_HOST}" --port "${RIVET_EXECUTOR_PORT}"
