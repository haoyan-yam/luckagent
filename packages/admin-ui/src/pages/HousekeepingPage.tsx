import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EyeOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import MemberPicker from '../components/MemberPicker';

// ---------------------------------------------------------------- types

type RuleKind = 'files' | 'extracted-zip' | 'codex-exec-sessions';
type RuleAction = 'archive' | 'trash';
type EntryStatus = 'pending' | 'archived' | 'trashed' | 'skipped' | 'error' | 'protected' | 'restored';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  kind: RuleKind;
  root: string;
  include: string[];
  exclude: string[];
  minAgeDays: number;
  minSizeMB: number;
  action: RuleAction;
  keepLatestPerSeries?: boolean;
}

interface AlertRecipient {
  type: 'user' | 'chat';
  id: string;
  name?: string;
}

interface AlertConfig {
  enabled: boolean;
  bot: string;
  recipients: AlertRecipient[];
  minFreeGB: number;
}

interface Config {
  schedule: { enabled: boolean; cron: string };
  archiveRoot: string;
  rules: Rule[];
  alert?: AlertConfig;
}

interface RuleSummary {
  id: string;
  name: string;
  action: RuleAction;
  matched: number;
  matchedBytes: number;
  done: number;
  doneBytes: number;
  skipped: number;
  errors: number;
  protected?: number;
  protectedBytes?: number;
  skippedReason?: string;
}

interface RunSummary {
  id: string;
  trigger: 'manual' | 'schedule';
  dryRun: boolean;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  phase?: string;
  rules: RuleSummary[];
  totals: { matched: number; matchedBytes: number; done: number; doneBytes: number; skipped: number; errors: number; protected?: number; protectedBytes?: number };
  freeBefore?: number;
  freeAfter?: number;
  archiveRoot?: string;
  trashDir?: string;
  error?: string;
  warnings?: string[];
}

interface RunEntry {
  ruleId: string;
  path: string;
  size: number;
  mtimeMs: number;
  touchedMs?: number;
  status: EntryStatus;
  dest?: string;
  sha1?: string;
  note?: string;
}

interface Status {
  config: Config;
  nextRunAt: number | null;
  current: RunSummary | null;
  disk: { totalBytes: number; freeBytes: number } | null;
  archive: { ok: boolean; root: string; reason?: string; freeBytes?: number };
  bots: string[];
}

// ---------------------------------------------------------------- helpers

const KIND_LABEL: Record<RuleKind, string> = {
  files: '按时间 / 体积',
  'extracted-zip': '已解压的 zip',
  'codex-exec-sessions': 'Codex 生图会话',
};
const KIND_HELP: Record<RuleKind, string> = {
  files: '命中匹配规则、且满足天数和体积条件的文件',
  'extracted-zip': '只处理内容已经完整解压在同一项目里的 zip（逐个比对文件名、大小、CRC）',
  'codex-exec-sessions': '只处理 codex exec（生图）产生的会话，你自己开的 Codex 会话不动',
};
const ENTRY_STATUS: Record<EntryStatus, { label: string; color: string }> = {
  pending: { label: '将处理', color: 'blue' },
  archived: { label: '已归档', color: 'green' },
  trashed: { label: '已进废纸篓', color: 'cyan' },
  skipped: { label: '跳过', color: 'orange' },
  error: { label: '出错', color: 'red' },
  protected: { label: '受保护', color: 'gold' },
  restored: { label: '已恢复', color: 'purple' },
};

function fmtBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtDuration(ms?: number): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

const actionTag = (a: RuleAction) => (a === 'archive' ? <Tag color="purple">归档到硬盘</Tag> : <Tag color="cyan">移到废纸篓</Tag>);

const runStatusTag = (r: RunSummary) => {
  if (r.status === 'running') return <Tag color="processing">进行中</Tag>;
  if (r.status === 'failed') return <Tag color="red">失败</Tag>;
  if (r.status === 'cancelled') return <Tag color="orange">已取消</Tag>;
  if (r.totals.errors) return <Tag color="orange">完成（有出错）</Tag>;
  return <Tag color="green">完成</Tag>;
};

// ---------------------------------------------------------------- page

export default function HousekeepingPage() {
  const { data, refresh } = usePoll<Status>(() => api.get('/admin/api/housekeeping'), 3000);
  const { data: runsData, refresh: refreshRuns } = usePoll<{ runs: RunSummary[] }>(
    () => api.get('/admin/api/housekeeping/runs?limit=100'),
    5000,
  );
  const [settingsForm] = Form.useForm();
  const [ruleForm] = Form.useForm();
  const [editing, setEditing] = useState<Rule | null | 'new'>(null);
  const [saving, setSaving] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const cfg = data?.config;
  const running = !!data?.current;

  useEffect(() => {
    if (cfg) settingsForm.setFieldsValue({ archiveRoot: cfg.archiveRoot, cron: cfg.schedule.cron, enabled: cfg.schedule.enabled });
    // only when the server config changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cfg?.schedule), cfg?.archiveRoot]);

  const saveConfig = async (next: Config, ok = '已保存') => {
    setSaving(true);
    try {
      await api.put('/admin/api/housekeeping/config', next);
      message.success(ok);
      await refresh();
      return true;
    } catch (err: any) {
      message.error(err?.message || '保存失败');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const startRun = async (dryRun: boolean, ruleIds?: string[]) => {
    try {
      const r = await api.post<{ runId: string }>('/admin/api/housekeeping/run', { dryRun, ruleIds });
      message.success(dryRun ? '开始预览，扫描完可在执行记录里查看' : '开始执行');
      await Promise.all([refresh(), refreshRuns()]);
      setOpenRun(r.runId);
    } catch (err: any) {
      message.error(err?.message || '启动失败');
    }
  };

  const onSaveSettings = async () => {
    if (!cfg) return;
    const v = await settingsForm.validateFields();
    await saveConfig({ ...cfg, archiveRoot: (v.archiveRoot || '').trim(), schedule: { enabled: !!v.enabled, cron: v.cron.trim() } });
  };

  const openEditor = (r: Rule | 'new') => {
    setEditing(r);
    ruleForm.setFieldsValue(
      r === 'new'
        ? { name: '', enabled: true, kind: 'files', root: '~/projects', include: '', exclude: '', minAgeDays: 30, minSizeMB: 0, action: 'archive', keepLatestPerSeries: false }
        : { ...r, include: r.include.join('\n'), exclude: r.exclude.join('\n') },
    );
  };

  const onSaveRule = async () => {
    if (!cfg || !editing) return;
    const v = await ruleForm.validateFields();
    const lines = (s: string) => (s || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const rule: Rule = {
      id: editing === 'new' ? '' : editing.id,
      name: v.name.trim(),
      enabled: v.enabled,
      kind: v.kind,
      root: v.root.trim(),
      include: lines(v.include),
      exclude: lines(v.exclude),
      minAgeDays: v.minAgeDays,
      minSizeMB: v.minSizeMB ?? 0,
      action: v.action,
      keepLatestPerSeries: !!v.keepLatestPerSeries,
    };
    const rules = editing === 'new' ? [...cfg.rules, rule] : cfg.rules.map((r) => (r.id === rule.id ? rule : r));
    if (await saveConfig({ ...cfg, rules }, editing === 'new' ? '已添加规则' : '已保存规则')) setEditing(null);
  };

  const ruleColumns = [
    {
      title: '启用',
      key: 'enabled',
      width: 70,
      render: (_: unknown, r: Rule) => (
        <Switch
          size="small"
          checked={r.enabled}
          disabled={saving}
          onChange={(on) => cfg && saveConfig({ ...cfg, rules: cfg.rules.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)) }, on ? '已启用' : '已停用')}
        />
      ),
    },
    {
      title: '规则',
      key: 'name',
      render: (_: unknown, r: Rule) => (
        <div>
          <Typography.Text strong>{r.name}</Typography.Text> <Tag>{KIND_LABEL[r.kind]}</Tag>
          <div style={{ fontSize: 12 }}>
            <Typography.Text type="secondary">{r.root}/</Typography.Text>
            {r.include.map((g) => (
              <Typography.Text key={g} code style={{ fontSize: 12 }}>
                {g}
              </Typography.Text>
            ))}
            {r.exclude.length > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {' '}
                排除 {r.exclude.join('、')}
              </Typography.Text>
            )}
          </div>
        </div>
      ),
    },
    {
      title: '条件',
      key: 'cond',
      render: (_: unknown, r: Rule) => (
        <span style={{ fontSize: 12 }}>
          超过 {r.minAgeDays} 天没改
          {r.minSizeMB > 0 && `，≥ ${r.minSizeMB} MB`}
          {r.keepLatestPerSeries && '，每个系列留最新一版'}
        </span>
      ),
    },
    { title: '处理', key: 'action', render: (_: unknown, r: Rule) => actionTag(r.action) },
    {
      title: '操作',
      key: 'ops',
      render: (_: unknown, r: Rule) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} disabled={running} onClick={() => startRun(true, [r.id])}>
            预览
          </Button>
          <Button size="small" onClick={() => openEditor(r)}>
            编辑
          </Button>
          <Popconfirm
            title={`删除规则「${r.name}」？`}
            onConfirm={() => cfg && saveConfig({ ...cfg, rules: cfg.rules.filter((x) => x.id !== r.id) }, '已删除')}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const runColumns = [
    {
      title: '开始时间',
      key: 'start',
      render: (_: unknown, r: RunSummary) => (
        <Typography.Link onClick={() => setOpenRun(r.id)}>{dayjs(r.startedAt).format('MM-DD HH:mm:ss')}</Typography.Link>
      ),
    },
    {
      title: '类型',
      key: 'type',
      render: (_: unknown, r: RunSummary) => (
        <Space size={4}>
          {r.dryRun ? <Tag>预览</Tag> : <Tag color="geekblue">执行</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.trigger === 'schedule' ? '定时' : '手动'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_: unknown, r: RunSummary) => (
        <Space size={4}>
          {runStatusTag(r)}
          {!!r.warnings?.length && (
            <Typography.Text type="warning" title={r.warnings.join('\n')}>
              ⚠ {r.warnings.length}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '命中',
      key: 'matched',
      render: (_: unknown, r: RunSummary) => `${r.totals.matched} 个 · ${fmtBytes(r.totals.matchedBytes)}`,
    },
    {
      title: '已处理',
      key: 'done',
      render: (_: unknown, r: RunSummary) => (r.dryRun ? '—' : `${r.totals.done} 个 · ${fmtBytes(r.totals.doneBytes)}`),
    },
    {
      title: '跳过 / 出错',
      key: 'err',
      render: (_: unknown, r: RunSummary) => {
        const ruleSkips = r.rules.filter((x) => x.skippedReason).length;
        return (
          <span>
            {r.totals.skipped}
            {ruleSkips > 0 && <Typography.Text type="warning">（{ruleSkips} 条规则未执行）</Typography.Text>} /{' '}
            {r.totals.errors ? <Typography.Text type="danger">{r.totals.errors}</Typography.Text> : 0}
          </span>
        );
      },
    },
    {
      title: '受保护',
      key: 'prot',
      render: (_: unknown, r: RunSummary) => (r.totals.protected ? `${r.totals.protected} 个 · ${fmtBytes(r.totals.protectedBytes)}` : '—'),
    },
    {
      title: '可用空间',
      key: 'free',
      render: (_: unknown, r: RunSummary) =>
        r.freeBefore != null && r.freeAfter != null && !r.dryRun
          ? `${fmtBytes(r.freeBefore)} → ${fmtBytes(r.freeAfter)}`
          : '—',
    },
    { title: '用时', key: 'dur', render: (_: unknown, r: RunSummary) => fmtDuration((r.finishedAt ?? Date.now()) - r.startedAt) },
  ];

  const disk = data?.disk;
  const usedPct = disk ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100) : 0;
  const cur = data?.current;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="清理归档"
        extra={
          <Space>
            {running ? (
              <Button danger icon={<StopOutlined />} onClick={() => api.post('/admin/api/housekeeping/cancel').then(() => message.info('正在停止'))}>
                停止
              </Button>
            ) : (
              <>
                <Button icon={<EyeOutlined />} onClick={() => startRun(true)}>
                  预览全部
                </Button>
                <Popconfirm
                  title="按已启用的规则立即执行？"
                  description="归档会先复制到硬盘并校验，再删本机文件；其余移到废纸篓"
                  onConfirm={() => startRun(false)}
                >
                  <Button type="primary" icon={<PlayCircleOutlined />}>
                    立即执行
                  </Button>
                </Popconfirm>
              </>
            )}
          </Space>
        }
      >
        {cur && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`${cur.dryRun ? '预览' : '执行'}中：${cur.phase || '…'}`}
            description={`已命中 ${cur.totals.matched} 个（${fmtBytes(cur.totals.matchedBytes)}）${cur.dryRun ? '' : `，已处理 ${cur.totals.done} 个（${fmtBytes(cur.totals.doneBytes)}）`}`}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          以下文件不会被处理，执行记录里标为「受保护」并写明原因：各 bot 记忆、CLAUDE.md、项目技能里提到的文件（长期规范类记忆和技能提到的目录整个保留）；近 60 天改过的脚本里用到的文件；勾选了「每个系列保留最新一版」的规则里，同一系列最新的那一版。文件的「天数」按最后一次修改或到本机的时间算，刚解压、刚拷来的素材不会被当成旧文件。
        </Typography.Paragraph>
        <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
          <Descriptions.Item label="本机磁盘">
            {disk ? (
              <div style={{ minWidth: 200 }}>
                <Progress percent={usedPct} size="small" status={usedPct >= 90 ? 'exception' : 'normal'} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  剩余 {fmtBytes(disk.freeBytes)} / 共 {fmtBytes(disk.totalBytes)}
                </Typography.Text>
              </div>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="归档硬盘">
            {data?.archive.ok ? (
              <span>
                <Tag color="green">可用</Tag>剩余 {fmtBytes(data.archive.freeBytes)}
              </span>
            ) : (
              <span>
                <Tag color="red">不可用</Tag>
                <Typography.Text type="secondary">{data?.archive.reason}（归档规则会跳过）</Typography.Text>
              </span>
            )}
          </Descriptions.Item>
        </Descriptions>

        <Form form={settingsForm} layout="inline" style={{ marginTop: 16, rowGap: 8 }}>
          <Form.Item name="archiveRoot" label="归档目录" style={{ minWidth: 360 }}>
            <Input placeholder="/Volumes/NAS/luckagent-archive" />
          </Form.Item>
          <Form.Item name="enabled" label="定时执行" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="cron" label="cron" rules={[{ required: true, message: '必填' }]} tooltip="分 时 日 月 周，例如 0 3 * * * 表示每天凌晨 3 点">
            <Input style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Button onClick={onSaveSettings} loading={saving}>
              保存设置
            </Button>
          </Form.Item>
          <Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {cfg?.schedule.enabled && data?.nextRunAt ? `下次执行 ${dayjs(data.nextRunAt).format('MM-DD HH:mm')}` : '定时未开启'}
            </Typography.Text>
          </Form.Item>
        </Form>
      </Card>

      <AlertCard status={data} saving={saving} onSave={(alert) => cfg && saveConfig({ ...cfg, alert }, '已保存提醒设置')} />

      <Card
        title="规则"
        extra={
          <Button icon={<PlusOutlined />} onClick={() => openEditor('new')}>
            新增规则
          </Button>
        }
      >
        <Table rowKey="id" size="small" pagination={false} columns={ruleColumns} dataSource={cfg?.rules || []} loading={!data} />
      </Card>

      <Card title="执行记录">
        <Table
          rowKey="id"
          size="small"
          columns={runColumns}
          dataSource={runsData?.runs || []}
          loading={!runsData}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
        />
      </Card>

      <Modal
        title={editing === 'new' ? '新增规则' : '编辑规则'}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={onSaveRule}
        confirmLoading={saving}
        width={640}
        destroyOnClose
      >
        <Form form={ruleForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '必填' }]}>
            <Input />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="kind" label="类型">
              <Select style={{ width: 180 }} options={(Object.keys(KIND_LABEL) as RuleKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
            </Form.Item>
            <Form.Item name="action" label="处理方式">
              <Radio.Group
                options={[
                  { value: 'archive', label: '归档到硬盘' },
                  { value: 'trash', label: '移到废纸篓' },
                ]}
              />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind}>
            {() => (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8 }}>
                {KIND_HELP[ruleForm.getFieldValue('kind') as RuleKind]}
              </Typography.Paragraph>
            )}
          </Form.Item>
          <Form.Item name="root" label="目录" rules={[{ required: true, message: '必填' }]} tooltip="必须在用户目录下，例如 ~/projects">
            <Input />
          </Form.Item>
          <Form.Item
            name="include"
            label="匹配（每行一个，相对上面的目录）"
            rules={[{ required: true, message: '至少一行' }]}
            tooltip="* 匹配一层里的任意名字，** 匹配任意多层，{a,b} 表示二选一。例：*/work/**/*.pkl"
          >
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="*/work/**/*.pkl" />
          </Form.Item>
          <Form.Item name="exclude" label="排除（每行一个，可留空）">
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} placeholder="**/*.{ttf,otf,ttc}" />
          </Form.Item>
          <Space size="large">
            <Form.Item name="minAgeDays" label="超过几天没改" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={1} addonAfter="天" />
            </Form.Item>
            <Form.Item name="minSizeMB" label="最小体积">
              <InputNumber min={0} addonAfter="MB" />
            </Form.Item>
          </Space>
          <Form.Item
            name="keepLatestPerSeries"
            valuePropName="checked"
            tooltip="同一文件夹里、名字只差数字的文件算一个系列（如 _arc_master_0831_1101.pkl 和 _0831_1108.pkl），最新的那一版永远不处理，给每周接着跑的任务当底稿"
          >
            <Checkbox>每个系列保留最新一版</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <RunDrawer runId={openRun} onClose={() => setOpenRun(null)} />
    </Space>
  );
}

// ---------------------------------------------------------------- run detail

function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [status, setStatus] = useState<EntryStatus | undefined>();
  const [rule, setRule] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 50;

  useEffect(() => {
    setStatus(undefined);
    setRule(undefined);
    setQ('');
    setPage(1);
  }, [runId]);

  const qs = new URLSearchParams({ offset: String((page - 1) * pageSize), limit: String(pageSize) });
  if (status) qs.set('status', status);
  if (rule) qs.set('rule', rule);
  if (q) qs.set('q', q);

  const { data } = usePoll<{ run: RunSummary; total: number; entries: RunEntry[]; counts: Record<string, number> } | null>(
    () => (runId ? api.get(`/admin/api/housekeeping/runs/${runId}?${qs}`) : Promise.resolve(null)),
    3000,
    [runId, qs.toString()],
  );
  const run = data?.run;
  const [restoring, setRestoring] = useState(false);
  const restorable = (data?.counts.archived || 0) + (data?.counts.trashed || 0);
  const restore = async (paths?: string[]) => {
    if (!runId) return;
    setRestoring(true);
    try {
      const r = await api.post<{ ok: number; failed: number; results: Array<{ path: string; ok: boolean; note?: string }> }>(
        '/admin/api/housekeeping/restore',
        { runId, paths },
      );
      if (r.failed) message.warning(`恢复 ${r.ok} 个，${r.failed} 个没恢复：${r.results.find((x) => !x.ok)?.note ?? ''}`);
      else message.success(`已恢复 ${r.ok} 个文件`);
    } catch (err: any) {
      message.error(err?.message || '恢复失败');
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Drawer
      open={!!runId}
      onClose={onClose}
      width={Math.min(1000, window.innerWidth - 40)}
      title={run ? `${run.dryRun ? '预览' : '执行'}记录 · ${dayjs(run.startedAt).format('YYYY-MM-DD HH:mm:ss')}` : '记录'}
    >
      {run && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {run.error && <Alert type="error" showIcon message={run.error} />}
          {!!run.warnings?.length && (
            <Alert type="warning" showIcon message="需要处理" description={<ul style={{ margin: 0, paddingLeft: 18 }}>{run.warnings.map((w) => <li key={w}>{w}</li>)}</ul>} />
          )}
          {run.status === 'running' && <Alert type="info" showIcon message={run.phase || '进行中'} />}
          <Descriptions size="small" column={{ xs: 1, md: 3 }} bordered>
            <Descriptions.Item label="状态">{runStatusTag(run)}</Descriptions.Item>
            <Descriptions.Item label="触发">{run.trigger === 'schedule' ? '定时' : '手动'}</Descriptions.Item>
            <Descriptions.Item label="用时">{fmtDuration((run.finishedAt ?? Date.now()) - run.startedAt)}</Descriptions.Item>
            {!run.dryRun && (
              <Descriptions.Item label="可用空间">
                {fmtBytes(run.freeBefore)} → {fmtBytes(run.freeAfter)}
              </Descriptions.Item>
            )}
            {run.archiveRoot && <Descriptions.Item label="归档到">{run.archiveRoot}</Descriptions.Item>}
            {run.trashDir && <Descriptions.Item label="废纸篓">{run.trashDir.replace(/^.*\/\.Trash\//, '废纸篓/')}</Descriptions.Item>}
          </Descriptions>

          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={run.rules}
            columns={[
              { title: '规则', dataIndex: 'name', key: 'name' },
              { title: '处理', key: 'action', render: (_: unknown, r: RuleSummary) => actionTag(r.action) },
              { title: '命中', key: 'm', render: (_: unknown, r: RuleSummary) => `${r.matched} 个 · ${fmtBytes(r.matchedBytes)}` },
              {
                title: '已处理',
                key: 'd',
                render: (_: unknown, r: RuleSummary) => (run.dryRun ? '—' : `${r.done} 个 · ${fmtBytes(r.doneBytes)}`),
              },
              {
                title: '备注',
                key: 'note',
                render: (_: unknown, r: RuleSummary) => (
                  <span>
                    {r.skippedReason && <Typography.Text type="warning">{r.skippedReason}</Typography.Text>}
                    {r.skipped > 0 && ` 跳过 ${r.skipped}`}
                    {!!r.protected && <Typography.Text type="secondary"> 记忆保护 {r.protected} 个（{fmtBytes(r.protectedBytes)}）</Typography.Text>}
                    {r.errors > 0 && <Typography.Text type="danger"> 出错 {r.errors}</Typography.Text>}
                  </span>
                ),
              },
            ]}
          />

          <Space wrap>
            <Select
              allowClear
              placeholder="全部规则"
              style={{ width: 200 }}
              value={rule}
              onChange={(v) => {
                setRule(v);
                setPage(1);
              }}
              options={run.rules.map((r) => ({ value: r.id, label: r.name }))}
            />
            <Select
              allowClear
              placeholder="全部状态"
              style={{ width: 160 }}
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={(Object.keys(ENTRY_STATUS) as EntryStatus[])
                .filter((s) => data?.counts[s])
                .map((s) => ({ value: s, label: `${ENTRY_STATUS[s].label}（${data?.counts[s]}）` }))}
            />
            {restorable > 0 && (
              <Popconfirm
                title={`把这次移走的 ${restorable} 个文件全部放回原位置？`}
                description="原位置已有同名文件的不会覆盖；归档到硬盘的需要接着 NAS"
                onConfirm={() => restore()}
              >
                <Button loading={restoring}>全部恢复</Button>
              </Popconfirm>
            )}
            <Input.Search
              allowClear
              placeholder="搜索路径"
              style={{ width: 260 }}
              onSearch={(v) => {
                setQ(v.trim());
                setPage(1);
              }}
            />
          </Space>

          <Table
            rowKey={(e: RunEntry) => `${e.ruleId}:${e.path}`}
            size="small"
            dataSource={data?.entries || []}
            pagination={{ current: page, pageSize, total: data?.total || 0, onChange: setPage, showSizeChanger: false, showTotal: (t) => `共 ${t} 个` }}
            columns={[
              {
                title: '文件',
                key: 'path',
                render: (_: unknown, e: RunEntry) => (
                  <div style={{ wordBreak: 'break-all', fontSize: 12 }}>
                    {e.path}
                    {e.dest && (
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          → {e.dest}
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                ),
              },
              { title: '大小', key: 'size', width: 90, render: (_: unknown, e: RunEntry) => fmtBytes(e.size) },
              {
                title: '最后变动',
                key: 'mt',
                width: 110,
                render: (_: unknown, e: RunEntry) => (
                  <span title={`修改时间 ${dayjs(e.mtimeMs).format('YYYY-MM-DD')}`}>{dayjs(e.touchedMs ?? e.mtimeMs).format('YY-MM-DD')}</span>
                ),
              },
              {
                title: '状态',
                key: 'st',
                width: 180,
                render: (_: unknown, e: RunEntry) => (
                  <span>
                    <Tag color={ENTRY_STATUS[e.status].color}>{ENTRY_STATUS[e.status].label}</Tag>
                    {e.note && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {e.note}
                      </Typography.Text>
                    )}
                  </span>
                ),
              },
              {
                title: '',
                key: 'ops',
                width: 70,
                render: (_: unknown, e: RunEntry) =>
                  e.status === 'archived' || e.status === 'trashed' ? (
                    <Popconfirm title="把这个文件放回原位置？" onConfirm={() => restore([e.path])}>
                      <Button size="small" loading={restoring}>
                        恢复
                      </Button>
                    </Popconfirm>
                  ) : null,
              },
            ]}
          />
        </Space>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------- alerts

function AlertCard({ status, saving, onSave }: { status: Status | null; saving: boolean; onSave: (a: AlertConfig) => void }) {
  const [form] = Form.useForm();
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }>>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const saved = status?.config.alert;
  const bot: string | undefined = Form.useWatch('bot', form);

  useEffect(() => {
    if (!saved) return;
    const rs = saved.recipients || [];
    form.setFieldsValue({
      enabled: saved.enabled,
      bot: saved.bot || undefined,
      minFreeGB: saved.minFreeGB,
      users: rs.filter((r) => r.type === 'user').map((r) => r.id),
      chats: rs.filter((r) => r.type === 'chat').map((r) => r.id),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved)]);

  useEffect(() => {
    if (!bot) return setChats([]);
    setLoadingChats(true);
    api
      .get<{ chats: Array<{ chatId: string; name: string }> }>(`/admin/api/feishu/chats?bot=${encodeURIComponent(bot)}`)
      .then((r) => setChats(r.chats))
      .catch(() => setChats([]))
      .finally(() => setLoadingChats(false));
  }, [bot]);

  const savedChatNames = Object.fromEntries((saved?.recipients || []).filter((r) => r.type === 'chat').map((r) => [r.id, r.name || r.id]));
  const chatOptions = [
    ...chats.map((c) => ({ value: c.chatId, label: c.name || c.chatId })),
    // 已保存、但不在机器人群列表里的会话（比如私聊 chat_id）也要能显示
    ...Object.entries(savedChatNames)
      .filter(([id]) => !chats.some((c) => c.chatId === id))
      .map(([id, name]) => ({ value: id, label: name === id ? `其他会话（${id.slice(0, 10)}…）` : name })),
  ];

  const submit = (v: { enabled?: boolean; bot?: string; users?: string[]; chats?: string[]; minFreeGB?: number }) => {
    const users = (v.users || []).map((id) => ({ type: 'user' as const, id }));
    const groups = (v.chats || []).map((id) => ({ type: 'chat' as const, id, name: chats.find((c) => c.chatId === id)?.name || savedChatNames[id] }));
    if (v.enabled && (!v.bot || users.length + groups.length === 0)) {
      message.error('开启提醒需要选机器人，并至少选一个人或一个群');
      return;
    }
    onSave({ enabled: !!v.enabled, bot: v.bot || '', recipients: [...users, ...groups], minFreeGB: v.minFreeGB || 15 });
  };

  const test = async () => {
    try {
      await api.post('/admin/api/housekeeping/alert-test');
      message.success('已发送测试提醒');
    } catch (err: any) {
      message.error(err?.message || '发送失败');
    }
  };

  return (
    <Card title="异常提醒" size="small">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        正常执行不打扰；只在执行失败、归档规则因硬盘没接上被跳过、出错较多、没有废纸篓权限，本机可用空间低于提醒线，或 NAS 归档硬盘剩余不到 50G 时，由选定的机器人发一条飞书消息（空间提醒每天最多一次）。可以私聊发给个人，也可以发到群，可以多选。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit} style={{ maxWidth: 720 }}>
        <Space size="large" wrap align="start">
          <Form.Item name="enabled" label="开启" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="bot" label="由哪个机器人发">
            <Select style={{ width: 200 }} allowClear options={(status?.bots || []).map((b) => ({ value: b, label: b }))} />
          </Form.Item>
          <Form.Item name="minFreeGB" label="本机可用空间低于">
            <InputNumber min={1} addonAfter="G" style={{ width: 140 }} />
          </Form.Item>
        </Space>
        <Form.Item name="users" label="私聊发给（个人）" tooltip="从机器人所在群的成员里选，也可以直接粘贴 open_id（ou_ 开头）。对方要在这个机器人的可用范围内">
          <MemberPicker botName={bot || null} hint={null} />
        </Form.Item>
        <Form.Item name="chats" label="发到群">
          <Select
            mode="multiple"
            allowClear
            showSearch
            loading={loadingChats}
            optionFilterProp="label"
            options={chatOptions}
            placeholder={bot ? '选择群（可多选）' : '先选机器人'}
          />
        </Form.Item>
        <Space>
          <Button htmlType="submit" type="primary" loading={saving}>
            保存
          </Button>
          <Button onClick={test} disabled={!saved?.enabled}>
            发送测试
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
