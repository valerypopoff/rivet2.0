#!/usr/bin/env bash
set -euo pipefail

bundle_dir="${1:?Usage: verify-macos-dmg.sh <bundle-dir> <aarch64-apple-darwin|x86_64-apple-darwin>}"
target_triple="${2:?Usage: verify-macos-dmg.sh <bundle-dir> <aarch64-apple-darwin|x86_64-apple-darwin>}"
temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mount_dir="$(mktemp -d "${temp_root%/}/rivet-dmg-verify.XXXXXX")"

if [[ ! -d "$bundle_dir" ]]; then
  printf 'macOS bundle directory does not exist: %s\n' "$bundle_dir" >&2
  exit 1
fi

dmg_path="$(find "$bundle_dir" -type f -name '*.dmg' -print -quit)"

if [[ -z "$dmg_path" ]]; then
  printf 'No .dmg bundle found under %s\n' "$bundle_dir" >&2
  exit 1
fi

cleanup() {
  hdiutil detach "$mount_dir" -quiet || true
  rm -rf "$mount_dir"
}
trap cleanup EXIT

hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
app_path="$(find "$mount_dir" -maxdepth 2 -type d -name '*.app' -print -quit)"

if [[ -z "$app_path" ]]; then
  printf 'No .app bundle found inside %s\n' "$dmg_path" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$app_path"
node .github/scripts/verify-macos-sidecars.mjs "$app_path" "$target_triple"
codesign --verify --verbose=2 "$dmg_path"
spctl --assess --type execute --verbose=4 "$app_path"
xcrun stapler validate "$dmg_path"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path"
