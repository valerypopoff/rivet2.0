import FeatureGates, { FeatureGateEnvironment } from '@atlaskit/feature-gate-js-client';

let initPromise: Promise<void> | null = null;

export function initializeFeatureGates(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  const environment = import.meta.env.DEV
    ? FeatureGateEnvironment.Development
    : FeatureGateEnvironment.Production;

  initPromise = FeatureGates.initializeFromValues(
    {
      environment,
      sdkKey: 'client-default-key',
      localMode: true,
    },
    {},
    {},
    {},
  ).catch(() => {
    // Atlaskit components should fall back to defaults even if initialization fails.
  });

  return initPromise;
}
