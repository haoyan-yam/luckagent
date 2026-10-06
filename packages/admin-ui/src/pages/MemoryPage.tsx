import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import { MarkdownView } from '../md';

interface Frontmatter {
  name: string;
  description: string;
  type: string;
}
interface MemFileView {
  file: string;
  title: string;
  hook: string;
  lineChars: number;
  indexed: boolean;
  exists: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  frontmatter: Frontmatter | null;
}
interface BotMemory {
  name: string;
  workdir: string;
  exists: boolean;
  memoryDir: string | null;
  index: { exists: boolean; lines: number; chars: number };
  files: MemFileView[];
}
interface OverviewPayload {
  limits: { lines: number; chars: number };
  bots: BotMemory[];
}
interface MemFile {
  file: string;
  content: string;
  frontmatter: Frontmatter | null;
  body: string;
  sizeBytes: number;
  mtime: string;
}
interface SearchHit { bot: string; file: string; matches: number; snippet: string; }

type MemType = 'project' | 'feedback' | 'reference' | 'user' | 'none';
type TypeFilter = MemType | 'all';
type Flag = 'stale' | 'longHook' | 'unindexed' | 'missing';

interface Row extends MemFileView {
  bot: string;
  type: MemType;
  stale: boolean;
  longHook: boolean;
}

const STALE_DAYS = 30;
/** 索引里一行超过这个字数就不是「指针」而是小作文了 */
const LONG_HOOK_CHARS = 150;
const WARN_RATIO = 0.7;

const TYPE_META: Record<MemType, { label: string; color?: string }> = {
  project: { label: '项目', color: 'blue' },
  feedback: { label: '反馈', color: 'magenta' },
  reference: { label: '参考', color: 'cyan' },
  user: { label: '用户', color: 'gold' },
  none: { label: '未标注' },
};
const TYPE_ORDER: MemType[] = ['project', 'feedback', 'reference', 'user', 'none'];

const FLAG_LABEL: Record<Flag, string> = {
  stale: `${STALE_DAYS} 天未更新`,
  longHook: '索引行过长',
  unindexed: '未入索引',
  missing: '文件缺失',
};

const toType = (t: string | undefined): MemType =>
  t === 'project' || t === 'feedback' || t === 'reference' || t === 'user' ? t : 'none';

const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 把命中的关键词标出来 */
function highlight(text: string, q: string) {
  const needle = q.trim();
  if (!needle) return text;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: Array<string | JSX.Element> = [];
  let i = 0;
  for (let j = lower.indexOf(n); j !== -1; j = lower.indexOf(n, i)) {
    out.push(text.slice(i, j), <mark key={j} style={{ padding: 0 }}>{text.slice(j, j + n.length)}</mark>);
    i = j + n.length;
  }
  out.push(text.slice(i));
  return out;
}

/** 记忆正文里的 [[name]] 引用转成可点击的内部链接 */
const linkifyRefs = (body: string) => body.replace(/\[\[([^\]\n]+)\]\]/g, (_, name: string) => `[${name}](#mem:${encodeURIComponent(name.trim())})`);

const hasFlag = (r: Row, f: Flag) =>
  f === 'stale' ? r.stale : f === 'longHook' ? r.longHook : f === 'unindexed' ? !r.indexed : !r.exists;

export default function MemoryPage() {
  const { data, error, refresh } = usePoll<OverviewPayload>(() => api.get('/admin/api/memory/overview'), 60000);
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [flagFilter, setFlagFilter] = useState<Flag | null>(null);
  const [viewer, setViewer] = useState<{ bot: string; title: string; loading: boolean; data?: MemFile } | null>(null);
  // 正文全文搜索：后端检索，结果按 bot/file 合进明细表的筛选
  const [contentHits, setContentHits] = useState<Map<string, SearchHit> | null>(null);
  const [searching, setSearching] = useState(false);
  const query = search.trim();

  useEffect(() => {
    if (query.length < 2) {
      setContentHits(null);
      setSearching(false);
      return;
    }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .get<{ hits: SearchHit[] }>(`/admin/api/memory/search?q=${encodeURIComponent(query)}`)
        .then((r) => { if (!stale) setContentHits(new Map(r.hits.map((h) => [`${h.bot}/${h.file}`, h]))); })
        .catch(() => { if (!stale) setContentHits(null); })
        .finally(() => { if (!stale) setSearching(false); });
    }, 300);
    return () => { stale = true; clearTimeout(timer); };
  }, [query]);

  const limits = data?.limits ?? { lines: 200, chars: 25000 };

  const rows: Row[] = useMemo(() => {
    const now = Date.now();
    return (data?.bots || []).flatMap((b) =>
      b.files.map((f) => ({
        ...f,
        bot: b.name,
        type: toType(f.frontmatter?.type),
        stale: !!f.mtime && now - Date.parse(f.mtime) > STALE_DAYS * 86400000,
        longHook: f.lineChars > LONG_HOOK_CHARS,
      })),
    );
  }, [data]);

  const openFile = async (bot: string, file: string, title: string) => {
    setViewer({ bot, title: `${bot} / ${title}`, loading: true });
    try {
      const d = await api.get<MemFile>(`/admin/api/memory/file?bot=${encodeURIComponent(bot)}&file=${encodeURIComponent(file)}`);
      setViewer({ bot, title: `${bot} / ${title}`, loading: false, data: d });
    } catch {
      setViewer({ bot, title: `${bot} / ${title}`, loading: false });
    }
  };

  // 详情里点记忆之间的引用：[[name]] 或指向同目录 .md 的相对链接
  const onMemoryLink = (href: string): boolean => {
    if (!viewer) return false;
    let target: Row | undefined;
    if (href.startsWith('#mem:')) {
      const name = decodeURIComponent(href.slice(5));
      target = rows.find((r) => r.bot === viewer.bot && r.exists && (r.frontmatter?.name === name || r.file === `${name}.md`));
      if (!target) {
        message.info(`${viewer.bot} 没有名为「${name}」的记忆`);
        return true;
      }
    } else if (/^(?!\w+:)(?:\.\/)?[^/#?]+\.md$/.test(href)) {
      const file = decodeURIComponent(href.replace(/^\.\//, ''));
      target = rows.find((r) => r.bot === viewer.bot && r.file === file && r.exists);
      if (!target) {
        message.info(`${viewer.bot} 的记忆目录里没有 ${file}`);
        return true;
      }
    } else {
      return false;
    }
    void openFile(target.bot, target.file, target.title);
    return true;
  };

  // ---------------- 总览：一个 bot 一行 ----------------
  const indexRatio = (b: BotMemory) => Math.max(b.index.lines / limits.lines, b.index.chars / limits.chars);

  const overviewRows = useMemo(
    () =>
      (data?.bots || []).map((b) => {
        const rs = rows.filter((r) => r.bot === b.name);
        return {
          ...b,
          count: rs.filter((r) => r.exists).length,
          totalBytes: rs.reduce((s, r) => s + (r.sizeBytes ?? 0), 0),
          feedback: rs.filter((r) => r.type === 'feedback').length,
          stale: rs.filter((r) => r.stale).length,
          longHook: rs.filter((r) => r.longHook).length,
          unindexed: rs.filter((r) => !r.indexed).length,
          missing: rs.filter((r) => !r.exists).length,
          lastUpdated: rs.reduce<string | null>((m, r) => (r.mtime && (!m || r.mtime > m) ? r.mtime : m), null),
          ratio: indexRatio(b),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, rows],
  );
  type OverviewRow = (typeof overviewRows)[number];

  const drillDown = (bot: string, flag: Flag | null = null) => {
    setBotFilter(bot);
    setFlagFilter(flag);
    setTypeFilter('all');
    setSearch('');
    setTab('detail');
  };

  const countCell = (n: number, bot: string, flag: Flag, color?: string) =>
    n > 0 ? (
      <Typography.Link onClick={(e) => { e.stopPropagation(); drillDown(bot, flag); }}>
        {color ? <Tag color={color}>{n}</Tag> : n}
      </Typography.Link>
    ) : (
      <Typography.Text type="secondary">0</Typography.Text>
    );

  const overviewColumns = [
    {
      title: 'Bot',
      dataIndex: 'name',
      key: 'name',
      width: 130,
      sorter: (a: OverviewRow, b: OverviewRow) => a.name.localeCompare(b.name),
      render: (v: string) => <Typography.Link strong>{v}</Typography.Link>,
    },
    {
      title: '记忆',
      key: 'count',
      width: 80,
      align: 'right' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.count - b.count,
      render: (_: unknown, r: OverviewRow) => (r.exists ? r.count : <Typography.Text type="secondary">暂无</Typography.Text>),
    },
    {
      title: '总大小',
      key: 'size',
      width: 90,
      align: 'right' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.totalBytes - b.totalBytes,
      render: (_: unknown, r: OverviewRow) => (r.totalBytes ? fmtSize(r.totalBytes) : '—'),
    },
    {
      title: (
        <Tooltip title={`bot 每次会话只加载 MEMORY.md 的前 ${limits.lines} 行 / ${limits.chars.toLocaleString()} 字符，超出部分 bot 看不到。取两项中占比更高的一项。`}>
          索引占用 ⓘ
        </Tooltip>
      ),
      key: 'index',
      width: 230,
      defaultSortOrder: 'descend' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.ratio - b.ratio,
      render: (_: unknown, r: OverviewRow) =>
        !r.index.exists ? (
          <Typography.Text type="secondary">{r.exists ? '无 MEMORY.md' : '—'}</Typography.Text>
        ) : (
          <div style={{ lineHeight: 1.2 }}>
            <Progress
              percent={Math.min(100, Math.round(r.ratio * 100))}
              size="small"
              status={r.ratio >= 1 ? 'exception' : 'normal'}
              strokeColor={r.ratio >= 1 ? undefined : r.ratio >= WARN_RATIO ? '#faad14' : undefined}
              style={{ marginBottom: 0 }}
            />
            <Typography.Text type={r.ratio >= 1 ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {r.index.lines}/{limits.lines} 行 · {fmtK(r.index.chars)}/{fmtK(limits.chars)} 字
              {r.ratio >= 1 && ' · 已被截断'}
            </Typography.Text>
          </div>
        ),
    },
    {
      title: '反馈',
      key: 'feedback',
      width: 70,
      align: 'right' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.feedback - b.feedback,
      render: (_: unknown, r: OverviewRow) => r.feedback || <Typography.Text type="secondary">0</Typography.Text>,
    },
    {
      title: `${STALE_DAYS} 天未更新`,
      key: 'stale',
      width: 100,
      align: 'right' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.stale - b.stale,
      render: (_: unknown, r: OverviewRow) => countCell(r.stale, r.name, 'stale'),
    },
    {
      title: <Tooltip title={`索引里超过 ${LONG_HOOK_CHARS} 字的行，建议精简成一句话指针，细节放进记忆文件`}>索引行过长 ⓘ</Tooltip>,
      key: 'longHook',
      width: 110,
      align: 'right' as const,
      sorter: (a: OverviewRow, b: OverviewRow) => a.longHook - b.longHook,
      render: (_: unknown, r: OverviewRow) => countCell(r.longHook, r.name, 'longHook', 'orange'),
    },
    {
      title: '异常',
      key: 'health',
      width: 150,
      render: (_: unknown, r: OverviewRow) =>
        r.unindexed || r.missing ? (
          <Space size={4} wrap>
            {r.unindexed > 0 && countCell(r.unindexed, r.name, 'unindexed', 'gold')}
            {r.unindexed > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>未入索引</Typography.Text>}
            {r.missing > 0 && countCell(r.missing, r.name, 'missing', 'red')}
            {r.missing > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>文件缺失</Typography.Text>}
          </Space>
        ) : r.exists ? (
          <Typography.Text type="success">正常</Typography.Text>
        ) : (
          '—'
        ),
    },
    {
      title: '最近更新',
      key: 'last',
      width: 110,
      sorter: (a: OverviewRow, b: OverviewRow) => (a.lastUpdated || '').localeCompare(b.lastUpdated || ''),
      render: (_: unknown, r: OverviewRow) =>
        r.lastUpdated ? <Tooltip title={dayjs(r.lastUpdated).format('YYYY-MM-DD HH:mm')}>{dayjs(r.lastUpdated).fromNow()}</Tooltip> : '—',
    },
  ];

  const totals = {
    memories: overviewRows.reduce((s, r) => s + r.count, 0),
    bots: overviewRows.filter((r) => r.exists).length,
    warn: overviewRows.filter((r) => r.ratio >= WARN_RATIO).length,
  };

  const overviewTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        各 bot 在对话中自主沉淀的私人笔记（按工作目录隔离，互不可见），共 {totals.memories} 条，分布在 {totals.bots} 个 bot。
        bot 每次会话开始只加载索引 MEMORY.md 的前 {limits.lines} 行 / {limits.chars.toLocaleString()} 字符，
        占用超过 {Math.round(WARN_RATIO * 100)}% 标黄、超限标红。点击一行查看该 bot 的记忆明细。
      </Typography.Text>
      {totals.warn > 0 && (
        <Alert type="warning" showIcon message={`有 ${totals.warn} 个 bot 的记忆索引占用超过 ${Math.round(WARN_RATIO * 100)}%，建议精简索引行（一行一句话指针）。`} />
      )}
      <Table
        rowKey="name"
        dataSource={overviewRows}
        columns={overviewColumns}
        loading={!data && !error}
        pagination={false}
        size="small"
        onRow={(r) => ({ onClick: () => drillDown(r.name), style: { cursor: 'pointer' } })}
      />
    </Space>
  );

  // ---------------- 明细：所有记忆拍平 ----------------
  // 计数基于「搜索 + bot + 状态」筛完的结果，类型计数随之联动
  const base = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!botFilter || r.bot === botFilter) &&
        (!flagFilter || hasFlag(r, flagFilter)) &&
        (!q ||
          r.title.toLowerCase().includes(q) ||
          r.hook.toLowerCase().includes(q) ||
          r.file.toLowerCase().includes(q) ||
          !!contentHits?.has(`${r.bot}/${r.file}`)),
    );
  }, [rows, search, botFilter, flagFilter, contentHits]);
  const typeCount = (t: MemType) => base.filter((r) => r.type === t).length;
  const visible = typeFilter === 'all' ? base : base.filter((r) => r.type === typeFilter);

  const detailColumns = [
    { title: 'Bot', dataIndex: 'bot', key: 'bot', width: 120, sorter: (a: Row, b: Row) => a.bot.localeCompare(b.bot) },
    {
      title: '记忆',
      key: 'title',
      width: 240,
      render: (_: unknown, r: Row) => (
        <div>
          {r.exists ? (
            <Typography.Link strong onClick={() => openFile(r.bot, r.file, r.title)}>{highlight(r.title, query)}</Typography.Link>
          ) : (
            <Typography.Text strong>{highlight(r.title, query)}</Typography.Text>
          )}
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.file}</Typography.Text>
            {!r.exists && <Tag color="red" style={{ marginLeft: 6 }}>文件缺失</Tag>}
            {!r.indexed && <Tag color="gold" style={{ marginLeft: 6 }}>未入索引</Tag>}
          </div>
        </div>
      ),
    },
    {
      title: '类型',
      key: 'type',
      width: 80,
      render: (_: unknown, r: Row) => <Tag color={TYPE_META[r.type].color}>{TYPE_META[r.type].label}</Tag>,
    },
    {
      title: '钩子（索引里的一句话）',
      key: 'hook',
      ellipsis: { showTitle: false },
      render: (_: unknown, r: Row) => {
        const hit = contentHits?.get(`${r.bot}/${r.file}`);
        return (
          <div>
            <Tooltip title={r.hook} placement="topLeft">
              {r.longHook && <Tag color="orange">{r.lineChars} 字</Tag>}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.hook ? highlight(r.hook, query) : '—'}</Typography.Text>
            </Tooltip>
            {hit && (
              <div style={{ whiteSpace: 'normal', marginTop: 2 }}>
                <Tag color="processing">正文 {hit.matches} 处</Tag>
                <Typography.Text style={{ fontSize: 12 }}>{highlight(hit.snippet, query)}</Typography.Text>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: '大小',
      key: 'size',
      width: 80,
      align: 'right' as const,
      sorter: (a: Row, b: Row) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0),
      render: (_: unknown, r: Row) => (r.sizeBytes !== null ? fmtSize(r.sizeBytes) : '—'),
    },
    {
      title: '更新',
      key: 'mtime',
      width: 110,
      sorter: (a: Row, b: Row) => (a.mtime || '').localeCompare(b.mtime || ''),
      render: (_: unknown, r: Row) =>
        r.mtime ? (
          <Tooltip title={dayjs(r.mtime).format('YYYY-MM-DD HH:mm')}>
            {r.stale ? <Tag color="orange">{dayjs(r.mtime).fromNow()}</Tag> : dayjs(r.mtime).fromNow()}
          </Tooltip>
        ) : (
          '—'
        ),
    },
  ];

  const detailTab = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder="搜索标题 / 钩子 / 正文"
          style={{ width: 240 }}
          value={search}
          loading={searching}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          showSearch
          style={{ width: 170 }}
          placeholder="全部 bot"
          value={botFilter}
          onChange={(v) => setBotFilter(v ?? null)}
          options={(data?.bots || []).filter((b) => b.exists).map((b) => ({ value: b.name, label: b.name }))}
        />
        <Select
          allowClear
          style={{ width: 150 }}
          placeholder="全部状态"
          value={flagFilter}
          onChange={(v) => setFlagFilter(v ?? null)}
          options={(Object.keys(FLAG_LABEL) as Flag[]).map((f) => ({ value: f, label: FLAG_LABEL[f] }))}
        />
        <Segmented<TypeFilter>
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'all', label: `全部 (${base.length})` },
            ...TYPE_ORDER.filter((t) => t !== 'none' || typeCount('none') > 0).map((t) => ({
              value: t,
              label: `${TYPE_META[t].label} (${typeCount(t)})`,
            })),
          ]}
        />
      </Space>
      <Table
        rowKey={(r) => `${r.bot}/${r.file}`}
        dataSource={visible}
        columns={detailColumns}
        loading={!data && !error}
        pagination={{ pageSize: 30, showSizeChanger: false, hideOnSinglePage: true }}
        size="small"
        locale={{ emptyText: rows.length === 0 ? '各 bot 还没有产生记忆' : '没有符合筛选条件的记忆' }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        类型取自记忆文件开头的 type 字段：项目 = 项目进展与决定，反馈 = 用户对 bot 的纠正与确认，参考 = 外部资料指针，用户 = 关于人的偏好。
        修改记忆仍在对应 bot 的记忆目录里手动编辑。
      </Typography.Text>
    </Space>
  );

  return (
    <Card
      title="记忆"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
          刷新
        </Button>
      }
    >
      {error && <Alert type="error" banner message={`加载失败：${error}`} style={{ marginBottom: 16 }} />}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'overview', label: '总览', children: overviewTab },
          { key: 'detail', label: `明细 (${rows.length})`, children: detailTab },
        ]}
      />

      <Drawer title={viewer?.title} open={!!viewer} onClose={() => setViewer(null)} width={720}>
        {viewer?.loading && <Typography.Text type="secondary">加载中…</Typography.Text>}
        {viewer && !viewer.loading && !viewer.data && <Alert type="warning" message="读取失败" />}
        {viewer?.data && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="类型">
                <Tag color={TYPE_META[toType(viewer.data.frontmatter?.type)].color}>{TYPE_META[toType(viewer.data.frontmatter?.type)].label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="名称">
                {viewer.data.frontmatter?.name ? <Typography.Text code>{viewer.data.frontmatter.name}</Typography.Text> : '—'}
              </Descriptions.Item>
              {viewer.data.frontmatter?.description && (
                <Descriptions.Item label="描述" span={2}>{viewer.data.frontmatter.description}</Descriptions.Item>
              )}
              <Descriptions.Item label="文件" span={2}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {viewer.data.file} · {(viewer.data.sizeBytes / 1024).toFixed(1)}KB · 更新于 {dayjs(viewer.data.mtime).format('YYYY-MM-DD HH:mm')}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            <MarkdownView text={linkifyRefs(viewer.data.body)} onLinkClick={onMemoryLink} />
          </>
        )}
      </Drawer>
    </Card>
  );
}
