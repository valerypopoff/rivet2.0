#!/bin/sh
set -eu

# Keep Helm 3's release sources and module graph. Rebuild with the same patched
# compiler as esbuild; downloading a newer Helm binary alone still ships Go
# 1.26.9's vulnerable standard library. Go's checksum database verifies sources.
version=3.22.1
case "${1:-}" in
  amd64|arm64) target_arch=$1 ;;
  *) echo 'Unsupported qualification Helm architecture' >&2; exit 1 ;;
esac
test "$(go env GOVERSION)" = go1.27.3
mkdir -p /out
# Versioned installation preserves the real main-module version and checksum in
# Go build info. Building from a module-cache directory reports '(devel)', which
# would make future Helm advisory matching unreliable. Never forge build info.
CGO_ENABLED=0 GOOS=linux GOARCH="$target_arch" GOTOOLCHAIN=local GOBIN= \
  go install -p 2 -mod=readonly -trimpath \
  -ldflags="-X helm.sh/helm/v3/internal/version.version=v${version} -X helm.sh/helm/v3/internal/version.metadata=rivet.go1.27.3" \
  "helm.sh/helm/v3/cmd/helm@v${version}"
binary="$(go env GOPATH)/bin/helm"
if [ "$(go env GOHOSTOS)-$(go env GOHOSTARCH)" != "linux-${target_arch}" ]; then
  binary="$(go env GOPATH)/bin/linux_${target_arch}/helm"
fi
cp "$binary" /out/helm
go version -m /out/helm > /out/helm-build.txt
grep -F "$(printf '\tmod\thelm.sh/helm/v3\tv%s\th1:' "$version")" /out/helm-build.txt
cp "$(go env GOPATH)/pkg/mod/helm.sh/helm/v3@v${version}/LICENSE" /out/helm-LICENSE
