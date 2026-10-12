// No imports of old launchers: rejection must happen before Docker, stores or
// host directories are touched. Historical helpers remain for migration tests.
console.error(
  'This Rivet Server launch mode is retired. Use yarn studio-server:dev for local Kubernetes, or yarn studio-server:kubernetes:release for a VM/cluster installation. PostgreSQL and S3-compatible storage are required. Export existing data with the previous release before upgrading; this command does not migrate or delete it.',
);
process.exitCode = 1;
