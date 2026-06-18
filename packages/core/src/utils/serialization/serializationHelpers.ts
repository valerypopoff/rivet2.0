/**
 * Shared serialization helpers used by V3 and V4 serializers.
 * Connection format, visual data encoding, and YAML envelope logic.
 */

import type { NodeConnection, NodeId, PortId, ChartNode } from '../../index.js';
import stableStringify from 'safe-stable-stringify';
// @ts-ignore
import * as yaml from 'yaml';

// ---- Connection serialization (shared by V3 and V4) ----

/**
 * Connection format: `outputPortId->"Target Node Title" targetNodeId/inputPortId`
 */
export type SerializedNodeConnection = `${string}->"${string}" ${string}/${string}`;

const CONNECTION_BEND_MARKER = ' __rivet_bend:';
const CONNECTION_BEND_MARKER_TITLE_FALLBACK = ' __rivet bend:';
const FINITE_NUMBER_PATTERN = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CONNECTION_BEND_PATTERN = new RegExp(
  `${CONNECTION_BEND_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${FINITE_NUMBER_PATTERN}),(${FINITE_NUMBER_PATTERN})$`,
);

export function serializeConnection(connection: NodeConnection, allNodes: ChartNode[]): SerializedNodeConnection {
  const targetTitle = serializeConnectionTargetTitle(
    allNodes.find((node) => node.id === connection.inputNodeId)?.title ?? '',
  );
  const bendPoint =
    connection.bendPoint && Number.isFinite(connection.bendPoint.x) && Number.isFinite(connection.bendPoint.y)
      ? `${CONNECTION_BEND_MARKER}${connection.bendPoint.x},${connection.bendPoint.y}`
      : '';

  return `${connection.outputId}->"${targetTitle}${bendPoint}" ${connection.inputNodeId}/${connection.inputId}`;
}

export function deserializeConnection(
  connection: SerializedNodeConnection,
  sourceNodeId: NodeId,
): NodeConnection {
  const match = connection.match(/(.+)->"(.*)"\s+(.+)\/(.+)/);
  if (!match) {
    throw new Error(`Invalid connection: ${connection}`);
  }
  const [, outputId, targetTitle, inputNodeId, inputId] = match;
  const bendPoint = deserializeConnectionBendPoint(targetTitle);

  return {
    outputId: outputId as PortId,
    outputNodeId: sourceNodeId,
    inputId: inputId as PortId,
    inputNodeId: inputNodeId as NodeId,
    ...(bendPoint ? { bendPoint } : {}),
  };
}

function serializeConnectionTargetTitle(targetTitle: string): string {
  return targetTitle.replaceAll(CONNECTION_BEND_MARKER, CONNECTION_BEND_MARKER_TITLE_FALLBACK);
}

function deserializeConnectionBendPoint(targetTitle: string | undefined): NodeConnection['bendPoint'] | undefined {
  const match = targetTitle?.match(CONNECTION_BEND_PATTERN);
  if (!match) {
    return undefined;
  }

  const x = Number.parseFloat(match[1]!);
  const y = Number.parseFloat(match[2]!);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

// ---- Visual data encoding (shared parsing) ----

export type VisualDataParts = {
  x: number;
  y: number;
  width: number | undefined;
  zIndex: number | undefined;
  borderColor?: string;
  bgColor?: string;
};

function parseOptionalFloat(val: string | undefined): number | undefined {
  return val === 'null' || val === undefined || val === '' ? undefined : parseFloat(val);
}

/** Parse `x/y/width/zIndex` or `x/y/width/zIndex/borderColor/bgColor` */
export function parseVisualData(packed: string): VisualDataParts {
  const parts = packed.split('/');
  const [x, y, width, zIndex, borderColor, bgColor] = parts;
  return {
    x: parseFloat(x!),
    y: parseFloat(y!),
    width: parseOptionalFloat(width),
    zIndex: parseOptionalFloat(zIndex),
    borderColor: borderColor || undefined,
    bgColor: bgColor || undefined,
  };
}

/** Encode visual data as `x/y/width/zIndex` (V3) */
export function packVisualDataV3(node: ChartNode): string {
  return `${node.visualData.x}/${node.visualData.y}/${node.visualData.width ?? 'null'}/${node.visualData.zIndex ?? 'null'}`;
}

/** Encode visual data as `x/y/width/zIndex/borderColor/bgColor` (V4) */
export function packVisualDataV4(node: ChartNode): string {
  return `${node.visualData.x}/${node.visualData.y}/${node.visualData.width ?? 'null'}/${node.visualData.zIndex ?? 'null'}/${node.visualData.color?.border ?? ''}/${node.visualData.color?.bg ?? ''}`;
}

// ---- YAML envelope ----

export function wrapInYamlEnvelope(version: number, data: unknown): string {
  const stabilized = JSON.parse(stableStringify(data) ?? '{}');
  return yaml.stringify({ version, data: stabilized }, null, { indent: 2 });
}

export function unwrapYamlEnvelope<T>(raw: unknown, expectedVersion: number, label: string): T {
  if (typeof raw !== 'string' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`${label} deserializer requires a string`);
  }

  const parsed = (typeof raw === 'string' ? yaml.parse(raw) : raw) as { version: number; data: T };
  if (parsed.version !== expectedVersion) {
    throw new Error(`${label} deserializer requires a version ${expectedVersion} ${label.toLowerCase()}`);
  }
  return parsed.data;
}
