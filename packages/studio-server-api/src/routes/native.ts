import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  listNativeDirectory,
  mkdirNativePath,
  nativePathExists,
  readNativeBinary,
  readNativeRelative,
  readNativeText,
  removeNativeDirectory,
  removeNativeFile,
  SUPPORTED_NATIVE_BASE_DIRS,
  writeNativeBinary,
  writeNativeText,
} from './native-io.js';

export const nativeRouter = Router();

const baseDirSchema = z.enum(SUPPORTED_NATIVE_BASE_DIRS).optional();

const readdirOptionsSchema = z.object({
  recursive: z.boolean().optional().default(false),
  includeDirectories: z.boolean().optional().default(false),
  filterGlobs: z.array(z.string()).optional().default([]),
  relative: z.boolean().optional().default(false),
  ignores: z.array(z.string()).optional().default([]),
});

const readdirSchema = z.object({
  path: z.string().min(1, 'path is required'),
  baseDir: baseDirSchema,
  options: readdirOptionsSchema.optional().default({
    recursive: false,
    includeDirectories: false,
    filterGlobs: [],
    relative: false,
    ignores: [],
  }),
});

const readPathSchema = z.object({
  path: z.string().min(1, 'path is required'),
  baseDir: baseDirSchema,
});

const writeTextSchema = z.object({
  path: z.string().min(1, 'path is required'),
  contents: z.string(),
  baseDir: baseDirSchema,
});

const writeBinarySchema = z.object({
  path: z.string().min(1, 'path is required'),
  contents: z.string(),
  baseDir: baseDirSchema,
});

const mkdirSchema = z.object({
  path: z.string().min(1, 'path is required'),
  recursive: z.boolean().optional().default(false),
});

const readRelativeSchema = z.object({
  relativeFrom: z.string().min(1, 'relativeFrom is required'),
  projectFilePath: z.string().min(1, 'projectFilePath is required'),
});

nativeRouter.post('/readdir', validateBody(readdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, baseDir, options } = req.body as z.infer<typeof readdirSchema>;
  res.json(await listNativeDirectory(dirPath, baseDir, {
    recursive: options.recursive,
    includeDirectories: options.includeDirectories,
    filterGlobs: options.filterGlobs,
    relative: options.relative,
    ignores: options.ignores,
  }));
}));

nativeRouter.post('/read-text', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  res.json({ contents: await readNativeText(filePath, baseDir) });
}));

nativeRouter.post('/read-binary', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  res.json({ contents: await readNativeBinary(filePath, baseDir) });
}));

nativeRouter.post('/write-text', validateBody(writeTextSchema), asyncHandler(async (req, res) => {
  const { path: filePath, contents, baseDir } = req.body as z.infer<typeof writeTextSchema>;
  await writeNativeText(filePath, contents, baseDir);
  res.json({ success: true });
}));

nativeRouter.post('/write-binary', validateBody(writeBinarySchema), asyncHandler(async (req, res) => {
  const { path: filePath, contents, baseDir } = req.body as z.infer<typeof writeBinarySchema>;
  await writeNativeBinary(filePath, contents, baseDir);
  res.json({ success: true });
}));

nativeRouter.post('/exists', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  res.json({ exists: await nativePathExists(filePath, baseDir) });
}));

nativeRouter.post('/mkdir', validateBody(mkdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, recursive } = req.body as z.infer<typeof mkdirSchema>;
  await mkdirNativePath(dirPath, recursive);
  res.json({ success: true });
}));

nativeRouter.post('/remove-dir', validateBody(mkdirSchema), asyncHandler(async (req, res) => {
  const { path: dirPath, recursive } = req.body as z.infer<typeof mkdirSchema>;
  await removeNativeDirectory(dirPath, recursive);
  res.json({ success: true });
}));

nativeRouter.post('/remove-file', validateBody(readPathSchema), asyncHandler(async (req, res) => {
  const { path: filePath, baseDir } = req.body as z.infer<typeof readPathSchema>;
  await removeNativeFile(filePath, baseDir);
  res.json({ success: true });
}));

nativeRouter.post('/read-relative', validateBody(readRelativeSchema), asyncHandler(async (req, res) => {
  const { relativeFrom, projectFilePath } = req.body as z.infer<typeof readRelativeSchema>;
  res.json({ contents: await readNativeRelative(relativeFrom, projectFilePath) });
}));
