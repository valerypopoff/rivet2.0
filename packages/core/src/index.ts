import * as RivetTypes from './exports.js';
import { installCodeRunnerNamespace } from './integrations/CodeRunnerNamespace.js';

installCodeRunnerNamespace(RivetTypes);
export * from './exports.js';

export const Rivet: typeof RivetTypes = undefined!;

export type RivetPluginInitializer = (rivet: typeof Rivet) => RivetTypes.RivetPlugin;
