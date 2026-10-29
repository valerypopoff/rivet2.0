import {
  captureDisplayAdmission,
  checkDisplayAdmission,
  type DisplayAdmission,
  type DisplayRejection,
} from './executionDisplayPolicy.js';
import type { ProjectBinding } from './projectBindingRegistry.js';
import type { ExecutionSourceKind } from './executionEventNormalization.js';

/** Metadata only. Never owns execution controls, payloads or reference effects. */
export function createExecutionObservationCoordinator() {
  const runs = new Map<object, Map<string, DisplayAdmission>>();
  const diagnostics: Array<{
    root: string;
    projectId: string;
    reason: DisplayRejection;
    sourceProjectId: string;
    sourceKind?: ExecutionSourceKind;
    bindingToken?: number;
    currentBindingToken?: number;
  }> = [];
  return {
    get(source: object, root: string) {
      return runs.get(source)?.get(root);
    },
    capture(
      source: object,
      root: string,
      projectId: string,
      receivers: Map<string, Pick<ProjectBinding, 'token'>>,
      conflict: (id: string) => boolean,
      requireSourceBinding = true,
      sourceKind?: ExecutionSourceKind,
    ) {
      let roots = runs.get(source);
      if (!roots) runs.set(source, (roots = new Map()));
      const old = roots.get(root);
      if (old) return old;
      const admission = captureDisplayAdmission(projectId, receivers, conflict, requireSourceBinding);
      admission.sourceKind = sourceKind;
      roots.set(root, admission);
      return admission;
    },
    check(
      admission: DisplayAdmission,
      root: string,
      id: string,
      current: (id: string) => Pick<ProjectBinding, 'token'> | undefined,
      conflict: (id: string) => boolean,
    ) {
      const reason = checkDisplayAdmission(admission, id, current, conflict);
      if (reason) {
        diagnostics.push({
          root,
          projectId: id,
          reason,
          sourceProjectId: admission.sourceProjectId,
          sourceKind: admission.sourceKind,
          bindingToken: admission.receivers.get(id)?.token,
          currentBindingToken: current(id)?.token,
        });
        if (diagnostics.length > 64) diagnostics.shift();
      }
      return reason;
    },
    settle(source: object, root: string) {
      const roots = runs.get(source);
      roots?.delete(root);
      if (!roots?.size) runs.delete(source);
    },
    disconnect(source: object) {
      runs.delete(source);
    },
    dispose() {
      runs.clear();
      diagnostics.length = 0;
    },
    inspect: () => ({
      sources: runs.size,
      roots: [...runs.values()].reduce((n, roots) => n + roots.size, 0),
      diagnostics: [...diagnostics],
    }),
  };
}
