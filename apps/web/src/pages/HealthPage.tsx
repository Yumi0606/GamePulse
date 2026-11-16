import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmtCst } from '@gamepulse/shared';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useGameName } from '../lib/hooks';
import { Badge, Card, Empty, QueryState, SectionTitle } from '../components/ui';

/**
 * 源健康视图：调度状态、处理链积压、最近一次拉取、源健康事件。
 *
 * 只读：不提供重跑、暂停、调整队列等控制能力。
 */
const KIND_LABEL: Record<string, string> = {
  http: '上游 HTTP 错误',
  network: '网络异常',
  parse: 'RSS 解析失败',
  empty: '空数据',
};

export function HealthPage() {
  const [params, setParams] = useSearchParams();
  const onlyUnresolved = params.get('unresolved') === '1';
  const gameName = useGameName();

  const healthQuery = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 30_000,
  });
  const eventsQuery = useQuery({
    queryKey: ['events'],
    queryFn: api.events,
    refetchInterval: 30_000,
  });

  const health = healthQuery.data;
  const now = health?.now ?? Math.floor(Date.now() / 1000);
  const events = (eventsQuery.data?.items ?? []).filter((e) => !onlyUnresolved || e.resolvedAt === null);

  return (
    <div className="space-y-3">
      <Card>
        <SectionTitle extra={health ? `服务端时间 ${fmtCst(health.now)}` : undefined}>运行状态</SectionTitle>
        <QueryState loading={healthQuery.isLoading} error={healthQuery.error} />
        {health ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="定时扫描"
              value={
                health.scan.enabled ? (
                  <Badge tone="ok">已启用</Badge>
                ) : (
                  <Badge tone="neutral">只读模式（未启动）</Badge>
                )
              }
              hint={health.scan.fetch.schedule || '—'}
            />
            <Field
              label="上次拉取"
              value={health.scan.fetch.lastRunAt ? fmtRelative(health.scan.fetch.lastRunAt, now) : '尚未执行'}
              hint={health.scan.fetch.lastRunAt ? fmtCst(health.scan.fetch.lastRunAt) : ''}
            />
            <Field
              label="下次拉取"
              value={health.scan.fetch.nextRunAt ? fmtRelative(health.scan.fetch.nextRunAt, now) : '未安排'}
              hint={health.scan.fetch.nextRunAt ? fmtCst(health.scan.fetch.nextRunAt) : ''}
            />
            <Field
              label="启用游戏"
              value={`${health.games.enabled} / ${health.games.total}`}
              hint="停用游戏不参与拉取"
            />
            <Field label="待结构化动态" value={health.backlog.postsToExtract} />
            <Field label="待 OCR 图片" value={health.backlog.imagesToOcr} />
            <Field
              label="未恢复异常"
              value={
                health.events.unresolved > 0 ? (
                  <span className="text-danger">{health.events.unresolved}</span>
                ) : (
                  '0'
                )
              }
              hint={health.events.cookieSuspect > 0 ? `疑似 cookie 失效 ${health.events.cookieSuspect}` : ''}
            />
            <Field
              label="最近一次拉取"
              value={health.meta ? `${health.meta.fetched} 条 / ${(health.meta.durationMs / 1000).toFixed(1)}s` : '尚未拉取'}
              hint={
                health.meta
                  ? `新增 ${health.meta.added} · 更新 ${health.meta.updated}（${fmtCst(health.meta.lastRunAt)}）`
                  : ''
              }
            />
          </div>
        ) : null}
        {health?.meta?.errors.length ? (
          <div className="mt-2 rounded border border-[#f0c9c9] bg-[#fdf4f4] px-3 py-2 text-[12px] text-danger">
            <div className="font-medium">最近批次拉取失败 {health.meta.errors.length} 项</div>
            <ul className="mt-1 list-inside list-disc">
              {health.meta.errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <section>
        <SectionTitle
          extra={
            <span className="flex items-center gap-2">
              最多保留最近 200 条 · 同一游戏后续拉取成功会自动标记恢复
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={onlyUnresolved}
                  onChange={(e) => {
                    const next = new URLSearchParams(params);
                    if (e.target.checked) next.set('unresolved', '1');
                    else next.delete('unresolved');
                    setParams(next, { replace: true });
                  }}
                />
                只看未恢复
              </label>
            </span>
          }
        >
          源健康事件
        </SectionTitle>
        <Card>
          <QueryState loading={eventsQuery.isLoading} error={eventsQuery.error} />
          {eventsQuery.data ? (
            events.length > 0 ? (
              <ul className="divide-y divide-line">
                {events.map((event) => (
                  <li key={event.id} className="py-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="w-[132px] shrink-0 font-mono text-[12px] text-muted">{fmtCst(event.occurredAt)}</span>
                      <Badge>{KIND_LABEL[event.kind] ?? event.kind}</Badge>
                      <span className="text-[13px]">{event.gameId ? gameName(event.gameId) : '系统'}</span>
                      {event.resolvedAt === null ? (
                        <Badge tone="danger">未恢复</Badge>
                      ) : (
                        <Badge tone="ok">已恢复 {fmtCst(event.resolvedAt)}</Badge>
                      )}
                      {event.isCookieSuspect ? <Badge tone="warn">疑似 cookie 失效</Badge> : null}
                    </div>
                    <div className="mt-1 text-[13px]">{event.summary}</div>
                    {event.detail ? (
                      <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{event.detail}</pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{onlyUnresolved ? '没有未恢复的异常' : '暂无异常记录'}</Empty>
            )
          ) : null}
        </Card>
      </section>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded border border-line bg-bg/50 px-2.5 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 text-[14px] font-medium">{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}
