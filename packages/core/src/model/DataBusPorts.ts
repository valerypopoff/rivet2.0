import type { PortId } from './NodeBase.js';

const INPUT_PORT_PATTERN = /^input([1-9]\d*)$/;
const OUTPUT_PORT_PATTERN = /^output([1-9]\d*)$/;

/** Shared hard safety limit for the dynamic Data Bus channel port range. */
export const MAX_DATA_BUS_CHANNEL_INDEX = 10_000;

function assertDataBusChannelIndex(channelIndex: number): void {
  if (
    !Number.isSafeInteger(channelIndex) ||
    channelIndex < 1 ||
    channelIndex > MAX_DATA_BUS_CHANNEL_INDEX
  ) {
    throw new RangeError(
      `Data Bus channel index must be a safe integer from 1 to ${MAX_DATA_BUS_CHANNEL_INDEX}.`,
    );
  }
}

export function parseDataBusChannelIndex(portId: string, input: boolean): number | undefined {
  const match = (input ? INPUT_PORT_PATTERN : OUTPUT_PORT_PATTERN).exec(portId);
  const channelIndex = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(channelIndex) && channelIndex > 0 && channelIndex <= MAX_DATA_BUS_CHANNEL_INDEX
    ? channelIndex
    : undefined;
}

export function getDataBusInputPortId(channelIndex: number): PortId {
  assertDataBusChannelIndex(channelIndex);
  return `input${channelIndex}` as PortId;
}

export function getDataBusOutputPortId(channelIndex: number): PortId {
  assertDataBusChannelIndex(channelIndex);
  return `output${channelIndex}` as PortId;
}
