# Qualification Helm dependency policy

This build-only tool module compiles the real upstream
`helm.sh/helm/v3/cmd/helm@v3.22.1` main package. It retains Helm's actual module
version and checksum, without a replacement main, upstream source fork or major
version change. The locked graph selects `golang.org/x/net v0.62.0` to fix
[CVE-2026-78661](https://pkg.go.dev/vuln/GO-2026-6860).

Normal image builds use the pinned Go compiler and `-mod=readonly`. Updating the
policy is a separate reviewed operation: use that compiler's `go mod tidy` with
only this directory mounted writable, then review `go.mod` and `go.sum`. Check
the resulting binary's build inventory and run the real CLI/TLS/HTTP2 fixture
before scanning the complete actor. Do not suppress scanner findings or change
the High/Critical gate. Build inventories and the upstream license remain in
`/opt/rivet/toolchain`.
