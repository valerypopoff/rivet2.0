#!/bin/sh
set -eu

case "${1:-}" in
  amd64|arm64) target_arch=$1 ;;
  *) echo 'Unsupported qualification kubectl architecture' >&2; exit 1 ;;
esac
test "$(go env GOVERSION)" = go1.27.3
cd /kubectl-policy
mkdir -p /out
# Build the real upstream main package, not a wrapper or a local fork. The
# separate locked tool module selects compatible patched libraries, while Go's
# build info retains kubernetes' actual release version and checksum.
CGO_ENABLED=0 GOOS=linux GOARCH="$target_arch" GOTOOLCHAIN=local \
  go build -p 2 -mod=readonly -trimpath \
  -ldflags='-X k8s.io/component-base/version.gitMajor=1 -X k8s.io/component-base/version.gitMinor=36 -X k8s.io/component-base/version.gitVersion=v1.36.6+rivet.go1.27.3 -X k8s.io/component-base/version.gitTreeState=dirty' \
  -o /out/kubectl k8s.io/kubernetes/cmd/kubectl
go version -m /out/kubectl > /out/kubectl-build.txt
grep -F "$(printf '\tmod\tk8s.io/kubernetes\tv1.36.6\th1:')" /out/kubectl-build.txt
grep -F "$(printf '\tdep\tgolang.org/x/net\tv0.60.0\th1:')" /out/kubectl-build.txt
grep -F "$(printf '\tdep\tgolang.org/x/text\tv0.42.0\th1:')" /out/kubectl-build.txt
cp "$(go env GOPATH)/pkg/mod/k8s.io/kubernetes@v1.36.6/LICENSE" /out/kubectl-LICENSE
