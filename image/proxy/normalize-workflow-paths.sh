#!/bin/sh

normalize_path() {
  value="$1"
  fallback="$2"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -z "$trimmed" ]; then
    trimmed="$fallback"
  fi

  case "$trimmed" in
    /*) ;;
    *) trimmed="/$trimmed" ;;
  esac

  normalized=$(printf '%s' "$trimmed" | sed 's:/*$::')

  if [ -z "$normalized" ]; then
    normalized="$fallback"
  fi

  printf '%s' "$normalized"
}

normalize_bool() {
  value="$1"
  fallback="${2:-0}"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]' '[:lower:]')

  if [ -z "$trimmed" ]; then
    printf '%s' "$fallback"
    return
  fi

  case "$trimmed" in
    1|true|yes|on) printf '1' ;;
    0|false|no|off) printf '0' ;;
    *) printf '%s' "$fallback" ;;
  esac
}

has_nonempty_value() {
  value="$1"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -n "$trimmed" ]; then
    printf '1'
  else
    printf '0'
  fi
}

append_space_separated() {
  list="$1"
  value="$2"

  if [ -z "$value" ]; then
    printf '%s' "$list"
    return
  fi

  if [ -z "$list" ]; then
    printf '%s' "$value"
  else
    printf '%s %s' "$list" "$value"
  fi
}

stage_ui_gate_prompt() {
  destination_dir="/tmp/nginx/html"
  destination="$destination_dir/ui-gate-prompt.html"
  source="${RIVET_UI_GATE_PROMPT_SOURCE:-}"

  if [ -z "$source" ]; then
    for candidate in /tmp/ui-gate-prompt.html /usr/share/nginx/html/ui-gate-prompt.html; do
      if [ -f "$candidate" ]; then
        source="$candidate"
        break
      fi
    done
  fi

  if [ -z "$source" ] || [ ! -f "$source" ]; then
    >&2 printf 'Error: could not find ui-gate-prompt.html for nginx UI gate.\n'
    exit 1
  fi

  if ! mkdir -p "$destination_dir"; then
    >&2 printf 'Error: could not create nginx UI gate directory "%s".\n' "$destination_dir"
    exit 1
  fi

  if ! cp "$source" "$destination"; then
    >&2 printf 'Error: could not stage ui-gate-prompt.html from "%s" to "%s".\n' "$source" "$destination"
    exit 1
  fi
}

resolve_proxy_resolver() {
  value="$1"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -z "$trimmed" ]; then
    printf '%s' "$trimmed"
    return
  fi

  old_ifs=$IFS
  IFS=' ,'
  set -- $trimmed
  IFS=$old_ifs

  resolved=''

  for resolver in "$@"; do
    resolver_trimmed=$(printf '%s' "${resolver}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$resolver_trimmed" ]; then
      continue
    fi

    case "$resolver_trimmed" in
      *[!0-9A-Fa-f:.]*)
        resolver_ips=''

        if command -v getent >/dev/null 2>&1; then
          resolver_ips=$(getent hosts "$resolver_trimmed" 2>/dev/null | awk '{print $1}' | awk '!seen[$0]++')
        fi

        if [ -z "$resolver_ips" ] && command -v nslookup >/dev/null 2>&1; then
          resolver_ips=$(nslookup "$resolver_trimmed" 2>/dev/null | awk '/^Address: / {print $2}' | awk '!seen[$0]++')
        fi

        if [ -n "$resolver_ips" ]; then
          for resolver_ip in $resolver_ips; do
            resolved=$(append_space_separated "$resolved" "$resolver_ip")
          done
        else
          >&2 printf 'Warning: could not resolve RIVET_PROXY_RESOLVER entry "%s"; leaving it unchanged.\n' "$resolver_trimmed"
          resolved=$(append_space_separated "$resolved" "$resolver_trimmed")
        fi
        ;;
      *)
        resolved=$(append_space_separated "$resolved" "$resolver_trimmed")
        ;;
    esac
  done

  printf '%s' "$resolved"
}

sha256_hex() {
  value="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$value" | sha256sum | awk '{print $1}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    printf '%s' "$value" | openssl dgst -sha256 -binary | od -An -vtx1 | tr -d ' \n'
    return
  fi

  printf ''
}

build_host_regex() {
  value="$1"
  api_key="${2:-}"
  trimmed=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  trimmed_api_key=$(printf '%s' "${api_key}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  if [ -z "$trimmed" ] || [ -z "$trimmed_api_key" ]; then
    printf 'a^'
    return
  fi

  old_ifs=$IFS
  IFS=','
  set -- $trimmed
  IFS=$old_ifs

  pattern=''
  for host in "$@"; do
    host_trimmed=$(printf '%s' "${host}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$host_trimmed" ]; then
      continue
    fi

    escaped_host=$(printf '%s' "${host_trimmed}" | sed 's/[][(){}.^$+*?|\\-]/\\&/g')
    if [ -z "$pattern" ]; then
      pattern="$escaped_host"
    else
      pattern="${pattern}|${escaped_host}"
    fi
  done

  if [ -z "$pattern" ]; then
    printf 'a^'
    return
  fi

  printf '^(%s)$' "$pattern"
}

export RIVET_PUBLISHED_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-}" "/workflows")"
export RIVET_LATEST_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_LATEST_WORKFLOWS_BASE_PATH:-}" "/workflows-latest")"
export RIVET_WEB_APPS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_APPS_BASE_PATH:-${RIVET_WEB_APPS_BASE_PATH:-}}" "/apps")"
export RIVET_LATEST_WEB_APPS_BASE_PATH="$(normalize_path "${RIVET_LATEST_APPS_BASE_PATH:-${RIVET_LATEST_WEB_APPS_BASE_PATH:-}}" "/apps-latest")"
export RIVET_PUBLISHED_APPS_BASE_PATH="$RIVET_WEB_APPS_BASE_PATH"
export RIVET_LATEST_APPS_BASE_PATH="$RIVET_LATEST_WEB_APPS_BASE_PATH"
export RIVET_REQUIRE_UI_GATE_KEY="$(normalize_bool "${RIVET_REQUIRE_UI_GATE_KEY:-}" "0")"
export RIVET_UI_GATE_KEY_PRESENT="$(has_nonempty_value "${RIVET_KEY:-}")"
export RIVET_UI_TOKEN_FREE_HOSTS_REGEX="$(build_host_regex "${RIVET_UI_TOKEN_FREE_HOSTS:-}" "${RIVET_KEY:-}")"
export RIVET_PROXY_RESOLVER="$(resolve_proxy_resolver "${RIVET_PROXY_RESOLVER:-}")"
export RIVET_PROXY_AUTH_TOKEN="$(sha256_hex "${RIVET_KEY:-}:proxy-auth")"
export RIVET_UI_SESSION_TOKEN="$(sha256_hex "${RIVET_KEY:-}:ui-session")"

stage_ui_gate_prompt

exec /docker-entrypoint.sh nginx -g 'daemon off;'
