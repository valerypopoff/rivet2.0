import { type GraphId } from '@valerypopoff/rivet2-core';
import { type PluginState } from '../../state/plugins.js';
import { type GraphReachabilityBucket, type GraphReachabilityReport } from '../../utils/graphReachability.js';

export type GraphListReachabilityPresentation = {
  bucketByGraphId: Record<GraphId, GraphReachabilityBucket>;
  showUnreachableIndicators: boolean;
  notice?: string;
};

type GraphListReachabilityPluginState = Pick<PluginState, 'loaded' | 'error'>;

export function buildGraphListReachabilityPresentation(options: {
  report: GraphReachabilityReport;
  graphIds: GraphId[];
  plugins: GraphListReachabilityPluginState[];
}): GraphListReachabilityPresentation {
  const { report, graphIds, plugins } = options;
  const bucketByGraphId = {} as Record<GraphId, GraphReachabilityBucket>;

  for (const graphId of graphIds) {
    bucketByGraphId[graphId] = getBucketForGraph(graphId, report);
  }

  const waitingForPlugins = plugins.some((plugin) => !plugin.loaded && !plugin.error);
  if (waitingForPlugins) {
    return {
      bucketByGraphId,
      showUnreachableIndicators: false,
      notice: 'Unreachable graph analysis is waiting for app plugins to load.',
    };
  }

  if (report.status === 'blocked') {
    return {
      bucketByGraphId,
      showUnreachableIndicators: false,
      notice: getBlockedAnalysisNotice(report),
    };
  }

  if (report.status === 'partial') {
    return {
      bucketByGraphId,
      showUnreachableIndicators: true,
      notice: getPartialAnalysisNotice(report),
    };
  }

  return {
    bucketByGraphId,
    showUnreachableIndicators: true,
  };
}

function getBucketForGraph(graphId: GraphId, report: GraphReachabilityReport): GraphReachabilityBucket {
  if (report.definite.has(graphId)) {
    return 'definitely-reachable';
  }

  if (report.dynamic.has(graphId)) {
    return 'dynamically-reachable';
  }

  return 'unreachable';
}

function getPartialAnalysisNotice(report: GraphReachabilityReport): string {
  const reasons = new Set(report.unsupportedReasons);

  if (reasons.has('unregistered-node-type') && reasons.has('third-party-plugin-node')) {
    return 'Unreachable graph analysis may be incomplete for unsupported or third-party plugin nodes.';
  }

  if (reasons.has('unregistered-node-type')) {
    return 'Unreachable graph analysis may be incomplete for unsupported node types.';
  }

  return 'Unreachable graph analysis may be incomplete for third-party plugin nodes.';
}

function getBlockedAnalysisNotice(report: GraphReachabilityReport): string | undefined {
  if (report.blockedReason === 'missing-main-graph') {
    return undefined;
  }

  return 'Set a valid Main Graph in Project settings to see unreachable graphs.';
}
