#!/bin/sh
set -eu

# Keep the npm/JS API and esbuild source unchanged; replace its vulnerable Go
# runtime. Go's checksum database authenticates the exact release sources.
version=0.25.12
target_arch=${1:-$(go env GOARCH)}
profile=${2:-all}
case "$target_arch" in
  amd64) target_package=x64 ;;
  arm64) target_package=arm64 ;;
  *) echo "Unsupported esbuild target architecture: $target_arch" >&2; exit 1 ;;
esac
case "$profile" in
  all) targets='linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64 windows-arm64' ;;
  runtime) targets="linux-${target_arch}" ;;
  *) echo "Unsupported esbuild packaging profile: $profile" >&2; exit 1 ;;
esac
go mod download "github.com/evanw/esbuild@v${version}"
cd "/go/pkg/mod/github.com/evanw/esbuild@v${version}"
for target in $targets; do
  os=${target%-*}
  arch=${target#*-}
  npm_os=$os
  npm_arch=$arch
  [ "$os" != windows ] || npm_os=win32
  [ "$arch" != amd64 ] || npm_arch=x64
  output="/out/@esbuild/${npm_os}-${npm_arch}/bin/esbuild"
  [ "$os" != windows ] || output="/out/@esbuild/${npm_os}-${npm_arch}/esbuild.exe"
  mkdir -p "$(dirname "$output")"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" GOTOOLCHAIN=local \
    go build -mod=readonly -trimpath -ldflags=-w -o "$output" ./cmd/esbuild
done
host_arch=$(go env GOARCH)
[ "$host_arch" != amd64 ] || host_arch=x64
if [ -f "/out/@esbuild/linux-${host_arch}/bin/esbuild" ]; then
  test "$(/out/@esbuild/linux-${host_arch}/bin/esbuild --version)" = "$version"
fi
# Keep the npm CLI copy aligned with the final image, not the compiler host.
cp "/out/@esbuild/linux-${target_package}/bin/esbuild" /out/esbuild
