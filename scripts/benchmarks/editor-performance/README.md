# Local editor performance benchmark

Run from the repository root after installing workspace dependencies and building
Core. No API credentials, production connection or paid environment is needed.

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet2-core run build
node .yarn/releases/yarn-4.17.1.cjs test:benchmark-support
node .yarn/releases/yarn-4.17.1.cjs benchmark:editor --samples 7 --check-loading
```

The runner builds into a fresh ignored `artifacts/benchmarks/editor-performance/`
directory. `--output artifacts/benchmarks/<new-directory>` selects an explicit
destination; an existing run lock prevents overwriting a previous run. It records
the build's Git revision/diff digest and the fixture's compiled Core hash.

Use `--dist <preserved-benchmark-dist>` to compare a previous build with the same
harness. That build must contain `benchmark-source.json` and the attribution
manifest. Do not label the preserved build with the current checkout identity.
Keep one unchanged compiled Core runtime for both sides of a paired UI comparison;
the recorded fixture-runtime hash must match.
Omit `--check-loading` when measuring the pre-optimization build: that flag asserts
no eager Monaco request and tests explicit recovery from a failed editor import.
The eager-load guard finds Monaco by its emitted module attribution and compares
exact emitted asset paths, ignoring request query strings. It does not assume a
chunk name or hash length, and missing Monaco attribution fails instead of
silently treating an empty match as successful deferral.

The HTTP fixture binds an unused loopback port, or refuses an occupied explicit
`RIVET_EDITOR_BENCH_PORT`. An existing local app is never stopped. Set
`PLAYWRIGHT_EXECUTABLE_PATH` only if the installed Playwright browser is elsewhere.
The script uses the repository headless observation runner. Tracing/video are
disabled for timings; a separate untimed repetition captures CPU profiles.

Keep builds and other test suites out of the timed comparison. In particular,
`test:app` prepares Core outputs, so finish it before starting Node/browser
fixtures. Compare steady-state and burst debugger samples separately. Results
include raw timing/resource observations, actual 999-node/10-graph completion,
project-scoped recording evidence, request counts and a final screenshot.

Interruption targets the retained live command's dedicated POSIX group or exact
Windows process tree, never processes found by a port/name search. Completed
command handles are not signalled. Preserve partial artifacts after cancellation;
use a new output directory for a fresh run.
Evidence export, browser contexts, debugger sockets and the HTTP fixture each have
an independently settled finalizer. Failure in one does not skip the others;
finalization failures are reported together with the original workload failure,
if any. This does not retry tests or discover/stop unrelated processes.

The production asset handler serves local files uncompressed. `servedJsBytes`
counts actual response bodies across all frames/workers; unique decoded module
size and per-frame decoded cost are separate metrics. None is a production
bandwidth estimate. Seven samples support median/range comparison, not an SLO.

`serve.mjs <dist> [port]` serves only a local production build for the existing
browser regression suites. Those suites own their API fixtures; it is not a
replacement development API. Stop only the server process started for the check.
