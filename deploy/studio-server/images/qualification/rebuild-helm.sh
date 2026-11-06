#!/bin/sh
set -eu

# Keep Helm 3's real upstream command and version. The locked build-only module
# patches x/net as well as the compiler; Go's checksum database verifies sources.
version=3.22.1
case "${1:-}" in
  amd64|arm64) target_arch=$1 ;;
  *) echo 'Unsupported qualification Helm architecture' >&2; exit 1 ;;
esac
test "$(go env GOVERSION)" = go1.27.3
cd /helm-policy
mkdir -p /out
# Building the dependency's actual main package preserves its release version
# and checksum; do not build a wrapper or relabel a '(devel)' main module.
CGO_ENABLED=0 GOOS=linux GOARCH="$target_arch" GOTOOLCHAIN=local \
  go build -p 2 -mod=readonly -trimpath \
  -ldflags="-X helm.sh/helm/v3/internal/version.version=v${version} -X helm.sh/helm/v3/internal/version.metadata=rivet.go1.27.3" \
  -o /out/helm helm.sh/helm/v3/cmd/helm
go version -m /out/helm > /out/helm-build.txt
grep -F "$(printf '\tmod\thelm.sh/helm/v3\tv%s\th1:' "$version")" /out/helm-build.txt
grep -F "$(printf '\tdep\tgolang.org/x/net\tv0.62.0\th1:')" /out/helm-build.txt
cp "$(go env GOPATH)/pkg/mod/helm.sh/helm/v3@v${version}/LICENSE" /out/helm-LICENSE
