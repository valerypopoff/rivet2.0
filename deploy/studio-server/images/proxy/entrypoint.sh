#!/bin/sh
set -eu

. /opt/rivet/lib/load-env.sh

load_optional_dotenv /vault/dotenv

mkdir -p /tmp/nginx/conf.d /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp

export NGINX_ENVSUBST_TEMPLATE_DIR="${NGINX_ENVSUBST_TEMPLATE_DIR:-/etc/nginx/templates}"
export NGINX_ENVSUBST_OUTPUT_DIR="${NGINX_ENVSUBST_OUTPUT_DIR:-/tmp/nginx/conf.d}"

exec /opt/rivet/proxy/normalize-workflow-paths.sh
