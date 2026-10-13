// Qualification gates must prove API readiness, not a frontend/login HTTP 200
// or the special healthy-process response used during restore maintenance.
export function assertRuntimeReadiness({ status, body }) {
  if (status !== 200) throw new Error(`/readyz returned HTTP ${status}`);
  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch {
    throw new Error(`/readyz returned non-JSON content (HTTP ${status}); check proxy health routing`);
  }
  if (snapshot?.ok !== true || snapshot.state !== 'ready' || snapshot.restoreMaintenance === true)
    throw new Error(`/readyz did not report a ready runtime (HTTP ${status})`);
}
