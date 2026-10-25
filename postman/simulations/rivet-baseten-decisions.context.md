# Baseten Decisions local simulation

## Purpose

Verify Rivet's actual inline/Profile nodes over local HTTP, without provider
credentials, paid inference or publication. Contract verified 2026-10-26 against
[Baseten's API reference](https://docs.baseten.co/reference/inference-api/system-one)
and [model guide](https://docs.baseten.co/inference/model-apis/decision-models).
The handler in `../mocks/baseten-decisions/default.js` is a repository-owned
stand-in, not a provider-certified mock. Bearer auth follows the API reference;
some model-library snippets instead show Api-Key. No authentication fallback or
automatic write replay under another scheme is introduced.

## Execution

From the repository root, run the listener and client in the same network context:

```sh
postman simulation run postman/simulations/rivet-baseten-decisions.sim.yaml --port 4932 --no-history --output ndjson
yarn workspace @valerypopoff/rivet2-core exec tsx scripts/check-baseten-simulation.mts
```

Stop the listener after verification. The client only substitutes the fixed
Baseten endpoint with a loopback HTTP URL; it preserves the real request body,
headers, method, parsing and cancellation. The key is the dummy `fixture-key`.
No upstream calls, project writes or cloud resources are involved.

## Assumptions

- The listener and client must share a network context. Sandboxed loopback
  isolation can otherwise look like a provider failure. (observed 2026-10-26)
- Run one verification client at a time: the rate-limit fixture deliberately
  maintains one sequential retry cycle. (reasoned 2026-10-26, `../mocks/baseten-decisions/default.js`)
- Owner-workspace discovery required Postman sign-in and was unavailable; the
  public API discovery index did not resolve this API. This repo-owned mock
  establishes no live access, quality, latency, capacity, pricing or CORS claim.
  (observed 2026-10-26)

## Observations

<!-- begin:observations -->

2026-10-26 review: the Baseten member served both models and all typed answer
paths, including `__proto__` question IDs, plus authentication, error, retry
and timeout scenarios. No member was silent. The simulator's answer map was
corrected to preserve prototype-like IDs; production request construction was
already safe. See `packages/core/scripts/check-baseten-simulation.mts`.

2026-10-26 initial verification: both model slugs and actual Profile outputs completed typed Choice/Score/Noul
requests with native inline-image State. Authentication rejection, JSON 503,
HTML 502, malformed successful JSON and a hanging response failed as expected.
The rate-limit scenario returned two 429s then success; an Api-Key header was
rejected with 401. Request diagnostics did not expose the dummy credential.

<!-- end:observations -->
