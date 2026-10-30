# Container vulnerability checks

Runtime images are a separate dependency boundary from Yarn and Cargo. Passing
those audits does not certify NGINX, Alpine libraries or binaries copied into a
container. Build Images now requires `scan-images` before promotion, alongside
the existing functional, migration and HA gates. Scanning does not deploy anything.

## Pinned NGINX and October 2026 update

The production Dockerfile, development Compose proxy and real proxy regression
fixtures use NGINX **1.30.6 Alpine**, pinned to the official multi-platform digest
`sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951`.
The former 1.27.5 pin predates the October 14 fixes for CVE-2026-15176,
CVE-2026-93479, CVE-2026-95101, CVE-2026-97629 and CVE-2026-97205, as well as
earlier fixes. Configuration prerequisites still matter; do not equate a version
match with a demonstrated exploit. See the [upstream advisories](https://nginx.org/en/security_advisories.html).

The final Rivet proxy additionally installs `brotli-libs>=1.2.1-r0`: the pinned
upstream image contains 1.2.0-r1, which the current scanner reports vulnerable to
CVE-2026-111497. Installing a patched NGINX alone does not fix that library.
The stock development/test image reference is not a release qualification;
scan the final production image, including its added packages. Version/digest
consistency is guarded by the workflow-policy check in `test:style`.

The proxy also requires `curl>=8.23.0-r0` and `libcurl>=8.23.0-r0`. The
October 26 CI inventory found both at 8.22.0-r0, blocked by
[CVE-2026-92392](https://curl.se/docs/CVE-2026-92392.html), an HTTP/2-upload
use-after-free fixed upstream in 8.23.0. These are two package findings for one
advisory, not two independent vulnerabilities. An unversioned `apk add curl`
does not refresh an already cached Docker layer when repository packages change.
Raising these minimums invalidates the package-install layer; the build refuses
older repository packages on either architecture. Keep curl for the existing proxy configuration
refresh/health paths; do not remove it, disable HTTP/2 globally, suppress the
finding or weaken the High/Critical gate to make publication pass.

## Release gate

- The four service lanes consume the candidate manifest from this workflow
  attempt and require its source SHA to match `GITHUB_SHA`. They scan immutable
  image digests, never a mutable `latest`/candidate tag.
- Proxy and web scan both Linux amd64 and arm64; API and executor scan amd64.
  Workflow validation compares this coverage with the actual build matrix.
  An architecture cannot be added to publication without extending the scan.
- Trivy 0.76.1 is itself digest-pinned. It runs in a temporary non-privileged,
  read-only-root container, without the Docker socket. Registry credentials are
  passed as environment variables, not command-line values or reports.
  The container explicitly uses the invoking Linux user's UID/GID (10001:10001
  on Windows). Linux callers must be non-root. Bind-mounted scratch, reports and
  cache directories retain host ownership: the scanner image's default root user
  cannot write runner-owned directories after all capabilities are dropped.
  Do not fix that failure by restoring capabilities, running privileged or making
  the root filesystem writable.
- Both OS and language packages are analyzed. All severity levels are retained;
  **every High or Critical finding blocks promotion**, even without an available
  fix. There is no broad ignore file, `--ignore-unfixed`, or allow-failure path.
  Existing JavaScript/Rust audits remain mandatory independently.
- Scanner/download/parse failures, empty OS inventories, image/architecture
  mismatch, end-of-life OS and a vulnerability database older than 48 hours all
  fail closed. Repository/ambient Trivy configuration and ignore files are not
  consulted. The scanner updates its database normally; cache age is checked
  after scanning, not assumed from a successful exit code.
- Sanitized JSON inventories, findings, assessment and terminal result are uploaded on
  failure as well as success (30-day retention), separately per service/run/
  attempt. Assessments record scanner digest, analyzed image ID/platform, source
  image or archive hash, time and database metadata. Do not upload the cache,
  archives, credentials, raw reports or scratch directories. Image ENV/history is
  removed before a report becomes uploadable, including when assessment fails.

If a finding blocks release, inspect the package, installed/fixed version and
vendor advisory; update the owning dependency/base and rescan. A scan outage or
unfixed finding is not permission to disable the gate. No existing exception
mechanism silently applies to container findings. Reports are point-in-time
evidence, not proof that every future vulnerability is known.

## Local verification

Use Docker Desktop's Linux engine. No GCP context, production connection or paid
environment is needed. Use a new output directory for every scan; stale reports
cannot be reused after a command fails.

```powershell
node .yarn/releases/yarn-4.17.1.cjs test:container-security
docker build --pull --platform linux/amd64 -f deploy/studio-server/images/proxy/Dockerfile -t rivet-security-local/proxy:nginx-1.30.6 .
docker image save --output artifacts/container-security/proxy.tar rivet-security-local/proxy:nginx-1.30.6
node scripts/ci/scan-container-images.mjs --archive artifacts/container-security/proxy.tar --platform linux/amd64 --output artifacts/container-security/proxy-scan
```

Create the archive's parent directory first. Native command failures must stop
the sequence; in PowerShell check `$LASTEXITCODE` after each command. Remote
mode accepts `--image repository@sha256:... --platform linux/amd64` instead of
`--archive`. CI mode uses `--manifest ... --service proxy --source-sha <40-char-sha>`
(or `GITHUB_SHA`) and derives all required platforms. Archive scans bind evidence
to the archive SHA-256 and analyzed image ID, not a tag.

The default cache is `artifacts/container-security-cache`; `--cache <directory>`
can reuse a local database across sequential scans. Do not share one writable
cache between concurrent scanner processes. Each GitHub matrix runner has its
own checkout/cache. Scratch uses test-owned disk, not a small tmpfs: database
download/extraction can exceed hundreds of MiB. Cleanup targets only the recorded
scanner container ID after matching its operation label. Reports remain local
under ignored `artifacts/`.

Run the existing real regressions after changing NGINX:

```powershell
node deploy/studio-server/scripts/verify-trusted-client-proxy.mjs
node deploy/studio-server/scripts/verify-vm-nginx-tls.mjs
node deploy/studio-server/scripts/verify-proxy-dns.mjs
```

The TLS fixture requires OpenSSL on PATH (Git for Windows supplies it under
`C:/Program Files/Git/usr/bin`). DNS verification invokes the repository's
`studio-server:ui:observe` runner headlessly through the test proxy; preserve its
outage, address replacement and active-WebSocket checks. These tests do not
reload the running local app or production. Local validation is not a production
deployment or provider qualification, and this dependency update requires no
database schema or object-storage migration.

## Historical baseline before remediation — 2026-10-25

These initial blocking results are historical. The final local results below
supersede them; they are retained to show what the remediation actually changed.

The patched final proxy was built and scanned on amd64 and arm64 with the pinned
scanner and database updated at `2026-10-25T07:10:41Z`. Both returned zero
vulnerabilities. The unmodified upstream amd64 base returned one High finding
(`brotli-libs` CVE-2026-111497); installing its published fixed package removed it.
This is also a real negative test of the new release-blocking assessment.

The fresh API image returned **499 findings, including 203 High/Critical**.
Those 203 instances represent 64 distinct CVE IDs, not 203 independent flaws.
Its Alpine OS packages were clean; findings came from shipped language packages
and bundled Go binaries, including six architecture-specific esbuild binaries.
These are image inventory findings, not a claim that each CVE is reachable by a
public Rivet request. Third-party packages currently remain available to plugins
and Code nodes, so deleting them as apparent build-only baggage could break
existing functionality. The container gate deliberately remains blocking; a
separate dependency/runtime-packaging remediation is needed before promoting
this image set. Do not waive the findings merely because the proxy is now clean.

The amd64 web image also returned 91 findings, including 27 High/Critical
instances representing 25 distinct CVEs. These are separate from functional
acceptance: the strict scan correctly exits nonzero while the proxy's real
auth/header, WebSocket, TLS/101 MiB upload and DNS/browser recovery checks pass.

The final local platform coverage was:

| Runtime image | Platforms scanned | Total findings per platform | High/Critical instances | Distinct blocking CVEs |
| ------------- | ----------------- | --------------------------: | ----------------------: | ---------------------: |
| Proxy         | amd64, arm64      |                           0 |                       0 |                      0 |
| Web           | amd64, arm64      |                          91 |                      27 |                     25 |
| API           | amd64             |                         499 |                     203 |                     64 |
| Executor      | amd64             |                         518 |                     191 |                     53 |

Five lean scanner regressions (including the actual CLI's startup-failure/stale
receipt check), the complete structural/style lane, workflow-policy guards,
documentation links and diff hygiene passed locally. The real proxy fixtures
passed all three configurations' DNS outage/address recovery and auth/header/
WebSocket behavior; the image phase also passed the headless repository browser
observer through the proxy. Both proxy binaries reported `nginx/1.30.6`.
The High/Critical scan failures above are intentional release blocks, not passing
security checks. No GitHub workflow was dispatched or production resource changed.

Reports and build/functional logs are local under `artifacts/container-security/`.
Generated archives and reports are not committed. These results do not change
the version running in production.

## Follow-up remediation

The table above records the pre-remediation inventory, not the current release
candidate. The follow-up keeps the strict scanner policy unchanged:

- API, executor and static web use the same digest-pinned Node **24.22.2 Alpine**
  base. Executor/web no longer inherit end-of-life Node 20 and its older OpenSSL
  and package-manager dependency trees. This changes the server container runtime,
  not desktop's supported OS or project/recording formats.
  The October 28 [Node 24.22.2 maintenance release](https://nodejs.org/en/blog/release/v24.22.2)
  contains V8 backports and a stream async-context fix. API/executor builders,
  runtime images, the static web build, the qualification toolchain and the
  vulnerability scanner use the same official multi-platform digest; the runtime
  dependency probe asserts this exact Node patch version. This candidate still
  requires fresh image scans and runtime qualification before production use.
- API retains npm (**11.21.1**, same major as the Node 24 base) and pnpm
  (**10.34.8**, same major as before); executor retains npm for dynamic runtime
  libraries and restore preparation. The static web server does not install
  packages at runtime, so only its unused npm/Yarn installations are omitted.
  Do not remove package installation from the graph-capable containers.
  Production Compose source builds point to this same web Dockerfile rather than
  the historical `compose/docker/Dockerfile.web` (Node 20 plus a separate `serve`
  installation). That old file is retained only for historical migration inputs;
  it is not the production build path or a qualified release image.
  npm 11.21.1 still bundles Undici 6.29.0; replace only that dependency with
  **6.29.1** (which has no dependencies), retaining the rest of npm's installation.
  Do not reinstall npm's entire development dependency tree to accomplish this.
- The six esbuild platform packages retain **0.25.12**, its source and JavaScript
  API. Their Go runtime is rebuilt with digest-pinned **Go 1.27.3**, using Go's
  module checksum database. Both the platform binary and npm's executable copy
  are replaced. The compiler/source-version policy is checked against the root
  resolution. This avoids combining a security fix with an esbuild API migration
  or raising native desktop requirements. No compiler is copied to final images.
  The compiler runs on `BUILDPLATFORM`; `TARGETARCH` selects the final npm CLI
  copy. Previously that copy was hard-coded to x64, which mismatched ARM64 builds
  even though the JavaScript API could select its separate ARM64 package. The
  image probe now checks the CLI's ELF machine type against `process.arch` and
  executes `--version`, in addition to exercising the JavaScript API. The build
  uses a Go compilation cache and rejects unsupported target architectures.
  This does not add ARM64 API/executor publication or provider qualification.
- `webpack-dev-middleware` stays on major 7 and resolves **7.4.6**. A regression
  uses the actual documentation compiler/middleware and checks normal assets and
  traversal through a non-slash-terminated `publicPath` (CVE-2026-76844).
- `zod-to-json-schema` accidentally publishes `dist-test-v3`/`dist-test-v4`, each
  containing obsolete Zod installations. Only those unexported fixture roots are
  excluded, including nested/scoped and workspace-local copies. Real converter
  entry points, Zod runtime dependencies, declarations, licenses and unrelated
  dependency tests/assets remain available. Unexpected package identities/versions,
  exported fixture paths and symlinked fixture roots fail closed rather than being pruned.
  This includes browser/bin/import and versioned type entry points, not only
  main/module/exports. Both fixture roots are validated before either is removed;
  an unexpected file or link leaves the other root intact. A fixture-free outer
  converter does not prevent inspection of nested converter dependencies.
  The supplied dependency root itself must also be a real directory: passing a
  symlink/junction now fails before traversal, rather than pruning its target.
  This prevents a linked staging root from modifying source dependencies.

Do not replace the existing `http-cache-semantics` Yarn patch with **unpatched**
4.3.0 merely to escape an advisory version range. That upstream release still
permits security-zeroed cache reuse; see [the source review](../DEPENDENCY-AUDIT.md).
The updated Yarn resolution uses 4.3.0 **with the existing fix retained** and
removes the now-unused advisory-version exception. npm/pnpm's independent 4.3.0
copies receive the same fix, not a version-label change. The build requires exact
reviewed source SHA-256 before and after modification and saves the receipt at
`/opt/rivet/cache-security-patches.json`. Unrecognized source fails closed.
The actual cache-behavior regression must pass for every installed package-manager
copy as well as the documentation consumer. A version-only scan is insufficient
evidence that this flaw is fixed.

The API/executor Dockerfiles run `verify-runtime-dependencies.mjs` against the
final filesystem as UID 10001. It tests real esbuild TypeScript transformation
and plugin bundling, the actual autoevals/Zod converter dependency, and offline
npm/pnpm installation from a temporary local fixture. BuildKit mounts this test
read-only; it and its generated fixtures are not shipped. These checks complement,
not replace, the candidate-image API/auth/recording smoke and browser acceptance.

### Lower-severity inventory is not an all-clear

The repaired executor still reports **52 Medium, 10 Low and 5 Unknown** finding
instances. They remain in the JSON and are not ignored or relabeled. The scan
gate blocks High/Critical; passing it does not mean zero known
vulnerabilities. In particular:

- The CSV prototype-pollution advisory requires `columns` and
  `group_columns_by_name`. Rivet's dataset/evaluation importers parse row arrays;
  the evaluation importer validates the header against its current field schema.
  Do not enable grouped object records without revisiting that dependency.
- The qs findings include non-default comma/array-limit and stringify behaviors.
  API form-body parsing uses `extended: false`, not that parser configuration.
  This is not a blanket claim about every query-parser or future consumer.
- Hono/Node-server findings belong to the MCP SDK's server-side dependencies;
  Rivet's MCP provider is a client, not a Hono server. Build/style tools and CSS
  parsers also remain available because dynamically authored Code/plugins can
  resolve installed packages. Removing them wholesale is not a compatible fix.
- Five Unknown entries repeat the Windows-only `x/sys/windows.NewNTUnicodeString`
  issue (CVE-2026-39824) in Go module inventories. These images execute Linux
  binaries, not Windows syscalls. Cross-platform package payloads were retained,
  not silently deleted; this is not native-Windows qualification.

Other Medium/Low entries still require consumer-specific review before invoking
the affected APIs with untrusted data. None is given a global "not affected"
waiver here. The focused remediation closes the confirmed release blockers and
the independently reproduced cache flaw; it does not certify arbitrary plugin
code or promise that every lower-severity advisory is harmless. Keep the full
inventory for subsequent dependency maintenance rather than forcing incompatible
major upgrades simply to obtain a zero-count report.

### Initial remediated qualification — 2026-10-25

All final platform scans pass the **unchanged** High/Critical gate using Trivy
0.76.1 and database `UpdatedAt=2026-10-25T07:10:41.872962161Z`:

| Image    | Platforms    | Previous High/Critical | Final High/Critical | Final total findings |
| -------- | ------------ | ---------------------: | ------------------: | -------------------: |
| Proxy    | amd64, arm64 |                      0 |                   0 |                    0 |
| Web      | amd64, arm64 |                27 each |                   0 |                    0 |
| API      | amd64        |                    203 |                   0 |                   67 |
| Executor | amd64        |                    191 |                   0 |                   67 |

API/executor each have the lower-severity breakdown described above. Their final
image IDs are `sha256:91845d06c3dca2fac7d266d0200b743c89cd9202ab740b933b1b1a4160d28884`
and `sha256:861109501890a445c89eb23eddb02762f16f49022dceeb0a0726022899c88888`.
Sanitized reports and assessments are in ignored `artifacts/container-security/`
under `secure-api-scan`, `secure-executor-scan`, `secure-web-scan` and
`secure-web-arm64-scan`; the unchanged proxy reports are `proxy-final-sanitized`
and `proxy-arm64-sanitized`. Archives may be removed after retaining their hash
receipts; local images and sanitized evidence remain available.

Verification passed: immutable Yarn install/cache, dependency audit (no advisory
exceptions; 38 Moderate/10 Low still reported), the full structural/style lane,
real middleware traversal and cache-policy regressions, runtime-staging tests,
and both final images' UID-10001 esbuild/converter/offline-install checks. The
existing candidate-image smoke passed real authentication, routing, metrics,
executor and workflow execution against disposable local Compose storage. Its
containers/network/volumes were removed. Headless `studio-server:ui:observe
dashboard-save-button.spec.ts` passed against the actual production web assets,
including editing/saving and Evaluations without a false conflict notice, using
mocked API data. Its exact test container was removed too. The existing eight
POSIX-only release-helper tests remain skipped on Windows; no new critical
security/runtime test uses a platform skip.

Follow-up review tightened report validation: every result must carry an actual
package array with named entries, valid OS versions and valid supplied language
versions; Go main modules may legitimately omit their version. Vulnerability IDs,
package names and installed versions must be strings, not merely truthy values.
Malformed inventories previously passed the nonempty-length check. Lean regression
matrices now reject them while preserving all six real platform reports. Cleanup
regressions cover nested fixture-free parents, exported browser/bin/type targets,
unexpected files, and real directory symlinks/junctions without platform skips.
The complete structural/style lane and real non-root Linux packaging test passed.
Rebuilding API with these rules reproduced the same final image ID above; the
current runtime payload therefore did not change. The stricter validator accepted
all six existing real reports. Fresh CLI controls also accepted the patched local
proxy and rejected the immutable upstream base over the remote-registry path on
its known Brotli finding; that negative control is not the final Rivet proxy.
Review evidence is retained under `artifacts/container-security/review-*`.
The headless production-assets save/Evaluations browser check also passed again,
and its exact temporary container was removed.

### Current qualification after boundary review — 2026-10-25

The linked-root regression reproduced deletion through a supplied root junction
before the fix; it now rejects that root and preserves the linked source tree.
It passed on Windows and inside the non-root Linux image, without platform skips.
An ARM64 runtime also reproduced the former CLI mismatch (ELF machine 62/x64,
where 183/ARM64 was required). The corrected cross-build artifact has machine
183 and executes esbuild 0.25.12 successfully in that ARM64 runtime. Unsupported
target architectures are rejected before toolchain downloads or writes. This is
artifact/CLI verification, not full ARM64 API/executor or GKE qualification.

Both AMD64 final images passed the stronger UID-10001 CLI architecture/version,
JavaScript transform/plugin, converter and offline-install probes. Fresh scans
still report **zero High/Critical and 67 total findings each**, with no exemptions:

- API: `sha256:ee1119456a979742617bd3d575a250bca0d5820ec9f57a70cbe850d1019e0565`.
- Executor: `sha256:a6030f0bc9f7b8dac63739ff56193a8071f685ad3247671ebe96e4d07e842892`.

The complete structural/style lane, repository checks, candidate-image application
smoke and headless production-assets browser check passed. The application smoke
used only disposable local data and removed its exact Compose resources. Reports
and logs are under ignored `artifacts/container-security/adjacent-*`; web/proxy
payloads and their existing scan results did not change. No release architecture
was added and no production resource was accessed.

These are local image/functional results, not GKE qualification. Committing this
source change does not deploy, change cloud resources or publish images. Follow
normal CI and release approval separately before changing a running installation.

## Temporary qualification actor boundary

The qualification actor is a separate final-image security boundary, not covered
by passing API/executor scans. Its Dockerfile must use the same pinned Node and
Go/esbuild remediation as the graph-capable images. It retains esbuild 0.25.12's
JavaScript API and all six platform packages, replacing their binaries with the
existing Go 1.27.3 build. Both executable resolution paths are tested. npm stays
available, with npm 11.21.1, its dependency-only Undici 6.29.1 update and the
existing cache-policy source/behavior guard. The final UID-10001 image runs the
same transform/plugin, converter and offline npm installation checks.

The actor's Helm 3 and kubectl 1.34 patch-line updates must also pass the complete
image scan and real chart/transport checks; updating a version is not itself
security evidence. Do not switch Helm majors or use an incompatible kubectl
minor merely to reduce findings. Kubernetes documents the supported
[kubectl version skew](https://kubernetes.io/releases/version-skew-policy/#kubectl).
Helm 3.22.1 is rebuilt from its checksum-verified upstream module using the pinned
Go 1.27.3 compiler without changing its module graph (`-mod=readonly`). The
versioned `go install` preserves its actual main-module version/checksum in Go's
build inventory; a `(devel)` main module is rejected, not relabeled or ignored.
This preserves future advisory matching in addition to fixing today's findings.
The official binary still uses Go 1.26.9. The local build identifies itself with
`+rivet.go1.27.3`, not a fabricated upstream Git commit; its build inventory and
license are retained under `/opt/rivet/toolchain`. The official kubectl 1.34.13
binary still contains vulnerable x/net and x/text versions. A small locked
build-only Go tool module compiles its **unmodified upstream main package** with
matching Kubernetes 0.34.13 libraries, x/net 0.60.0 and x/text 0.42.0. The retained
tooling/test-only compression dependency resolves to patched 1.18.7 source too.
No local replacement main or Kubernetes source fork is maintained. Normal image
builds cannot rewrite this policy or its checksums. Both CLIs retain actual
upstream module versions/checksums and explicit Rivet rebuild markers; no Go
compiler or build cache enters the final actor.

The additional mandatory non-root final-image probe runs real kubectl against a
temporary local trusted-TLS/HTTP2 API, with an explicit synthetic kubeconfig.
It checks file-backed exact-identity writes, a committed write with a lost
acknowledgement (no resend), read-only inspection and rejection of a stale
resource version. It cannot access a host kubeconfig or live cluster. The
separate actor browser/video and chart-render checks remain required.
The named `qualification-toolchain` build stage runs that probe before copying
or compiling the application checkout. Independent tool layers do not depend on
`SOURCE_SHA`; full actor builds still include all source, dependency and browser
gates. Testing this stage alone is not a passing full-actor vulnerability scan.

The maintained actor source projection excludes **only**
`packages/app/src-tauri`, the unused native desktop backend, using Git's explicit
sparse-checkout mechanism. The browser editor and hosted source remain present;
no native desktop binary is built or installed in this image. This is removal of
an unused component from the actor package, not an advisory exception or scanner
path exclusion. Desktop source files, Cargo manifests/lockfile and their separate
audit in the real repository are unchanged. This does not remediate or qualify
the desktop ZIP dependency itself. Its
[upstream advisory](https://github.com/zip-rs/zip2/security/advisories/GHSA-m665-v7pm-7grj)
remains relevant to desktop maintenance.

The full commit/tree identity is retained. Shared source admission validates the
original SHA, exact allowed projection, exact excluded paths and absence of the
excluded working-tree directory. Unexpected sparse paths, assume-unchanged flags,
hidden required files, dirty content and foreign revisions fail closed. Full
clean checkouts remain supported; they cannot use arbitrary skip-worktree flags.
The installer, offline actor and provider entry point all use this boundary.
The context builder uses that same verifier before cloning and after applying
the permitted projection. Admission explicitly includes all non-ignored
untracked files, regardless of `status.showUntrackedFiles`, and disables Git's
configured filesystem-monitor hooks. A user's display/performance preference is
not source-integrity evidence and must not execute a host hook during inspection.
All verification and context-building Git commands disable replacement objects:
an expected `HEAD` SHA must refer to its actual committed tree, not a local
`refs/replace` substitution. A replacement cannot make unrelated bytes qualify
as the expected source. Existing host replacement refs are left untouched.
Regression tests check original native bytes remain unchanged, along with hidden
edits/missing required files and projection changes. No container scan finding is
ignored, reclassified, or waived by the desktop's separate audit policy.

### Qualification actor scan — 2026-10-30

Release preparation later observed production on GKE 1.36.4. The current actor
therefore deliberately advances kubectl to upstream 1.36.6 and its matching
0.36.6 libraries, retaining the pinned Go compiler and reviewed networking/text
minimums. The previous 1.34 client is outside the supported one-minor client skew.
This client update requires a fresh build, transport probe and full actor scan;
the historical image/scan below does not qualify it. See the upstream
[version-skew policy](https://kubernetes.io/releases/version-skew-policy/).

The final local Linux-amd64 actor
`sha256:9dedcb136e4dd71cda5a519162a563474008c59cac331f6f50441c1895783b25`
passed the unchanged Trivy gate with **zero High/Critical** findings, compared
with 247 in the initial actor. It retains 56 Medium, 11 Low and 10 Unknown
finding instances. They remain in the report; no exception or suppression was
added. The analysis used database `UpdatedAt=2026-10-30T01:01:11.134360213Z` and
was recorded at `2026-10-30T10:37:38.284Z`. The sanitized assessment binds its
image ID, platform and archive hash. Reports are under
`artifacts/staging-security-20261030/acceptance/actor-scan`.

This is a disposable clean-source local build, not a published release. The
separate actor preflight, real frontend Playwright journey and CLI/TLS/HTTP2
probe passed. The exact scanned image also passed 78 Linux transport/chart,
two source/installer and 27 kernel-lock/process tests, with no skips; their
fixtures use synthetic local data. Preserve normal CI,
published-source binding and provider qualification before cloud admission.

### Source-admission review follow-up — 2026-10-30

The subsequent review reproduced a clean-source bypass when
`status.showUntrackedFiles=no` hid an extra source file. It also verified that a
configured Git filesystem-monitor hook could execute during the earlier source
inspection. The shared verifier now explicitly includes untracked files and
disables that hook. The builder uses it on both sides of cloning instead of
maintaining separate, weaker clean-checkout assertions.

The strengthened existing source/installer regressions passed on Windows and
Linux, including real configured-hook and hidden-file cases. Linux used the
previously scanned image with only the three reviewed source/test files mounted
read-only; this is current-source test evidence, not a new immutable-image scan.
The earlier image/scan identities above remain historical, unchanged evidence.
Rebuild and scan the exact published candidate through normal CI before using
the updated actor. No dependency versions, scanner rules or native desktop
sources changed in this follow-up.

Further source-identity review reproduced a local `refs/replace` substitution:
`HEAD` still reported the expected SHA and ordinary Git status was clean, but
the working tree contained different source. Verification and context-building
commands now use `--no-replace-objects`. The existing regression checks both
direct verification and rejection before cloning; after removing the fixture's
replacement, ordinary verification succeeds again. Both source/installer tests
passed on Windows and Linux without skips, along with the seven security-policy
regressions. Linux again used reviewed read-only overlays, not a newly built or
scanned actor. No real repository replacement refs were changed.
