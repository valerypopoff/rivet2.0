import {
  sanitizeProjectExecutorMode,
  type ProjectExecutorMode,
} from '../../../../rivet/packages/app/src/utils/projectExecutorMode.js';
import { normalizeRuntimeWebSocketUrl } from '../../../shared/hosted-env';

export function normalizeHostedProjectExecutorMode(value: unknown): ProjectExecutorMode | undefined {
  const mode = sanitizeProjectExecutorMode(value);
  if (mode?.type !== 'remote-debugger') {
    return mode;
  }

  return {
    type: 'remote-debugger',
    url: normalizeRuntimeWebSocketUrl(mode.url),
  };
}
