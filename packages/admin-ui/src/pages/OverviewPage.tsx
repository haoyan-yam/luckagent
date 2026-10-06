import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Col, Descriptions, Drawer, Empty, Progress, Row, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, BotOverview } from '../api/types';
import { Sparkline } from '../components/Sparkline';
import { MarkdownView } from '../md';

interface AttentionItem { key: string; level: 'error' | 'warning'; title: string; detail?: string; link?: string; }
interface AttentionPayload { generatedAt: string; items: AttentionItem[]; }
interface DashboardPayload {
  generatedAt: string;
  tasks: {
    total: number;
    members: number;
    scheduled: number;
    failed: number;
    failedScheduled: number;
    people: number;
    perBot: Record<string, { members: number; scheduled: number; failed: number }>;
  };
  skills: {
    days: string[];
    daily: number[];
    uses7d: number;
    usesPrev7d: number;
    perBot: Record<string, number>;
    top: Array<{ skill: string; count: number; bots: string[]; project: boolean }>;
  };
  memory: {
    total: number;
    created7d: number;
    updated7d: number;
    perBot: Record<string, { count: number; ratio: number }>;
    recent: Array<{ bot: string; file: string; title: string; mtime: string; isNew: boolean }>;
  };
}
interface FeedItem {
  ts: number;
  bot: string;
  source: 'member' | 'scheduler';
  status: 'running' | 'done' | 'failed';
  summary: string;
  durationMs?: number;
  error?: string;
}
interface MemFile {
  file: string;
  frontmatter: { name: string; description: string; type: string } | null;
  body: string;
  sizeBytes: number;
  mtime: string;
}

const MEM_TYPE: Record<string, string> = { project: '项目', feedback: '反馈', reference: '参考', user: '用户' };

function fmtDuration(ms?: number) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

const MEMORY_WARN = 0.7;

function fmtUptime(sec?: number): string {
  if (sec === undefined) return '-';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
  return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
}

const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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

/** 与上一周期对比：只标方向和幅度，不做好坏着色（用量多少没有对错） */
function Delta({ now, before, label }: { now: number; before: number; label: string }) {
  if (before === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}{now === 0 ? '持平' : '无数据'}</Typography.Text>;
  const diff = now - before;
  if (diff === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}持平</Typography.Text>;
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {diff > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.round(Math.abs(diff / before) * 100)}% {label}
    </Typography.Text>
  );
}

function StatTile({ label, value, sub, extra, link }: { label: string; value: React.ReactNode; sub?: React.ReactNode; extra?: React.ReactNode; link?: string }) {
  return (
    <Card size="small" styles={{ body: { padding: '12px 16px' } }} style={{ height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>{label}</Typography.Text>
        {link && <Link to={link} style={{ fontSize: 12 }}>查看 →</Link>}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
        <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
        {extra}
      </div>
      <div style={{ minHeight: 20, marginTop: 2 }}>{sub}</div>
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
  const { data: dash } = usePoll<DashboardPayload>(() => api.get('/admin/api/dashboard'), 60000);
  // 待处理：飞书群列表在后端缓存 5 分钟，这里每分钟拉一次，失败数等即时项最多晚 1 分钟
  const { data: attention, error: attentionError } = usePoll<AttentionPayload>(() => api.get('/admin/api/attention'), 60000);
  const { data: feed } = usePoll<{ items: FeedItem[] }>(() => api.get('/admin/api/activity/feed'), 60000);
  const [memViewer, setMemViewer] = useState<{ title: string; loading: boolean; data?: MemFile } | null>(null);

  const openMemory = async (bot: string, file: string, title: string) => {
    const head = `${bot} / ${title}`;
    setMemViewer({ title: head, loading: true });
    try {
      const d = await api.get<MemFile>(`/admin/api/memory/file?bot=${encodeURIComponent(bot)}&file=${encodeURIComponent(file)}`);
      setMemViewer({ title: head, loading: false, data: d });
    } catch {
      setMemViewer({ title: head, loading: false });
    }
  };

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

  // ---------------- 定时任务：同一时刻的同类任务合并（跨 bot），bot 列在后面 ----------------
  const batches = useMemo(() => {
    const m = new Map<string, { when: string; name: string; count: number; bots: Map<string, number> }>();
    for (const t of data?.schedule.upcoming || []) {
      const name = batchName(t.label);
      const key = `${t.nextExecuteAt.slice(0, 16)}|${name}`;
      const cur = m.get(key) ?? { when: t.nextExecuteAt, name, count: 0, bots: new Map<string, number>() };
      cur.count++;
      cur.bots.set(t.botName, (cur.bots.get(t.botName) ?? 0) + 1);
      m.set(key, cur);
    }
    return [...m.values()].slice(0, 6).map((b) => ({
      ...b,
      botText: [...b.bots].map(([bot, n]) => (n > 1 ? `${bot} ×${n}` : bot)).join('、'),
    }));
  }, [data]);

  // ---------------- 运行状态卡片 ----------------
  const t = dash?.tasks;
  const sk = dash?.skills;
  const mem = dash?.memory;
  const skillDayLabels = (sk?.days || []).map((d) => dayjs(d).format('M/D'));
  const nextRun = data?.schedule.upcoming[0];

  const tiles = (
    <Row gutter={[16, 16]}>
      <Col xs={12} lg={6}>
        <StatTile
          label="今日任务"
          value={t?.total ?? '-'}
          extra={t && t.failed > 0 ? <Tag color="red">{t.failed} 失败</Tag> : undefined}
          sub={t && <Typography.Text type="secondary" style={{ fontSize: 12 }}>成员发起 {t.members}（{t.people} 人）· 定时 {t.scheduled}</Typography.Text>}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="技能调用（近 7 天）"
          link="/skills"
          value={sk ? <>{sk.uses7d}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>次</span></> : '-'}
          extra={sk ? <Sparkline values={sk.daily} labels={skillDayLabels} format={(v) => `${v} 次`} /> : undefined}
          sub={sk && <Delta now={sk.uses7d} before={sk.usesPrev7d} label="比上周" />}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="记忆沉淀（近 7 天）"
          link="/memory"
          value={mem ? <>{mem.created7d}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>条新增</span></> : '-'}
          sub={mem && <Typography.Text type="secondary" style={{ fontSize: 12 }}>另有 {mem.updated7d} 条更新 · 共 {mem.total} 条</Typography.Text>}
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatTile
          label="定时任务（今日）"
          link="/schedule"
          value={t ? <>{t.scheduled}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>次已运行</span></> : '-'}
          extra={t && t.failedScheduled > 0 ? <Tag color="red">{t.failedScheduled} 失败</Tag> : undefined}
          sub={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {nextRun ? `下一个 ${whenText(nextRun.nextExecuteAt)} · ` : ''}共 {data?.schedule.recurring ?? '-'} 个周期任务
            </Typography.Text>
          }
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
            </div>
          ))}
        </Space>
      )}
    </Card>
  );

  // ---------------- 实时动态 ----------------
  const feedCard = (
    <Card size="small" title="实时动态" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>每分钟刷新</Typography.Text>} style={{ height: '100%' }}>
      {!feed && <Typography.Text type="secondary">加载中…</Typography.Text>}
      {feed && feed.items.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="最近没有任务" />}
      {feed && feed.items.length > 0 && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {feed.items.map((f, i) => (
            <div key={`${f.ts}-${f.bot}-${i}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {f.status === 'running' ? (
                  <Badge status="processing" />
                ) : f.status === 'failed' ? (
                  <CloseCircleFilled style={{ color: '#cf1322' }} aria-label="失败" />
                ) : (
                  <CheckCircleFilled style={{ color: '#389e0d' }} aria-label="完成" />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flex: 'none' }}>
                  {f.status === 'running' ? '执行中' : dayjs(f.ts).format('HH:mm')}
                </Typography.Text>
                <Typography.Text strong style={{ flex: 'none' }}>{f.bot}</Typography.Text>
                <Tag color={f.source === 'member' ? 'blue' : undefined} style={{ margin: 0, flex: 'none' }}>{f.source === 'member' ? '成员' : '定时'}</Tag>
                <Typography.Text ellipsis={{ tooltip: f.summary }} style={{ flex: 1, minWidth: 0 }}>{f.summary || '—'}</Typography.Text>
                {f.durationMs ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>{fmtDuration(f.durationMs)}</Typography.Text>
                ) : null}
              </div>
              {f.error && (
                <Typography.Text type="danger" style={{ fontSize: 12, marginLeft: 22 }} ellipsis={{ tooltip: f.error }}>
                  {f.error}
                </Typography.Text>
              )}
            </div>
          ))}
        </Space>
      )}
    </Card>
  );

  // ---------------- 技能活跃榜 / 最近沉淀的记忆 ----------------
  const topMax = Math.max(1, ...(sk?.top || []).map((x) => x.count));
  const skillRankCard = (
    <Card size="small" title="技能活跃榜（近 7 天）" extra={<Link to="/skills">全部技能 →</Link>} style={{ height: '100%' }}>
      {!sk && <Typography.Text type="secondary">加载中…</Typography.Text>}
      {sk && sk.top.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 7 天没有 bot 调用技能" />}
      {sk && sk.top.length > 0 && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {sk.top.map((x) => (
            <div key={x.skill} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 170, minWidth: 0, flex: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Typography.Text ellipsis={{ tooltip: x.skill }} style={{ minWidth: 0 }}>{x.skill}</Typography.Text>
                <Tag style={{ margin: 0, flex: 'none' }} color={x.project ? 'blue' : undefined}>{x.project ? '项目' : '全局'}</Tag>
              </div>
              <div style={{ flex: 1, height: 8, background: '#f0efec', borderRadius: 4 }}>
                <div style={{ width: `${(x.count / topMax) * 100}%`, height: '100%', background: '#2a78d6', borderRadius: 4 }} />
              </div>
              <Typography.Text style={{ width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flex: 'none' }}>{x.count} 次</Typography.Text>
              <Typography.Text type="secondary" ellipsis={{ tooltip: x.bots.join('、') }} style={{ width: 120, fontSize: 12, flex: 'none' }}>
                {x.bots.join('、')}
              </Typography.Text>
            </div>
          ))}
        </Space>
      )}
    </Card>
  );

  const recentMemoryCard = (
    <Card size="small" title="最近沉淀的记忆" extra={<Link to="/memory">全部记忆 →</Link>} style={{ height: '100%' }}>
      {!mem && <Typography.Text type="secondary">加载中…</Typography.Text>}
      {mem && mem.recent.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有记忆" />}
      {mem && mem.recent.length > 0 && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {mem.recent.map((m) => (
            <div key={`${m.bot}/${m.file}`} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Tooltip title={dayjs(m.mtime).format('YYYY-MM-DD HH:mm')}>
                <Typography.Text type="secondary" style={{ fontSize: 12, width: 64, flex: 'none' }}>{dayjs(m.mtime).fromNow()}</Typography.Text>
              </Tooltip>
              <Tag color={m.isNew ? 'green' : undefined} style={{ margin: 0, flex: 'none' }}>{m.isNew ? '新增' : '更新'}</Tag>
              <Typography.Text style={{ flex: 'none' }}>{m.bot}</Typography.Text>
              <Typography.Link ellipsis style={{ flex: 1, minWidth: 0 }} onClick={() => openMemory(m.bot, m.file, m.title)}>
                {m.title}
              </Typography.Link>
            </div>
          ))}
        </Space>
      )}
    </Card>
  );

  // ---------------- 机器人表格 ----------------
  type BotRow = BotOverview & {
    members: number;
    scheduled: number;
    skills7d: number;
    memCount: number;
    memRatio: number;
    anomaly: boolean;
  };
  const botRows: BotRow[] = useMemo(() => {
    const rows = (data?.bots || []).map((b) => {
      const tb = dash?.tasks.perBot[b.name];
      const m = dash?.memory.perBot[b.name];
      return {
        ...b,
        members: tb?.members ?? 0,
        scheduled: tb?.scheduled ?? 0,
        skills7d: dash?.skills.perBot[b.name] ?? 0,
        memCount: m?.count ?? 0,
        memRatio: m?.ratio ?? 0,
        anomaly: !b.running || b.today.failed > 0,
      };
    });
    // 有异常的置顶，其余按最近活动排
    return rows.sort(
      (a, b) => Number(b.anomaly) - Number(a.anomaly) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name),
    );
  }, [data, dash]);

  const muted = (v: React.ReactNode) => <Typography.Text type="secondary">{v}</Typography.Text>;

  const botColumns = [
    {
      title: 'Bot',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: '状态',
      key: 'state',
      render: (_: unknown, b: BotRow) =>
        !b.running ? (
          <Badge status="error" text="离线" />
        ) : b.executors.active > 0 ? (
          <Badge status="processing" text={`执行中 ${b.executors.active}`} />
        ) : (
          <Badge status="default" text={muted('空闲')} />
        ),
    },
    {
      title: '今日任务',
      key: 'tasks',
      sorter: (a: BotRow, b: BotRow) => a.today.tasks - b.today.tasks,
      render: (_: unknown, b: BotRow) =>
        b.today.tasks === 0 ? (
          muted('—')
        ) : (
          <span>
            {b.today.tasks}
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
              {[b.members && `成员 ${b.members}`, b.scheduled && `定时 ${b.scheduled}`].filter(Boolean).join(' · ')}
            </Typography.Text>
            {b.today.failed > 0 && <Tag color="red" style={{ marginLeft: 6 }}>{b.today.failed} 失败</Tag>}
          </span>
        ),
    },
    {
      title: '技能调用（7 天）',
      key: 'skills',
      align: 'right' as const,
      sorter: (a: BotRow, b: BotRow) => a.skills7d - b.skills7d,
      render: (_: unknown, b: BotRow) => (b.skills7d ? `${b.skills7d} 次` : muted('—')),
    },
    {
      title: <Tooltip title="记忆条数；进度条是 MEMORY.md 索引的加载占用（超过 200 行 / 25,000 字符会被截断）">记忆 ⓘ</Tooltip>,
      key: 'memory',
      sorter: (a: BotRow, b: BotRow) => a.memCount - b.memCount,
      render: (_: unknown, b: BotRow) =>
        b.memCount === 0 ? (
          muted('—')
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140 }}>
            <span style={{ minWidth: 42, fontVariantNumeric: 'tabular-nums' }}>{b.memCount} 条</span>
            <Tooltip title={`索引占用 ${Math.round(b.memRatio * 100)}%`}>
              <Progress
                percent={Math.min(100, Math.round(b.memRatio * 100))}
                size="small"
                showInfo={false}
                status={b.memRatio >= 1 ? 'exception' : 'normal'}
                strokeColor={b.memRatio >= 1 ? undefined : b.memRatio >= MEMORY_WARN ? '#faad14' : undefined}
                style={{ width: 70, margin: 0 }}
              />
            </Tooltip>
          </div>
        ),
    },
    {
      title: '最近活动',
      key: 'last',
      defaultSortOrder: undefined,
      sorter: (a: BotRow, b: BotRow) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0),
      render: (_: unknown, b: BotRow) =>
        b.lastActivityAt ? <Tooltip title={dayjs(b.lastActivityAt).format('YYYY-MM-DD HH:mm')}>{dayjs(b.lastActivityAt).fromNow()}</Tooltip> : muted('—'),
    },
    {
      title: (
        <Tooltip title="今日任务的 API 等价金额，仅供参考——走订阅用量，不额外计费">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>用量参考 ⓘ</Typography.Text>
        </Tooltip>
      ),
      key: 'usage',
      align: 'right' as const,
      sorter: (a: BotRow, b: BotRow) => a.today.costUsd - b.today.costUsd,
      render: (_: unknown, b: BotRow) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{b.today.costUsd ? usd(b.today.costUsd) : '—'}</Typography.Text>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {failCount >= 2 && (
        <Alert type="error" banner message={`桥接连接中断（${error || '轮询失败'}）——若刚触发重启属正常，恢复后自动消失。`} />
      )}
      {statusBar}
      {tiles}
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>{attentionCard}</Col>
        <Col xs={24} xl={14}>{feedCard}</Col>
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>{skillRankCard}</Col>
        <Col xs={24} lg={12}>{recentMemoryCard}</Col>
      </Row>

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
                  <div key={`${b.when}|${b.name}`} style={{ display: 'flex', gap: 10, alignItems: 'baseline', minWidth: 0 }}>
                    <Typography.Text strong style={{ minWidth: 86, flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{whenText(b.when)}</Typography.Text>
                    <Typography.Text style={{ flex: 'none' }}>
                      {b.name}
                      {b.count > 1 && ` × ${b.count}`}
                    </Typography.Text>
                    <Typography.Text type="secondary" ellipsis={{ tooltip: b.botText }} style={{ fontSize: 12, flex: 1, minWidth: 0 }}>{b.botText}</Typography.Text>
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

      <Drawer title={memViewer?.title} open={!!memViewer} onClose={() => setMemViewer(null)} width={720}>
        {memViewer?.loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {memViewer && !memViewer.loading && !memViewer.data && <Alert type="warning" message="读取失败" />}
        {memViewer?.data && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">{MEM_TYPE[memViewer.data.frontmatter?.type ?? ''] ?? '未标注'}</Descriptions.Item>
              <Descriptions.Item label="更新">{dayjs(memViewer.data.mtime).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              {memViewer.data.frontmatter?.description && (
                <Descriptions.Item label="描述" span={2}>{memViewer.data.frontmatter.description}</Descriptions.Item>
              )}
            </Descriptions>
            <MarkdownView text={memViewer.data.body} />
            <div style={{ marginTop: 16 }}>
              <Link to="/memory">在记忆页查看全部 →</Link>
            </div>
          </>
        )}
      </Drawer>
    </Space>
  );
}
