import type { NextFunction, Request, Response } from 'express';

import { runWithAppSettingsSnapshot } from '../app-settings/settings-repository.js';

export function captureAppSettingsSnapshot(_req: Request, _res: Response, next: NextFunction): void {
  runWithAppSettingsSnapshot(next);
}
