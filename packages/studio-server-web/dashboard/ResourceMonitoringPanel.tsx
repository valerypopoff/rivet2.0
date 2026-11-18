import { useEffect, useState } from 'react';
import Button from '@atlaskit/button';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  ResourceHistory,
  ResourceHistoryPoint,
  ResourceIdentity,
  ResourcePeriod,
  ResourcePoolHistory,
  ResourceRole,
  ResourceSource,
  ResourceStatistics,
} from '../../studio-server-shared/resource-monitoring-types';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';
import { SegmentedControl, SegmentedControlButton } from './SegmentedControl';
import './ResourceMonitoringPanel.css';

const cpu = (value: number | null | undefined) =>
  value == null ? 'Unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
const ram = (value: number | null | undefined) =>
  value == null
    ? 'Unavailable'
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const allocation = (value: number | null, format: typeof cpu) => (value === null ? 'Not reported' : format(value));
const when = (value: number) => new Date(value).toLocaleString();
const elapsed = (value: number) => `${Math.round(value / 60000).toLocaleString()} min`;
const scope = (source: ResourceSource) => (source === 'node-process' ? 'Server process only (RSS)' : 'Whole container');
const roleLabel: Record<ResourceRole, string> = {
  execution: 'Execution replica',
  control: 'Editor and dashboard replica',
  combined: 'Combined server',
};
const viewKey = (view: Pick<ResourcePoolHistory, 'scope' | 'role'>) => `pool:${view.scope}:${view.role}`;
const sessionView = (identity: ResourceIdentity): Pick<ResourcePoolHistory, 'scope' | 'role'> => ({
  scope: identity.source === 'node-process' ? 'process' : 'container',
  role: identity.role === 'control' ? 'control' : 'execution',
});

function Statistics({
  label,
  value,
  format,
  periodMs,
}: {
  label: string;
  value: ResourceStatistics;
  format: typeof cpu;
  periodMs: number;
}) {
  return (
    <div className="resource-stat">
      <strong>{label}</strong>
      <span>Average {format(value.average)}</span>
      <span>Approx. p95 {format(value.p95)}</span>
      <span>Highest observed {format(value.peak)}</span>
      <small>
        Sampled time: {elapsed(value.coverageMs)} / {elapsed(periodMs)}
      </small>
    </div>
  );
}

function ResourceChart({
  points,
  metric,
  title,
}: {
  points: ResourceHistoryPoint[];
  metric: 'cpuMillicores' | 'memoryBytes';
  title: string;
}) {
  const format = metric === 'cpuMillicores' ? cpu : ram;
  return (
    <div className="resource-chart" aria-label={title}>
      <h4>{title}</h4>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={points} margin={{ top: 5, right: 20, bottom: 5, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, #444)" />
          <XAxis
            dataKey="at"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            minTickGap={45}
            tickFormatter={(at: number) =>
              new Date(at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            }
          />
          <YAxis tickFormatter={(value: number) => format(value)} width={85} />
          <Tooltip
            labelFormatter={(at) => when(Number(at))}
            formatter={(value) => format(value == null ? null : Number(value))}
          />
          <Line
            type="linear"
            dataKey={metric}
            name={title}
            stroke={metric === 'cpuMillicores' ? '#64b5f6' : '#c5a0ff'}
            dot={points.filter((p) => p[metric] != null).length === 1 ? { r: 3 } : false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ResourceMonitoringPanel() {
  const [period, setPeriod] = useState<ResourcePeriod>('1h');
  const [data, setData] = useState<ResourceHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('pool:container:execution');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let disposed = false,
      flight: AbortController | undefined;
    const refresh = async () => {
      if (disposed) return;
      setNow(Date.now());
      if (flight) return;
      const controller = new AbortController();
      flight = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 10000);
      try {
        const next = await parseJsonResponse<ResourceHistory>(
          await fetch(`${RIVET_API_BASE_URL}/deployment-status/resources?period=${period}`, {
            signal: controller.signal,
          }),
        );
        if (!disposed) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!disposed)
          setError(
            timedOut
              ? 'Monitoring request timed out.'
              : e instanceof Error
                ? e.message
                : 'Monitoring could not be refreshed.',
          );
      } finally {
        window.clearTimeout(timeout);
        flight = undefined;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      flight?.abort();
    };
  }, [period]);

  const views = new Map(
    [...(data?.pools ?? []), ...(data?.instances.map((i) => sessionView(i.identity)) ?? [])].map((view) => [
      viewKey(view),
      view,
    ]),
  );
  const chosen = views.has(selected) ? selected : views.keys().next().value ?? '';
  const effective = data?.pools.find((p) => viewKey(p) === chosen);
  const processOnly = views.get(chosen)?.scope === 'process';
  const latest = effective?.latest;
  const latestComplete = latest?.complete;
  const visibleInstances = data?.instances.filter((i) => viewKey(sessionView(i.identity)) === chosen) ?? [];
  const recentSessionCount = data ? data.instances.filter((i) => now - i.lastSampleAt <= data.staleAfterMs).length : 0;
  return (
    <section
      className="app-settings-section deployment-status-section resource-monitoring"
      aria-label="Resource monitoring"
    >
      <div className="resource-header">
        <div className="app-settings-section-title">CPU and RAM monitoring</div>
        <div className="resource-periods" aria-label="Resource history period">
          {(['1h', '24h', '7d'] as const).map((p) => (
            <Button key={p} isSelected={period === p} onClick={() => setPeriod(p)}>
              {p === '1h' ? '1 hour' : p === '24h' ? '24 hours' : '7 days'}
            </Button>
          ))}
        </div>
      </div>
      <p className="app-settings-field-help">
        Collected in the background every 5 seconds. History is retained for 7 days. Peaks are the highest observed
        samples and can miss shorter spikes. CPU is shown in millicores: 1000m = 1 CPU core.
      </p>
      {error || data?.error ? (
        <div className="project-settings-error" role="status">
          {error ?? data?.error}
        </div>
      ) : null}
      {!data && !error ? <p role="status">Loading resource observations…</p> : null}
      {data?.period !== period && data ? <p role="status">Loading selected period…</p> : null}
      {data && (
        <>
          <p className="app-settings-field-help">
            Across all views: {data.omittedInstances > 0 ? 'At least ' : ''}
            {recentSessionCount} monitoring session{recentSessionCount === 1 ? '' : 's'} reported within the last{' '}
            {Math.round(data.staleAfterMs / 1000)} seconds · {data.instances.length} session
            {data.instances.length === 1 ? '' : 's'} available for this period.
          </p>
          <p className="app-settings-field-help">
            Each start of a monitored server process creates a new monitoring session. Data covers execution and
            editor/dashboard replicas. Session counts are not live replica or Kubernetes Pod counts.
          </p>
          {data.omittedInstances > 0 ? (
            <p role="status">
              At least {data.omittedInstances} additional monitoring{' '}
              {data.omittedInstances === 1 ? 'session is' : 'sessions are'} not shown. Totals cover only the sessions
              included in this view.
            </p>
          ) : null}
          {!data.instances.length ? <p>No resource samples have arrived yet.</p> : null}
          {views.size > 0 ? (
            <div className="app-settings-field">
              <span className="app-settings-field-label">Resource view</span>
              <SegmentedControl className="resource-views" label="Resource view">
                {[...views].map(([key, view]) => (
                  <SegmentedControlButton key={key} selected={chosen === key} onClick={() => setSelected(key)}>
                    {view.role === 'execution' ? 'Execution replicas' : 'Editor and dashboard replicas'}
                    {view.scope === 'process' ? ' — server process only (RSS)' : ''}
                  </SegmentedControlButton>
                ))}
              </SegmentedControl>
            </div>
          ) : null}
          {effective ? (
            <>
              {latest ? (
                <p className="app-settings-field-help">
                  Latest sample: {when(latest.at)} · {latest.reporters} session{latest.reporters === 1 ? '' : 's'} ·{' '}
                  {now - latest.at > data.staleAfterMs ? 'No recent samples' : 'Recent samples'}
                  <br />
                  CPU {cpu(latestComplete ? latest.cpuMillicores : null)} ·{' '}
                  {processOnly ? 'Server process RAM (RSS)' : 'Container RAM'}{' '}
                  {ram(latestComplete ? latest.memoryBytes : null)} · Active published runs{' '}
                  {latest.activeRuns ?? 'Unavailable'} / {latest.runLimit ?? 'Unavailable'}
                  {!latestComplete ? ' · Incomplete reporting coverage' : null}
                </p>
              ) : null}
              <div className="resource-stats">
                <Statistics label="CPU" value={effective.cpu} format={cpu} periodMs={data.to - data.from} />
                <Statistics
                  label={processOnly ? 'Server process RAM (RSS)' : 'Container RAM'}
                  value={effective.memory}
                  format={ram}
                  periodMs={data.to - data.from}
                />
              </div>
              <p className="app-settings-field-help">
                Approximate p95 is the usage level that measurements stayed at or below for about 95% of sampled time.
                Gaps remain gaps. Totals use samples taken at the same time. Chart points are{' '}
                {data.period === '1h' ? '1-minute' : data.period === '24h' ? '5-minute' : '30-minute'} averages; highest
                observed samples are shown above. Partial intervals use only complete samples.
              </p>
              <p className="app-settings-field-help">
                Totals use samples from the same role and measurement scope. Session details below cover this resource
                view.
              </p>
              <p className="app-settings-field-help">
                Container RAM includes child processes and filesystem cache. Server process RAM (RSS, or resident
                memory) excludes child processes.
              </p>
              <ResourceChart points={effective.points} metric="cpuMillicores" title="CPU usage (millicores)" />
              <ResourceChart
                points={effective.points}
                metric="memoryBytes"
                title={processOnly ? 'Server process RAM (RSS)' : 'Container RAM usage'}
              />
            </>
          ) : views.size > 0 ? (
            <p role="status">Historical totals are not available yet. Latest session readings are shown below.</p>
          ) : null}
          <div className="resource-instances">
            {visibleInstances.map((i) => (
              <article className="resource-instance" key={i.identity.incarnation}>
                <div className="resource-header">
                  <strong>
                    {i.identity.name} · {roleLabel[i.identity.role]}
                  </strong>
                  <span className={now - i.lastSampleAt > data.staleAfterMs ? 'resource-stale' : 'resource-fresh'}>
                    {now - i.lastSampleAt > data.staleAfterMs ? 'No recent samples' : 'Recent samples'}
                  </span>
                </div>
                <small>
                  {scope(i.identity.source)} · {i.identity.source} · Monitoring session{' '}
                  {i.identity.incarnation.slice(0, 8)} · Last sample {when(i.lastSampleAt)}
                </small>
                <dl className="resource-values">
                  <div>
                    <dt>Latest CPU / RAM</dt>
                    <dd>
                      {cpu(i.latest.cpuMillicores)} / {ram(i.latest.memoryBytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>CPU / RAM reservations</dt>
                    <dd>
                      {allocation(i.allocation.cpuRequestMillicores, cpu)} /{' '}
                      {allocation(i.allocation.memoryRequestBytes, ram)}
                    </dd>
                  </div>
                  <div>
                    <dt>CPU / RAM limits</dt>
                    <dd>
                      {allocation(i.allocation.cpuLimitMillicores, cpu)} /{' '}
                      {allocation(i.allocation.memoryLimitBytes, ram)}
                    </dd>
                  </div>
                  <div>
                    <dt>Active published runs / replica limit</dt>
                    <dd>
                      {i.latest.activeRuns === null
                        ? 'Unavailable'
                        : `${i.latest.activeRuns} / ${i.latest.runLimit ?? 'Unavailable'}`}
                    </dd>
                  </div>
                  {i.latest.workingSetBytes !== null ? (
                    <div>
                      <dt>Estimated working set</dt>
                      <dd>{ram(i.latest.workingSetBytes)}</dd>
                    </div>
                  ) : null}
                  {i.latest.lifetimeMemoryPeakBytes !== null ? (
                    <div>
                      <dt>Container lifetime RAM peak</dt>
                      <dd>
                        {ram(i.latest.lifetimeMemoryPeakBytes)}
                        <br />
                        <small>Across the container lifetime, not just the selected period.</small>
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {i.droppedSamples > 0 ? (
                  <small>{i.droppedSamples} sample observations dropped; history may contain gaps.</small>
                ) : null}
              </article>
            ))}
          </div>
          <p className="app-settings-field-help">
            Restart counts and out-of-memory (OOM) kills are unavailable without platform data. Monitoring does not
            change resource requests, limits or execution concurrency.
          </p>
        </>
      )}
    </section>
  );
}
