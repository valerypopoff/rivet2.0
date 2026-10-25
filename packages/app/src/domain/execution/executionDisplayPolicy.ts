import type { ProjectBinding } from './projectBindingRegistry.js';
import type { ExecutionSourceKind } from './executionEventNormalization.js';

export type DisplayRejection = 'closed-or-rebound' | 'ownership-conflict' | 'not-captured' | 'source-rebound';
export type DisplayAdmission = {
  sourceKind?: ExecutionSourceKind;
  sourceProjectId: string;
  requireSourceBinding: boolean;
  receivers: Map<string, ProjectBinding>;
  graphOwners: Map<string, string>;
  blocked: Map<string, DisplayRejection>;
};

/** Common lifetime rules; callers supply mode-specific ownership/eligibility policy. */
export function captureDisplayAdmission(
  sourceProjectId: string,
  receivers: Map<string, Pick<ProjectBinding, 'token'>>,
  conflict: (id: string) => boolean,
  requireSourceBinding = true,
): DisplayAdmission {
  const admission: DisplayAdmission = {
    sourceProjectId,
    requireSourceBinding,
    receivers: new Map(receivers),
    graphOwners: new Map(),
    blocked: new Map(),
  };
  for (const id of receivers.keys())
    if (id !== sourceProjectId && conflict(id)) admission.blocked.set(id, 'ownership-conflict');
  return admission;
}

export function checkDisplayAdmission(
  admission: DisplayAdmission,
  id: string,
  current: (id: string) => Pick<ProjectBinding, 'token'> | undefined,
  conflict: (id: string) => boolean,
): DisplayRejection | undefined {
  const source = admission.receivers.get(admission.sourceProjectId);
  if (admission.requireSourceBinding && (!source || source.token !== current(admission.sourceProjectId)?.token))
    return 'source-rebound';
  const rejected = admission.blocked.get(id);
  if (rejected) return rejected;
  const receiver = admission.receivers.get(id);
  if (!receiver) return 'not-captured';
  const reason =
    receiver.token !== current(id)?.token
      ? 'closed-or-rebound'
      : id !== admission.sourceProjectId && conflict(id)
        ? 'ownership-conflict'
        : undefined;
  if (reason) admission.blocked.set(id, reason);
  return reason;
}
