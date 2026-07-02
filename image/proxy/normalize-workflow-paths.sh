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

read_json_string_property() {
  file_path="$1"
  property_name="$2"

  if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    printf ''
    return
  fi

  sed -n "s/.*\"${property_name}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file_path" | head -n 1
}

has_json_property() {
  file_path="$1"
  property_name="$2"

  if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    return 1
  fi

  grep -q "\"${property_name}\"[[:space:]]*:" "$file_path"
}

read_json_scalar_property() {
  file_path="$1"
  property_name="$2"

  if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
    printf ''
    return
  fi

  sed -n "s/.*\"${property_name}\"[[:space:]]*:[[:space:]]*\\([^,}]*\\).*/\\1/p" "$file_path" | head -n 1 | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

normalize_positive_integer_seconds() {
  value="$1"

  case "$value" in
    ''|0|*[!0123456789]*)
      return 1
      ;;
  esac

  printf '%s' "$value"
}

set_default_runtime_limits() {
  RIVET_PROXY_READ_TIMEOUT="180s"
}

read_runtime_limit_settings() {
  RIVET_RUNTIME_LIMIT_SETTINGS_VALID=1
  set_default_runtime_limits

  runtime_limit_settings_file="${RIVET_APP_DATA_ROOT:-/data/rivet-app}/settings/runtime-limits.json"
  if [ ! -f "$runtime_limit_settings_file" ]; then
    return
  fi

  raw_proxy_read_timeout_seconds="$(read_json_scalar_property "$runtime_limit_settings_file" "proxyReadTimeoutSeconds")"
  if has_json_property "$runtime_limit_settings_file" "proxyReadTimeoutSeconds" && [ -z "$raw_proxy_read_timeout_seconds" ]; then
    >&2 printf 'Warning: invalid runtime limit settings file "%s"; keeping previous nginx public routes.\n' "$runtime_limit_settings_file"
    RIVET_RUNTIME_LIMIT_SETTINGS_VALID=0
    return
  fi

  if [ -n "$raw_proxy_read_timeout_seconds" ]; then
    if ! proxy_read_timeout_seconds="$(normalize_positive_integer_seconds "$raw_proxy_read_timeout_seconds")"; then
      >&2 printf 'Warning: invalid proxyReadTimeoutSeconds in "%s"; keeping previous nginx public routes.\n' "$runtime_limit_settings_file"
      RIVET_RUNTIME_LIMIT_SETTINGS_VALID=0
      return
    fi

    RIVET_PROXY_READ_TIMEOUT="${proxy_read_timeout_seconds}s"
  fi
}

normalize_public_route_setting() {
  value="$1"
  slug=$(printf '%s' "${value}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s:^/*::; s:/*$::' | tr '[:upper:]' '[:lower:]')

  if [ -z "$slug" ] || [ "${#slug}" -gt 64 ]; then
    return 1
  fi

  case "$slug" in
    */*|-*|*-|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*)
      return 1
      ;;
    __rivet_auth|api|assets|internal|node_modules|ui-auth|ws)
      return 1
      ;;
  esac

  printf '/%s' "$slug"
}

set_default_public_routes() {
  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH:-}" "/workflows")"
  RIVET_LATEST_WORKFLOWS_BASE_PATH="$(normalize_path "${RIVET_LATEST_WORKFLOWS_BASE_PATH:-}" "/workflows-latest")"
  RIVET_WEB_APPS_BASE_PATH="$(normalize_path "${RIVET_PUBLISHED_APPS_BASE_PATH:-${RIVET_WEB_APPS_BASE_PATH:-}}" "/apps")"
  RIVET_LATEST_WEB_APPS_BASE_PATH="$(normalize_path "${RIVET_LATEST_APPS_BASE_PATH:-${RIVET_LATEST_WEB_APPS_BASE_PATH:-}}" "/apps-latest")"
  RIVET_PUBLISHED_APPS_BASE_PATH="$RIVET_WEB_APPS_BASE_PATH"
  RIVET_LATEST_APPS_BASE_PATH="$RIVET_LATEST_WEB_APPS_BASE_PATH"
}

read_public_route_settings() {
  RIVET_PUBLIC_ROUTES_SETTINGS_VALID=1
  set_default_public_routes

  public_route_settings_file="${RIVET_APP_DATA_ROOT:-/data/rivet-app}/settings/public-routes.json"
  legacy_web_app_route_settings_file="${RIVET_APP_DATA_ROOT:-/data/rivet-app}/settings/web-app-routes.json"
  settings_file=''

  if [ -f "$public_route_settings_file" ]; then
    settings_file="$public_route_settings_file"
    raw_configured_published_workflows_base_path="$(read_json_string_property "$settings_file" "publishedWorkflowsBasePath")"
    raw_configured_latest_workflows_base_path="$(read_json_string_property "$settings_file" "latestWorkflowsBasePath")"
    raw_configured_published_apps_base_path="$(read_json_string_property "$settings_file" "publishedAppsBasePath")"
    raw_configured_latest_apps_base_path="$(read_json_string_property "$settings_file" "latestAppsBasePath")"
  elif [ -f "$legacy_web_app_route_settings_file" ]; then
    settings_file="$legacy_web_app_route_settings_file"
    raw_configured_published_workflows_base_path=''
    raw_configured_latest_workflows_base_path=''
    raw_configured_published_apps_base_path="$(read_json_string_property "$settings_file" "publishedAppsBasePath")"
    raw_configured_latest_apps_base_path="$(read_json_string_property "$settings_file" "latestAppsBasePath")"
  else
    return
  fi

  invalid_public_route_settings=0
  configured_published_workflows_base_path="$RIVET_PUBLISHED_WORKFLOWS_BASE_PATH"
  configured_latest_workflows_base_path="$RIVET_LATEST_WORKFLOWS_BASE_PATH"
  configured_published_apps_base_path="$RIVET_WEB_APPS_BASE_PATH"
  configured_latest_apps_base_path="$RIVET_LATEST_WEB_APPS_BASE_PATH"

  if [ -n "$raw_configured_published_workflows_base_path" ]; then
    if ! configured_published_workflows_base_path="$(normalize_public_route_setting "$raw_configured_published_workflows_base_path")"; then
      invalid_public_route_settings=1
    fi
  fi

  if [ -n "$raw_configured_latest_workflows_base_path" ]; then
    if ! configured_latest_workflows_base_path="$(normalize_public_route_setting "$raw_configured_latest_workflows_base_path")"; then
      invalid_public_route_settings=1
    fi
  fi

  if [ -n "$raw_configured_published_apps_base_path" ]; then
    if ! configured_published_apps_base_path="$(normalize_public_route_setting "$raw_configured_published_apps_base_path")"; then
      invalid_public_route_settings=1
    fi
  fi

  if [ -n "$raw_configured_latest_apps_base_path" ]; then
    if ! configured_latest_apps_base_path="$(normalize_public_route_setting "$raw_configured_latest_apps_base_path")"; then
      invalid_public_route_settings=1
    fi
  fi

  seen_routes=' '
  for route_path in "$configured_published_workflows_base_path" "$configured_latest_workflows_base_path" "$configured_published_apps_base_path" "$configured_latest_apps_base_path"; do
    route_slug=$(printf '%s' "$route_path" | sed 's:^/*::; s:/*$::')
    case "$seen_routes" in
      *" $route_slug "*)
        invalid_public_route_settings=1
        ;;
    esac
    seen_routes="${seen_routes}${route_slug} "
  done

  if [ "$invalid_public_route_settings" = "1" ]; then
    >&2 printf 'Warning: invalid public route settings file "%s"; using deployment defaults.\n' "$settings_file"
    set_default_public_routes
    RIVET_PUBLIC_ROUTES_SETTINGS_VALID=0
    return
  fi

  RIVET_PUBLISHED_WORKFLOWS_BASE_PATH="$configured_published_workflows_base_path"
  RIVET_LATEST_WORKFLOWS_BASE_PATH="$configured_latest_workflows_base_path"
  RIVET_WEB_APPS_BASE_PATH="$configured_published_apps_base_path"
  RIVET_LATEST_WEB_APPS_BASE_PATH="$configured_latest_apps_base_path"
  RIVET_PUBLISHED_APPS_BASE_PATH="$RIVET_WEB_APPS_BASE_PATH"
  RIVET_LATEST_APPS_BASE_PATH="$RIVET_LATEST_WEB_APPS_BASE_PATH"
}

set_default_trusted_hosts() {
  RIVET_TRUSTED_HOSTS_REGEX='a^'
}

read_trusted_host_settings() {
  set_default_trusted_hosts

  trusted_host_settings_file="${RIVET_APP_DATA_ROOT:-/data/rivet-app}/settings/trusted-hosts.json"
  if [ ! -f "$trusted_host_settings_file" ]; then
    return
  fi

  raw_trusted_hosts="$(read_json_string_property "$trusted_host_settings_file" "trustedHostsCsv")"
  if [ -z "$raw_trusted_hosts" ]; then
    return
  fi

  RIVET_TRUSTED_HOSTS_REGEX="$(build_host_regex "$raw_trusted_hosts" "${RIVET_KEY:-}")"
}

write_public_routes_include() {
  output_file="${1:-$RIVET_PUBLIC_ROUTES_INCLUDE_FILE}"
  temp_file="${output_file}.tmp"
  output_dir="$(dirname "$output_file")"

  mkdir -p "$output_dir"

  cat > "$temp_file" <<EOF
    location ${RIVET_PUBLISHED_WORKFLOWS_BASE_PATH}/ {
        proxy_pass \$execution_upstream;
        proxy_http_version 1.1;
        proxy_set_header X-Rivet-Proxy-Auth ${RIVET_PROXY_AUTH_TOKEN};
        proxy_set_header X-Rivet-Token-Free-Host \$rivet_ui_host_is_token_free;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Host \$rivet_forwarded_host;
        proxy_set_header X-Forwarded-Proto \$rivet_forwarded_proto;
        include ${RIVET_PROXY_TIMEOUT_INCLUDE_FILE};
    }

    location ${RIVET_WEB_APPS_BASE_PATH}/ {
        proxy_pass \$execution_upstream;
        proxy_http_version 1.1;
        proxy_set_header X-Rivet-Proxy-Auth ${RIVET_PROXY_AUTH_TOKEN};
        proxy_set_header X-Rivet-Token-Free-Host \$rivet_ui_host_is_token_free;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Host \$rivet_forwarded_host;
        proxy_set_header X-Forwarded-Proto \$rivet_forwarded_proto;
        include ${RIVET_PROXY_TIMEOUT_INCLUDE_FILE};
    }

    location ${RIVET_LATEST_WORKFLOWS_BASE_PATH}/ {
        proxy_pass \$api_upstream;
        proxy_http_version 1.1;
        proxy_set_header X-Rivet-Proxy-Auth ${RIVET_PROXY_AUTH_TOKEN};
        proxy_set_header X-Rivet-Token-Free-Host \$rivet_ui_host_is_token_free;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Host \$rivet_forwarded_host;
        proxy_set_header X-Forwarded-Proto \$rivet_forwarded_proto;
        include ${RIVET_PROXY_TIMEOUT_INCLUDE_FILE};
    }

    location ${RIVET_LATEST_WEB_APPS_BASE_PATH}/ {
        proxy_pass \$api_upstream;
        proxy_http_version 1.1;
        proxy_set_header X-Rivet-Proxy-Auth ${RIVET_PROXY_AUTH_TOKEN};
        proxy_set_header X-Rivet-Token-Free-Host \$rivet_ui_host_is_token_free;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Host \$rivet_forwarded_host;
        proxy_set_header X-Forwarded-Proto \$rivet_forwarded_proto;
        include ${RIVET_PROXY_TIMEOUT_INCLUDE_FILE};
    }
EOF

  mv "$temp_file" "$output_file"
}

write_trusted_hosts_include() {
  output_file="${1:-$RIVET_TRUSTED_HOSTS_INCLUDE_FILE}"
  temp_file="${output_file}.tmp"
  output_dir="$(dirname "$output_file")"

  mkdir -p "$output_dir"

  cat > "$temp_file" <<EOF
    ~*${RIVET_TRUSTED_HOSTS_REGEX} 1;
EOF

  mv "$temp_file" "$output_file"
}

write_proxy_timeout_include() {
  output_file="${1:-$RIVET_PROXY_TIMEOUT_INCLUDE_FILE}"
  temp_file="${output_file}.tmp"
  output_dir="$(dirname "$output_file")"

  mkdir -p "$output_dir"

  cat > "$temp_file" <<EOF
        proxy_read_timeout ${RIVET_PROXY_READ_TIMEOUT};
        proxy_send_timeout ${RIVET_PROXY_READ_TIMEOUT};
EOF

  mv "$temp_file" "$output_file"
}

get_public_routes_signature() {
  printf '%s|%s|%s|%s|%s|%s|%s' \
    "$RIVET_PUBLISHED_WORKFLOWS_BASE_PATH" \
    "$RIVET_LATEST_WORKFLOWS_BASE_PATH" \
    "$RIVET_WEB_APPS_BASE_PATH" \
    "$RIVET_LATEST_WEB_APPS_BASE_PATH" \
    "${RIVET_PROXY_AUTH_TOKEN:-}" \
    "${RIVET_PROXY_READ_TIMEOUT:-}" \
    "${RIVET_TRUSTED_HOSTS_REGEX:-}"
}

start_public_routes_reload_watcher() {
  (
    last_signature="$(get_public_routes_signature)"
    interval="${RIVET_PUBLIC_ROUTES_RELOAD_INTERVAL_SECONDS:-2}"
    case "$interval" in
      ''|*[!0123456789]*)
        interval=2
        ;;
    esac

    while sleep "$interval"; do
      read_runtime_limit_settings
      if [ "${RIVET_RUNTIME_LIMIT_SETTINGS_VALID:-1}" != "1" ]; then
        continue
      fi

      read_trusted_host_settings
      read_public_route_settings
      if [ "${RIVET_PUBLIC_ROUTES_SETTINGS_VALID:-1}" != "1" ]; then
        continue
      fi

      next_signature="$(get_public_routes_signature)"
      if [ "$next_signature" = "$last_signature" ]; then
        continue
      fi

      previous_public_routes_include="$(cat "$RIVET_PUBLIC_ROUTES_INCLUDE_FILE" 2>/dev/null || true)"
      previous_proxy_timeout_include="$(cat "$RIVET_PROXY_TIMEOUT_INCLUDE_FILE" 2>/dev/null || true)"
      previous_trusted_hosts_include="$(cat "$RIVET_TRUSTED_HOSTS_INCLUDE_FILE" 2>/dev/null || true)"
      if write_proxy_timeout_include "$RIVET_PROXY_TIMEOUT_INCLUDE_FILE" && write_public_routes_include "$RIVET_PUBLIC_ROUTES_INCLUDE_FILE" && write_trusted_hosts_include "$RIVET_TRUSTED_HOSTS_INCLUDE_FILE" && nginx -t >/tmp/nginx/public-routes-test.log 2>&1; then
        if nginx -s reload >/tmp/nginx/public-routes-reload.log 2>&1; then
          >&2 printf 'Reloaded nginx public routes: workflows=%s latest-workflows=%s apps=%s latest-apps=%s\n' \
            "$RIVET_PUBLISHED_WORKFLOWS_BASE_PATH" \
            "$RIVET_LATEST_WORKFLOWS_BASE_PATH" \
            "$RIVET_WEB_APPS_BASE_PATH" \
            "$RIVET_LATEST_WEB_APPS_BASE_PATH"
          last_signature="$next_signature"
        else
          >&2 printf 'Warning: nginx public route reload failed; keeping generated routes for next reload attempt.\n'
          cat /tmp/nginx/public-routes-reload.log >&2 2>/dev/null || true
        fi
      else
        >&2 printf 'Warning: generated nginx public routes failed validation; keeping previous routes.\n'
        cat /tmp/nginx/public-routes-test.log >&2 2>/dev/null || true
        printf '%s' "$previous_public_routes_include" > "$RIVET_PUBLIC_ROUTES_INCLUDE_FILE"
        printf '%s' "$previous_proxy_timeout_include" > "$RIVET_PROXY_TIMEOUT_INCLUDE_FILE"
        printf '%s' "$previous_trusted_hosts_include" > "$RIVET_TRUSTED_HOSTS_INCLUDE_FILE"
      fi
    done
  ) &
}

export NGINX_ENVSUBST_OUTPUT_DIR="${NGINX_ENVSUBST_OUTPUT_DIR:-/etc/nginx/conf.d}"
export RIVET_PUBLIC_ROUTES_INCLUDE_FILE="${RIVET_PUBLIC_ROUTES_INCLUDE_FILE:-/tmp/nginx/rivet-public-routes.inc}"
export RIVET_PROXY_TIMEOUT_INCLUDE_FILE="${RIVET_PROXY_TIMEOUT_INCLUDE_FILE:-/tmp/nginx/rivet-proxy-timeout.inc}"
export RIVET_TRUSTED_HOSTS_INCLUDE_FILE="${RIVET_TRUSTED_HOSTS_INCLUDE_FILE:-/tmp/nginx/rivet-trusted-hosts.inc}"

read_runtime_limit_settings
if [ "${RIVET_RUNTIME_LIMIT_SETTINGS_VALID:-1}" != "1" ]; then
  >&2 printf 'Error: invalid runtime limit settings; refusing to start nginx with unsafe route timeouts.\n'
  exit 1
fi

read_trusted_host_settings
read_public_route_settings
export RIVET_PROXY_READ_TIMEOUT
export RIVET_PUBLISHED_WORKFLOWS_BASE_PATH
export RIVET_LATEST_WORKFLOWS_BASE_PATH
export RIVET_WEB_APPS_BASE_PATH
export RIVET_LATEST_WEB_APPS_BASE_PATH
export RIVET_PUBLISHED_APPS_BASE_PATH="$RIVET_WEB_APPS_BASE_PATH"
export RIVET_LATEST_APPS_BASE_PATH="$RIVET_LATEST_WEB_APPS_BASE_PATH"
export RIVET_REQUIRE_UI_GATE_KEY="$(normalize_bool "${RIVET_REQUIRE_UI_GATE_KEY:-}" "0")"
export RIVET_TRUST_INCOMING_FORWARDED_HEADERS="$(normalize_bool "${RIVET_TRUST_INCOMING_FORWARDED_HEADERS:-}" "0")"
export RIVET_UI_GATE_KEY_PRESENT="$(has_nonempty_value "${RIVET_KEY:-}")"
export RIVET_PROXY_RESOLVER="$(resolve_proxy_resolver "${RIVET_PROXY_RESOLVER:-}")"
export RIVET_PROXY_AUTH_TOKEN="$(sha256_hex "${RIVET_KEY:-}:proxy-auth")"
export RIVET_UI_SESSION_TOKEN="$(sha256_hex "${RIVET_KEY:-}:ui-session")"

write_proxy_timeout_include "$RIVET_PROXY_TIMEOUT_INCLUDE_FILE"
write_public_routes_include "$RIVET_PUBLIC_ROUTES_INCLUDE_FILE"
write_trusted_hosts_include "$RIVET_TRUSTED_HOSTS_INCLUDE_FILE"
stage_ui_gate_prompt
start_public_routes_reload_watcher

exec /docker-entrypoint.sh nginx -g 'daemon off;'
