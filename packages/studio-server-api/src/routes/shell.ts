import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { getCommandTimeout, getMaxOutputBytes, isShellAllowed, validatePath } from '../security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { exec } from '../utils/exec.js';

export const shellRouter = Router();

const execOptionsSchema = z.object({
  cwd: z.string().min(1).optional(),
});

const execSchema = z.object({
  program: z.string().min(1, 'program is required'),
  args: z.array(z.string()).default([]),
  options: execOptionsSchema.default({}),
});

shellRouter.post('/exec', validateBody(execSchema), asyncHandler(async (req, res) => {
  const { program, args, options } = req.body as z.infer<typeof execSchema>;

  if (!isShellAllowed(program)) {
    res.status(403).json({ error: `Command not allowed: ${program}` });
    return;
  }

  let cwd = options.cwd;
  if (cwd) {
    cwd = validatePath(cwd);
  }

  const timeout = getCommandTimeout();
  const maxOutput = getMaxOutputBytes();
  const result = await exec(program, args, { cwd, timeoutMs: timeout, maxOutputBytes: maxOutput });
  res.json(result);
}));
