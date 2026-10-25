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

- API, executor and static web use the same digest-pinned Node **24.22.1 Alpine**
  base. Executor/web no longer inherit end-of-life Node 20 and its older OpenSSL
  and package-manager dependency trees. This changes the server container runtime,
  not desktop's supported OS or project/recording formats.
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

| Image | Platforms | Previous High/Critical | Final High/Critical | Final total findings |
| ----- | --------- | ---------------------: | ------------------: | -------------------: |
| Proxy | amd64, arm64 | 0 | 0 | 0 |
| Web | amd64, arm64 | 27 each | 0 | 0 |
| API | amd64 | 203 | 0 | 67 |
| Executor | amd64 | 191 | 0 | 67 |

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
