# Rivet decision image simulation

## Purpose

Repo-owned Jev and OpenAI contract subsets for shared State and question-local
Instructions; see their handlers, not a live model-quality or account-access test.

## Execution

Run `postman simulation run postman/simulations/rivet-jev-images.sim.yaml --port 4921 --no-history --output ndjson`,
then `node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet2-core exec tsx scripts/check-jev-image-simulation.mts`.
Use the printed listener address; stop the owned simulation with Ctrl+C after checking request receipts.

## Assumptions

- Contracts come from official provider documentation; owner-mock discovery requires
  unavailable Postman login. No live upstream requests are made. (observed 2026-10-25)
- Both client and listener must run outside the Windows sandbox together; mixed
  sandbox contexts cannot connect over loopback. Only dummy credentials and a generated
  PNG are used. (observed 2026-10-25)

## Observations

<!-- begin:observations -->

2026-10-25: Added documented Jev Box requests with shared/question-local images in
inline/Profile modes; both members served traffic and expected missing-header
requests still failed. Box coordinates/confidence survived the real HTTP/parser path.
2026-10-25: Both members served real node requests: Jev shared State plus Jev/OpenAI
question Instructions in inline/Profile modes, native/assembled PNGs; expected
missing-header requests were rejected. No silent members.

<!-- end:observations -->

## What didn't work

- 2026-10-25: Sandbox Postman startup crashed with `GetFileType` in the dataset daemon.
  Running the same local command outside the sandbox resolved startup.
