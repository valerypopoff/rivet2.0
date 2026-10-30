# Qualification kubectl dependency policy

This build-only Go tool module compiles the real upstream
`k8s.io/kubernetes/cmd/kubectl@v1.36.6` entry point. There is no replacement main
program, local source fork or runtime module installer. The Kubernetes libraries
stay on their matching 0.36.6 release; the networking/text libraries retain the
reviewed security minimums. The retained
tooling/test-only compression dependency also resolves to its patched source.

`go.mod` and `go.sum` freeze the complete graph. The normal image build uses
`-mod=readonly`, the pinned Go compiler and Go's checksum database. It must not
run `go get` or `go mod tidy`. Both Helm and kubectl retain real release versions
and checksums in Go build info, plus explicit Rivet rebuild metadata in CLI output.
Build inventories and upstream licenses are copied into the final image.

To deliberately update this policy, run the pinned compiler's `go mod tidy`
with this directory as its only writable source mount, review both files and
the resulting build inventory, then rebuild/scan the complete actor. Do not
change Kubernetes minor versions or add a replacement entry point incidentally.
The 1.36 update is intentional: fresh release preparation found production on
GKE 1.36.4, outside the previous 1.34 client's supported one-minor skew. Keep
future client updates within the live control plane's supported skew and verify
the actual CLI/transport behavior before freezing the actor.
The mandatory final-image toolchain probe checks actual trusted TLS/HTTP2,
file-backed writes, lost acknowledgements and stale resource identities.

Keep this workaround scoped to the qualification image. Once a compatible
official binary includes the fixes and passes the same full-image scan and
transport regressions, prefer that binary and remove this extra build policy.
