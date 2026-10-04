# Dependency audit policy and October 2026 triage

Run `yarn security:audit` before committing dependency changes. High/critical
findings are blocking unless their exact advisory, package and immediate dependent
have a current documented exception in `security/dependency-audit-exceptions.json`.
Critical findings cannot be waived; new dependents and expired/unused exceptions
still fail. Do not broaden exceptions to every consumer of a package.

Tooling-only exceptions should also list exact `workspaceOwners`. The audit resolves
their offline `yarn why -R <dependent> --json` ancestry, including Yarn's deduplicated
references, and rejects any newly reachable workspace even if the immediate npm
dependent is unchanged. Missing or malformed ancestry fails closed. The two October
exceptions below use this additional constraint; older exceptions retain their
existing immediate-dependent policy. Review owners again when changing dependency
paths; workspace ownership alone is not proof that a use remains build-time-only.

Audit reports fail closed on unknown severity, malformed finding rows, error
diagnostics, signals and unexpected child exit codes. Yarn's normal exit 1 for
findings and its explicit `No audit suggestions` info record are supported; a
partial report followed by an error must never become a passing audit. Exceptions
require real `YYYY-MM-DD` calendar dates, not dates JavaScript rolls into the next
month. Regression fixtures cover these boundaries alongside expiry, critical
findings and unreviewed consumers.
The audit child suppresses Node runtime warnings (not security advisories) so
unexpected stderr also blocks certification, even if stdout contains valid rows.

## 2026-10-04 follow-up

- `braces` advisory 1240992 / [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  3.0.3 is still the latest npm release. The audited `chokidar@3.5.3` path belongs
  to Docusaurus and executor build tooling (`esbuild-plugin-copy`), not Rivet
  request-time project execution. Watch patterns must remain repository-controlled;
  never feed remote/user-controlled glob patterns into these watchers.
- `http-cache-semantics` advisory 1240991 /
  [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp):
  the audited `cacheable-request@10.2.14` path comes only from Docusaurus's
  update-notifier public npm metadata lookup, through latest-version, package-json
  and got. It is not an authenticated, cross-user server cache.

Both exceptions expire **2026-10-10**. They accept those reviewed tooling paths
temporarily; they do not claim the vulnerable packages are fixed or waive runtime
use. Reassess the paths and available upstream fixes before expiry.

An apparent new release is not proof of remediation. `http-cache-semantics@4.3.0`
was published on October 4 and blocked by Yarn's one-day minimum-age gate. The
registry archive's SHA-512 integrity and `index.js` were checked against its exact
upstream commit `b1d4bd682fbab0252985de45219f4e7497c0067c`. Synthetic shared-cache
policies for Set-Cookie and proxy-revalidate responses still returned
`satisfiesWithoutRevalidation: true` with `max-stale=999999`, despite `maxAge() === 0`.
It was therefore not installed, and the age gate remains unchanged. Test the
actual prohibited cache-reuse cases before removing the exception; merely moving
beyond an advisory's version range is insufficient.

## CI test contracts

`yarn test:style` continues rejecting new production-source-reading tests. Static
Compose/proxy contracts live in the repository verifier; runtime bootstrap failures
are covered by the browser observer. A local `test-style: fixture-read:` annotation
is appropriate only when reading test-owned generated artifacts, serialized project
fixtures or published documentation assets, never production implementation text.

Node output-selection/replay tests must expect Core's scalar
`control-flow-excluded` marker for an entirely pruned split output, with an undefined
value. Executed sibling outputs remain ordinary arrays. The repeated-loop test
checks both cases, fresh child identities and the serialized replay round-trip;
do not reintroduce a fabricated `control-flow-excluded[]` type.

Generated Graph Builder policy assets must also be refreshed after changing LLM
node defaults: `yarn check:graph-builder-policy --write`, then inspect the diff and
run `yarn test:style`. The October follow-up regenerated the two model nodes with
explicit default `errorOnNon200: true` and `catchRequestFailed: false`; prompts,
connections and model behavior were not changed.
