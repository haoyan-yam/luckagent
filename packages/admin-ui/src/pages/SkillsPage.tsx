import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Card,
  Col,
  Collapse,
  Descriptions,
  Drawer,
  Input,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import { MarkdownView } from '../md';

interface SkillInfo {
  name: string;
  description: string;
  kind: 'dir' | 'symlink' | 'git';
  updatedAt: string | null;
}
interface SkillsPayload {
  globalDir: string;
  global: SkillInfo[];
  bots: Array<{ name: string; workdir: string; skills: SkillInfo[] }>;
}
interface SkillDetail {
  name: string;
  skillMd: string;
  files: string[];
  truncated: boolean;
}
interface UsageStat {
  total: number;
  last7d: number;
  last30d: number;
  sessions: number;
  /** 未走 Skill 工具、直接读 SKILL.md / 跑脚本的轮数 */
  direct: number;
  lastUsedAt: string | null;
}
interface UsagePayload {
  scanning: boolean;
  lastScanAt: string | null;
  /** bot → 该 bot 最早的会话记录时间 */
  coverage: Record<string, string>;
  usage: Record<string, Record<string, UsageStat>>;
}

type UsageState = 'active' | 'idle' | 'never';
type UsageFilter = UsageState | 'all';

interface ProjectRow extends SkillInfo {
  bot: string;
  workdir: string;
  stat: UsageStat;
  coverageFrom: string | null;
  state: UsageState;
}

const NO_USAGE: UsageStat = { total: 0, last7d: 0, last30d: 0, sessions: 0, direct: 0, lastUsedAt: null };

const KIND_TAG: Record<SkillInfo['kind'], { color: string; label: string }> = {
  dir: { color: 'default', label: '目录' },
  symlink: { color: 'blue', label: '符号链接' },
  git: { color: 'green', label: 'git 检出' },
};

const STATE_LABEL: Record<UsageState, string> = { active: '近 30 天在用', idle: '30 天未用', never: '从未使用' };

const usageState = (s: UsageStat): UsageState => (s.last30d > 0 ? 'active' : s.total > 0 ? 'idle' : 'never');

const fmtDate = (v: string | null) => (v ? dayjs(v).format('YYYY-MM-DD') : '—');

export default function SkillsPage() {
  const { data, error } = usePoll<SkillsPayload>(() => api.get('/admin/api/skills'), 30000);
  // 首次全量扫描对话记录要几秒：统计中时加快轮询，扫完回到慢速
  const [scanning, setScanning] = useState(false);
  const { data: usage, error: usageError } = usePoll<UsagePayload>(
    () => api.get('/admin/api/skills/usage'),
    scanning ? 3000 : 60000,
  );
  useEffect(() => setScanning(!!usage?.scanning), [usage?.scanning]);

  const [tab, setTab] = useState('project');
  const [search, setSearch] = useState('');
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all');
  const [detail, setDetail] = useState<{
    title: string;
    loading: boolean;
    data?: SkillDetail;
    stat?: UsageStat;
    coverageFrom?: string | null;
  } | null>(null);

  const openDetail = async (scope: 'global' | 'bot', skill: string, bot?: string, stat?: UsageStat, coverageFrom?: string | null) => {
    const title = bot ? `${bot} / ${skill}` : skill;
    setDetail({ title, loading: true, stat, coverageFrom });
    try {
      const qs = scope === 'bot' ? `scope=bot&bot=${encodeURIComponent(bot!)}&skill=${encodeURIComponent(skill)}` : `scope=global&skill=${encodeURIComponent(skill)}`;
      const d = await api.get<SkillDetail>(`/admin/api/skills/detail?${qs}`);
      setDetail({ title, loading: false, data: d, stat, coverageFrom });
    } catch {
      setDetail({ title, loading: false, stat, coverageFrom });
    }
  };

  // ---- 项目技能：所有 bot 的定制技能拍平成一张表，叠加使用统计 ----
  const projectRows: ProjectRow[] = useMemo(() => {
    const rows: ProjectRow[] = [];
    for (const b of data?.bots || []) {
      for (const s of b.skills) {
        const stat = usage?.usage[b.name]?.[s.name] || NO_USAGE;
        rows.push({ ...s, bot: b.name, workdir: b.workdir, stat, coverageFrom: usage?.coverage[b.name] ?? null, state: usageState(stat) });
      }
    }
    return rows;
  }, [data, usage]);

  const botsWithSkills = useMemo(() => Array.from(new Set(projectRows.map((r) => r.bot))), [projectRows]);
  const botsWithoutSkills = (data?.bots || []).filter((b) => b.skills.length === 0).map((b) => b.name);

  // 搜索 + bot 先过滤，使用状态的计数基于这一层
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projectRows.filter(
      (r) =>
        (!botFilter || r.bot === botFilter) &&
        (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
    );
  }, [projectRows, search, botFilter]);
  const stateCount = (s: UsageState) => searched.filter((r) => r.state === s).length;
  const visibleRows = usageFilter === 'all' ? searched : searched.filter((r) => r.state === usageFilter);

  const projectColumns = [
    { title: 'Bot', dataIndex: 'bot', key: 'bot', width: 130, sorter: (a: ProjectRow, b: ProjectRow) => a.bot.localeCompare(b.bot) },
    {
      title: '技能',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (v: string, r: ProjectRow) => (
        <Typography.Link onClick={() => openDetail('bot', v, r.bot, r.stat, r.coverageFrom)}>
          <strong>{v}</strong>
        </Typography.Link>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'desc',
      ellipsis: { showTitle: false },
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v || '—'}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: '近 7 天',
      key: 'd7',
      width: 80,
      align: 'right' as const,
      sorter: (a: ProjectRow, b: ProjectRow) => a.stat.last7d - b.stat.last7d,
      render: (_: unknown, r: ProjectRow) => r.stat.last7d || <Typography.Text type="secondary">0</Typography.Text>,
    },
    {
      title: '近 30 天',
      key: 'd30',
      width: 90,
      align: 'right' as const,
      sorter: (a: ProjectRow, b: ProjectRow) => a.stat.last30d - b.stat.last30d,
      render: (_: unknown, r: ProjectRow) => r.stat.last30d || <Typography.Text type="secondary">0</Typography.Text>,
    },
    {
      title: '累计',
      key: 'total',
      width: 70,
      align: 'right' as const,
      sorter: (a: ProjectRow, b: ProjectRow) => a.stat.total - b.stat.total,
      render: (_: unknown, r: ProjectRow) => r.stat.total || <Typography.Text type="secondary">0</Typography.Text>,
    },
    {
      title: '最近使用',
      key: 'last',
      width: 130,
      sorter: (a: ProjectRow, b: ProjectRow) =>
        (a.stat.lastUsedAt ? Date.parse(a.stat.lastUsedAt) : 0) - (b.stat.lastUsedAt ? Date.parse(b.stat.lastUsedAt) : 0),
      render: (_: unknown, r: ProjectRow) =>
        r.state === 'never' ? (
          <Tooltip title={r.coverageFrom ? `${r.bot} 自 ${fmtDate(r.coverageFrom)}（现存最早的会话记录）以来没有用过` : undefined}>
            <Tag>从未使用</Tag>
          </Tooltip>
        ) : (
          <Tooltip title={dayjs(r.stat.lastUsedAt).format('YYYY-MM-DD HH:mm')}>
            {r.state === 'idle' ? <Tag color="orange">{dayjs(r.stat.lastUsedAt).fromNow()}</Tag> : dayjs(r.stat.lastUsedAt).fromNow()}
          </Tooltip>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'at',
      width: 110,
      sorter: (a: ProjectRow, b: ProjectRow) => (a.updatedAt || '').localeCompare(b.updatedAt || ''),
      render: fmtDate,
    },
  ];

  const globalColumns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      render: (v: string) => (
        <Typography.Link onClick={() => openDetail('global', v)}>
          <strong>{v}</strong>
        </Typography.Link>
      ),
    },
    { title: '描述', dataIndex: 'description', key: 'desc', ellipsis: true },
    {
      title: '来源',
      dataIndex: 'kind',
      key: 'kind',
      width: 100,
      render: (k: SkillInfo['kind']) => <Tag color={KIND_TAG[k].color}>{KIND_TAG[k].label}</Tag>,
    },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'at', width: 120, render: fmtDate },
  ];

  const globalSkills = data?.global || [];
  const larkSkills = globalSkills.filter((s) => s.name.startsWith('lark-'));
  const mainSkills = globalSkills.filter((s) => !s.name.startsWith('lark-'));

  // 各 bot 会话记录的起始日不同，只看有项目技能的 bot
  const coverageDates = botsWithSkills
    .map((b) => usage?.coverage[b])
    .filter((v): v is string => !!v)
    .sort();
  const coverageText =
    coverageDates.length === 0
      ? ''
      : fmtDate(coverageDates[0]) === fmtDate(coverageDates[coverageDates.length - 1])
        ? `，统计自 ${fmtDate(coverageDates[0])} 起`
        : `，各 bot 统计起始日 ${fmtDate(coverageDates[0])} ~ ${fmtDate(coverageDates[coverageDates.length - 1])}（以现存最早的会话记录为准）`;

  const usageMeta = (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {usage?.scanning && (
        <>
          <Spin size="small" /> 正在统计对话记录…{' '}
        </>
      )}
      使用次数 = 用到该技能的对话轮数（一次请求里跑多少次脚本都只算 1 次），含 Skill 工具调用、直接读取 SKILL.md、直接运行技能脚本
      {coverageText}
      {usage?.lastScanAt && `；上次统计 ${dayjs(usage.lastScanAt).format('HH:mm')}`}
    </Typography.Text>
  );

  const projectTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {usageError && <Alert type="warning" showIcon message={`使用统计加载失败：${usageError}`} />}
      <Row gutter={16}>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic
              title="项目技能"
              value={projectRows.length}
              suffix={<span style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)' }}>分布在 {botsWithSkills.length} 个 bot</span>}
            /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="近 30 天在用" value={projectRows.filter((r) => r.state === 'active').length} valueStyle={{ color: '#389e0d' }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="30 天未用" value={projectRows.filter((r) => r.state === 'idle').length} valueStyle={{ color: '#d48806' }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title="从未使用" value={projectRows.filter((r) => r.state === 'never').length} /></Card>
        </Col>
      </Row>
      {usageMeta}
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="搜索技能名 / 描述"
          style={{ width: 220 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          showSearch
          style={{ width: 180 }}
          placeholder="全部 bot"
          value={botFilter}
          onChange={(v) => setBotFilter(v ?? null)}
          options={botsWithSkills.map((n) => ({ value: n, label: n }))}
        />
        <Segmented<UsageFilter>
          value={usageFilter}
          onChange={setUsageFilter}
          options={[
            { value: 'all', label: `全部 (${searched.length})` },
            ...(['active', 'idle', 'never'] as UsageState[]).map((s) => ({ value: s, label: `${STATE_LABEL[s]} (${stateCount(s)})` })),
          ]}
        />
      </Space>
      <Table
        rowKey={(r) => `${r.bot}/${r.name}`}
        dataSource={visibleRows}
        columns={projectColumns}
        loading={!data && !error}
        pagination={{ pageSize: 20, hideOnSinglePage: true }}
        size="small"
        rowClassName={(r) => (r.state === 'never' ? 'skill-row-unused' : '')}
        locale={{ emptyText: projectRows.length === 0 ? '各 bot 工作目录下暂无项目级技能' : '没有符合筛选条件的技能' }}
      />
      {botsWithoutSkills.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          没有项目级技能的 bot（{botsWithoutSkills.length}）：{botsWithoutSkills.join('、')}
        </Typography.Text>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        项目级技能放在各 bot 工作目录的 <Typography.Text code>.claude/skills/</Typography.Text>，只对该 bot 生效，
        与全局同名时项目级优先。「从未使用」指该 bot 统计起始日以来没有任何读取或调用记录——
        常见于纯文案类技能：模型没触发 Skill 工具、也没读 SKILL.md，说明技能内容其实没被用上，可能需要改进描述（description）。
      </Typography.Paragraph>
    </Space>
  );

  const globalTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {data?.globalDir}（对所有 bot 生效，由 luckagent update / lark-cli 维护，不纳入使用统计）
      </Typography.Text>
      <Table rowKey="name" dataSource={mainSkills} columns={globalColumns} pagination={false} size="small" loading={!data && !error} />
      {larkSkills.length > 0 && (
        <Collapse
          ghost
          items={[{
            key: 'lark',
            label: `lark-* 飞书技能（${larkSkills.length} 个，随 lark-cli 安装）`,
            children: <Table rowKey="name" dataSource={larkSkills} columns={globalColumns} pagination={false} size="small" />,
          }]}
        />
      )}
    </Space>
  );

  return (
    <Card title="技能">
      <style>{'.skill-row-unused td { opacity: 0.6; }'}</style>
      {error && <Alert type="error" banner message={`加载失败：${error}`} style={{ marginBottom: 16 }} />}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'project', label: `项目技能 (${projectRows.length})`, children: projectTab },
          { key: 'global', label: `全局技能 (${globalSkills.length})`, children: globalTab },
        ]}
      />

      <Drawer title={detail?.title} open={!!detail} onClose={() => setDetail(null)} width={720}>
        {detail?.stat && (
          <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="近 7 天">{detail.stat.last7d}</Descriptions.Item>
            <Descriptions.Item label="近 30 天">{detail.stat.last30d}</Descriptions.Item>
            <Descriptions.Item label="累计">{detail.stat.total}</Descriptions.Item>
            <Descriptions.Item label="涉及会话">{detail.stat.sessions}</Descriptions.Item>
            <Descriptions.Item label="直接使用">
              <Tooltip title="没走 Skill 工具、直接读取 SKILL.md 或运行技能脚本的轮数">{detail.stat.direct}</Tooltip>
            </Descriptions.Item>
            <Descriptions.Item label="统计起始">{fmtDate(detail.coverageFrom ?? null)}</Descriptions.Item>
            <Descriptions.Item label="最近使用" span={3}>
              {detail.stat.lastUsedAt ? dayjs(detail.stat.lastUsedAt).format('YYYY-MM-DD HH:mm') : '从未使用'}
            </Descriptions.Item>
          </Descriptions>
        )}
        {detail?.loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {detail && !detail.loading && !detail.data && <Alert type="warning" message="读取失败" />}
        {detail?.data && (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {detail.data.skillMd ? (
              <MarkdownView text={detail.data.skillMd} />
            ) : (
              <Alert type="info" message="该技能没有 SKILL.md" />
            )}
            <Card size="small" title={`文件清单（${detail.data.files.length}${detail.data.truncated ? '+，已截断' : ''}）`}>
              <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{detail.data.files.join('\n')}</pre>
            </Card>
          </Space>
        )}
      </Drawer>
    </Card>
  );
}
