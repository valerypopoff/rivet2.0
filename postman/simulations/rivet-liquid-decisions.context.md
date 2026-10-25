# Liquid Decisions local simulation

## Purpose

Exercise Rivet's real Decision AI nodes with d1/d1.1 through local HTTP.
The repo-owned mock in `../mocks/liquid-decisions/default.js` follows the
[hosted model guide](https://docs.liquid.ai/lfm/models/d1), checked 2026-10-26.
It models only the request/answer subset this client exercises, not inference.

## Execution

```sh
postman simulation run postman/simulations/rivet-liquid-decisions.sim.yaml --port 4933 --no-history --output ndjson
yarn workspace @valerypopoff/rivet2-core exec tsx scripts/check-liquid-simulation.mts
```

Wait for the listening event; run listener and client in the same network
context, then stop the listener. Only a dummy key and loopback traffic are used.

## Assumptions

- Owner mock discovery requires Postman sign-in and was unavailable; Orbit
  returned a different provider, not Liquid. The official guide is the source.
  (observed 2026-10-26)
- This verifies request mapping and parsing, not live model availability,
  quality, account access, latency or d1.1 pricing. (reasoned 2026-10-26)

## Observations

<!-- begin:observations -->

2026-10-26: the Liquid member served both model IDs through inline and real
Profile-node paths. Ordered image/text mapping, all three answer types, raw
Usage, d1's revised cost and d1.1's unknown cost passed. No member was silent.
No provider credential, paid inference or production resource was used.

<!-- end:observations -->
