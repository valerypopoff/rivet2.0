import Checkbox from '@atlaskit/checkbox';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import Select from '@atlaskit/select';
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
  WorkflowRunStatisticsAggregation,
  WorkflowRunStatisticsPeriod,
  WorkflowRunStatisticsResponse,
  WorkflowRunStatisticsSurface,
  WorkflowRunStatisticsTargetSummary,
} from './types';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import { getWorkflowRunStatisticsTargetKey } from './types';
import { fetchWorkflowRunStatistics, fetchWorkflowRunStatisticsCatalog } from './workflowApi';
import './RunStatisticsModal.css';

type PeriodPreset = '24h' | '7d' | '30d' | '90d' | 'custom';
type RunKind = 'published' | 'latest' | 'both';
type ChartGrouping = Exclude<WorkflowRunStatisticsAggregation, 'auto'>;

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

// Green, yellow, and red are reserved for run outcomes in this modal.
const CHART_MEDIAN_COLOR = '#5aa9ff';
const CHART_P95_COLOR = '#c58aff';
const costFormatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 6 });

function formatCost(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'Unavailable' : costFormatter.format(value);
}

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

function hasValidPeriod(period: WorkflowRunStatisticsPeriod): boolean {
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}

function getCatalogQueryKey(
  surface: WorkflowRunStatisticsSurface,
): string {
  return surface;
}

function getStatisticsQueryKey(
  target: WorkflowRunStatisticsTargetSummary['target'],
  period: WorkflowRunStatisticsPeriod,
  runKind: RunKind,
  includeFailed: boolean,
  includeWarnings: boolean,
  durationGrouping: ChartGrouping,
  costGrouping: ChartGrouping,
): string {
  return JSON.stringify([
    getWorkflowRunStatisticsTargetKey(target),
    period.from,
    period.to,
    runKind,
    includeFailed,
    includeWarnings,
    durationGrouping,
    costGrouping,
  ]);
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

function MetricCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="run-statistics-metric-card">
      <div className="run-statistics-metric-label">{label}</div>
      <div className="run-statistics-metric-value">{formatDuration(value)}</div>
    </div>
  );
}

function ChartGroupingControl({ label, value, onChange }: {
  label: string;
  value: ChartGrouping;
  onChange: (value: ChartGrouping) => void;
}) {
  return (
    <SegmentedControl label={label}>
      <SegmentedControlButton selected={value === 'day'} onClick={() => onChange('day')}>By day</SegmentedControlButton>
      <SegmentedControlButton selected={value === 'week'} onClick={() => onChange('week')}>By week</SegmentedControlButton>
    </SegmentedControl>
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
      <div className="run-statistics-outcome-heading">
        <div className="run-statistics-metric-label">{label}</div>
        <div className="run-statistics-outcome-value" title="Share of included runs">{total > 0 ? formatPercentage(count, total) : '—'}</div>
      </div>
      <div className="run-statistics-outcome-count">
        {count.toLocaleString()} {count === 1 ? 'run' : 'runs'}
      </div>
    </div>
  );
}

type StatisticsTargetOption = {
  description: string;
  label: string;
  value: string;
};

function StatisticsTargetSelect({
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
  const options = useMemo<StatisticsTargetOption[]>(
    () => targets.map((summary) => ({
      description: getTargetDescription(summary),
      label: formatTargetLabel(summary),
      value: getWorkflowRunStatisticsTargetKey(summary.target),
    })),
    [targets],
  );
  const label = surface === 'endpoint' ? 'Workflow endpoint' : 'Web app action';

  return (
    <Select
      inputId="run-statistics-target-select"
      className="run-statistics-target-select"
      classNamePrefix="run-statistics-target-select"
      options={options}
      value={options.find((option) => option.value === selectedTargetKey) ?? null}
      onChange={(option: StatisticsTargetOption | null) => onSelect(option?.value ?? '')}
      formatOptionLabel={(option: StatisticsTargetOption, { context }: { context: 'menu' | 'value' }) => (
        <div className="run-statistics-target-option">
          <div className="run-statistics-target-option-label">{option.label}</div>
          {context === 'menu' ? <div className="run-statistics-target-option-description">{option.description}</div> : null}
        </div>
      )}
      isSearchable={options.length > 8}
      menuPlacement="auto"
      menuPortalTarget={typeof document === 'undefined' ? undefined : document.body}
      menuPosition="fixed"
      aria-label={label}
    />
  );
}

export const RunStatisticsModal: FC<RunStatisticsModalProps> = ({ isOpen, onClose }) => {
  const [surface, setSurface] = useState<WorkflowRunStatisticsSurface>('endpoint');
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('7d');
  const [period, setPeriod] = useState<WorkflowRunStatisticsPeriod>(() => getPeriod('7d'));
  const [runKind, setRunKind] = useState<RunKind>('published');
  const [durationGrouping, setDurationGrouping] = useState<ChartGrouping>('day');
  const [costGrouping, setCostGrouping] = useState<ChartGrouping>('day');
  const [includeFailed, setIncludeFailed] = useState(false);
  const [includeWarnings, setIncludeWarnings] = useState(false);
  const [catalog, setCatalog] = useState<WorkflowRunStatisticsCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogResultKey, setCatalogResultKey] = useState<string | null>(null);
  const [selectedTargetKey, setSelectedTargetKey] = useState('');
  const [statistics, setStatistics] = useState<WorkflowRunStatisticsResponse | null>(null);
  const [statisticsLoading, setStatisticsLoading] = useState(false);
  const [statisticsError, setStatisticsError] = useState<string | null>(null);
  const [statisticsResultKey, setStatisticsResultKey] = useState<string | null>(null);

  const validPeriod = hasValidPeriod(period);
  const catalogQueryKey = getCatalogQueryKey(surface);
  const catalogReady = Boolean(catalog && !catalogLoading && catalogResultKey === catalogQueryKey);
  const selectedTarget = useMemo(
    () => (
      catalogReady
        ? catalog?.targets.find((candidate) => getWorkflowRunStatisticsTargetKey(candidate.target) === selectedTargetKey) ?? null
        : null
    ),
    [catalog, catalogReady, selectedTargetKey],
  );
  const statisticsQueryKey = selectedTarget
    ? getStatisticsQueryKey(selectedTarget.target, period, runKind, includeFailed, includeWarnings, durationGrouping, costGrouping)
    : null;
  const statisticsReady = Boolean(
    statistics &&
    !statisticsLoading &&
    statisticsQueryKey &&
    statisticsResultKey === statisticsQueryKey,
  );

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const requestKey = catalogQueryKey;
    setCatalogLoading(true);
    setCatalogError(null);
    void fetchWorkflowRunStatisticsCatalog(surface, { signal: controller.signal })
      .then((nextCatalog) => {
        if (controller.signal.aborted) return;
        setCatalog(nextCatalog);
        setCatalogResultKey(requestKey);
        setSelectedTargetKey((current) => (
          nextCatalog.targets.some((target) => getWorkflowRunStatisticsTargetKey(target.target) === current)
            ? current
            : (nextCatalog.targets[0] ? getWorkflowRunStatisticsTargetKey(nextCatalog.targets[0].target) : '')
        ));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalog(null);
        setCatalogResultKey(requestKey);
        setSelectedTargetKey('');
        setCatalogError(error instanceof Error ? error.message : 'Unable to load run statistics targets.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [catalogQueryKey, isOpen, surface]);

  useEffect(() => {
    if (!isOpen || !selectedTarget || !validPeriod) {
      setStatistics(null);
      setStatisticsResultKey(null);
      return;
    }
    const controller = new AbortController();
    const requestKey = statisticsQueryKey;
    setStatisticsLoading(true);
    setStatisticsError(null);
    void fetchWorkflowRunStatistics(
      {
        target: selectedTarget.target,
        period,
        runKind,
        includeFailed,
        includeWarnings,
        aggregation: durationGrouping,
        costAggregation: costGrouping,
      },
      { signal: controller.signal },
    )
      .then((nextStatistics) => {
        if (controller.signal.aborted) return;
        setStatistics(nextStatistics);
        setStatisticsResultKey(requestKey);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatistics(null);
        setStatisticsResultKey(requestKey);
        setStatisticsError(error instanceof Error ? error.message : 'Unable to load run statistics.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatisticsLoading(false);
      });
    return () => controller.abort();
  }, [isOpen, selectedTarget, statisticsQueryKey, validPeriod]);

  if (!isOpen) return null;

  const currentStatusTotal = statistics ? getStatusTotal(statistics.currentStatusCounts) : 0;
  const includedStatusTotal = statistics ? statistics.currentStatusCounts.succeeded
    + (includeFailed ? statistics.currentStatusCounts.failed : 0)
    + (includeWarnings ? statistics.currentStatusCounts.suspicious : 0) : 0;
  const selectedPeriodLabel = validPeriod
    ? `${timestampFormatter.format(new Date(period.from))} to ${timestampFormatter.format(new Date(period.to))}`
    : 'Choose a valid period';

  return (
    <ModalTransition>
      <ModalDialog testId="run-statistics-modal" label="Run statistics" onClose={onClose}>
        <ModalBody>
          <div className="project-settings-modal-shell run-statistics-shell">
            <div className="project-settings-modal-header-row run-statistics-header-row">
              <div className="run-statistics-header-content">
                <div className="project-settings-modal-heading run-statistics-heading">
                  <div className="project-settings-modal-title run-statistics-title">Run statistics</div>
                  <div className="run-statistics-help">Compare duration and estimated AI cost across retained run recordings.</div>
                </div>
                <SegmentedControl className="run-statistics-surface-switcher" label="Run type">
                  <SegmentedControlButton selected={surface === 'endpoint'} onClick={() => setSurface('endpoint')}>Endpoints</SegmentedControlButton>
                  <SegmentedControlButton selected={surface === 'web_app'} onClick={() => setSurface('web_app')}>Web apps</SegmentedControlButton>
                </SegmentedControl>
              </div>
              <button type="button" className="project-settings-close-button" onClick={onClose} aria-label="Close run statistics">&times;</button>
            </div>

            <div className="project-settings-modal-content run-statistics-content">
              <div className="run-statistics-target-control">
                <div className="run-recordings-field-label">{surface === 'endpoint' ? 'Workflow endpoint' : 'Web app action'}</div>
                {catalogLoading ? <div className="run-statistics-empty-state">Loading available runs...</div> : null}
                {catalogReady && catalog?.targets.length === 0 ? <div className="run-statistics-empty-state">No retained recorded runs.</div> : null}
                {catalogReady && catalog ? (
                  <StatisticsTargetSelect surface={surface} targets={catalog.targets} selectedTargetKey={selectedTargetKey} onSelect={setSelectedTargetKey} />
                ) : null}
                {catalogError && catalogResultKey === catalogQueryKey ? <div className="project-settings-error">{catalogError}</div> : null}
              </div>

              <div className="run-statistics-controls">
                <div className="run-statistics-control-group">
                  <div className="run-recordings-field-label">Period</div>
                  <SegmentedControl className="run-statistics-period-options" label="Period">
                    {periodOptions.map((option) => (
                      <SegmentedControlButton
                        key={option.value}
                        selected={periodPreset === option.value}
                        onClick={() => {
                          setPeriodPreset(option.value);
                          setPeriod(getPeriod(option.value));
                        }}
                      >
                        {option.label}
                      </SegmentedControlButton>
                    ))}
                    <SegmentedControlButton selected={periodPreset === 'custom'} onClick={() => setPeriodPreset('custom')}>Custom</SegmentedControlButton>
                  </SegmentedControl>
                </div>
                <div className="run-statistics-control-group">
                  <div className="run-recordings-field-label">Version</div>
                  <SegmentedControl label="Version">
                    {(['published', 'latest', 'both'] as RunKind[]).map((value) => (
                      <SegmentedControlButton key={value} selected={runKind === value} onClick={() => setRunKind(value)}>
                        {value === 'both' ? 'Both' : value[0].toUpperCase() + value.slice(1)}
                      </SegmentedControlButton>
                    ))}
                  </SegmentedControl>
                </div>
                <div className="run-statistics-control-group">
                  <div className="run-statistics-status-options" role="group" aria-label="Included runs">
                    <Checkbox label="Include failed runs" isChecked={includeFailed} onChange={(event) => setIncludeFailed(event.currentTarget.checked)} />
                    <Checkbox label="Include runs with warnings" isChecked={includeWarnings} onChange={(event) => setIncludeWarnings(event.currentTarget.checked)} />
                  </div>
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
              {statisticsReady && currentStatusTotal === 0 ? (
                <div className="run-statistics-empty-state">No runs for this target match the selected period and version.</div>
              ) : null}
              <section className="run-statistics-details" aria-live="polite">
                {catalogReady && !selectedTarget ? <div className="run-statistics-empty-state">Choose a target with recorded runs.</div> : null}
                {selectedTarget ? (
                  <>
                    <div className="run-statistics-period-label">{statisticsReady ? `${includedStatusTotal.toLocaleString()} ${includedStatusTotal === 1 ? 'run' : 'runs'}, ` : ''}{selectedPeriodLabel}</div>
                    {statisticsError && statisticsResultKey === statisticsQueryKey ? <div className="project-settings-error">{statisticsError}</div> : null}
                    {statisticsLoading ? <div className="run-statistics-empty-state">Calculating statistics...</div> : null}
                    {statisticsReady && currentStatusTotal > 0 ? (
                      <>
                          {includeFailed || includeWarnings ? <div className="run-statistics-outcomes" role="region" aria-label="Run outcomes">
                            <div className="run-statistics-outcome-cards">
                              <OutcomeCard label="Succeeded" tone="succeeded" count={statistics.currentStatusCounts.succeeded} total={includedStatusTotal} />
                              {includeFailed ? <OutcomeCard label="Errors" tone="failed" count={statistics.currentStatusCounts.failed} total={includedStatusTotal} /> : null}
                              {includeWarnings ? <OutcomeCard label="Warnings" tone="warning" count={statistics.currentStatusCounts.suspicious} total={includedStatusTotal} /> : null}
                            </div>
                          </div> : null}
                          <section className="run-statistics-section" role="region" aria-label="Timing statistics">
                            <div className="run-statistics-chart-header">
                              <div className="run-statistics-chart-heading">Duration</div>
                              <ChartGroupingControl label="Duration chart grouping" value={durationGrouping} onChange={setDurationGrouping} />
                            </div>
                            <div className="run-statistics-statistics-help">Processor execution time, excluding network and recording persistence.</div>
                            <div className="run-statistics-metrics">
                              <MetricCard label="Median" value={statistics.current.medianDurationMs} />
                              <MetricCard label="P95" value={statistics.current.p95DurationMs} />
                              <MetricCard label="Average" value={statistics.current.averageDurationMs} />
                              <MetricCard label="Fastest" value={statistics.current.minDurationMs} />
                              <MetricCard label="Slowest" value={statistics.current.maxDurationMs} />
                            </div>
                            {statistics.current.runCount === 0 ? <div className="run-statistics-empty-state">No runs match these statistics filters.</div> : null}
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
                                      <Line type="monotone" dataKey="medianDurationMs" name="Median" stroke={CHART_MEDIAN_COLOR} strokeWidth={2} dot={false} connectNulls />
                                      <Line type="monotone" dataKey="p95DurationMs" name="P95" stroke={CHART_P95_COLOR} strokeWidth={2} dot={false} connectNulls />
                                    </LineChart>
                                  </ResponsiveContainer>
                                </div>
                              </div>
                            ) : null}
                          </section>
                          <section className="run-statistics-section" role="region" aria-label="Cost statistics">
                            <div className="run-statistics-chart-header">
                              <div className="run-statistics-chart-heading">Cost</div>
                              <ChartGroupingControl label="Cost chart grouping" value={costGrouping} onChange={setCostGrouping} />
                            </div>
                            <div className="run-statistics-statistics-help">Supported LLM and Decision AI estimates for included runs, including called projects and background work; not provider invoices.</div>
                            {statistics.cost && statistics.costBuckets ? (
                              <>
                                <div className="run-statistics-cost-metrics">
                                  <div className="run-statistics-metric-card"><div className="run-statistics-metric-label">Known subtotal</div><div className="run-statistics-metric-value">{formatCost(statistics.cost.knownCostUsd)}</div></div>
                                  <div className="run-statistics-metric-card"><div className="run-statistics-metric-label">Average per complete run</div><div className="run-statistics-metric-value">{formatCost(statistics.cost.averageCompleteCostUsd)}</div></div>
                                </div>
                                {statistics.cost.partialCount + statistics.cost.unknownCount > 0 ? <div className="run-statistics-notes">Known subtotal can omit costs from partial or unknown runs.</div> : null}
                                {statistics.costBuckets.some((bucket) => bucket.knownCostUsd != null) ? (
                                  <div className="run-statistics-chart-card">
                                    <div className="run-statistics-chart-heading">Cost over time</div>
                                    {!statistics.costBuckets.some((bucket) => bucket.averageCompleteCostUsd != null) ? (
                                      <div className="run-statistics-empty-state">No complete cost estimates to average for these runs.</div>
                                    ) : null}
                                    <div className="run-statistics-chart">
                                      <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={statistics.costBuckets.map((bucket) => ({ ...bucket, label: timestampFormatter.format(new Date(bucket.from)) }))} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                                          <CartesianGrid stroke="rgba(255, 255, 255, 0.08)" vertical={false} />
                                          <XAxis dataKey="label" minTickGap={36} tick={{ fill: 'var(--grey-light)', fontSize: 11 }} tickLine={false} axisLine={false} />
                                          <YAxis tickFormatter={formatCost} tick={{ fill: 'var(--grey-light)', fontSize: 11 }} tickLine={false} axisLine={false} width={76} />
                                          <Tooltip formatter={(value: number | undefined) => formatCost(value)} contentStyle={{ background: '#1f2228', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6 }} labelStyle={{ color: '#dfe1e6' }} />
                                          <Legend wrapperStyle={{ fontSize: 12 }} />
                                          <Line type="linear" dataKey="knownCostUsd" name="Known subtotal" stroke={CHART_MEDIAN_COLOR} strokeWidth={2} connectNulls={false} />
                                          <Line type="linear" dataKey="averageCompleteCostUsd" name="Average per complete run" stroke={CHART_P95_COLOR} strokeWidth={2} connectNulls={false} />
                                        </LineChart>
                                      </ResponsiveContainer>
                                    </div>
                                  </div>
                                ) : <div className="run-statistics-empty-state">No known cost estimates for these runs.</div>}
                              </>
                            ) : <div className="run-statistics-empty-state">Cost statistics are not available from this server yet.</div>}
                          </section>
                      </>
                    ) : null}
                  </>
                ) : null}
              </section>
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
