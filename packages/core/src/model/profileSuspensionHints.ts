/** Shared inspector wording for LLM and Classifier profile suspension. */
export const profileSuspensionHints = {
  host: 'Requires Studio Server or a host with shared profile health. Not available in standalone Rivet.',
  enable: 'Suspend this profile after provider failures or timeouts. After suspension, allow one recovery attempt.',
  threshold: 'Failures or timeouts within the failure window needed to suspend this profile.',
  window: 'Rolling period for counting failures and timeouts.',
  duration: 'Time to suspend this profile before one recovery attempt.',
} as const;
