#!/bin/sh
# A Docker development service bind-mounts the monorepo at /workspace, while
# its dependencies deliberately use Yarn's node-modules linker. A node-modules
# install otherwise removes the host checkout's tracked PnP loaders. Preserve
# them around that one install so the host and its normal Yarn commands stay
# valid throughout a Docker-dev startup.
set -eu

workspace="$1"
shift

pnp_cjs="$workspace/.pnp.cjs"
pnp_loader="$workspace/.pnp.loader.mjs"

if [ ! -s "$pnp_cjs" ] || [ ! -s "$pnp_loader" ]; then
  echo "[preserve-host-pnp] Missing host PnP loaders. Run: corepack enable && yarn install --immutable" >&2
  exit 1
fi

backup_dir="$(mktemp -d)"
cp -p "$pnp_cjs" "$backup_dir/.pnp.cjs"
cp -p "$pnp_loader" "$backup_dir/.pnp.loader.mjs"

restore() {
  exit_status=$?

  # A real host-side immutable install recreates both loaders. Do not
  # overwrite it; restore only the deletion caused by this container's
  # node-modules install.
  if [ ! -s "$pnp_cjs" ] || [ ! -s "$pnp_loader" ]; then
    cp -p "$backup_dir/.pnp.cjs" "$pnp_cjs"
    cp -p "$backup_dir/.pnp.loader.mjs" "$pnp_loader"
  fi

  rm -rf "$backup_dir"
  exit "$exit_status"
}

trap restore EXIT
"$@"