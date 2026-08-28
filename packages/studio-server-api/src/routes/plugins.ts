import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest } from '../utils/httpError.js';
import {
  appendInstallLog,
  ensurePluginReady,
  getPluginDir,
  normalizePluginPackageName,
  normalizePluginTag,
  validatePluginPackagePath,
} from './plugin-installer.js';

export const pluginsRouter = Router();

const pluginRequestSchema = z.object({
  package: z.string().transform((value, ctx) => {
    try {
      return normalizePluginPackageName(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid plugin package name',
      });
      return z.NEVER;
    }
  }),
  tag: z.string().transform((value, ctx) => {
    try {
      return normalizePluginTag(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'Invalid plugin tag',
      });
      return z.NEVER;
    }
  }),
});

pluginsRouter.post('/install-package', validateBody(pluginRequestSchema), asyncHandler(async (req, res) => {
  const { package: pkg, tag } = req.body as z.infer<typeof pluginRequestSchema>;

  let log = '';
  const addLog = (message: string) => {
    log += `${message}\n`;
  };

  try {
    await ensurePluginReady(pkg, tag, addLog);
  } catch (error) {
    throw appendInstallLog(error, log);
  }

  addLog(`Plugin ready: ${pkg}@${tag}`);
  res.json({ success: true, log });
}));

pluginsRouter.post('/load-package-main', validateBody(pluginRequestSchema), asyncHandler(async (req, res) => {
  const { package: pkg, tag } = req.body as z.infer<typeof pluginRequestSchema>;
  await ensurePluginReady(pkg, tag, () => undefined);
  const pluginDir = getPluginDir(pkg, tag);
  const pluginFilesPath = path.join(pluginDir, 'package');
  const pkgJsonPath = path.join(pluginFilesPath, 'package.json');
  const pkgJsonData = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8')) as { main?: string };
  const main = pkgJsonData.main;

  if (!main) {
    throw badRequest(`No main field in package.json for ${pkg}@${tag}`);
  }

  const mainPath = path.join(pluginFilesPath, main);
  const safePath = validatePluginPackagePath(pluginFilesPath, mainPath);
  const contents = await fs.readFile(safePath, 'utf-8');
  res.json({ contents });
}));
