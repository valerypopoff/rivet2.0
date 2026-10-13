/** Validate the supported serving boundary before importing the server or opening stores.
 * Migration tools and compatibility fixtures deliberately do not use this entry point.
 */
export function assertServerDeploymentContract(env: NodeJS.ProcessEnv = process.env): void {
  const read = (name: string) => env[name]?.trim();
  const required = {
    RIVET_DEPLOYMENT_TOPOLOGY: 'replicated',
    RIVET_APP_SETTINGS_BACKEND: 'postgres',
    RIVET_DEPLOYMENT_STORAGE_MODE: 'managed',
    RIVET_DEPLOYMENT_DATABASE_MODE: 'managed',
    RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'verify',
  };
  for (const [name, value] of Object.entries(required)) {
    if (read(name) !== value) {
      throw new Error(
        `Rivet Server requires ${name}=${value}. Use a managed container deployment; storage initialization belongs to its migration task. Existing data was not changed.`,
      );
    }
  }
  if (!['control', 'execution', 'evaluation'].includes(read('RIVET_API_PROFILE') ?? '')) {
    throw new Error(
      'Rivet Server requires an explicit control, execution or evaluation API profile. Combined single-host serving is retired.',
    );
  }
  if (
    env.RIVET_LOCAL_METADATA_BOOT_GENERATION?.trim() ||
    env.RIVET_LOCAL_METADATA_CONTROL_ROOT?.trim() ||
    env.RIVET_LOCAL_METADATA_UPGRADE_ENABLED === '1'
  ) {
    throw new Error(
      'Local SQLite serving generations are retired. Export from the previous server and import into a fresh PostgreSQL/S3 installation.',
    );
  }
}
