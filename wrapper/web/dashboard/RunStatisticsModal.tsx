import Checkbox from '@atlaskit/checkbox';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useEffect, useMemo, useState, type FC } from 'react';

import type {
  WorkflowRunStatisticsStatusCounts,
  WorkflowRunStatisticsCatalogResponse,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTargetSummary,
} from './types';
import { getWorkflowRunStatisticsTargetKey } from './types';
import { fetchWorkflowRunStatistics, fetchWorkflowRunStatisticsCatalog } from './workflowApi';
import './RunStatisticsModal.css';

type PeriodPreset = '24h' | '7d' | '30d' | '90d' | 'custom';
type RunKind = 'published' | 'latest' | 'both';

type RunStatisticsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const periodOptions: Array<{ value: Exclude<PeriodPreset, 'custom'>; label: string }> = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function getPeriod(preset: Exclude<PeriodPreset, 'custom'>): WorkflowRunStatisticsPeriod {
  const to = new Date();
  const durationByPreset = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
  } as const;
  return {
    from: new Date(to.getTime() - durationByPreset[preset]).toISOString(),
    to: to.toISOString(),
  };
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDuration(value: number | null): string {
  if (value == null) return 'No runs';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} m ${seconds} s`;
}

function formatAxisDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatTargetLabel(summary: WorkflowRunStatisticsTargetSummary): string {
  if (summary.target.surface === 'endpoint') return summary.projectName;
  if (summary.isLegacy) return `Legacy action - ${summary.endpointNameAtExecution ?? 'unknown route'}`;
  const component = summary.componentLabel || summary.componentType || 'Action';
  return `${summary.uiGraphName || 'Web app'} - ${component}`;
}

function getTargetDescription(summary: WorkflowRunStatisticsTargetSummary): string {
  if (summary.target.surface === 'endpoint') {
    return `${summary.totalRuns.toLocaleString()} recorded ${summary.totalRuns === 1 ? 'run' : 'runs'}`;
  }
  return `${summary.projectName} - ${summary.totalRuns.toLocaleString()} recorded ${summary.totalRuns === 1 ? 'run' : 'runs'}`;
}

function getDeltaLabel(value: number | null): { text: string; tone: 'faster' | 'slower' | 'neutral' } {
  if (value == null || value === 0) return { text: 'No change', tone: 'neutral' };
  if (value < 0) return { text: `${formatDuration(Math.abs(value))} faster`, tone: 'faster' };
  return { text: `${formatDuration(value)} slower`, tone: 'slower' };
}

function hasValidPeriod(period: WorkflowRunStatisticsPeriod): boolean {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

function updateDateTimePeriod(
  period: WorkflowRunStatisticsPeriod,
  key: keyof WorkflowRunStatisticsPeriod,
  value: string,
): WorkflowRunStatisticsPeriod {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? { ...period, [key]: new Date(timestamp).toISOString() }
    : { ...period, [key]: value };
}

function MetricCard({
  label,
  value,
  delta,
}: {
  label: string;
  value: number | null;
  delta?: number | null;
}) {
  const deltaLabel = getDeltaLabel(delta ?? null);
  return (
    <div className="run-statistics-metric-card">
      <div className="run-statistics-metric-label">{label}</div>
      <div className="run-statistics-metric-value">{formatDuration(value)}</div>
      {delta !== undefined ? (
        <div className={`run-statistics-metric-delta ${deltaLabel.tone}`}>{deltaLabel.text}</div>
      ) : null}
    </div>
  );
}

function getStatusTotal(counts: WorkflowRunStatisticsStatusCounts): number {
  return counts.succeeded + counts.failed + counts.suspicious;
}

function formatPercentage(count: number, total: number): string {
  if (count === 0 || total === 0) return '0%';
  const percentage = (count / total) * 100;
  return percentage < 1 ? '<1%' : `${Math.round(percentage)}%`;
}

function OutcomeCard({
  label,
  tone,
  count,
  total,
}: {
  label: string;
  tone: 'succeeded' | 'failed' | 'warning';
  count: number;
  total: number;
}) {
  return (
    <div className={`run-statistics-outcome-card ${tone}`}>
      <div className="run-statistics-metric-label">{label}</div>
      <div className="run-statistics-outcome-value">{formatPercentage(count, total)}</div>
      <div className="run-statistics-outcome-count">
        {count.toLocaleString()} of {total.toLocaleString()} {total === 1 ? 'run' : 'runs'}
      </div>
    </div>
  );
}

function StatisticsNavigator({
  surface,
  targets,
  selectedTargetKey,
  onSelect,
}: {
  surface: WorkflowRunStatisticsSurface;
  targets: WorkflowRunStatisticsTargetSummary[];
  selectedTargetKey: string;
  onSelect: (key: string) => void;
}) {
  const groups = useMemo(() => {
    if (surface === 'endpoint') {
      return [{ key: 'endpoints', label: null, targets }];
    }
    const grouped = new Map<string, { label: string; targets: WorkflowRunStatisticsTargetSummary[] }>();
    for (const target of targets) {
      const uiGraphId = 'uiGraphId' in target.target ? target.target.uiGraphId : 'legacy';
      const key = JSON.stringify([target.target.workflowId, uiGraphId]);
      const existing = grouped.get(key) ?? {
        label: target.isLegacy ? target.projectName : `${target.projectName} - ${target.uiGraphName || 'Web app'}`,
        targets: [],
      };
      existing.targets.push(target);
      grouped.set(key, existing);
    }
    return [...grouped.entries()].map(([key, group]) => ({ key, ...group }));
  }, [surface, targets]);

  return (
    <nav className="run-statistics-navigator" aria-label={surface === 'endpoint' ? 'Workflow endpoints' : 'Web app actions'}>
      {groups.map((group) => (
        <div className="run-statistics-target-group" key={group.key}>
          {group.label ? <div className="run-statistics-target-group-label">{group.label}</div> : null}
          {group.targets.map((summary) => {
            const targetKey = getWorkflowRunStatisticsTargetKey(summary.target);
            return (
              <button
                type="button"
                className={`run-statistics-target${selectedTargetKey === targetKey ? ' active' : ''}`}
                key={targetKey}
                onClick={() => onSelect(targetKey)}
              >
                <span className="run-statistics-target-label">{formatTargetLabel(summary)}</span>
                <span className="run-statistics-target-description">{getTargetDescription(summary)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export const RunStatisticsModal: FC<RunStatisticsModalProps> = ({ isOpen, onClose }) => {
  const [surface, setSurface] = useState<WorkflowRunStatisticsSurface>('endpoint');
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('7d');
  const [period, setPeriod] = useState<WorkflowRunStatisticsPeriod>(() => getPeriod('7d'));
  const [runKind, setRunKind] = useState<RunKind>('published');
  const [includeFailed, setIncludeFailed] = useState(false);
  const [includeWarnings, setIncludeWarnings] = useState(false);
  const [catalog, setCatalog] = useState<WorkflowRunStatisticsCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [statistics, setStatistics] = useState<WorkflowRunStatisticsResponse | null>(null);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);

  const selectedTarget = useMemo(
    () => catalog?.targets.find((candidate) => getWorkflowRunStatisticsTargetKey(candidate.target) === selectedTargetKey) ?? null,
    [catalog, selectedTargetKey],
  );
  const validPeriod = hasValidPeriod(period);

  useEffect(() => {
    if (!isOpen || !validPeriod) return;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    void fetchWorkflowRunStatisticsCatalog(surface, period, runKind, { signal: controller.signal })
      .then((nextCatalog) => {
        if (controller.signal.aborted) return;
        setCatalog(nextCatalog);
        setSelectedTargetKey((current) => (
          nextCatalog.targets.some((target) => getWorkflowRunStatisticsTargetKey(target.target) === current)
            ? current
            : (nextCatalog.targets[0] ? getWorkflowRunStatisticsTargetKey(nextCatalog.targets[0].target) : '')
        ));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog(null);
        setSelectedTargetKey('');
        setCatalogError(error instanceof Error ? error.message : 'Unable to load run statistics targets.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [isOpen, period, runKind, surface, validPeriod]);

  useEffect(() => {
    if (!isOpen || !selectedTarget || !validPeriod) {
      setStatistics(null);
      return;
    }
    const controller = new AbortController();
    setStatisticsLoading(true);
    setStatisticsError(null);
    void fetchWorkflowRunStatistics({
      target: selectedTarget.target,
      period,
      runKind,
      includeFailed,
      includeWarnings,
    }, { signal: controller.signal })
      .then((nextStatistics) => {
        if (!controller.signal.aborted) setStatistics(nextStatistics);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatistics(null);
        setStatisticsError(error instanceof Error ? error.message : 'Unable to load run statistics.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatisticsLoading(false);
      });
    return () => controller.abort();
  }, [includeFailed, includeWarnings, isOpen, period, runKind, selectedTarget, validPeriod]);

  if (!isOpen) return null;

  const selectedTitle = selectedTarget ? formatTargetLabel(selectedTarget) : '';
  const excludedCurrent = statistics
    ? statistics.currentExcludedStatusCounts.failed + statistics.currentExcludedStatusCounts.suspicious
    : 0;
  const currentStatusTotal = statistics ? getStatusTotal(statistics.currentStatusCounts) : 0;
  const selectedPeriodLabel = validPeriod
    ? `${timestampFormatter.format(new Date(period.from))} to ${timestampFormatter.format(new Date(period.to))}`
    : 'Choose a valid period';

  return (
    <ModalTransition>
      <ModalDialog testId="run-statistics-modal" width="x-large" label="Run statistics" onClose={onClose}>
        <ModalBody>
          <div className="project-settings-modal-shell run-statistics-shell">
            <div className="project-settings-modal-header-row run-statistics-header-row">
              <div className="project-settings-modal-heading run-statistics-heading">
                <div className="project-settings-modal-title run-statistics-title">Run statistics</div>
                <div className="run-statistics-help">Compare processor execution time across retained run recordings.</div>
              </div>
              <button type="button" className="project-settings-close-button" onClick={onClose} aria-label="Close run statistics">&times;</button>
            </div>

            <div className="project-settings-modal-content run-statistics-content">
              <div className="run-statistics-controls">
                <div className="run-statistics-control-group">
                  <div className="run-recordings-field-label">Runs</div>
                  <div className="run-recordings-segmented">
                    <button type="button" className={`run-recordings-segmented-button${surface === 'endpoint' ? ' active' : ''}`} onClick={() => setSurface('endpoint')}>Endpoints</button>
                    <button type="button" className={`run-recordings-segmented-button${surface === 'web_app' ? ' active' : ''}`} onClick={() => setSurface('web_app')}>Web apps</button>
                  </div>
                </div>
                <div className="run-statistics-control-group">
                  <div className="run-recordings-field-label">Period</div>
                  <div className="run-recordings-segmented run-statistics-period-options">
                    {periodOptions.map((option) => (
                      <button
                        type="button"
                        key={option.value}
                        className={`run-recordings-segmented-button${periodPreset === option.value ? ' active' : ''}`}
                        onClick={() => {
                          setPeriodPreset(option.value);
                          setPeriod(getPeriod(option.value));
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                    <button type="button" className={`run-recordings-segmented-button${periodPreset === 'custom' ? ' active' : ''}`} onClick={() => setPeriodPreset('custom')}>Custom</button>
                  </div>
                </div>
                <div className="run-statistics-control-group">
                  <div className="run-recordings-field-label">Version</div>
                  <div className="run-recordings-segmented">
                    {(['published', 'latest', 'both'] as RunKind[]).map((value) => (
                      <button type="button" key={value} className={`run-recordings-segmented-button${runKind === value ? ' active' : ''}`} onClick={() => setRunKind(value)}>
                        {value === 'both' ? 'Both' : value[0].toUpperCase() + value.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="run-statistics-status-options">
                  <Checkbox label="Include failed runs" isChecked={includeFailed} onChange={(event) => setIncludeFailed(event.currentTarget.checked)} />
                  <Checkbox label="Include runs with warnings" isChecked={includeWarnings} onChange={(event) => setIncludeWarnings(event.currentTarget.checked)} />
                </div>
              </div>

              {periodPreset === 'custom' ? (
                <div className="run-statistics-custom-period">
                  <label>
                    <span>From</span>
                    <input type="datetime-local" value={toDateTimeLocal(period.from)} onChange={(event) => setPeriod((current) => updateDateTimePeriod(current, 'from', event.currentTarget.value))} />
                  </label>
                  <label>
                    <span>To</span>
                    <input type="datetime-local" value={toDateTimeLocal(period.to)} onChange={(event) => setPeriod((current) => updateDateTimePeriod(current, 'to', event.currentTarget.value))} />
                  </label>
                </div>
              ) : null}

              {!validPeriod ? <div className="project-settings-error">The period end must be after its start.</div> : null}
              {catalogError ? <div className="project-settings-error">{catalogError}</div> : null}

              <div className="run-statistics-layout">
                <aside className="run-statistics-sidebar">
                  <div className="run-statistics-sidebar-heading">{surface === 'endpoint' ? 'Workflow endpoints' : 'Web app actions'}</div>
                  {catalogLoading ? <div className="run-statistics-empty-state">Loading available runs...</div> : null}
                  {!catalogLoading && catalog?.targets.length === 0 ? <div className="run-statistics-empty-state">No recorded runs in this period.</div> : null}
                  {!catalogLoading && catalog ? (
                    <StatisticsNavigator surface={surface} targets={catalog.targets} selectedTargetKey={selectedTargetKey} onSelect={setSelectedTargetKey} />
                  ) : null}
                </aside>

                <section className="run-statistics-details" aria-live="polite">
                  {!selectedTarget && !catalogLoading ? <div className="run-statistics-empty-state">Choose a target with recorded runs.</div> : null}
                  {selectedTarget ? (
                    <>
                      <div className="run-statistics-details-heading">
                        <div>
                          <div className="run-statistics-target-title">{selectedTitle}</div>
                          <div className="run-statistics-period-label">{selectedPeriodLabel}</div>
                        </div>
                        {statistics ? <div className="run-statistics-run-count">{statistics.current.runCount.toLocaleString()} included runs</div> : null}
                      </div>
                      {statisticsError ? <div className="project-settings-error">{statisticsError}</div> : null}
                      {statisticsLoading ? <div className="run-statistics-empty-state">Calculating statistics...</div> : null}
                      {statistics && !statisticsLoading ? (
                        <>
                          <div className="run-statistics-metrics">
                            <MetricCard label="Median" value={statistics.current.medianDurationMs} delta={statistics.medianDelta.absoluteMs} />
                            <MetricCard label="P95" value={statistics.current.p95DurationMs} delta={statistics.p95Delta.absoluteMs} />
                            <MetricCard label="Average" value={statistics.current.averageDurationMs} />
                            <MetricCard label="Fastest" value={statistics.current.minDurationMs} />
                            <MetricCard label="Slowest" value={statistics.current.maxDurationMs} />
                          </div>
                          <div className="run-statistics-outcomes" role="region" aria-label="Run outcomes">
                            <div>
                              <div className="run-statistics-chart-heading">Run outcomes</div>
                              <div className="run-statistics-outcomes-help">All matching runs, regardless of the duration filters above.</div>
                            </div>
                            <div className="run-statistics-outcome-cards">
                              <OutcomeCard label="Succeeded" tone="succeeded" count={statistics.currentStatusCounts.succeeded} total={currentStatusTotal} />
                              <OutcomeCard label="Errors" tone="failed" count={statistics.currentStatusCounts.failed} total={currentStatusTotal} />
                              <OutcomeCard label="Warnings" tone="warning" count={statistics.currentStatusCounts.suspicious} total={currentStatusTotal} />
                            </div>
                          </div>
                          {statistics.current.runCount === 0 ? <div className="run-statistics-empty-state">No runs match these filters.</div> : null}
                          {statistics.current.runCount > 0 ? (
                            <div className="run-statistics-chart-card">
                              <div className="run-statistics-chart-heading">Duration over time</div>
                              <div className="run-statistics-chart">
                                <ResponsiveContainer width="100%" height="100%">
                                  <LineChart data={statistics.buckets.map((bucket) => ({ ...bucket, label: timestampFormatter.format(new Date(bucket.from)) }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                                    <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                                    <XAxis dataKey="label" minTickGap={36} tick={{ fill: 'var(--grey-light)', fontSize: 11 }} tickLine={false} axisLine={false} />
                                    <YAxis tickFormatter={formatAxisDuration} tick={{ fill: 'var(--grey-light)', fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
                                    <Tooltip formatter={(value: number | undefined) => formatDuration(value ?? null)} contentStyle={{ background: '#1f2228', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6 }} labelStyle={{ color: '#dfe1e6' }} />
                                    <Legend wrapperStyle={{ fontSize: 12 }} />
                                    <Line type="monotone" dataKey="medianDurationMs" name="Median" stroke="#7ee294" strokeWidth={2} dot={false} connectNulls />
                                    <Line type="monotone" dataKey="p95DurationMs" name="P95" stroke="#f4c95d" strokeWidth={2} dot={false} connectNulls />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          ) : null}
                          <div className="run-statistics-notes">
                            <span>Previous equal period: {statistics.previous.runCount.toLocaleString()} included runs.</span>
                            {excludedCurrent > 0 ? <span>{excludedCurrent.toLocaleString()} failed or warning {excludedCurrent === 1 ? 'run is' : 'runs are'} excluded.</span> : null}
                            <span>Times measure processor execution, not network or recording persistence.</span>
                          </div>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </section>
              </div>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
