import { useEffect, useState } from 'react';
import Button from '@atlaskit/button';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type {
  ResourceHistory,
  ResourceHistoryPoint,
  ResourcePeriod,
  ResourceStatistics,
} from '../../studio-server-shared/resource-monitoring-types';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import { parseJsonResponse } from './apiRequest';
import './ResourceMonitoringPanel.css';

const cpu = (value: number | null | undefined) =>
  value == null ? 'Unavailable' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
const ram = (value: number | null | undefined) =>
  value == null
    ? 'Unavailable'
    : value >= 1024 ** 3
      ? `${(value / 1024 ** 3).toFixed(2)} GiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const allocation = (value: number | null, format: typeof cpu) => (value === null ? 'Not configured' : format(value));
const when = (value: number) => new Date(value).toLocaleString();
const elapsed = (value: number) => `${Math.round(value / 60000).toLocaleString()} min`;
const scope = (source: string) =>
  source === 'node-process' ? 'Process only (Node RSS)' : 'Container (charged memory)';

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
        Coverage: {elapsed(value.coverageMs)} / {elapsed(periodMs)}
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
        <LineChart
          data={points.map((p) => (p.complete ? p : { ...p, [metric]: null }))}
          margin={{ top: 5, right: 20, bottom: 5, left: 12 }}
        >
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
            dot={false}
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

  const pool = data?.pools.find((p) => `pool:${p.scope}:${p.role}` === selected);
  const instance = data?.instances.find((i) => i.identity.incarnation === selected);
  const effective = pool ?? instance ?? data?.pools[0] ?? data?.instances[0];
  const chosen =
    effective && 'identity' in effective
      ? effective.identity.incarnation
      : effective
        ? `pool:${effective.scope}:${effective.role}`
        : '';
  const processOnly =
    effective &&
    ('identity' in effective ? effective.identity.source === 'node-process' : effective.scope === 'process');
  const latest = effective?.latest;
  const latestComplete = latest && (!('complete' in latest) || latest.complete);
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
        samples and can miss shorter spikes.
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
            {data.omittedInstances > 0 ? 'At least ' : ''}
            {data.instances.filter((i) => now - i.lastSampleAt <= data.staleAfterMs).length} currently reporting
            instances · {data.instances.length} histories in this period. Reporting counts are not Kubernetes Pod
            counts.
          </p>
          {data.omittedInstances > 0 ? (
            <p role="status">
              At least {data.omittedInstances} additional instance histories are outside this bounded view. Pool totals
              cover the listed histories.
            </p>
          ) : null}
          {!data.instances.length ? <p>No resource samples have arrived yet.</p> : null}
          {!!effective && (
            <>
              <label className="app-settings-field">
                <span className="app-settings-field-label">History</span>
                <select
                  value={chosen}
                  onChange={(event) => setSelected(event.currentTarget.value)}
                  aria-label="Resource history instance"
                >
                  {data.pools.map((p) => (
                    <option key={`pool:${p.scope}:${p.role}`} value={`pool:${p.scope}:${p.role}`}>
                      {p.role === 'execution' ? 'Execution' : 'Control'} pool —{' '}
                      {p.scope === 'container' ? 'container totals' : 'process-only totals'} (
                      {p.latest ? `${p.latest.reporters} in latest observation` : 'no observations'})
                    </option>
                  ))}
                  {data.instances.map((i) => (
                    <option key={i.identity.incarnation} value={i.identity.incarnation}>
                      {i.identity.name} · {i.identity.role} · {scope(i.identity.source)} ·{' '}
                      {i.identity.incarnation.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              {latest ? (
                <p className="app-settings-field-help">
                  Latest observation: {when(latest.at)} ·{' '}
                  {now - latest.at > data.staleAfterMs ? 'Stale / unavailable' : 'Reporting'}
                  <br />
                  CPU {cpu(latestComplete ? latest.cpuMillicores : null)} · {processOnly ? 'Node RSS' : 'Container RAM'}{' '}
                  {ram(latestComplete ? latest.memoryBytes : null)} · Active published runs{' '}
                  {latest.activeRuns ?? 'Unavailable'} / {latest.runLimit ?? 'Unavailable'}
                  {!latestComplete ? ' · Incomplete reporting coverage' : null}
                </p>
              ) : null}
              <div className="resource-stats">
                <Statistics label="CPU" value={effective.cpu} format={cpu} periodMs={data.to - data.from} />
                <Statistics
                  label={processOnly ? 'Node RSS' : 'Container RAM'}
                  value={effective.memory}
                  format={ram}
                  periodMs={data.to - data.from}
                />
              </div>
              <p className="app-settings-field-help">
                Approximate p95 uses duration-weighted distributions (up to 5% bucket rounding). Gaps remain gaps. Pool
                peaks use aligned reporting samples. Chart points are{' '}
                {data.period === '1h' ? '1-minute' : data.period === '24h' ? '5-minute' : '30-minute'} averages; highest
                observed samples are shown above.
              </p>
              <ResourceChart points={effective.points} metric="cpuMillicores" title="CPU usage (millicores)" />
              <ResourceChart
                points={effective.points}
                metric="memoryBytes"
                title={processOnly ? 'Node process RSS' : 'Container charged memory'}
              />
            </>
          )}
          <div className="resource-instances">
            {data.instances.map((i) => (
              <article className="resource-instance" key={i.identity.incarnation}>
                <div className="resource-header">
                  <strong>
                    {i.identity.name} · {i.identity.role}
                  </strong>
                  <span className={now - i.lastSampleAt > data.staleAfterMs ? 'resource-stale' : 'resource-fresh'}>
                    {now - i.lastSampleAt > data.staleAfterMs ? 'Stale / unavailable' : 'Reporting'}
                  </span>
                </div>
                <small>
                  {scope(i.identity.source)} · {i.identity.source} · {i.identity.incarnation.slice(0, 8)} · Last sample{' '}
                  {when(i.lastSampleAt)}
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
                    <dt>Active published runs / limit</dt>
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
                      <dt>Cgroup lifetime memory high-water</dt>
                      <dd>{ram(i.latest.lifetimeMemoryPeakBytes)}</dd>
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
            Restart and OOM counts are unavailable without authoritative platform data. Process-only measurements
            exclude child executors. Monitoring does not change reservations or concurrency.
          </p>
        </>
      )}
    </section>
  );
}
