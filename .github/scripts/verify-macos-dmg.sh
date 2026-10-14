#!/usr/bin/env bash
set -euo pipefail

bundle_dir="${1:?Usage: verify-macos-dmg.sh <bundle-dir> <aarch64-apple-darwin|x86_64-apple-darwin>}"
target_triple="${2:?Usage: verify-macos-dmg.sh <bundle-dir> <aarch64-apple-darwin|x86_64-apple-darwin>}"
case "$target_triple" in
  aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) printf 'Unsupported macOS target: %s\n' "$target_triple" >&2; exit 1 ;;
esac

if [[ ! -d "$bundle_dir" ]]; then
  printf 'macOS bundle directory does not exist: %s\n' "$bundle_dir" >&2
  exit 1
fi

dmg_paths=()
while IFS= read -r -d '' candidate; do
  dmg_paths+=("$candidate")
done < <(find "$bundle_dir" -type f -name '*.dmg' -print0)

if (( ${#dmg_paths[@]} != 1 )); then
  printf 'Expected exactly one .dmg bundle under %s; found %d\n' "$bundle_dir" "${#dmg_paths[@]}" >&2
  exit 1
fi
dmg_path="${dmg_paths[0]}"
temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mount_dir="$(mktemp -d "${temp_root%/}/rivet-dmg-verify.XXXXXX")"
mount_attempted=0

cleanup() {
  local status=$?
  trap - EXIT
  if (( mount_attempted )) && ! hdiutil detach "$mount_dir" -quiet; then
    printf 'Unable to detach verification image at %s; leaving it intact.\n' "$mount_dir" >&2
    if (( status == 0 )); then status=1; fi
    exit "$status"
  fi
  # Never recursively remove a mountpoint: a failed detach must leave its
  # contents untouched. Successful detach leaves only our empty temp directory.
  if ! rmdir "$mount_dir"; then
    printf 'Unable to remove empty verification directory: %s\n' "$mount_dir" >&2
    if (( status == 0 )); then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT

mount_attempted=1
hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
app_paths=()
while IFS= read -r -d '' candidate; do
  app_paths+=("$candidate")
done < <(find "$mount_dir" -maxdepth 2 -type d -name '*.app' -print0)

if (( ${#app_paths[@]} != 1 )); then
  printf 'Expected exactly one .app bundle inside %s; found %d\n' "$dmg_path" "${#app_paths[@]}" >&2
  exit 1
fi
app_path="${app_paths[0]}"

codesign --verify --deep --strict --verbose=2 "$app_path"
node .github/scripts/verify-macos-sidecars.mjs "$app_path" "$target_triple"
codesign --verify --verbose=2 "$dmg_path"
spctl --assess --type execute --verbose=4 "$app_path"
node .github/scripts/staple-macos-dmg.mjs --validate "$dmg_path"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"
