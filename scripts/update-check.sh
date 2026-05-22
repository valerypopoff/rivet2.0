#!/usr/bin/env bash
# Compatibility scanner for upstream rivet/ updates
# Run after replacing rivet/ to detect breaking changes before deploying

set -euo pipefail

RIVET_APP_SRC="rivet/packages/app/src"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

ERRORS=0

echo "=== Rivet Studio Server Compatibility Scanner ==="
echo ""

# 1. Check for new @tauri-apps/api/* import subpaths
echo "[1/7] Checking for new Tauri import subpaths..."
KNOWN_SUBPATHS="@tauri-apps/api/app|@tauri-apps/api/dialog|@tauri-apps/api/fs|@tauri-apps/api/globalShortcut|@tauri-apps/api/http|@tauri-apps/api/path|@tauri-apps/api/process|@tauri-apps/api/shell|@tauri-apps/api/tauri|@tauri-apps/api/updater|@tauri-apps/api/window|@tauri-apps/api"

NEW_IMPORTS=$(grep -rhoP "from\s+['\"](@tauri-apps/api[^'\"]*)['\"]" "$RIVET_APP_SRC" 2>/dev/null | \
  sed "s/from ['\"]//;s/['\"]//" | sort -u | \
  grep -vE "^($KNOWN_SUBPATHS)$" || true)

if [ -n "$NEW_IMPORTS" ]; then
  echo "  FAIL: New Tauri import subpaths found (need shims):"
  echo "$NEW_IMPORTS" | sed 's/^/    /'
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: No new Tauri import subpaths"
fi

# 2. Check that all aliased upstream files still exist
echo "[2/7] Checking aliased upstream file paths..."
ALIASED_FILES=(
  "state/savedGraphs.ts"
  "state/settings.ts"
  "hooks/useCheckForUpdate.tsx"
  "hooks/useContextMenu.ts"
  "hooks/useCopyNodesHotkeys.ts"
  "hooks/useLoadPackagePlugin.ts"
  "hooks/useLoadProject.ts"
  "hooks/useSyncCurrentStateIntoOpenedProjects.ts"
  "hooks/useWindowsHotkeysFix.tsx"
  "model/native/TauriNativeApi.ts"
  "utils/deserializeProject.ts"
  "utils/tauri.ts"
)

ALIASED_MISSING_COUNT=0
for f in "${ALIASED_FILES[@]}"; do
  if [ ! -f "$RIVET_APP_SRC/$f" ]; then
    echo "  FAIL: Aliased file missing: $RIVET_APP_SRC/$f"
    ERRORS=$((ERRORS + 1))
    ALIASED_MISSING_COUNT=$((ALIASED_MISSING_COUNT + 1))
  fi
done

if [ "${ALIASED_MISSING_COUNT:-0}" -eq 0 ]; then
  echo "  OK: All aliased files exist"
fi

# 3. Check for hardcoded localhost WebSocket URLs
echo "[3/7] Checking for hardcoded localhost WebSocket URLs..."
HARDCODED=$(grep -rn "ws://localhost:2188[89]" "$RIVET_APP_SRC" 2>/dev/null | \
  grep -v "node_modules" || true)

if [ -n "$HARDCODED" ]; then
  echo "  WARN: Hardcoded localhost WebSocket URLs found:"
  echo "$HARDCODED" | sed 's/^/    /'
  # Not a hard fail: these are expected in upstream, overrides handle them
  echo "  (Review host wiring if new executor/debugger entrypoints appear)"
else
  echo "  OK: No hardcoded localhost WebSocket URLs"
fi

# 4. Check for direct native/API constructors that provider seams do not cover
echo "[4/7] Checking for direct native API usage and unexpected TauriIOProvider construction..."
DIRECT_USAGE=$(grep -rn "new TauriNativeApi\|new TauriIOProvider" "$RIVET_APP_SRC" 2>/dev/null | \
  grep -v "node_modules" | \
  grep -vE "(TauriNativeApi\.ts|TauriIOProvider\.ts|providers/ProvidersContext\.tsx|utils/globals/ioProvider\.ts)" || true)

if [ -n "$DIRECT_USAGE" ]; then
  echo "  WARN: Direct instantiation found outside the expected host/provider seams:"
  echo "$DIRECT_USAGE" | sed 's/^/    /'
  echo "  Review whether these files need a native API shim or provider override"
else
  echo "  OK: No unexpected direct instantiation"
fi

# 5. Check upstream provider seams used by hosted mode
echo "[5/7] Checking upstream provider seams..."
PROVIDERS_CONTEXT="$RIVET_APP_SRC/providers/ProvidersContext.tsx"
TAURI_UTILS="$RIVET_APP_SRC/utils/tauri.ts"
PROJECT_REFERENCE_LOADER="$RIVET_APP_SRC/model/TauriProjectReferenceLoader.ts"
DATASETS_IO="$RIVET_APP_SRC/io/datasets.ts"

if ! grep -q "export type EnvironmentProvider" "$PROVIDERS_CONTEXT" ||
  ! grep -q "export type PathPolicyProvider" "$PROVIDERS_CONTEXT" ||
  ! grep -q "readRelativeProjectFile" "$PROVIDERS_CONTEXT" ||
  ! grep -q "getDefaultEnvironmentProvider" "$TAURI_UTILS" ||
  ! grep -q "getDefaultPathPolicyProvider" "$TAURI_UTILS" ||
  ! grep -q "readRelativeProjectFile" "$PROJECT_REFERENCE_LOADER" ||
  ! grep -q "allowDataFileNeighbor" "$DATASETS_IO"; then
  echo "  FAIL: Upstream provider seam changed; review hosted environment/path-policy overrides"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Provider seams are present"
fi

# 6. Check upstream entry point exists
echo "[6/7] Checking upstream entry point..."
if [ ! -f "$RIVET_APP_SRC/index.tsx" ]; then
  echo "  FAIL: Upstream entry point missing: $RIVET_APP_SRC/index.tsx"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Entry point exists"
fi

# 7. Check upstream vite config exists (for reference)
echo "[7/7] Checking upstream vite config..."
if [ ! -f "rivet/packages/app/vite.config.ts" ]; then
  echo "  FAIL: Upstream vite.config.ts missing"
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Upstream vite.config.ts exists"
fi

echo ""
echo "=== Summary ==="
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS critical issues found. Fix before deploying."
  exit 1
else
  echo "PASSED: No critical issues found."
  exit 0
fi
