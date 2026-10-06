import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { usePoll } from '../hooks/usePoll';
import type { Overview, ScheduleTask } from '../api/types';

const LABEL_PREFIX = 'group-summary:';
// 每天早 7 点总结「昨天全天」——配合下面模板的时间窗全覆盖无缺口
// （工作日版 cron 会让周五的内容永远没人总结）。
const DEFAULT_CRON = '0 7 * * *';
const DEFAULT_TEMPLATE = `请生成本群昨日日报（本群 chat_id: {chatId}），标题写明昨天的日期。步骤：
1. 用 lark-cli（--profile {bot} --as bot）拉取本群昨天 00:00 至今天 00:00（即昨天全天）的消息记录；
2. 归纳为四节：📌 昨日主题 / ✅ 达成的决定 / 📋 待办与负责人 / ❓ 遗留问题；
3. 控制在一屏内，直接发到本群；若昨日无有效讨论，只发一句「昨日无讨论」；
4. 发完后，把值得长期保留、且聊天记录之外查不到的耐久要点（项目决定、deadline、相关方偏好、方案变更、关键分工）写进你的本地记忆；闲聊流水不写，没有耐久信息就不写；涉密内容只写本地、不进共享记忆库。`;

interface Chat {
  chatId: string;
  name: string;
}

type RowStatus = 'on' | 'paused' | 'ignored' | 'unset' | 'orphan';

interface Row {
  botName: string;
  chatId: string;
  name: string;
  status: RowStatus;
  task?: ScheduleTask;
}

const STATUS_LABEL: Record<RowStatus, string> = {
  unset: '未配置',
  on: '已开日报',
  paused: '已暂停',
  ignored: '已忽略',
  orphan: '失效',
};
const STATUS_ORDER: RowStatus[] = ['unset', 'on', 'paused', 'ignored', 'orphan'];

export default function GroupSummaryPage() {
  const [chatsByBot, setChatsByBot] = useState<Record<string, Chat[]>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});
  const [loadingChats, setLoadingChats] = useState(false);
  const [excludedByBot, setExcludedByBot] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState('');
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RowStatus | 'all'>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<Row | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const { data: overview } = usePoll<Overview>(() => api.get('/admin/api/overview'), 30000);
  const botNames = useMemo(() => (overview?.bots || []).map((b) => b.name), [overview]);
  // overview 每 30s 轮询一次会产生新数组；用名单字符串做依赖，名单不变就不重拉飞书
  const botKey = botNames.join('\n');

  const { data: schedule, refresh: refreshSchedule } = usePoll<{ recurringTasks: ScheduleTask[] }>(
    () => api.get('/api/schedule'),
    10000,
  );

  // 所有 bot 并行拉群列表 + 忽略名单；单个 bot 失败（未运行/凭证失效）只记错误，不影响其他 bot
  const loadSeq = useRef(0);
  const loadAll = useCallback(async (names: string[]) => {
    const seq = ++loadSeq.current;
    setLoadingChats(true);
    const results = await Promise.all(
      names.map(async (name) => {
        const [chats, excluded] = await Promise.allSettled([
          api.get<{ chats: Chat[] }>(`/admin/api/feishu/chats?bot=${encodeURIComponent(name)}`),
          api.get<{ excluded: string[] }>(`/admin/api/group-summary?bot=${encodeURIComponent(name)}`),
        ]);
        return { name, chats, excluded };
      }),
    );
    if (seq !== loadSeq.current) return;
    const nextChats: Record<string, Chat[]> = {};
    const nextErrors: Record<string, string> = {};
    const nextExcluded: Record<string, string[]> = {};
    for (const r of results) {
      if (r.chats.status === 'fulfilled') nextChats[r.name] = r.chats.value.chats;
      else nextErrors[r.name] = (r.chats.reason as any)?.message || '拉取群列表失败';
      nextExcluded[r.name] = r.excluded.status === 'fulfilled' ? r.excluded.value.excluded : [];
    }
    setChatsByBot(nextChats);
    setChatErrors(nextErrors);
    setExcludedByBot(nextExcluded);
    setLoadingChats(false);
  }, []);

  useEffect(() => {
    if (!botKey) return;
    void loadAll(botKey.split('\n'));
  }, [botKey, loadAll]);

  const saveExcluded = useCallback((bot: string, update: (prev: string[]) => string[]) => {
    setExcludedByBot((prevAll) => {
      const next = update(prevAll[bot] || []);
      api.put('/admin/api/group-summary', { bot, excluded: next }).catch(async (err: any) => {
        message.error(err?.message || '保存忽略名单失败');
        // 失败以服务端为准回读，避免本地状态漂移
        try {
          const r = await api.get<{ excluded: string[] }>(`/admin/api/group-summary?bot=${encodeURIComponent(bot)}`);
          setExcludedByBot((cur) => ({ ...cur, [bot]: r.excluded }));
        } catch { /* 桥接不可达时保持现状 */ }
      });
      return { ...prevAll, [bot]: next };
    });
  }, []);

  const rows: Row[] = useMemo(() => {
    const list: Row[] = [];
    for (const bot of botNames) {
      const tasks = (schedule?.recurringTasks || []).filter(
        (t) => t.botName === bot && (t.label || '').startsWith(LABEL_PREFIX),
      );
      const taskByChat = new Map(tasks.map((t) => [(t.label || '').slice(LABEL_PREFIX.length), t]));
      const chats = chatsByBot[bot];
      const excluded = excludedByBot[bot] || [];
      if (!chats) {
        // 群列表拉不到（bot 未运行等）：已配置的日报照样列出来，只是群名未知、也无法判定失效
        for (const [cid, task] of taskByChat) {
          list.push({ botName: bot, chatId: cid, name: '（群列表未拉到）', status: task.status === 'paused' ? 'paused' : 'on', task });
        }
        continue;
      }
      for (const c of chats) {
        const task = taskByChat.get(c.chatId);
        const base = { botName: bot, chatId: c.chatId, name: c.name };
        if (task) list.push({ ...base, status: task.status === 'paused' ? 'paused' : 'on', task });
        else if (excluded.includes(c.chatId)) list.push({ ...base, status: 'ignored' });
        else list.push({ ...base, status: 'unset' });
      }
      // Tasks whose group the bot has since left → orphans, still deletable.
      // Only when the chats fetch SUCCEEDED with data — an error/empty list
      // must not mislabel every healthy task as orphaned (and invite mass
      // deletion).
      if (chats.length > 0) {
        for (const [cid, task] of taskByChat) {
          if (!chats.some((c) => c.chatId === cid)) {
            list.push({ botName: bot, chatId: cid, name: '（bot 已不在此群）', status: 'orphan', task });
          }
        }
      }
    }
    return list;
  }, [botNames, chatsByBot, excludedByBot, schedule]);

  // 群名搜索 + bot 筛选先过一遍，状态计数基于这一层，切状态时数字不跳
  const searched = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!botFilter || r.botName === botFilter) &&
        (!q || r.name.toLowerCase().includes(q) || r.chatId.toLowerCase().includes(q)),
    );
  }, [rows, search, botFilter]);
  const statusCounts = useMemo(() => {
    const m: Record<RowStatus, number> = { unset: 0, on: 0, paused: 0, ignored: 0, orphan: 0 };
    for (const r of searched) m[r.status]++;
    return m;
  }, [searched]);
  const visibleRows = statusFilter === 'all' ? searched : searched.filter((r) => r.status === statusFilter);

  const errorBots = Object.keys(chatErrors);

  const openEditor = (row: Row) => {
    setEditorTarget(row);
    form.setFieldsValue({
      cronExpr: row.task?.cronExpr || DEFAULT_CRON,
      prompt:
        row.task?.prompt ||
        DEFAULT_TEMPLATE.replaceAll('{bot}', row.botName).replaceAll('{chatId}', row.chatId),
    });
    setEditorOpen(true);
  };

  const submitEditor = async () => {
    if (!editorTarget) return;
    const { cronExpr, prompt } = await form.validateFields();
    setSaving(true);
    try {
      if (editorTarget.task) {
        await api.patch(`/api/schedule/${editorTarget.task.id}`, { cronExpr, prompt });
        message.success('已更新');
      } else {
        await api.post('/api/schedule', {
          botName: editorTarget.botName,
          chatId: editorTarget.chatId,
          prompt,
          cronExpr,
          label: `${LABEL_PREFIX}${editorTarget.chatId}`,
        });
        // 开启日报的群顺手移出忽略名单
        saveExcluded(editorTarget.botName, (prev) => prev.filter((c) => c !== editorTarget.chatId));
        message.success('日报已开启（调度即时生效，无需重启）');
      }
      setEditorOpen(false);
      void refreshSchedule();
    } catch (err: any) {
      message.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      void refreshSchedule();
    } catch (err: any) {
      message.error(err?.message || '操作失败');
    }
  };

  const runNow = async (row: Row) => {
    const prompt =
      row.task?.prompt || DEFAULT_TEMPLATE.replaceAll('{bot}', row.botName).replaceAll('{chatId}', row.chatId);
    try {
      await api.post('/api/talk', { botName: row.botName, chatId: row.chatId, prompt, async: true });
      message.success('已触发一次日报，稍后到群里查看结果');
    } catch (err: any) {
      message.error(err?.message || '触发失败');
    }
  };

  const statusTag = (s: RowStatus) =>
    s === 'on' ? (
      <Tag color="green">已开日报</Tag>
    ) : s === 'paused' ? (
      <Tag color="orange">已暂停</Tag>
    ) : s === 'ignored' ? (
      <Tag>已忽略</Tag>
    ) : s === 'orphan' ? (
      <Tag color="red">失效</Tag>
    ) : (
      <Tag color="blue">未配置</Tag>
    );

  const columns = [
    { title: 'Bot', key: 'bot', render: (_: unknown, r: Row) => r.botName },
    {
      title: '群',
      key: 'name',
      render: (_: unknown, r: Row) => (
        <span>
          <strong>{r.name}</strong>{' '}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.chatId.slice(0, 14)}…
          </Typography.Text>
        </span>
      ),
    },
    { title: '状态', key: 'status', render: (_: unknown, r: Row) => statusTag(r.status) },
    {
      title: '计划',
      key: 'plan',
      render: (_: unknown, r: Row) =>
        r.task ? (
          <span>
            <Typography.Text code>{r.task.cronExpr}</Typography.Text>{' '}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              下次 {r.task.nextExecuteAt ? dayjs(r.task.nextExecuteAt).format('MM-DD HH:mm') : '—'}
            </Typography.Text>
          </span>
        ) : (
          '—'
        ),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, r: Row) => (
        <Space wrap>
          {r.status === 'unset' && (
            <>
              <Button size="small" type="primary" onClick={() => openEditor(r)}>
                开启日报
              </Button>
              <Button size="small" onClick={() => saveExcluded(r.botName, (prev) => [...prev, r.chatId])}>
                忽略
              </Button>
            </>
          )}
          {r.status === 'ignored' && (
            <>
              <Button size="small" onClick={() => saveExcluded(r.botName, (prev) => prev.filter((c) => c !== r.chatId))}>
                取消忽略
              </Button>
              <Button size="small" type="primary" onClick={() => openEditor(r)}>
                开启日报
              </Button>
            </>
          )}
          {(r.status === 'on' || r.status === 'paused') && r.task && (
            <>
              {r.status === 'on' ? (
                <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${r.task!.id}/pause`), '已暂停')}>
                  暂停
                </Button>
              ) : (
                <Button size="small" onClick={() => act(() => api.post(`/api/schedule/${r.task!.id}/resume`), '已恢复')}>
                  恢复
                </Button>
              )}
              <Button size="small" onClick={() => openEditor(r)}>
                修改
              </Button>
              <Button size="small" onClick={() => runNow(r)}>
                立即试跑
              </Button>
              <Popconfirm
                title="关闭该群日报？"
                description="删除对应的周期任务；群会回到「未配置」状态。"
                onConfirm={() => act(() => api.del(`/api/schedule/${r.task!.id}`), '已关闭')}
              >
                <Button size="small" danger>
                  关闭
                </Button>
              </Popconfirm>
            </>
          )}
          {r.status === 'orphan' && r.task && (
            <Popconfirm title="删除这条失效任务？" onConfirm={() => act(() => api.del(`/api/schedule/${r.task!.id}`), '已删除')}>
              <Button size="small" danger>
                删除失效任务
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const unsetTotal = rows.filter((r) => r.status === 'unset').length;

  return (
    <Card
      title="群日报"
      extra={
        <Button onClick={() => botKey && loadAll(botKey.split('\n'))} loading={loadingChats}>
          刷新群列表
        </Button>
      }
    >
      {errorBots.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`${errorBots.length} 个 bot 无法拉取群列表：${errorBots.join('、')}`}
          description={
            <>
              {errorBots.map((b) => (
                <div key={b}>
                  <Typography.Text code>{b}</Typography.Text> {chatErrors[b]}
                </div>
              ))}
              <div>bot 需处于运行状态且飞书凭证有效（需要 im:chat:readonly 权限）；它已配置的日报仍会列出。</div>
            </>
          }
        />
      )}
      {unsetTotal > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`有 ${unsetTotal} 个群尚未配置日报——逐个「开启」或「忽略」后此提示消失。`}
        />
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder="搜索群名 / chat_id"
          style={{ width: 220 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          style={{ width: 180 }}
          placeholder="全部 bot"
          value={botFilter}
          onChange={(v) => setBotFilter(v ?? null)}
          options={botNames.map((n) => ({ value: n, label: n }))}
        />
        <Segmented<RowStatus | 'all'>
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'all', label: `全部 (${searched.length})` },
            ...STATUS_ORDER.map((s) => ({ value: s, label: `${STATUS_LABEL[s]} (${statusCounts[s]})` })),
          ]}
        />
      </Space>
      <Table
        rowKey={(r) => `${r.botName}:${r.chatId}`}
        dataSource={visibleRows}
        columns={columns}
        loading={loadingChats}
        pagination={{ pageSize: 20 }}
        size="small"
        locale={{
          emptyText: botNames.length === 0 ? '暂无 bot' : rows.length === 0 ? 'bot 们不在任何群里（先把 bot 拉进群）' : '没有符合筛选条件的群',
        }}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        日报本质是 label 为 <Typography.Text code>group-summary:&lt;chatId&gt;</Typography.Text> 的周期任务
        （也会出现在「定时任务」页），调度改动即时生效、无需重启；日报内容由 bot 在对应群会话里
        用 lark-cli 拉取对应时段消息后生成并直接发群。忽略名单存于{' '}
        <Typography.Text code>~/.luckagent/group-summary.json</Typography.Text>。
      </Typography.Paragraph>

      <Modal
        title={editorTarget?.task ? `修改日报：${editorTarget?.name}` : `开启日报：${editorTarget?.name}`}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        onOk={submitEditor}
        confirmLoading={saving}
        okText={editorTarget?.task ? '保存' : '开启'}
        cancelText="取消"
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="cronExpr"
            label="发送时间（cron 表达式）"
            rules={[{ required: true, message: '必填' }]}
            extra="默认每天 07:00（总结昨天全天）；时区取 .env 的 SCHEDULE_TIMEZONE"
          >
            <Input placeholder={DEFAULT_CRON} />
          </Form.Item>
          <Form.Item name="prompt" label="日报提示词模板" rules={[{ required: true, message: '必填' }]}>
            <Input.TextArea rows={8} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
