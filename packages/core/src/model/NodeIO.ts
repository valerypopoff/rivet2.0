import type { DataValue } from './DataValue.js';
import type { PortId } from './NodeBase.js';

/** Values accepted by and emitted from a node process invocation. */
export type NodeInputs = Record<PortId, DataValue | undefined>;
export type NodeOutputs = Record<PortId, DataValue | undefined>;
