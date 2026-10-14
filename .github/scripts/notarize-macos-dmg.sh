#!/usr/bin/env bash
set -euo pipefail

required=(
  APPLE_SIGNING_IDENTITY
  APPLE_API_ISSUER
  APPLE_API_KEY
  APPLE_API_KEY_PATH
)

missing=()
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'Missing required macOS DMG notarization environment: %s\n' "${missing[*]}" >&2
  exit 1
fi

bundle_dir="${1:?Usage: notarize-macos-dmg.sh <bundle-dir>}"

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

codesign_args=(--force --timestamp --sign "$APPLE_SIGNING_IDENTITY")
if [[ -n "${APPLE_SIGNING_KEYCHAIN:-}" ]]; then
  codesign_args+=(--keychain "$APPLE_SIGNING_KEYCHAIN")
fi

codesign "${codesign_args[@]}" "$dmg_path"
xcrun notarytool submit "$dmg_path" \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait
node .github/scripts/staple-macos-dmg.mjs "$dmg_path"
