/** Non-secret activity reported only by the authenticated local-upgrade API. */
export type LocalUpgradeOperation =
  | 'prepare'
  | 'restart'
  | 'inspect'
  | 'pause'
  | 'fingerprint'
  | 'backup'
  | 'copy'
  | 'activate'
  | 'validate'
  | 'return-to-legacy'
  | 'resume'
  | 'cancel';
