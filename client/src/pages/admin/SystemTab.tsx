/** System facts read from the running server: versions, storage, table sizes and how the ledger is composed. */
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api.ts';
import { fmtBytes, fmtNumber, titleCase } from '@/lib/format.ts';
import { Badge, Card, CardHeader, DescriptionList, ErrorState, LoadingBlock } from '@/components/ui/primitives.tsx';
import { DataClassBadge, DemoBadge, MarketTime } from '@/components/domain/domain.tsx';
import type { SystemInfo } from '@shared/api/admin.ts';
import { PathLine } from './shared.tsx';

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d} d ${h} h` : h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function SystemTab() {
  const system = useQuery({ queryKey: ['admin', 'system'], queryFn: () => apiGet<SystemInfo>('/admin/system') });
  if (system.isPending) return <LoadingBlock />;
  if (system.isError || !system.data) return <ErrorState error={system.error} onRetry={() => void system.refetch()} />;
  const s = system.data;
  const tables = Object.entries(s.tables).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Server" subtitle="The running installation." />
        <div className="px-4 py-3.5">
          <DescriptionList
            items={[
              { label: 'Environment', value: titleCase(s.environment) },
              { label: 'Uptime', value: uptime(s.uptime_seconds) },
              {
                label: 'Collection scheduler',
                value: s.scheduler_enabled ? <Badge tone="good">Running</Badge> : <Badge tone="warn">Switched off</Badge>,
              },
              { label: 'Node.js', value: <span className="mono">{s.version.node}</span> },
              { label: 'SQLite', value: <span className="mono">{s.version.sqlite}</span> },
              { label: 'Schema version', value: <span className="mono">{s.version.migration}{s.version.migration_name ? ` · ${s.version.migration_name}` : ''}</span> },
              { label: 'Database size', value: `${fmtBytes(s.database.size_bytes)} (+ ${fmtBytes(s.database.wal_size_bytes)} write-ahead log)` },
            ]}
          />
          <div className="mt-2.5 flex flex-col gap-2.5 border-t border-line pt-2.5">
            <PathLine label="Data directory" path={s.data_dir} />
            <PathLine label="Database file" path={s.database.path} />
          </div>
          {!s.scheduler_enabled ? (
            <p className="mt-3 text-[12px] leading-4 text-ink-3">
              With the scheduler off (PIOS_SCHEDULER=off), nothing runs by itself: no scheduled collection, no periodic alert checks, no automatic exchange-rate refresh and no Excel mirror refresh. Everything can still be started by hand.
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Price ledger by origin" subtitle="How the stored observations entered the system. Real and demo rows are counted separately." />
        {s.observations_by_class.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12.5px] text-ink-3">No price observation has been stored yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th scope="col">Origin</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Observations
                  </th>
                  <th scope="col">Last observed</th>
                </tr>
              </thead>
              <tbody>
                {s.observations_by_class.map((row) => (
                  <tr key={`${row.data_class}-${row.is_demo}`}>
                    <td>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <DataClassBadge value={row.data_class} />
                        {row.is_demo ? <DemoBadge /> : <Badge tone="outline">Real</Badge>}
                      </span>
                    </td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {fmtNumber(row.count)}
                    </td>
                    <td>
                      <MarketTime iso={row.last_observed_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader title="Tables" subtitle="Rows per table, and how many of them belong to the demo dataset." />
        <div className="table-wrap">
          <table className="grid-table is-dense">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Rows
                </th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Of which demo
                </th>
              </tr>
            </thead>
            <tbody>
              {tables.map(([name, count]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {fmtNumber(count)}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {name in s.demo_rows ? fmtNumber(s.demo_rows[name]) : <span className="text-ink-4">n/a</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
