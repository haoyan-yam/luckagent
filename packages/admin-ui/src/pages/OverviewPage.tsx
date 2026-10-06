import { useEffect, useMemo } from 'react';
import { Alert, Badge, Button, Card, Col, Empty, Row, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, BotOverview } from '../api/types';
import { Sparkline } from '../components/Sparkline';
import { CostTrendChart } from '../components/CostTrendChart';

interface BotDaily { tasks: number[]; failed: number[]; cost: number[]; }
interface CostTrend {
  days: string[];
  byBot: Record<string, BotDaily>;
  today: { tasks: number; failed: number; costUsd: number };
  yesterdaySoFar: { tasks: number; failed: number; costUsd: number };
  dataSince: string | null;
}

interface AttentionItem { key: string; level: 'error' | 'warning'; title: string; detail?: string; link?: string; }
interface AttentionPayload { generatedAt: string; items: AttentionItem[]; }

const UP_BAD = '#cf1322';
const DOWN_GOOD = '#389e0d';

function fmtUptime(sec?: number): string {
  if (sec === undefined) return '-';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** 定时任务的批次名：label 前缀 → 人话 */
const batchName = (label: string | null) => {
  if (!label) return '定时任务';
  const prefix = label.split(':')[0];
  return prefix === 'group-summary' ? '群日报' : label.includes(':') ? prefix : label;
};

function whenText(iso: string) {
  const t = dayjs(iso);
  const d = t.startOf('day').diff(dayjs().startOf('day'), 'day');
  const prefix = d === 0 ? '今天' : d === 1 ? '明天' : d === 2 ? '后天' : t.format('MM-DD');
  return `${prefix} ${t.format('HH:mm')}`;
}

/** stat tile 的对比行：带方向箭头 + 文字，颜色 = 方向 × 涨是不是坏事 */
function Delta({ now, before, upIsBad, unit, label }: { now: number; before: number; upIsBad?: boolean; unit: 'pct' | 'count'; label: string }) {
  if (before === 0 && now === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}持平</Typography.Text>;
  if (before === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}无数据</Typography.Text>;
  const diff = now - before;
  if (Math.abs(diff) < 1e-9) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}持平</Typography.Text>;
  const up = diff > 0;
  const color = upIsBad === undefined ? undefined : up === upIsBad ? UP_BAD : DOWN_GOOD;
  const text = unit === 'pct' ? `${Math.round(Math.abs(diff / before) * 100)}%` : String(Math.abs(Math.round(diff)));
  return (
    <span style={{ fontSize: 12, color: color ?? 'rgba(0,0,0,0.45)' }}>
      {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {text}
      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>{label}</Typography.Text>
    </span>
  );
}

function StatTile({ label, value, delta, extra }: { label: string; value: React.ReactNode; delta?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <Card size="small" styles={{ body: { padding: '12px 16px' } }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>{label}</Typography.Text>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
        {extra}
      </div>
      <div style={{ minHeight: 20, marginTop: 2 }}>{delta}</div>
    </Card>
  );
}

type StatusLevel = 'success' | 'warning' | 'error';
interface StatusItem { key: string; level: StatusLevel; label: React.ReactNode; detail?: React.ReactNode; action?: React.ReactNode; }

export default function OverviewPage({
  onConfigDirty,
  onRestart,
}: {
  onConfigDirty: (dirty: boolean) => void;
  onRestart: () => void;
}) {
  const { data, error, failCount } = usePoll<Overview>(() => api.get('/admin/api/overview'), 5000);
  const { data: costs } = usePoll<CostTrend>(() => api.get('/admin/api/costs?days=7'), 60000);
  // 待处理：飞书群列表在后端缓存 5 分钟，这里每分钟拉一次，失败数等即时项最多晚 1 分钟
  // 趋势图固定按 30 天取数：颜色按 30 天排名分配，切 7 天只截取，不会重新上色
  const { data: trend30 } = usePoll<CostTrend>(() => api.get('/admin/api/costs?days=30'), 60000);
  const { data: attention, error: attentionError } = usePoll<AttentionPayload>(() => api.get('/admin/api/attention'), 60000);

  useEffect(() => {
    if (data) onConfigDirty(data.configDirty);
  }, [data, onConfigDirty]);

  // ---------------- 系统状态条 ----------------
  const offline = (data?.bots || []).filter((b) => !b.running);
  const statusItems: StatusItem[] = data
    ? [
        {
          key: 'bridge',
          level: 'success',
          label: <>bridge v{data.bridge.version} · 运行 {fmtUptime(data.bridge.uptime)} · 内存 {Math.round(data.bridge.memory.rssMb)}MB</>,
        },
        {
          key: 'core',
          level: data.core.up ? 'success' : 'error',
          label: data.core.up ? <>core 正常 · 运行 {fmtUptime(data.core.uptime)}</> : 'core 不可达',
          detail: data.core.up ? undefined : 'core 服务连不上：共享记忆、技能库、跨 bot 协作不可用。终端执行 luckagent status 查看。',
        },
        {
          key: 'bots',
          level: offline.length ? 'error' : 'success',
          label: `${data.bots.length - offline.length}/${data.bots.length} 个 bot 在线`,
          detail: offline.length ? `未运行或启动失败：${offline.map((b) => b.name).join('、')}——去「运行日志」看 error.log。` : undefined,
        },
        {
          key: 'pm2',
          level: data.pm2StartupConfigured === false ? 'warning' : 'success',
          label: data.pm2StartupConfigured === false ? '开机自启未配置' : '开机自启已配置',
          detail:
            data.pm2StartupConfigured === false
              ? '系统更新/断电重启后 bot 不会自动恢复（曾因此离线一整个上午）。终端执行 pm2 startup 并按提示运行输出的 sudo 命令，再 pm2 save。'
              : undefined,
        },
        {
          key: 'config',
          level: data.configError ? 'error' : data.configDirty ? 'warning' : 'success',
          label: data.configError ? '配置文件异常' : data.configDirty ? '配置待生效' : '配置正常',
          detail: data.configError
            ? `${data.configError} —— 下方机器人列表可能不完整，请勿据此判断“尚未配置”。`
            : data.configDirty
              ? 'bots.json 在进程启动后被修改过，改动尚未生效。'
              : undefined,
          action: data.configDirty && !data.configError ? <Button size="small" type="primary" onClick={onRestart}>重启生效</Button> : undefined,
        },
      ]
    : [];
  const problems = statusItems.filter((s) => s.level !== 'success');
  const worst: StatusLevel = problems.some((p) => p.level === 'error') ? 'error' : problems.length ? 'warning' : 'success';

  const statusBar = (
    <Card
      size="small"
      styles={{ body: { padding: '8px 16px' } }}
      style={worst === 'success' ? undefined : { borderColor: worst === 'error' ? '#ffa39e' : '#ffd591', background: worst === 'error' ? '#fff1f0' : '#fffbe6' }}
    >
      <Space wrap size={[20, 4]}>
        {statusItems.map((s) => (
          <Badge key={s.key} status={s.level} text={<Typography.Text type={s.level === 'success' ? 'secondary' : undefined} style={{ fontSize: 13 }}>{s.label}</Typography.Text>} />
        ))}
        {!data && <Typography.Text type="secondary">加载中…</Typography.Text>}
      </Space>
      {problems.filter((p) => p.detail).map((p) => (
        <div key={p.key} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Typography.Text style={{ fontSize: 13 }}>
            <Badge status={p.level} /> {p.detail}
          </Typography.Text>
          {p.action}
        </div>
      ))}
    </Card>
  );

  // ---------------- 成本卡片 ----------------
  const dailyTotals = useMemo(() => {
    if (!costs) return null;
    const n = costs.days.length;
    const cost = Array(n).fill(0) as number[];
    const tasks = Array(n).fill(0) as number[];
    for (const b of Object.values(costs.byBot)) {
      b.cost.forEach((v, i) => (cost[i] += v));
      b.tasks.forEach((v, i) => (tasks[i] += v));
    }
    return { cost, tasks };
  }, [costs]);

  const today = costs?.today;
  const ySoFar = costs?.yesterdaySoFar;
  const weekCost = dailyTotals ? sum(dailyTotals.cost) : 0;
  const weekTasks = dailyTotals ? sum(dailyTotals.tasks) : 0;
  const avgToday = today && today.tasks ? today.costUsd / today.tasks : 0;
  const avgWeek = weekTasks ? weekCost / weekTasks : 0;
  const dayLabels = (costs?.days || []).map((d) => dayjs(d).format('M/D'));

  const tiles = (
    <Row gutter={[16, 16]}>
      <Col xs={12} lg={6}>
        <StatTile
          label="今日任务"
          value={today?.tasks ?? '-'}
          extra={today && today.failed > 0 ? <Tag color="red">{today.failed} 失败</Tag> : undefined}
          delta={today && ySoFar ? <Delta now={today.tasks} before={ySoFar.tasks} unit="count" label="比昨天同一时段" /> : undefined}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="今日成本"
          value={today ? usd(today.costUsd) : '-'}
          delta={today && ySoFar ? <Delta now={today.costUsd} before={ySoFar.costUsd} upIsBad unit="pct" label="比昨天同一时段" /> : undefined}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="近 7 天成本"
          value={costs ? usd(weekCost) : '-'}
          extra={dailyTotals ? <Sparkline values={dailyTotals.cost} labels={dayLabels} format={usd} /> : undefined}
          delta={costs ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>日均 {usd(weekCost / costs.days.length)} · {weekTasks} 个任务</Typography.Text> : undefined}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="今日平均每个任务"
          value={today ? (today.tasks ? usd(avgToday) : '—') : '-'}
          delta={today && today.tasks && avgWeek ? <Delta now={avgToday} before={avgWeek} upIsBad unit="pct" label="比近 7 天平均" /> : undefined}
        />
      </Col>
    </Row>
  );

  // ---------------- 待处理 ----------------
  const attentionCard = (
    <Card
      size="small"
      title="待处理"
      extra={attention && <Typography.Text type="secondary" style={{ fontSize: 12 }}>更新于 {dayjs(attention.generatedAt).format('HH:mm')}</Typography.Text>}
      style={{ height: '100%' }}
    >
      {!attention && !attentionError && <Typography.Text type="secondary">检查中…（首次要拉各 bot 的飞书群列表，稍等几秒）</Typography.Text>}
      {attentionError && !attention && <Typography.Text type="danger">加载失败：{attentionError}</Typography.Text>}
      {attention && attention.items.length === 0 && (
        <Space>
          <CheckCircleFilled style={{ color: '#389e0d' }} />
          <Typography.Text>一切正常，没有需要处理的事</Typography.Text>
        </Space>
      )}
      {attention && attention.items.length > 0 && (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {attention.items.map((it) => (
            <div key={it.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              {it.level === 'error' ? (
                <CloseCircleFilled style={{ color: '#cf1322', marginTop: 4 }} aria-label="严重" />
              ) : (
                <ExclamationCircleFilled style={{ color: '#d48806', marginTop: 4 }} aria-label="注意" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Typography.Text strong>{it.title}</Typography.Text>
                {it.detail && (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{it.detail}</Typography.Text>
                  </div>
                )}
              </div>
              {it.link && <Link to={it.link} style={{ whiteSpace: 'nowrap' }}>去处理 →</Link>}
              {!it.link && it.key === 'cost-spike' && (
                <Typography.Link
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={() => document.getElementById('cost-trend')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                >
                  看趋势 →
                </Typography.Link>
              )}
            </div>
          ))}
        </Space>
      )}
    </Card>
  );

  // ---------------- 机器人表格 ----------------
  type BotRow = BotOverview & { week: number; weekDaily: number[]; anomaly: boolean };
  const botRows: BotRow[] = useMemo(() => {
    const rows = (data?.bots || []).map((b) => {
      const daily = costs?.byBot[b.name]?.cost ?? (costs ? Array(costs.days.length).fill(0) : []);
      return { ...b, week: sum(daily), weekDaily: daily, anomaly: !b.running || b.today.failed > 0 };
    });
    // 有异常的置顶，其余按今日成本、近 7 天成本排
    return rows.sort(
      (a, b) => Number(b.anomaly) - Number(a.anomaly) || b.today.costUsd - a.today.costUsd || b.week - a.week || a.name.localeCompare(b.name),
    );
  }, [data, costs]);

  const botColumns = [
    {
      title: 'Bot',
      dataIndex: 'name',
      key: 'name',
      render: (v: string, b: BotRow) => (
        <span>
          <strong>{v}</strong>
          {!b.running && <Tag color="red" style={{ marginLeft: 8 }}>离线</Tag>}
        </span>
      ),
    },
    {
      title: '今日任务',
      key: 'tasks',
      align: 'right' as const,
      sorter: (a: BotRow, b: BotRow) => a.today.tasks - b.today.tasks,
      render: (_: unknown, b: BotRow) => (
        <span>
          {b.today.failed > 0 && <Tag color="red">{b.today.failed} 失败</Tag>}
          {b.today.tasks || <Typography.Text type="secondary">0</Typography.Text>}
        </span>
      ),
    },
    {
      title: '今日成本',
      key: 'cost',
      align: 'right' as const,
      sorter: (a: BotRow, b: BotRow) => a.today.costUsd - b.today.costUsd,
      render: (_: unknown, b: BotRow) => (b.today.costUsd ? usd(b.today.costUsd) : <Typography.Text type="secondary">$0.00</Typography.Text>),
    },
    {
      title: '近 7 天成本',
      key: 'week',
      sorter: (a: BotRow, b: BotRow) => a.week - b.week,
      render: (_: unknown, b: BotRow) => (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(b.week)}</span>
          <Sparkline values={b.weekDaily} labels={dayLabels} format={usd} width={70} height={20} />
        </div>
      ),
    },
    {
      title: '状态',
      key: 'state',
      render: (_: unknown, b: BotRow) =>
        !b.running ? (
          <Typography.Text type="danger">离线</Typography.Text>
        ) : b.executors.active > 0 ? (
          <Badge status="processing" text={`执行中 ${b.executors.active}`} />
        ) : (
          <Typography.Text type="secondary">空闲</Typography.Text>
        ),
    },
    {
      title: '最近活动',
      key: 'last',
      sorter: (a: BotRow, b: BotRow) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0),
      render: (_: unknown, b: BotRow) =>
        b.lastActivityAt ? <Tooltip title={dayjs(b.lastActivityAt).format('YYYY-MM-DD HH:mm')}>{dayjs(b.lastActivityAt).fromNow()}</Tooltip> : '—',
    },
  ];

  // ---------------- 定时任务：同一时刻、同一 bot、同类任务合并 ----------------
  const batches = useMemo(() => {
    const m = new Map<string, { when: string; botName: string; name: string; count: number }>();
    for (const t of data?.schedule.upcoming || []) {
      const name = batchName(t.label);
      const key = `${t.nextExecuteAt.slice(0, 16)}|${t.botName}|${name}`;
      const cur = m.get(key);
      if (cur) cur.count++;
      else m.set(key, { when: t.nextExecuteAt, botName: t.botName, name, count: 1 });
    }
    return [...m.values()].slice(0, 6);
  }, [data]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {failCount >= 2 && (
        <Alert type="error" banner message={`桥接连接中断（${error || '轮询失败'}）——若刚触发重启属正常，恢复后自动消失。`} />
      )}
      {statusBar}
      {tiles}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>{attentionCard}</Col>
        <Col xs={24} xl={14}>
          <Card size="small" title="每日成本" id="cost-trend" style={{ height: '100%' }}>
            {trend30 ? <CostTrendChart data={trend30} /> : <Typography.Text type="secondary">加载中…</Typography.Text>}
          </Card>
        </Col>
      </Row>

      <Card title="机器人" extra={<Link to="/bots">管理 →</Link>} size="small">
        {data && data.bots.length === 0 ? (
          <Empty description={
            <span>
              尚未配置任何机器人 —— 去 <Link to="/bots">机器人管理</Link> 用「飞书接入向导」创建第一个
            </span>
          } />
        ) : (
          <Table
            rowKey="name"
            dataSource={botRows}
            columns={botColumns}
            pagination={false}
            size="small"
            loading={!data && !error}
            rowClassName={(b) => (b.anomaly ? 'overview-row-anomaly' : '')}
          />
        )}
        <style>{'.overview-row-anomaly td { background: #fff1f0 !important; }'}</style>
      </Card>

      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={`接下来的定时任务（周期 ${data?.schedule.recurring ?? '-'} · 一次性 ${data?.schedule.oneTime ?? '-'}）`}
            extra={<Link to="/schedule">查看 →</Link>}
          >
            {batches.length ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {batches.map((b) => (
                  <div key={`${b.when}|${b.botName}|${b.name}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                    <Typography.Text strong style={{ minWidth: 86, fontVariantNumeric: 'tabular-nums' }}>{whenText(b.when)}</Typography.Text>
                    <Typography.Text>{b.botName}</Typography.Text>
                    <Typography.Text type="secondary">
                      {b.name}
                      {b.count > 1 && ` × ${b.count}`}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无周期任务" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card size="small" title="今日失败" extra={<Link to="/logs">看日志 →</Link>}>
            {data?.recentFailures.length ? (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {data.recentFailures.map((f, i) => (
                  <div key={i}>
                    <Tag color="red">{f.botName}</Tag>
                    <Typography.Text type="secondary">
                      {dayjs(f.timestamp).format('HH:mm')} {f.errorMessage || '未知错误'}
                    </Typography.Text>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天没有失败的任务" />
            )}
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
