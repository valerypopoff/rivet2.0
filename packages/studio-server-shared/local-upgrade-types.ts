/** Non-secret activity reported only by the authenticated local-upgrade API. */
export type LocalUpgradeOperation =
  | 'inspect'
  | 'pause'
  | 'fingerprint'
  | 'copy'
  | 'activate'
  | 'validate'
  | 'return-to-legacy'
  | 'resume'
  | 'cancel';
