import { setTimeout as sleep } from 'node:timers/promises';

// Deliberately narrow: CrashLoopBackOff, probe failures, OOM, image pulls and
// scheduling delays alone do not prove the packaged program cannot start.
export function fatalStartupReason(log) {
  if (/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/.test(log)) return 'missing-module';
  if (
    /\b(?:ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_PACKAGE_IMPORT_NOT_DEFINED|ERR_INVALID_PACKAGE_CONFIG|ERR_UNKNOWN_FILE_EXTENSION)\b/.test(
      log,
    )
  )
    return 'invalid-program';
  if (
    /SyntaxError: (?:Unexpected token|Unexpected identifier|Invalid or unexpected token|Cannot use import statement|The requested module .* does not provide an export named)/.test(
      log,
    )
  )
    return 'invalid-program';
}

/** Read-only observation. Stop the owned command scope on a proven startup
 * error, then let the caller settle accepted work and clean normally. */
export async function monitorFatalStartup({ listPods, readLog, images, controller, intervalMs = 3000 }) {
  while (!controller.signal.aborted) {
    try {
      for (const pod of await listPods()) {
        if (
          pod.metadata?.deletionTimestamp ||
          !pod.metadata?.ownerReferences?.some(
            (owner) => owner.controller && ['ReplicaSet', 'StatefulSet', 'Job'].includes(owner.kind),
          )
        )
          continue;
        for (const status of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
          const container = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].find(
            (c) => c.name === status.name,
          );
          // A fresh process still starting may recover from its predecessor's
          // failure. Only inspect an exited instance or its crash backoff.
          if (!status.state?.terminated && status.state?.waiting?.reason !== 'CrashLoopBackOff') continue;
          const terminated = status.state?.terminated ?? status.lastState?.terminated;
          if (
            status.ready ||
            !Number.isInteger(terminated?.exitCode) ||
            terminated.exitCode === 0 ||
            !images.includes(container?.image)
          )
            continue;
          // Inspect the terminated instance, not an unrelated current container.
          let log;
          try {
            log = await readLog(pod, status.name, !status.state?.terminated);
          } catch {
            continue; // One stale/unreadable container must not hide other failures.
          }
          const reason = fatalStartupReason(log);
          if (reason) {
            const error = new Error(
              `Packaged container cannot start (${reason}); stopping test commands. Cleanup remains required.`,
            );
            error.code = 'RIVET_FATAL_STARTUP';
            controller.abort(error);
            return;
          }
        }
      }
    } catch {
      // Observation/RBAC/GC errors are not application startup proof. Existing
      // health/deadline checks still fail the test if the rollout cannot finish.
    }
    await sleep(intervalMs, undefined, { signal: controller.signal }).catch(() => {});
  }
}
