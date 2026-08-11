import { Button } from '@pitolet/ui';
import { Activity, Database, RefreshCw, Server, Users, Waypoints } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type OwnerOverview } from '../../api.js';
import { AdminShell } from '../../components/AdminShell.js';

const RANGES: Array<7 | 30 | 90> = [7, 30, 90];

export function AdminOverview() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [data, setData] = useState<OwnerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.adminOverview(days));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Could not load the owner overview.');
    }
  }, [days]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  return (
    <AdminShell
      active="overview"
      title="Overview"
      description="See how people use Pitolet and where they need help."
      actions={
        <div className="ptl-admin-range" aria-label="Analytics range">
          {RANGES.map((range) => (
            <button
              type="button"
              key={range}
              className={days === range ? 'is-active' : ''}
              aria-pressed={days === range}
              onClick={() => setDays(range)}
            >
              {range} days
            </button>
          ))}
        </div>
      }
    >
      {error ? (
        <AdminError message={error} retry={load} />
      ) : !data ? (
        <AdminOverviewSkeleton />
      ) : (
        <OverviewContent data={data} />
      )}
    </AdminShell>
  );
}

function OverviewContent({ data }: { data: OwnerOverview }) {
  const metrics = [
    ['Total accounts', data.summary.totalAccounts],
    ['New accounts', data.summary.newAccounts],
    ['Active users', data.summary.activeUsers],
    ['Active workspaces', data.summary.activeWorkspaces],
    ['MCP connected', data.summary.connectedWorkspaces],
    ['Activated', data.summary.activatedWorkspaces],
    ['Successful imports', data.summary.imports],
    ['Returning users', data.summary.returningUsers],
    ['New feedback', data.summary.newFeedback],
    ['Open problems', data.summary.openProblems],
  ] as const;

  return (
    <div className="ptl-admin-stack">
      <section className="ptl-admin-metric-grid" aria-label="Product summary">
        {metrics.map(([label, value]) => (
          <article className="ptl-admin-metric" key={label}>
            <span>{label}</span>
            <strong>{value.toLocaleString()}</strong>
          </article>
        ))}
      </section>

      <div className="ptl-admin-two-column">
        <section className="ptl-admin-panel">
          <div className="ptl-admin-panel-head">
            <div>
              <h2>Activation funnel</h2>
              <p>Accounts created during this range.</p>
            </div>
            <Waypoints size={17} />
          </div>
          <div className="ptl-admin-funnel">
            {data.funnel.map((step, index) => {
              const base = Math.max(data.funnel[0]?.count ?? 0, 1);
              return (
                <div className="ptl-admin-funnel-row" key={step.key}>
                  <span>{step.label}</span>
                  <div>
                    <i
                      style={{
                        width: `${Math.max((step.count / base) * 100, step.count ? 4 : 0)}%`,
                      }}
                    />
                  </div>
                  <strong>{step.count}</strong>
                  {index > 0 && (
                    <small>
                      {data.funnel[index - 1]!.count
                        ? `${Math.round((step.count / data.funnel[index - 1]!.count) * 100)}%`
                        : '0%'}
                    </small>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <TrendPanel data={data} />
      </div>

      <section className="ptl-admin-panel">
        <div className="ptl-admin-panel-head">
          <div>
            <h2>Application health</h2>
            <p>Current process and database readings.</p>
          </div>
          <Activity size={17} />
        </div>
        <div className="ptl-admin-health-grid">
          <HealthStat
            icon={Server}
            label="Uptime"
            value={formatDuration(data.health.uptimeSeconds)}
          />
          <HealthStat
            icon={Database}
            label="Database"
            value={`${data.health.databaseResponseMs} ms`}
          />
          <HealthStat
            icon={Activity}
            label="Memory"
            value={`${formatBytes(data.health.rssBytes)} RSS, ${formatBytes(data.health.heapUsedBytes)} heap`}
          />
          <HealthStat icon={Users} label="Editor sockets" value={String(data.health.wsClients)} />
          <HealthStat
            icon={Waypoints}
            label="Loaded runtimes"
            value={String(data.health.loadedWorkspaces)}
          />
          <HealthStat
            icon={Database}
            label="PostgreSQL pool"
            value={`${data.health.pgPoolIdle}/${data.health.pgPoolTotal} idle, ${data.health.pgPoolWaiting} waiting`}
          />
        </div>
        <div className="ptl-admin-release">Release {data.health.release}</div>
      </section>
    </div>
  );
}

function TrendPanel({ data }: { data: OwnerOverview }) {
  const max = useMemo(
    () => Math.max(1, ...data.trends.flatMap((day) => [day.users, day.workspaces])),
    [data.trends],
  );
  return (
    <section className="ptl-admin-panel">
      <div className="ptl-admin-panel-head">
        <div>
          <h2>Daily activity</h2>
          <p>Users and workspaces with recorded activity.</p>
        </div>
        <Users size={17} />
      </div>
      <div className="ptl-admin-trend" aria-label="Daily activity chart">
        {data.trends.map((day) => (
          <div
            className="ptl-admin-trend-day"
            key={day.date}
            title={`${day.date}: ${day.users} users, ${day.workspaces} workspaces`}
          >
            <i className="is-workspaces" style={{ height: `${(day.workspaces / max) * 100}%` }} />
            <i className="is-users" style={{ height: `${(day.users / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="ptl-admin-legend">
        <span>
          <i className="is-users" /> Users
        </span>
        <span>
          <i className="is-workspaces" /> Workspaces
        </span>
      </div>
    </section>
  );
}

function HealthStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: string;
}) {
  return (
    <div className="ptl-admin-health-stat">
      <Icon size={15} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days ? `${days}d ${hours}h` : `${hours}h`;
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function AdminOverviewSkeleton() {
  return (
    <div className="ptl-admin-skeleton" aria-label="Loading overview">
      <div />
      <div />
      <div />
      <div />
      <div />
    </div>
  );
}

function AdminError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="ptl-state-card is-error">
      <strong>Overview could not load</strong>
      <span>{message}</span>
      <Button variant="outline" onClick={retry}>
        <RefreshCw size={14} /> Retry
      </Button>
    </div>
  );
}
