import { isReleaseMaintenanceActive } from '../../release-maintenance.js';
import { isVmMigrationMaintenanceActive } from '../../vm-migration-maintenance.js';

export function isRecordingCompactionPaused(): boolean {
  return isReleaseMaintenanceActive() || isVmMigrationMaintenanceActive();
}
