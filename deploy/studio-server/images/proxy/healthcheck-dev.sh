#!/bin/sh
set -eu

# The gate may legitimately return a login page. Check web separately as well,
# so that login HTML cannot conceal an unavailable dashboard server.
check_200() {
    response=$(wget -S -O /dev/null -T 5 "$1" 2>&1) || return 1
    printf '%s\n' "$response" | grep -q 'HTTP/1.1 200 OK'
}

check_200 "${RIVET_HEALTH_PROXY_URL:-http://127.0.0.1/}"
check_200 "${RIVET_HEALTH_WEB_URL:-http://web:5174/}"
