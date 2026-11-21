export type TransitionIdentity = {
  protocol: 1;
  release: string;
  namespace: string;
  context: string;
  requiredEncodings?: string[];
};
export function serveRecordingTransitionGuard(
  check: () => Promise<void>,
  identity: TransitionIdentity,
): Promise<{ url: string; close(): Promise<void> }>;
export function assertRecordingTransitionGuard(
  identity: Omit<TransitionIdentity, 'protocol'>,
  required?: boolean,
): Promise<TransitionIdentity | undefined>;
