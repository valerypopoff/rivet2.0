import type { Pool, PoolClient, QueryConfig } from 'pg';
import type {
  ResourceHistory,
  ResourceInstanceHistory,
  ResourcePeriod,
  ResourceReport,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';
import { RESOURCE_PERIODS, resourceStatistics, fillResourceHistory, summarizeResourceSamples } from './history.js';
import { RESOURCE_SAMPLE_MS, RESOURCE_STALE_MS } from './sampler.js';

export const RESOURCE_RETENTION_MS = 7 * 86400000;
export const RESOURCE_MAX_INSTANCES = 64;
const query = (text: string, values?: unknown[]): QueryConfig & { query_timeout: number } => ({
  text,
  values,
  query_timeout: 6000,
});

// One statement atomically updates bounded batches. Replayed or older partial
// minutes cannot inflate statistics or overwrite a newer observation.
const WRITE_SQL = `WITH reports AS (
  SELECT value AS r FROM jsonb_array_elements($1::jsonb)
), owners AS (
  INSERT INTO resource_monitoring_instances AS existing
    (installation,incarnation,role,name,source,allocation,first_at,last_at,latest,dropped_samples)
  SELECT r#>>'{identity,installation}',r#>>'{identity,incarnation}',r#>>'{identity,role}',
    r#>>'{identity,name}',r#>>'{identity,source}',r->'allocation',
    (SELECT min((s->>'at')::bigint) FROM jsonb_array_elements(r->'buckets') b CROSS JOIN LATERAL jsonb_array_elements(b->'samples') s),
    (r->'latest'->>'at')::bigint,r->'latest',(r->>'droppedSamples')::bigint FROM reports
  ORDER BY r#>>'{identity,incarnation}'
  ON CONFLICT (installation,incarnation) DO UPDATE SET
    first_at=LEAST(existing.first_at,EXCLUDED.first_at),last_at=GREATEST(existing.last_at,EXCLUDED.last_at),
    latest=CASE WHEN EXCLUDED.last_at>=existing.last_at THEN EXCLUDED.latest ELSE existing.latest END,
    allocation=CASE WHEN EXCLUDED.last_at>=existing.last_at THEN EXCLUDED.allocation ELSE existing.allocation END,
    dropped_samples=GREATEST(existing.dropped_samples,EXCLUDED.dropped_samples)
  WHERE existing.role=EXCLUDED.role AND existing.source=EXCLUDED.source AND existing.name=EXCLUDED.name
  RETURNING installation,incarnation
)
INSERT INTO resource_monitoring_minutes AS existing (installation,incarnation,bucket_at,revision,samples,summary)
SELECT o.installation,o.incarnation,(b->>'at')::bigint,(b->>'revision')::bigint,b->'samples',b->'summary'
FROM reports CROSS JOIN LATERAL jsonb_array_elements(r->'buckets') b
JOIN owners o ON o.installation=r#>>'{identity,installation}' AND o.incarnation=r#>>'{identity,incarnation}'
ON CONFLICT (installation,incarnation,bucket_at) DO UPDATE SET revision=EXCLUDED.revision,samples=EXCLUDED.samples,summary=EXCLUDED.summary
WHERE EXCLUDED.revision>existing.revision`;

// Aggregate on PostgreSQL, not by transferring seven days of raw samples to
// every browser. At most 64 instances and 337 chart points per series emerge.
const HISTORY_SQL = `WITH selected AS MATERIALIZED (
  SELECT *,CASE WHEN source='node-process' THEN 'process' ELSE 'container' END AS scope,
    CASE WHEN role='control' THEN 'control' ELSE 'execution' END AS pool_role
  FROM resource_monitoring_instances WHERE installation=$1 AND last_at >= $2
  ORDER BY last_at DESC,incarnation LIMIT 64
), observations AS MATERIALIZED (
  SELECT i.incarnation,i.pool_role,i.scope,b.bucket_at,b.summary<>'{}'::jsonb AS summarized,s.at,
    GREATEST(0,LEAST(s.at,$3)-GREATEST(s.at-s."durationMs",$2)) AS weight,
    s."cpuMillicores" AS cpu,s."memoryBytes" AS memory,
    s."workingSetBytes" AS working,s."activeRuns" AS active,s."runLimit" AS run_limit
  FROM resource_monitoring_minutes b JOIN selected i USING(installation,incarnation)
  CROSS JOIN LATERAL jsonb_to_recordset(b.samples) AS s(at double precision,"durationMs" double precision,
    "cpuMillicores" double precision,"memoryBytes" double precision,"workingSetBytes" double precision,
    "activeRuns" double precision,"runLimit" double precision)
  WHERE b.installation=$1 AND b.bucket_at >= $2-60000 AND b.bucket_at <= $3
    AND s.at >= $2 AND s.at <= $3
), aligned AS (
  SELECT *,floor(at/5000)*5000 AS slot FROM observations
), pool_observations AS MATERIALIZED (
  SELECT a.scope,a.pool_role,a.slot AS at,MIN(a.weight) AS weight,COUNT(*)::int AS reporters,
    COUNT(*)=(SELECT count(*) FROM selected i WHERE i.scope=a.scope AND i.pool_role=a.pool_role
      AND i.first_at <= a.slot+5000 AND i.last_at>=a.slot)
      AND MAX(a.at)-MIN(a.at)<=1000 AND MIN(a.weight)>=4500 AND MAX(a.weight)<=5500 AS complete,
    CASE WHEN COUNT(a.cpu)=COUNT(*) THEN SUM(a.cpu) END AS cpu,SUM(a.memory) AS memory,
    CASE WHEN COUNT(a.working)=COUNT(*) THEN SUM(a.working) END AS working,
    CASE WHEN COUNT(a.active)=COUNT(*) THEN SUM(a.active) END AS active,
    CASE WHEN COUNT(a.run_limit)=COUNT(*) THEN SUM(a.run_limit) END AS run_limit
  FROM aligned a GROUP BY a.scope,a.pool_role,a.slot
), field_values AS (
  SELECT incarnation AS id,f.field,f.value,weight FROM observations
    CROSS JOIN LATERAL(VALUES('cpu',cpu),('memory',memory),('workingSet',working)) f(field,value)
    WHERE NOT summarized OR bucket_at<$2+12500 OR bucket_at+60000>$3
  UNION ALL
  SELECT 'pool:'||scope||':'||pool_role,f.field,f.value,weight FROM pool_observations
    CROSS JOIN LATERAL(VALUES('cpu',cpu),('memory',memory)) f(field,value) WHERE complete
), contributions AS (
  SELECT i.incarnation AS id,f.key AS field,bin.key::double precision AS upper,
    (bin.value->>'weight')::double precision AS weight,(bin.value->>'sum')::double precision AS sum,
    (bin.value->>'peak')::double precision AS peak
  FROM resource_monitoring_minutes b JOIN selected i USING(installation,incarnation)
  CROSS JOIN LATERAL jsonb_each(b.summary) f CROSS JOIN LATERAL jsonb_each(f.value) bin
  WHERE b.installation=$1 AND b.bucket_at >= $2+12500 AND b.bucket_at+60000 <= $3
  UNION ALL
  SELECT id,field,CASE WHEN value=0 THEN 0 ELSE power(1.05,ceil(ln(value)/ln(1.05))) END,
    weight,value*weight,value FROM field_values WHERE value IS NOT NULL
), histogram AS (
  SELECT id,field,upper,SUM(weight) AS weight,SUM(sum) AS sum,MAX(peak) AS peak
  FROM contributions GROUP BY id,field,upper
), histograms AS (
  SELECT id,field,jsonb_object_agg(upper::text,weight) AS bins,SUM(sum) AS sum,SUM(weight) AS weight,MAX(peak) AS peak
  FROM histogram GROUP BY id,field
), stats AS (
  SELECT id,jsonb_object_agg(field,jsonb_build_object('sum',sum,'weight',weight,'peak',peak,'histogram',bins)) AS data
  FROM histograms GROUP BY id
), instance_points AS (
  SELECT incarnation,floor(at/$4)*$4 AS at,
    SUM(cpu*weight)/NULLIF(SUM(weight) FILTER(WHERE cpu IS NOT NULL),0) AS cpu,
    SUM(memory*weight)/NULLIF(SUM(weight),0) AS memory,
    SUM(working*weight)/NULLIF(SUM(weight) FILTER(WHERE working IS NOT NULL),0) AS working,
    AVG(active) AS active,MAX(run_limit) AS run_limit FROM observations GROUP BY incarnation,floor(at/$4)
), instance_series AS (
  SELECT incarnation,jsonb_agg(jsonb_build_object('at',at,'cpuMillicores',cpu,'memoryBytes',memory,'workingSetBytes',working,
    'activeRuns',active,'runLimit',run_limit,'reporters',1,'complete',true) ORDER BY at) AS points
  FROM instance_points GROUP BY incarnation
), pool_points AS (
  SELECT scope,pool_role,floor(at/$4)*$4 AS at,
    AVG(cpu) FILTER(WHERE complete) AS cpu,AVG(memory) FILTER(WHERE complete) AS memory,
    AVG(working) FILTER(WHERE complete) AS working,AVG(active) FILTER(WHERE complete) AS active,
    MAX(run_limit) FILTER(WHERE complete) AS run_limit,MAX(reporters) AS reporters,BOOL_AND(complete) AS complete
  FROM pool_observations GROUP BY scope,pool_role,floor(at/$4)
), pool_series AS (
  SELECT scope,pool_role,jsonb_agg(jsonb_build_object('at',at,'cpuMillicores',cpu,'memoryBytes',memory,'workingSetBytes',working,
    'activeRuns',active,'runLimit',run_limit,'reporters',reporters,'complete',complete) ORDER BY at) AS points
  FROM pool_points GROUP BY scope,pool_role
)
SELECT jsonb_build_object(
  'instances',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'identity',jsonb_build_object('installation',i.installation,'incarnation',i.incarnation,'role',i.role,'name',i.name,'source',i.source),
    'allocation',i.allocation,'firstSampleAt',i.first_at,'lastSampleAt',i.last_at,'latest',i.latest,'droppedSamples',i.dropped_samples,
    'stats',COALESCE(st.data,'{}'::jsonb),'points',COALESCE(se.points,'[]'::jsonb)))
    FROM selected i LEFT JOIN stats st ON st.id=i.incarnation LEFT JOIN instance_series se USING(incarnation)),'[]'::jsonb),
  'pools',COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',scope,'role',pool_role,'stats',COALESCE(st.data,'{}'::jsonb),'points',points,
    'latest',(SELECT jsonb_build_object('at',o.at,'cpuMillicores',o.cpu,'memoryBytes',o.memory,'workingSetBytes',o.working,
      'activeRuns',o.active,'runLimit',o.run_limit,'reporters',o.reporters,'complete',o.complete)
      FROM pool_observations o WHERE o.scope=p.scope AND o.pool_role=p.pool_role ORDER BY o.at DESC LIMIT 1)))
    FROM pool_series p LEFT JOIN stats st ON st.id='pool:'||p.scope||':'||p.pool_role),'[]'::jsonb),
  'omittedInstances',GREATEST(0,(SELECT count(*) FROM resource_monitoring_instances WHERE installation=$1 AND last_at >= $2)-64)
) AS data`;

type RawStats = Parameters<typeof resourceStatistics>[0];
export class ResourceMonitoringStore {
  constructor(
    private readonly pool: Pool,
    private readonly installation: string,
  ) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query(query('BEGIN'));
      // All telemetry operations, including writes and cleanup, release a
      // contended shared connection promptly. These settings are transaction-local.
      await client.query(
        query(
          "SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL jit=off; SET LOCAL work_mem='16MB'",
        ),
      );
      const result = await run(client);
      await client.query(query('COMMIT'));
      return result;
    } catch (error) {
      try {
        await client.query(query('ROLLBACK'));
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async write(reports: ResourceReport[]): Promise<void> {
    if (!reports.length) return;
    if (reports.length > 32 || reports.some((r) => r.identity.installation !== this.installation))
      throw Error('Invalid resource write scope');
    const prepared = JSON.stringify(
      reports.map((report) => ({
        ...report,
        buckets: report.buckets.map((bucket) => ({ ...bucket, summary: summarizeResourceSamples(bucket.samples) })),
        latest: report.buckets.flatMap((b) => b.samples).reduce((a, b) => (a.at > b.at ? a : b)),
      })),
    );
    await this.transaction((client) => client.query(query(WRITE_SQL, [prepared])));
  }

  async history(period: ResourcePeriod, now: number): Promise<ResourceHistory> {
    const { duration, step } = RESOURCE_PERIODS[period],
      from = now - duration;
    const result = await this.transaction((client) =>
      client.query(query(HISTORY_SQL, [this.installation, from, now, step])),
    );
    const raw = result.rows[0].data as {
      instances: Array<ResourceInstanceHistory & { stats: Record<string, RawStats> }>;
      pools: Array<{
        scope: 'container' | 'process';
        role: 'execution' | 'control';
        stats: Record<string, RawStats>;
        points: ResourceInstanceHistory['points'];
        latest: ResourceInstanceHistory['points'][number] | null;
      }>;
      omittedInstances: number;
    };
    return {
      available: true,
      error: null,
      period,
      from,
      to: now,
      generatedAt: now,
      sampleIntervalMs: RESOURCE_SAMPLE_MS,
      staleAfterMs: RESOURCE_STALE_MS,
      percentile: 'approximate-duration-weighted',
      omittedInstances: Number(raw.omittedInstances),
      instances: raw.instances.map(({ stats, ...instance }) => ({
        ...instance,
        cpu: resourceStatistics(stats.cpu),
        memory: resourceStatistics(stats.memory),
        workingSet: resourceStatistics(stats.workingSet),
        points: fillResourceHistory(instance.points, from, now, step),
      })),
      pools: raw.pools.map(({ stats, ...pool }) => ({
        ...pool,
        cpu: resourceStatistics(stats.cpu),
        memory: resourceStatistics(stats.memory),
        points: fillResourceHistory(pool.points, from, now, step),
      })),
    };
  }

  async cleanup(now: number): Promise<void> {
    const before = now - RESOURCE_RETENTION_MS;
    await this.transaction(async (client) => {
      await client.query(
        query(
          `DELETE FROM resource_monitoring_minutes WHERE ctid IN
      (SELECT ctid FROM resource_monitoring_minutes WHERE installation=$1 AND bucket_at<$2 LIMIT 500)`,
          [this.installation, before],
        ),
      );
      await client.query(
        query(
          `DELETE FROM resource_monitoring_instances WHERE ctid IN
      (SELECT ctid FROM resource_monitoring_instances WHERE installation=$1 AND last_at<$2 LIMIT 100)`,
          [this.installation, before],
        ),
      );
    });
  }
}
